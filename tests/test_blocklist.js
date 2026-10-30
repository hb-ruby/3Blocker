/**
 * 3Blocker Automated Test Suite
 * Tests parser, validation before swap, parent domain resolution,
 * multi-tier precedence, exponential backoff, and atomic storage.
 */

// Load BlocklistCore module
const isGjs = typeof imports !== "undefined" && imports.gi;
if (isGjs) {
  const [okCore, bytesCore] = imports.gi.GLib.file_get_contents("./blocklist-core.js");
  eval(new TextDecoder().decode(bytesCore));

  const [okDb, bytesDb] = imports.gi.GLib.file_get_contents("./db.js");
  eval(new TextDecoder().decode(bytesDb));
}

const Core = globalThis.BlocklistCore || require("../blocklist-core.js");
const DB = globalThis.BlocklistDB || require("../db.js");

let totalTests = 0;
let passedTests = 0;
let failedTests = [];

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    failedTests.push(message);
    print(`  FAIL: ${message}`);
  } else {
    passedTests++;
    print(`  PASS: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected: ${expected}, got: ${actual})`);
}

function runTests() {
  print("\n==========================================");
  print("   3Blocker Unit & Integration Tests      ");
  print("==========================================\n");

  testHostnameValidation();
  testBlocklistParser();
  testValidationBeforeSwap();
  testParentDomainTraversal();
  testPrecedenceRules();
  testExponentialBackoff();
  testAtomicSwap();
  testWildcardRules();
  testNormalizeRule();

  print("\n==========================================");
  print(`Results: ${passedTests}/${totalTests} tests passed.`);
  if (failedTests.length > 0) {
    print(`FAILURES (${failedTests.length}):`);
    failedTests.forEach((f) => print(`  - ${f}`));
    if (typeof process !== "undefined") process.exitCode = 1;
  } else {
    print("ALL TESTS PASSED SUCCESSFULLY!");
  }
  print("==========================================\n");
}

function testHostnameValidation() {
  print("\n--- 1. Hostname Validation Tests ---");

  assert(Core.isValidHostname("example.com"), "Valid simple domain");
  assert(Core.isValidHostname("sub.example.co.uk"), "Valid domain with multiple labels");
  assert(Core.isValidHostname("my-blog.tumblr.com"), "Valid domain with hyphen");
  assert(Core.isValidHostname("sub_domain.jouwpagina.nl"), "Valid domain with underscore label");

  // Invalid cases
  assert(!Core.isValidHostname("localhost"), "Reject localhost");
  assert(!Core.isValidHostname("sub.localhost"), "Reject .localhost");
  assert(!Core.isValidHostname("127.0.0.1"), "Reject IPv4 127.0.0.1");
  assert(!Core.isValidHostname("192.168.1.1"), "Reject private IPv4");
  assert(!Core.isValidHostname("https://example.com"), "Reject full URL with protocol");
  assert(!Core.isValidHostname("example.com/path"), "Reject domain with path");
  assert(!Core.isValidHostname("example.com:8080"), "Reject domain with port");
  assert(!Core.isValidHostname("example..com"), "Reject empty label double dot");
  assert(!Core.isValidHostname("com"), "Reject bare TLD single label");
  assert(!Core.isValidHostname(""), "Reject empty string");
  assert(!Core.isValidHostname(null), "Reject null");
}

