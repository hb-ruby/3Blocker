/**
 * 3Blocker Background Script
 * Intercepts top-level page requests via blocking webRequest.onBeforeRequest,
 * enforces multi-tier precedence, and manages live blocklist updates with conditional requests.
 *
 * Firefox runs MV3 backgrounds as event pages that are unloaded when idle. Every event listener
 * is therefore registered synchronously at the top level (so Firefox can wake us for it), and
 * anything that needs the lists waits on `backgroundReady` first.
 */

// In-memory runtime state
let activeBlocklistSet = new Set();
let userAllowlist = new Set();
let userCustomBlocks = new Set();
let bundledCustomBlocks = new Set(); // from custom-blocklist.txt
let blocklistMeta = null;
let isUpdating = false;

const DAY_MS = 24 * 60 * 60 * 1000;

// Initialize on background startup (and on every wake-up after Firefox unloads the event page)
const backgroundReady = initBackground().catch((err) => {
  console.error("Failed to initialize 3Blocker background:", err);
});

async function initBackground() {
  console.log("3Blocker background initializing...");

  // 1. Load user rules from storage and the bundled custom blocks
  await loadUserRules();
  await loadBundledCustomBlocks();

  // Listen for storage changes to keep user rules in sync
  if (typeof browser !== "undefined" && browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes.user_allowlist) {
          userAllowlist = new Set(changes.user_allowlist.newValue || []);
        }
        if (changes.user_custom_blocks) {
          userCustomBlocks = new Set(changes.user_custom_blocks.newValue || []);
        }
      }
    });
  }

  // 2. Open DB and load active blocklist
  try {
    const loaded = await BlocklistDB.loadActiveBlocklist();
    blocklistMeta = loaded.meta;

    if (loaded.domains && loaded.domains.size > 0) {
      activeBlocklistSet = loaded.domains;
      console.log(`Loaded ${activeBlocklistSet.size} domains from IndexedDB cache.`);
    } else {
      console.log("IndexedDB cache is empty. Loading bundled fallback blocklist.txt...");
      await loadBundledBlocklist();
    }
  } catch (dbErr) {
    console.warn("Could not load from IndexedDB, loading bundled fallback:", dbErr);
    await loadBundledBlocklist();
  }

  // 3. Setup periodic refresh alarm (every 24 hours)
  setupAlarms();

  // 4. Check the live list if it has never been fetched or is over a day old. Not on every
  //    start: the event page wakes up often, and the daily alarm covers regular refreshes.
  const neverFetchedLive = !blocklistMeta || (!blocklistMeta.etag && !blocklistMeta.lastModified);
  const fetchedAt = blocklistMeta && blocklistMeta.fetchedAt ? Date.parse(blocklistMeta.fetchedAt) : 0;
  if (neverFetchedLive || Date.now() - fetchedAt > DAY_MS) {
    setTimeout(() => {
      fetchLiveBlocklist(false).catch((e) => {
        console.warn("Initial live blocklist check skipped/failed:", e);
      });
    }, 3000);
  }
}

/**
 * Load bundled fallback list from extension package (./blocklist.txt).
 */
async function loadBundledBlocklist() {
  try {
    const fallbackUrl = (typeof browser !== "undefined" && browser.runtime && browser.runtime.getURL)
      ? browser.runtime.getURL("blocklist.txt")
      : "blocklist.txt";

    const response = await fetch(fallbackUrl);
    if (!response.ok) {
      throw new Error(`Failed to read bundled blocklist: HTTP ${response.status}`);
    }

    const text = await response.text();
    const parsed = BlocklistCore.parseBlocklist(text);
    const validation = BlocklistCore.validateBlocklistCandidate(parsed, 0);

    if (!validation.valid) {
      throw new Error(`Bundled blocklist failed validation: ${validation.error}`);
    }

    // Atomically persist bundled list to IndexedDB as initial active version
    blocklistMeta = await BlocklistDB.saveBlocklistAtomic(parsed.domains, {
      fetchedAt: new Date().toISOString(),
      etag: null,
      lastModified: null
    });

    activeBlocklistSet = new Set(parsed.domains);
    console.log(`Successfully bundled & loaded fallback list with ${activeBlocklistSet.size} domains.`);
  } catch (err) {
    console.error("Critical: Could not load bundled blocklist:", err);
  }
}

/**
 * Load the always-on custom blocks shipped with the extension (./custom-blocklist.txt).
 */
async function loadBundledCustomBlocks() {
  try {
    const response = await fetch(browser.runtime.getURL("custom-blocklist.txt"));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    bundledCustomBlocks = BlocklistCore.parseRuleList(await response.text());
  } catch (err) {
    console.error("Could not load custom-blocklist.txt:", err);
  }
}

/**
 * Load user custom blocklist and allowlist.
 */
async function loadUserRules() {
  const rules = await BlocklistDB.getUserRules();
  userAllowlist = rules.allowlist;
  userCustomBlocks = rules.customBlocks;
}

/**
 * Configure Alarms for periodic refreshes.
 */
