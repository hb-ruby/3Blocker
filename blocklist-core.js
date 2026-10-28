/**
 * 3Blocker Core Blocklist Engine
 * Handles parsing, validation, parent domain resolution, precedence rules, and backoff.
 */
(function (global) {
  "use strict";

  const LIVE_BLOCKLIST_URL = "https://blocklistproject.github.io/Lists/alt-version/porn-nl.txt";
  const BASE_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
  const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Hostname regex allowing standard domain labels: letters, digits, hyphens, underscores (used in subdomains)
  // Each label 1-63 chars, labels separated by dots, at least two labels (domain + TLD)
  const HOSTNAME_LABEL_REGEX = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
  const IP_V4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;

  /**
   * Validate if a string is a clean, valid internet hostname.
   * Disallows IP addresses and localhost as per specification.
   */
  function isValidHostname(str) {
    if (!str || typeof str !== "string") return false;
    if (str.length === 0 || str.length > 253) return false;
    if (str === "localhost" || str.endsWith(".localhost")) return false;
    if (IP_V4_REGEX.test(str)) return false;

    // Reject URLs with protocols or slashes or ports
    if (str.includes("/") || str.includes(":") || str.includes("?") || str.includes("@")) {
      return false;
    }

    const labels = str.split(".");
    // Must have at least two labels (e.g. domain.tld)
    if (labels.length < 2) return false;

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (!label || label.length > 63) return false;
      if (!HOSTNAME_LABEL_REGEX.test(label)) return false;
    }

    // Top-level domain (last label) should not be all-numeric
    const tld = labels[labels.length - 1];
    if (/^\d+$/.test(tld)) return false;

    return true;
  }

  /**
   * Parse plain text blocklist.
   * Format: plain text, one domain per line, '#' comments, no localhost/IP prefixes.
   * Trims whitespace, lowercases, skips comments & blank lines, validates hostnames, dedupes.
   *
   * @param {string} rawText
   * @returns {{ domains: string[], invalidLines: string[], stats: { total: number, comments: number, empty: number, valid: number, invalid: number } }}
   */
  function parseBlocklist(rawText) {
    if (typeof rawText !== "string") {
      throw new TypeError("parseBlocklist expects a string input");
    }

    const domainSet = new Set();
    const invalidLines = [];
    let comments = 0;
    let empty = 0;
    let total = 0;

    // Split on CRLF or LF
    const lines = rawText.split(/\r?\n/);
    total = lines.length;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim().toLowerCase();

      if (line.length === 0) {
        empty++;
        continue;
      }

      if (line.startsWith("#")) {
        comments++;
        continue;
      }

      // Strip unwanted leading prefixes if encountered (e.g. 127.0.0.1 or 0.0.0.0)
      if (line.startsWith("127.0.0.1 ") || line.startsWith("0.0.0.0 ")) {
        line = line.replace(/^(?:127\.0\.0\.1|0\.0\.0\.0)\s+/, "").trim();
      }

      if (isValidHostname(line)) {
        domainSet.add(line);
      } else {
        if (invalidLines.length < 50) {
          invalidLines.push(line);
        }
      }
    }

    const validCount = domainSet.size;
    const invalidCount = total - empty - comments - validCount;

    return {
      domains: Array.from(domainSet),
      invalidLines,
      stats: {
        total,
        comments,
        empty,
        valid: validCount,
        invalid: Math.max(0, invalidCount)
      }
    };
  }

  /**
   * Validation before swap:
   * Reject the download if it's empty, far smaller than the current list (<50%),
   * or contains non-hostname junk (e.g., HTML response or high invalid line ratio).
   *
   * @param {{ domains: string[], stats: object }} parsedResult
   * @param {number} cachedCount
   * @returns {{ valid: boolean, error: string | null }}
   */
  function validateBlocklistCandidate(parsedResult, cachedCount = 0) {
    if (!parsedResult || !parsedResult.domains) {
      return { valid: false, error: "Candidate is missing domains data" };
    }

    const count = parsedResult.domains.length;

    // 1. Must not be empty
    if (count === 0) {
      return { valid: false, error: "Blocklist candidate is completely empty (0 valid domains)" };
    }

    // 2. Reject if far smaller than current list (<50% of cached count)
    if (cachedCount > 0 && count < cachedCount * 0.5) {
      return {
        valid: false,
        error: `Candidate count (${count}) is far smaller than cached count (${cachedCount}) (<50% threshold)`
      };
    }

    // 3. Junk validation: check if non-empty, non-comment lines have excessive error rate
    const nonCommentTotal = parsedResult.stats.total - parsedResult.stats.empty - parsedResult.stats.comments;
    if (nonCommentTotal > 0) {
      const invalidRatio = parsedResult.stats.invalid / nonCommentTotal;
      // If > 2% of substantive lines are junk, or if invalid lines look like HTML tags
      if (invalidRatio > 0.02 && parsedResult.stats.invalid > 50) {
        return {
          valid: false,
          error: `Candidate contains excessive non-hostname junk (${(invalidRatio * 100).toFixed(2)}% invalid lines)`
        };
      }
    }

    // Quick check on invalid sample lines for HTML / 404 signatures
    if (parsedResult.invalidLines && parsedResult.invalidLines.length > 0) {
      for (const sample of parsedResult.invalidLines) {
        if (sample.includes("<!doctype") || sample.includes("<html") || sample.includes("<head") || sample.includes("404 not found")) {
          return { valid: false, error: "Candidate appears to be an HTML error page rather than a plain text blocklist" };
        }
      }
    }

    return { valid: true, error: null };
  }

  /**
   * Break a hostname into itself and all parent domains.
   * e.g. "a.b.c.example.com" -> ["a.b.c.example.com", "b.c.example.com", "c.example.com", "example.com"]
   * Does not return single TLD labels (e.g. "com").
   *
   * @param {string} hostname
   * @returns {string[]}
   */
  function getParentDomains(hostname) {
    if (!hostname || typeof hostname !== "string") return [];
    const cleanHost = hostname.trim().toLowerCase();
    const parts = cleanHost.split(".");
    if (parts.length < 2) return [cleanHost];

    const results = [];
    for (let i = 0; i <= parts.length - 2; i++) {
      results.push(parts.slice(i).join("."));
    }
    return results;
  }

  /**
   * Safe URL parser that works in both standard browser WebExtension environments
   * and standalone JS runtimes (for automated testing).
   */
  function parseUrlParts(urlString) {
    if (!urlString || typeof urlString !== "string") return null;
    if (typeof URL !== "undefined") {
      try {
        const u = new URL(urlString);
        return {
          protocol: u.protocol,
          hostname: u.hostname.toLowerCase(),
          pathname: u.pathname || "/",
          search: u.search || ""
        };
      } catch (e) {
        return null;
      }
    }
    // Standalone fallback regex parser
    const match = urlString.match(/^([a-z0-9+.-]+:)\/\/([^/?#:]+)(?::\d+)?(\/[^?#]*)?(\?[^#]*)?/i);
    if (!match) return null;
    return {
      protocol: match[1].toLowerCase(),
      hostname: match[2].toLowerCase(),
      pathname: match[3] || "/",
      search: match[4] || ""
    };
  }

  /**
   * Check a URL against User Allowlist, User Custom Blocks, and Main Blocklist Set.
   * User allowlist always takes highest precedence.
   * User custom blocks take second precedence.
   * Main blocklist takes third precedence.
   *
   * @param {string} urlString
   * @param {object} stores
   * @param {Set<string>|Array<string>} stores.allowlist - domains or exact URLs allowed by user
   * @param {Set<string>|Array<string>} stores.customBlocks - domains or exact URLs blocked by user
   * @param {Set<string>} stores.mainBlocklistSet - fast Set containing live/bundled blocklist domains
   * @returns {{ blocked: boolean, reason: "allowlisted"|"custom_block"|"main_blocklist"|"allowed", matchedRule: string|null }}
   */
  function checkUrlPrecedence(urlString, stores) {
    const urlObj = parseUrlParts(urlString);
    if (!urlObj) {
      return { blocked: false, reason: "allowed", matchedRule: null };
    }

    // Only process http/https protocols
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      return { blocked: false, reason: "allowed", matchedRule: null };
    }

    const host = urlObj.hostname;
    const exactPageUrl = `${host}${urlObj.pathname}${urlObj.search || ""}`.toLowerCase();
    const parentDomains = getParentDomains(host);

    const allowlistSet = stores.allowlist instanceof Set ? stores.allowlist : new Set(stores.allowlist || []);
    const customBlocksSet = stores.customBlocks instanceof Set ? stores.customBlocks : new Set(stores.customBlocks || []);
    const mainSet = stores.mainBlocklistSet instanceof Set ? stores.mainBlocklistSet : new Set(stores.mainBlocklistSet || []);

    // 1. PRECEDENCE: User Allowlist (Always takes first precedence)
    if (allowlistSet.has(exactPageUrl)) {
      return { blocked: false, reason: "allowlisted", matchedRule: exactPageUrl };
    }
    for (const d of parentDomains) {
      if (allowlistSet.has(d)) {
        return { blocked: false, reason: "allowlisted", matchedRule: d };
      }
    }

    // 2. PRECEDENCE: User Custom Blocklist
    if (customBlocksSet.has(exactPageUrl)) {
      return { blocked: true, reason: "custom_block", matchedRule: exactPageUrl };
    }
    for (const d of parentDomains) {
      if (customBlocksSet.has(d)) {
        return { blocked: true, reason: "custom_block", matchedRule: d };
      }
    }

    // 3. PRECEDENCE: Main Blocklist (checks host and parent domains against the set)
    for (const d of parentDomains) {
      if (mainSet.has(d)) {
        return { blocked: true, reason: "main_blocklist", matchedRule: d };
      }
    }

    // 4. Not blocked
    return { blocked: false, reason: "allowed", matchedRule: null };
  }

  /**
   * Exponential backoff calculation for retry attempts.
   *
   * @param {number} retryCount - current number of consecutive retries
   * @param {number} [baseDelayMs=300000] - 5 minutes
   * @param {number} [maxDelayMs=86400000] - 24 hours
   * @returns {number} delay in milliseconds
   */
  function calculateBackoffDelay(retryCount, baseDelayMs = BASE_BACKOFF_MS, maxDelayMs = MAX_BACKOFF_MS) {
    const exponent = Math.max(0, retryCount);
    const delay = baseDelayMs * Math.pow(2, exponent);
    return Math.min(delay, maxDelayMs);
  }

  // Export module for both browser and Node/CJS environments
  const CoreModule = {
    LIVE_BLOCKLIST_URL,
    BASE_BACKOFF_MS,
    MAX_BACKOFF_MS,
    isValidHostname,
    parseBlocklist,
    validateBlocklistCandidate,
    getParentDomains,
    checkUrlPrecedence,
    calculateBackoffDelay
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CoreModule;
  }
  if (typeof global !== "undefined") {
    global.BlocklistCore = CoreModule;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