function testBlocklistParser() {
  print("\n--- 2. Blocklist Parser Tests ---");

  const rawList = `
# Title: Test Blocklist
# Description: Sample adult list
# Entries: 5

example.com
  TRIM-ME.ORG  
# Comment in between
EXAMPLE.COM
127.0.0.1 bad-hosts-prefix.net
0.0.0.0 zero-prefix.org
sub_domain.test.co

# Some junk lines that should be filtered
localhost
192.168.1.1
invalid..domain
https://not-a-domain.com/path
`;

  const parsed = Core.parseBlocklist(rawList);

  assertEqual(parsed.stats.comments, 5, "Parsed 5 comment lines");
  assert(parsed.domains.includes("example.com"), "Included trimmed lowercased example.com");
  assert(parsed.domains.includes("trim-me.org"), "Included trimmed lowercased trim-me.org");
  assert(parsed.domains.includes("bad-hosts-prefix.net"), "Stripped 127.0.0.1 prefix correctly");
  assert(parsed.domains.includes("zero-prefix.org"), "Stripped 0.0.0.0 prefix correctly");
  assert(parsed.domains.includes("sub_domain.test.co"), "Included valid underscore subdomain");

  // Deduping check
  const exampleCount = parsed.domains.filter((d) => d === "example.com").length;
  assertEqual(exampleCount, 1, "Deduplicated repeated example.com");

  // Rejection check
  assert(!parsed.domains.includes("localhost"), "Excluded localhost");
  assert(!parsed.domains.includes("192.168.1.1"), "Excluded IP address");
}

function testValidationBeforeSwap() {
  print("\n--- 3. Validation Before Swap Tests ---");

  const cachedCount = 100000;

  // 1. Empty download
  const emptyRes = Core.validateBlocklistCandidate({ domains: [], stats: { total: 0, valid: 0, invalid: 0, empty: 0, comments: 0 } }, cachedCount);
  assert(!emptyRes.valid, "Reject empty download candidate");

  // 2. Far smaller than current list (< 50%)
  const smallRes = Core.validateBlocklistCandidate({ domains: new Array(40000).fill("test.com"), stats: { total: 40000, valid: 40000, invalid: 0, empty: 0, comments: 0 } }, cachedCount);
  assert(!smallRes.valid, "Reject download that is < 50% of cached count");

  // 3. Acceptable drop (>= 50%)
  const okRes = Core.validateBlocklistCandidate({ domains: new Array(85000).fill("test.com"), stats: { total: 85000, valid: 85000, invalid: 0, empty: 0, comments: 0 } }, cachedCount);
  assert(okRes.valid, "Accept candidate that is >= 50% of cached count");

  // 4. First run (cachedCount = 0)
  const initialRes = Core.validateBlocklistCandidate({ domains: ["site1.com", "site2.com"], stats: { total: 2, valid: 2, invalid: 0, empty: 0, comments: 0 } }, 0);
  assert(initialRes.valid, "Accept valid initial candidate when cache is empty");

  // 5. HTML error page junk detection
  const htmlJunk = {
    domains: ["site.com"],
    invalidLines: ["<!doctype html>", "<html lang='en'>", "404 not found"],
    stats: { total: 10, valid: 1, invalid: 9, empty: 0, comments: 0 }
  };
  const htmlRes = Core.validateBlocklistCandidate(htmlJunk, 1);
  assert(!htmlRes.valid, "Reject HTML 404 error page as junk");
}

function testParentDomainTraversal() {
  print("\n--- 4. Parent Domain Traversal Tests ---");

  const parents1 = Core.getParentDomains("video.cdn.reddit.com");
  assertEqual(parents1.length, 3, "video.cdn.reddit.com has 3 parent steps");
  assertEqual(parents1[0], "video.cdn.reddit.com", "Level 0: full host");
  assertEqual(parents1[1], "cdn.reddit.com", "Level 1: parent");
  assertEqual(parents1[2], "reddit.com", "Level 2: root domain");
  assert(!parents1.includes("com"), "Does not include bare TLD com");

  const parents2 = Core.getParentDomains("example.com");
  assertEqual(parents2.length, 1, "example.com has 1 step");
  assertEqual(parents2[0], "example.com", "Only returns example.com");
}