async function setupAlarms() {
  if (typeof browser === "undefined" || !browser.alarms) return;

  // Periodic daily alarm (every 1440 minutes = 24 hours). Only create it if missing, so
  // waking the event page doesn't keep pushing the next refresh another day out.
  if (!(await browser.alarms.get("refreshBlocklistDaily"))) {
    browser.alarms.create("refreshBlocklistDaily", {
      periodInMinutes: 1440
    });
  }
}

if (typeof browser !== "undefined" && browser.alarms) {
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "refreshBlocklistDaily" || alarm.name === "retryBlocklistAlarm") {
      await backgroundReady;
      fetchLiveBlocklist(false).catch((err) => {
        console.warn("Alarm triggered blocklist refresh failed:", err);
      });
    }
  });
}

/**
 * Fetch the live blocklist using conditional HTTP headers (ETag / Last-Modified).
 * Validates before swapping to prevent overwriting with corrupted or shrunken lists.
 * Implements exponential backoff on failure.
 *
 * @param {boolean} isManual - whether triggered manually by the user
 * @returns {Promise<{ success: boolean, count?: number, notModified?: boolean, error?: string }>}
 */
async function fetchLiveBlocklist(isManual = false) {
  if (isUpdating) {
    return { success: false, error: "Update already in progress" };
  }

  isUpdating = true;
  await BlocklistDB.setMetadata({ status: "updating" });

  try {
    const meta = await BlocklistDB.getMetadata();
    const headers = {};

    // Conditional HTTP headers
    if (meta.etag) {
      headers["If-None-Match"] = meta.etag;
    }
    if (meta.lastModified) {
      headers["If-Modified-Since"] = meta.lastModified;
    }

    const response = await fetch(BlocklistCore.LIVE_BLOCKLIST_URL, {
      method: "GET",
      headers: headers
    });

    // 1. Handle HTTP 304 Not Modified
    if (response.status === 304) {
      console.log("Live blocklist is unchanged (HTTP 304 Not Modified).");
      const updatedMeta = await BlocklistDB.setMetadata({
        fetchedAt: new Date().toISOString(),
        status: "idle",
        lastError: null,
        retryCount: 0,
        nextRetryAt: null
      });
      blocklistMeta = updatedMeta;
      clearRetryAlarm();
      return { success: true, notModified: true, count: activeBlocklistSet.size };
    }

    // 2. Handle HTTP Errors (4xx, 5xx)
    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status} ${response.statusText}`);
    }

    // 3. Handle HTTP 200 OK
    const newEtag = response.headers.get("ETag") || response.headers.get("etag");
    const newLastModified = response.headers.get("Last-Modified") || response.headers.get("last-modified");
    const rawText = await response.text();

    // Parse candidate
    const parsed = BlocklistCore.parseBlocklist(rawText);

    // Validation before swap
    const validation = BlocklistCore.validateBlocklistCandidate(parsed, activeBlocklistSet.size);
    if (!validation.valid) {
      throw new Error(`Validation rejected candidate download: ${validation.error}`);
    }

    // Atomic swap in IndexedDB
    const newMeta = await BlocklistDB.saveBlocklistAtomic(parsed.domains, {
      etag: newEtag,
      lastModified: newLastModified,
      fetchedAt: new Date().toISOString()
    });

    // Atomic swap in memory
    activeBlocklistSet = new Set(parsed.domains);
    blocklistMeta = newMeta;
    clearRetryAlarm();

    console.log(`Live blocklist atomically updated: ${activeBlocklistSet.size} domains.`);
    return { success: true, count: activeBlocklistSet.size };

  } catch (err) {
    console.error("Live blocklist update failed:", err.message);
    const meta = await BlocklistDB.getMetadata();
    const currentRetries = (meta.retryCount || 0) + 1;
    const backoffDelay = BlocklistCore.calculateBackoffDelay(currentRetries);
    const nextRetry = Date.now() + backoffDelay;

    const errorMeta = await BlocklistDB.setMetadata({
      status: "error",
      lastError: err.message,
      retryCount: currentRetries,
      nextRetryAt: nextRetry
    });
    blocklistMeta = errorMeta;

    // Schedule retry alarm if alarms API is available
    scheduleRetryAlarm(backoffDelay);

    return { success: false, error: err.message };
  } finally {
    isUpdating = false;
  }
}

function scheduleRetryAlarm(delayMs) {
  if (typeof browser !== "undefined" && browser.alarms) {
    browser.alarms.create("retryBlocklistAlarm", {
      when: Date.now() + delayMs
    });
    console.log(`Scheduled retry in ${Math.round(delayMs / 60000)} minutes.`);
  }
}

function clearRetryAlarm() {
  if (typeof browser !== "undefined" && browser.alarms) {
    browser.alarms.clear("retryBlocklistAlarm");
  }
}

/**
 * Request Interception & Redirection:
 * Checks top-level page requests against Allowlist, Custom Blocks, and Main Blocklist.
 * If blocked, the request is redirected to the local blocked.html before anything is sent.
 * Firefox holds the request while this (async) blocking listener runs, including while a
 * suspended event page wakes up and reloads the lists.
 */
if (typeof browser !== "undefined" && browser.webRequest && browser.webRequest.onBeforeRequest) {
  browser.webRequest.onBeforeRequest.addListener(
    async (details) => {
      await backgroundReady;

      const check = checkUrl(details.url);
      if (check.blocked) {
        return { redirectUrl: blockedPageUrl(details.url, check.reason, check.matchedRule) };
      }
      return {};
    },
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
    ["blocking"]
  );
}

/**
 * Single-page sites (e.g. Reddit) change the URL with history.pushState instead of
 * loading a new page, which onBeforeRequest never sees. Check those URL changes too.
 */
if (typeof browser !== "undefined" && browser.webNavigation && browser.webNavigation.onHistoryStateUpdated) {
  browser.webNavigation.onHistoryStateUpdated.addListener(
    async (details) => {
      if (details.frameId !== 0) return;
      await backgroundReady;

      const check = checkUrl(details.url);
      if (check.blocked) {
        try {
          await browser.tabs.update(details.tabId, { url: blockedPageUrl(details.url, check.reason, check.matchedRule) });
        } catch (tabErr) {
          console.warn("Could not redirect blocked tab:", tabErr);
        }
      }
    },
    { url: [{ schemes: ["http", "https"] }] }
  );
}

function checkUrl(url) {
  return BlocklistCore.checkUrlPrecedence(url, {
    allowlist: userAllowlist,
    customBlocks: userCustomBlocks,
    extraBlocks: bundledCustomBlocks,
    mainBlocklistSet: activeBlocklistSet
  });
}

function blockedPageUrl(targetUrl, reason, matchedRule) {
  return browser.runtime.getURL(
    `blocked.html?url=${encodeURIComponent(targetUrl)}&reason=${encodeURIComponent(reason)}&match=${encodeURIComponent(matchedRule || "")}`
  );
}

/**
 * Messaging API to communicate with Popup and future Options page.
 */
if (typeof browser !== "undefined" && browser.runtime && browser.runtime.onMessage) {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message).then(sendResponse).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // Keep message channel open for async response
  });
}

async function handleMessage(message) {
  if (!message || !message.type) return { success: false, error: "Missing message type" };

  // After a wake-up the rule sets are empty until loaded; writing before then would
  // overwrite the user's stored rules.
  await backgroundReady;

  switch (message.type) {
    case "GET_STATUS": {
      const meta = await BlocklistDB.getMetadata();
      return {
        success: true,
        isUpdating,
        domainCount: activeBlocklistSet.size || (meta ? meta.domainCount : 0),
        etag: meta ? meta.etag : null,
        lastModified: meta ? meta.lastModified : null,
        fetchedAt: meta ? meta.fetchedAt : null,
        status: isUpdating ? "updating" : (meta ? meta.status : "idle"),
        lastError: meta ? meta.lastError : null,
        retryCount: meta ? meta.retryCount : 0,
        nextRetryAt: meta ? meta.nextRetryAt : null,
        allowlistCount: userAllowlist.size,
        customBlocksCount: userCustomBlocks.size
      };
    }

    case "REFRESH_BLOCKLIST_NOW": {
      const result = await fetchLiveBlocklist(true);
      return result;
    }

    case "CHECK_URL": {
      return { success: true, ...checkUrl(message.url) };
    }

    case "GET_USER_RULES": {
      return {
        success: true,
        allowlist: [...userAllowlist].sort(),
        customBlocks: [...userCustomBlocks].sort()
      };
    }

    case "ADD_CUSTOM_BLOCK": {
      const rule = BlocklistCore.normalizeRule(message.rule);
      if (!rule) return { success: false, error: "Not a valid rule" };
      userCustomBlocks.add(rule);
      // The allowlist wins over custom blocks, so drop the same rule there or the block would do nothing
      userAllowlist.delete(rule);
      await BlocklistDB.setUserRules(userAllowlist, userCustomBlocks);
      return { success: true, rule, count: userCustomBlocks.size };
    }

    case "REMOVE_CUSTOM_BLOCK": {
      if (!message.rule) return { success: false, error: "Rule is required" };
      userCustomBlocks.delete(message.rule.toLowerCase().trim());
      await BlocklistDB.setUserRules(userAllowlist, userCustomBlocks);
      return { success: true, count: userCustomBlocks.size };
    }

    case "ADD_ALLOWLIST": {
      const rule = BlocklistCore.normalizeRule(message.rule);
      if (!rule) return { success: false, error: "Not a valid rule" };
      userAllowlist.add(rule);
      // If rule was also in custom blocks, remove it to resolve conflict
      userCustomBlocks.delete(rule);
      await BlocklistDB.setUserRules(userAllowlist, userCustomBlocks);
      return { success: true, rule, count: userAllowlist.size };
    }

    case "REMOVE_ALLOWLIST": {
      if (!message.rule) return { success: false, error: "Rule is required" };
      userAllowlist.delete(message.rule.toLowerCase().trim());
      await BlocklistDB.setUserRules(userAllowlist, userCustomBlocks);
      return { success: true, count: userAllowlist.size };
    }

    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}
