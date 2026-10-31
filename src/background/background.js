/**
 * 3Blocker Background Script
 * Intercepts top-level page requests via blocking webRequest.onBeforeRequest,
 * and enforces multi-tier precedence. The main blocklist is the copy bundled in lists/blocklist.txt;
 * it is never downloaded (the source repo was archived in 2026-10, so the list no longer changes).
 *
 * Firefox runs MV3 backgrounds as event pages that are unloaded when idle. Every event listener
 * is therefore registered synchronously at the top level (so Firefox can wake us for it), and
 * anything that needs the lists waits on `backgroundReady` first.
 */

// In-memory runtime state
let activeBlocklistSet = new Set();
let userAllowlist = new Set();
let userCustomBlocks = new Set();
let blocklistMeta = null;

// Initialize on background startup (and on every wake-up after Firefox unloads the event page)
const backgroundReady = initBackground().catch((err) => {
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

  // 2. Load the main blocklist from the IndexedDB cache, unless it is missing or wasn't made from
  //    this version's bundled file (e.g. an older version's online download): then re-read
  //    the bundled file. Parsing 18 MB on every wake would be slow, hence the cache.
  try {
    const loaded = await BlocklistDB.loadActiveBlocklist();
    blocklistMeta = loaded.meta;

    if (loaded.domains && loaded.domains.size > 0 && blocklistMeta.bundledVersion === extensionVersion()) {
      activeBlocklistSet = loaded.domains;
      console.log(`Loaded ${activeBlocklistSet.size} domains from IndexedDB cache.`);
    } else {
      console.log("Loading bundled blocklist.txt into IndexedDB...");
      await loadBundledBlocklist();
    }
  } catch (dbErr) {
    console.warn("Could not load from IndexedDB, loading bundled list:", dbErr);
    await loadBundledBlocklist();
  }
}

function extensionVersion() {
  return (typeof browser !== "undefined" && browser.runtime && browser.runtime.getManifest)
    ? browser.runtime.getManifest().version
    : "dev";
}

/**
 * Load the bundled main blocklist (lists/blocklist.txt) and cache it in IndexedDB.
 */
async function loadBundledBlocklist() {
  try {
    const fallbackUrl = (typeof browser !== "undefined" && browser.runtime && browser.runtime.getURL)
      ? browser.runtime.getURL("lists/blocklist.txt")
      : "lists/blocklist.txt";

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

    // Atomically persist the bundled list to IndexedDB, tagged with this extension version
    blocklistMeta = await BlocklistDB.saveBlocklistAtomic(parsed.domains, {
      bundledVersion: extensionVersion()
    });

    activeBlocklistSet = new Set(parsed.domains);
    console.log(`Loaded bundled blocklist with ${activeBlocklistSet.size} domains.`);
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
 * Request Interception & Redirection:
 * Checks top-level page requests against the Main Blocklist, Allowlist, and Custom Blocks (in that order).
 * If blocked, the request is redirected to the local blocked/blocked.html before anything is sent.
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
    mainBlocklistSet: activeBlocklistSet
  });
}

function blockedPageUrl(targetUrl, reason, matchedRule) {
  return browser.runtime.getURL(
    `blocked/blocked.html?url=${encodeURIComponent(targetUrl)}&reason=${encodeURIComponent(reason)}&match=${encodeURIComponent(matchedRule || "")}`
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
        domainCount: activeBlocklistSet.size || (meta ? meta.domainCount : 0),
        bundledVersion: meta ? meta.bundledVersion || null : null,
        allowlistCount: userAllowlist.size,
        customBlocksCount: userCustomBlocks.size
      };
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
      // The main blocklist beats the allowlist, so such a rule would never do anything
      const listed = BlocklistCore.mainBlocklistMatchForRule(rule, activeBlocklistSet);
      if (listed) {
        return { success: false, error: `${listed} is on the main blocklist and can't be allowed.`, mainBlocklist: listed };
      }
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