function testPrecedenceRules() {
  print("\n--- 5. Multi-Tier Precedence Tests ---");

  const stores = {
    allowlist: new Set([
      "safe.com",
      "allowed.adult-hub.com",
      "evil.com/safe-portal"
    ]),
    customBlocks: new Set([
      "custom-distraction.com",
      "reddit.com/r/all"
    ]),
    mainBlocklistSet: new Set([
      "adult-hub.com",
      "evil.com"
    ])
  };

  // 1. Main Blocklist match
  const r1 = Core.checkUrlPrecedence("https://adult-hub.com/videos", stores);
  assert(r1.blocked, "adult-hub.com is blocked by main blocklist");
  assertEqual(r1.reason, "main_blocklist", "Reason is main_blocklist");

  // 2. Parent domain match in Main Blocklist
  const r2 = Core.checkUrlPrecedence("https://sub.deep.adult-hub.com/watch", stores);
  assert(r2.blocked, "sub.deep.adult-hub.com is blocked by parent adult-hub.com");
  assertEqual(r2.matchedRule, "adult-hub.com", "Matched parent rule");

  // 3. User Allowlist overrides Main Blocklist
  const r3 = Core.checkUrlPrecedence("https://allowed.adult-hub.com/home", stores);
  assert(!r3.blocked, "allowed.adult-hub.com is allowed despite adult-hub.com in blocklist");
  assertEqual(r3.reason, "allowlisted", "Reason is allowlisted");

  // 4. Exact page allowlist overrides domain block
  const r4 = Core.checkUrlPrecedence("https://evil.com/safe-portal", stores);
  assert(!r4.blocked, "evil.com/safe-portal is allowed despite evil.com in main blocklist");

  // 5. Custom Blocklist works for unlisted domain
  const r5 = Core.checkUrlPrecedence("https://custom-distraction.com/feed", stores);
  assert(r5.blocked, "custom-distraction.com is blocked by user custom block");
  assertEqual(r5.reason, "custom_block", "Reason is custom_block");

  // 6. Custom Blocklist for exact path
  const r6 = Core.checkUrlPrecedence("https://reddit.com/r/all", stores);
  assert(r6.blocked, "reddit.com/r/all path is blocked by custom rule");

  const r7 = Core.checkUrlPrecedence("https://reddit.com/r/science", stores);
  assert(!r7.blocked, "reddit.com/r/science is allowed when only /r/all was blocked");

  // 7. General allowed site
  const r8 = Core.checkUrlPrecedence("https://wikipedia.org", stores);
  assert(!r8.blocked, "wikipedia.org is allowed");
  assertEqual(r8.reason, "allowed", "Reason is allowed");
}

function testExponentialBackoff() {
  print("\n--- 6. Exponential Backoff Tests ---");

  const b0 = Core.calculateBackoffDelay(0);
  assertEqual(b0, 5 * 60 * 1000, "Retry 0 is 5 minutes");

  const b1 = Core.calculateBackoffDelay(1);
  assertEqual(b1, 10 * 60 * 1000, "Retry 1 is 10 minutes");

  const b2 = Core.calculateBackoffDelay(2);
  assertEqual(b2, 20 * 60 * 1000, "Retry 2 is 20 minutes");

  const b3 = Core.calculateBackoffDelay(3);
  assertEqual(b3, 40 * 60 * 1000, "Retry 3 is 40 minutes");

  const bMax = Core.calculateBackoffDelay(15);
  assertEqual(bMax, 24 * 60 * 60 * 1000, "Retry 15 is capped at 24 hours max");
}

function testAtomicSwap() {
  print("\n--- 7. Atomic Swap & Metadata Tests ---");

  assert(typeof DB.saveBlocklistAtomic === "function", "DB.saveBlocklistAtomic is defined");
  assert(typeof DB.loadActiveBlocklist === "function", "DB.loadActiveBlocklist is defined");
  assert(typeof DB.getMetadata === "function", "DB.getMetadata is defined");
  assert(typeof DB.setMetadata === "function", "DB.setMetadata is defined");
  assert(typeof DB.CHUNK_SIZE === "number" && DB.CHUNK_SIZE > 0, "DB.CHUNK_SIZE is positive number");
}

