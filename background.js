/**
 * 3Blocker Background Service Worker / Script
 * Intercepts navigation via webNavigation.onBeforeNavigate,
 * enforces multi-tier precedence, and manages live blocklist updates with conditional requests.
 */

// In-memory runtime state
let activeBlocklistSet = new Set();
let userAllowlist = new Set();
let userCustomBlocks = new Set();
let blocklistMeta = null;
let isUpdating = false;

// Initialize on background startup
initBackground().catch((err) => {
  console.error("Failed to initialize 3Blocker background:", err);
});

async function initBackground() {
  console.log("3Blocker background initializing...");

  // 1. Load user rules from storage
  await loadUserRules();

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

  // 4. Initial update check in background (non-blocking)
  setTimeout(() => {
    fetchLiveBlocklist(false).catch((e) => {
      console.warn("Initial live blocklist check skipped/failed:", e);
    });
  }, 3000);
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
function setupAlarms() {
  if (typeof browser === "undefined" || !browser.alarms) return;

  // Periodic daily alarm (every 1440 minutes = 24 hours)
  browser.alarms.create("refreshBlocklistDaily", {
    periodInMinutes: 1440
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "refreshBlocklistDaily" || alarm.name === "retryBlocklistAlarm") {
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
 * WebNavigation Interception & Redirection:
 * Checks incoming top-level navigation against Allowlist, Custom Blocks, and Main Blocklist.
 * If blocked, redirects the tab to the local blocked.html.
 */
if (typeof browser !== "undefined" && browser.webNavigation && browser.webNavigation.onBeforeNavigate) {
  browser.webNavigation.onBeforeNavigate.addListener(async (details) => {
    // Only intercept top-level page navigations (frameId 0)
    if (details.frameId !== 0) return;

    const targetUrl = details.url;
    if (!targetUrl || (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))) {
      return;
    }

    // Do not intercept extension's own pages
    const extensionOrigin = browser.runtime.getURL("");
    if (targetUrl.startsWith(extensionOrigin)) {
      return;
    }

    const check = BlocklistCore.checkUrlPrecedence(targetUrl, {
      allowlist: userAllowlist,
      customBlocks: userCustomBlocks,
      mainBlocklistSet: activeBlocklistSet
    });

    let blockReason = check.blocked ? check.reason : null;
    let blockMatch = check.matchedRule;

    // Time limits apply even to allowlisted sites, since the user set them explicitly
    if (!blockReason) {
      await timeLimitsReady;
      const limitedDomain = BlocklistCore.findLimitedDomain(httpHostname(targetUrl), timeLimits);
      if (limitedDomain && getTimeLimitStatus(limitedDomain).expired) {
        blockReason = "time_limit";
        blockMatch = limitedDomain;
      }
    }

    if (blockReason) {
      try {
        await browser.tabs.update(details.tabId, { url: blockedPageUrl(targetUrl, blockReason, blockMatch) });
      } catch (tabErr) {
        console.warn("Could not redirect blocked tab:", tabErr);
      }
    }
  });
}

function blockedPageUrl(targetUrl, reason, matchedRule) {
  return browser.runtime.getURL(
    `blocked.html?url=${encodeURIComponent(targetUrl)}&reason=${encodeURIComponent(reason)}&match=${encodeURIComponent(matchedRule || "")}`
  );
}

function httpHostname(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") ? u.hostname.toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Site Time Limits:
 * Time is counted only while a limited site is the active tab of the focused browser window.
 * The running session is persisted so counting survives the background page being suspended,
 * and an alarm fires when the remaining allowance runs out to send the tab to blocked.html.
 */
const TIME_LIMIT_EXPIRE_ALARM = "timeLimitExpire";
const TIME_LIMIT_TICK_ALARM = "timeLimitTick";
const STALE_SESSION_MS = 2 * 60 * 1000;

let timeLimits = {};
let timeLimitSession = null;
let timeLimitQueue = Promise.resolve();
const timeLimitsReady = loadTimeLimits();

async function loadTimeLimits() {
  const state = await BlocklistDB.getTimeLimitState();
  timeLimits = state.limits;
  timeLimitSession = state.session;
}

// The tick alarm flushes the session every minute, so a longer gap means the browser was
// closed or the machine slept mid-session. Don't count that time.
function liveSessionStart(session, now) {
  return session && now - session.startedAt <= STALE_SESSION_MS ? session.startedAt : null;
}

// Serialize time limit updates so overlapping tab/window events can't double-count
function runTimeLimitTask(task) {
  const result = timeLimitQueue.then(() => timeLimitsReady).then(task);
  timeLimitQueue = result.catch((err) => console.warn("Time limit update failed:", err));
  return result;
}

function getTimeLimitStatus(domain, now = Date.now()) {
  const sessionStart = timeLimitSession && timeLimitSession.domain === domain ? liveSessionStart(timeLimitSession, now) : null;
  return BlocklistCore.computeTimeLimitState(timeLimits[domain], now, sessionStart);
}

function resetIfNewDay(entry) {
  const today = BlocklistCore.todayKey();
  if (entry.day !== today) {
    entry.day = today;
    entry.usedSeconds = 0;
    entry.extraSeconds = 0;
  }
}

// Add the running session's elapsed time to its domain and stop counting
function flushTimeLimitSession(now) {
  const session = timeLimitSession;
  timeLimitSession = null;
  if (!session) return;

  const entry = timeLimits[session.domain];
  const startedAt = liveSessionStart(session, now);
  if (!entry || entry.paused || !startedAt) return;
  resetIfNewDay(entry);
  entry.usedSeconds += Math.max(0, (now - startedAt) / 1000);
}

/**
 * Re-evaluate which site (if any) should be counting right now, persist usage,
 * and block the active tab if its allowance is used up.
 */
async function syncTimeLimitSession() {
  const now = Date.now();
  flushTimeLimitSession(now);

  let activeTab = null;
  try {
    const win = await browser.windows.getLastFocused({ populate: true });
    if (win && win.focused) {
      activeTab = win.tabs.find((t) => t.active) || null;
    }
  } catch (e) {
    console.warn("Could not query focused window:", e);
  }

  const domain = activeTab ? BlocklistCore.findLimitedDomain(httpHostname(activeTab.url), timeLimits) : null;
  if (domain) {
    const entry = timeLimits[domain];
    resetIfNewDay(entry);
    if (getTimeLimitStatus(domain, now).expired) {
      await redirectTimeLimitedTabs(domain);
    } else if (!entry.paused) {
      timeLimitSession = { domain, tabId: activeTab.id, startedAt: now };
    }
  }

  await BlocklistDB.setTimeLimitState(timeLimits, timeLimitSession);
  scheduleTimeLimitAlarms(now);
}

function scheduleTimeLimitAlarms(now) {
  if (!browser.alarms) return;
  if (timeLimitSession) {
    const { remainingSeconds } = getTimeLimitStatus(timeLimitSession.domain, now);
    browser.alarms.create(TIME_LIMIT_EXPIRE_ALARM, { when: now + remainingSeconds * 1000 });
    browser.alarms.create(TIME_LIMIT_TICK_ALARM, { periodInMinutes: 1 });
  } else {
    browser.alarms.clear(TIME_LIMIT_EXPIRE_ALARM);
    browser.alarms.clear(TIME_LIMIT_TICK_ALARM);
  }
}

// Send every open tab on the expired domain to the block page
async function redirectTimeLimitedTabs(domain) {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    const host = httpHostname(tab.url);
    if (host && BlocklistCore.findLimitedDomain(host, { [domain]: true })) {
      try {
        await browser.tabs.update(tab.id, { url: blockedPageUrl(tab.url, "time_limit", domain) });
      } catch (tabErr) {
        console.warn("Could not redirect time-limited tab:", tabErr);
      }
    }
  }
}

if (typeof browser !== "undefined" && browser.tabs && browser.windows) {
  const resync = () => {
    runTimeLimitTask(syncTimeLimitSession).catch(() => {});
  };

  browser.tabs.onActivated.addListener(resync);
  browser.tabs.onRemoved.addListener(resync);
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) resync();
  });
  browser.windows.onFocusChanged.addListener(resync);
  if (browser.alarms) {
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === TIME_LIMIT_EXPIRE_ALARM || alarm.name === TIME_LIMIT_TICK_ALARM) resync();
    });
  }
  resync();
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
      const result = BlocklistCore.checkUrlPrecedence(message.url, {
        allowlist: userAllowlist,
        customBlocks: userCustomBlocks,
        mainBlocklistSet: activeBlocklistSet
      });
      return { success: true, ...result };
    }

    case "ADD_CUSTOM_BLOCK": {
      if (!message.rule) return { success: false, error: "Rule is required" };
      userCustomBlocks.add(message.rule.toLowerCase().trim());
      await BlocklistDB.setUserRules(userAllowlist, userCustomBlocks);
      return { success: true, count: userCustomBlocks.size };
    }

    case "REMOVE_CUSTOM_BLOCK": {
      if (!message.rule) return { success: false, error: "Rule is required" };
      userCustomBlocks.delete(message.rule.toLowerCase().trim());
      await BlocklistDB.setUserRules(userAllowlist, userCustomBlocks);
      return { success: true, count: userCustomBlocks.size };
    }

    case "ADD_ALLOWLIST": {
      if (!message.rule) return { success: false, error: "Rule is required" };
      const rule = message.rule.toLowerCase().trim();
      userAllowlist.add(rule);
      // If rule was also in custom blocks, remove it to resolve conflict
      userCustomBlocks.delete(rule);
      await BlocklistDB.setUserRules(userAllowlist, userCustomBlocks);
      return { success: true, count: userAllowlist.size };
    }

    case "REMOVE_ALLOWLIST": {
      if (!message.rule) return { success: false, error: "Rule is required" };
      userAllowlist.delete(message.rule.toLowerCase().trim());
      await BlocklistDB.setUserRules(userAllowlist, userCustomBlocks);
      return { success: true, count: userAllowlist.size };
    }

    case "GET_TIME_LIMIT": {
      await timeLimitsReady;
      const domain = BlocklistCore.findLimitedDomain(httpHostname(message.url), timeLimits);
      if (!domain) return { success: true, domain: null };
      return {
        success: true,
        domain,
        paused: !!timeLimits[domain].paused,
        counting: !!(timeLimitSession && timeLimitSession.domain === domain),
        ...getTimeLimitStatus(domain)
      };
    }

    case "SET_TIME_LIMIT": {
      const domain = (message.domain || "").toLowerCase().trim();
      const limitSeconds = Math.round(Number(message.minutes) * 60);
      if (!domain || !(limitSeconds > 0)) return { success: false, error: "Domain and a positive number of minutes are required" };

      return runTimeLimitTask(async () => {
        flushTimeLimitSession(Date.now());
        const entry = timeLimits[domain] || { usedSeconds: 0, extraSeconds: 0, day: BlocklistCore.todayKey(), paused: false };
        entry.limitSeconds = limitSeconds;
        timeLimits[domain] = entry;
        await syncTimeLimitSession();
        return { success: true };
      });
    }

    case "REMOVE_TIME_LIMIT": {
      return runTimeLimitTask(async () => {
        flushTimeLimitSession(Date.now());
        delete timeLimits[message.domain];
        await syncTimeLimitSession();
        return { success: true };
      });
    }

    case "ADD_TIME_LIMIT_EXTRA": {
      return runTimeLimitTask(async () => {
        const entry = timeLimits[message.domain];
        if (!entry) return { success: false, error: "No time limit for this domain" };
        flushTimeLimitSession(Date.now());
        resetIfNewDay(entry);
        entry.extraSeconds += Math.round(Number(message.minutes) * 60) || 0;
        await syncTimeLimitSession();
        return { success: true };
      });
    }

    case "SET_TIME_LIMIT_PAUSED": {
      return runTimeLimitTask(async () => {
        const entry = timeLimits[message.domain];
        if (!entry) return { success: false, error: "No time limit for this domain" };
        // Flush before changing state so time up to now is counted under the old setting
        flushTimeLimitSession(Date.now());
        entry.paused = !!message.paused;
        await syncTimeLimitSession();
        return { success: true };
      });
    }

    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}