function testWildcardRules() {
  print("\n--- 8. Wildcard & Bundled Rule Tests ---");

  const extra = Core.parseRuleList(
    "# comment line\n\nreddit.com/register*   # sign-up\nReddit.com*type=media*\r\nreddit.com/account/register*\n"
  );
  assertEqual(extra.size, 3, "parseRuleList skips comments/blank lines and keeps 3 rules");
  assert(extra.has("reddit.com*type=media*"), "parseRuleList lowercases rules and strips CR");

  const stores = { allowlist: new Set(), customBlocks: new Set(), extraBlocks: extra, mainBlocklistSet: new Set() };
  const blocked = (url) => Core.checkUrlPrecedence(url, stores);

  assert(blocked("https://www.reddit.com/register/").blocked, "www.reddit.com/register/ is blocked");
  assert(blocked("https://old.reddit.com/register?dest=https%3A%2F%2Fold.reddit.com%2F").blocked, "old.reddit.com/register?dest=... is blocked");
  assert(blocked("https://reddit.com/account/register/").blocked, "reddit.com/account/register/ is blocked");
  assertEqual(blocked("https://www.reddit.com/register/").reason, "custom_block", "Bundled rules report custom_block");
  assertEqual(blocked("https://www.reddit.com/register/").matchedRule, "reddit.com/register*", "Matched rule is the wildcard rule");

  assert(blocked("https://www.reddit.com/search/?q=cats&type=media").blocked, "Reddit media search is blocked");
  assert(blocked("https://www.reddit.com/r/pics/search/?q=x&type=media&sort=new").blocked, "Subreddit media search is blocked");
  assert(blocked("https://www.reddit.com/search/?q=cats&TYPE=MEDIA").blocked, "Matching is case-insensitive");

  assert(!blocked("https://www.reddit.com/").blocked, "Reddit front page is allowed");
  assert(!blocked("https://www.reddit.com/r/technology/").blocked, "Subreddits are allowed");
  assert(!blocked("https://www.reddit.com/search/?q=cats&type=link").blocked, "Post search is allowed");
  assert(!blocked("https://www.reddit.com/login/").blocked, "Login page is allowed");
  assert(!blocked("https://notreddit.com/register").blocked, "Wildcard does not match a different domain ending in reddit.com");
  assert(!blocked("https://example.com/?u=reddit.com&type=media").blocked, "Wildcard must start at a domain boundary");

  const dots = Core.checkUrlPrecedence("https://exampleXcom/", { customBlocks: new Set(["example.com*"]) });
  assert(!dots.blocked, "Dots in wildcard rules are literal");

  // User allowlist still wins, and can hold wildcard rules too
  stores.allowlist = new Set(["reddit.com*type=media*"]);
  const allowed = blocked("https://www.reddit.com/search/?q=cats&type=media");
  assert(!allowed.blocked && allowed.reason === "allowlisted", "Allowlisted wildcard overrides bundled block");
}

function testNormalizeRule() {
  print("\n--- User rule normalization ---");
  assertEqual(Core.normalizeRule("  Example.COM "), "example.com", "Trims and lowercases");
  assertEqual(Core.normalizeRule("https://www.example.com/path?q=1#top"), "www.example.com/path?q=1", "Drops scheme and fragment");
  assertEqual(Core.normalizeRule("http://example.com/"), "example.com/", "Keeps the path, so a page rule stays a page rule");
  assertEqual(Core.normalizeRule("Reddit.com/register*"), "reddit.com/register*", "Keeps wildcard rules");
  assertEqual(Core.normalizeRule(""), null, "Rejects empty input");
  assertEqual(Core.normalizeRule("   "), null, "Rejects whitespace-only input");
  assertEqual(Core.normalizeRule("exa mple.com"), null, "Rejects rules containing spaces");
  assertEqual(Core.normalizeRule("com"), null, "Rejects a bare word that can never match");
  assertEqual(Core.normalizeRule(null), null, "Rejects non-strings");
}

// Execute tests
runTests();
