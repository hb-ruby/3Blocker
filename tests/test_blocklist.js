/**
 * 3Blocker Automated Test Suite
 * Tests parser, validation before swap, parent domain resolution,
 * multi-tier precedence, and atomic storage.
 */

// Load BlocklistCore module
const isGjs = typeof imports !== "undefined" && imports.gi;
if (isGjs) {
  const [okCore, bytesCore] = imports.gi.GLib.file_get_contents("./src/background/blocklist-core.js");
  eval(new TextDecoder().decode(bytesCore));

  const [okDb, bytesDb] = imports.gi.GLib.file_get_contents("./src/background/db.js");
  eval(new TextDecoder().decode(bytesDb));
}

const Core = globalThis.BlocklistCore || require("../src/background/blocklist-core.js");
const DB = globalThis.BlocklistDB || require("../src/background/db.js");

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
  testNoLiveRefresh();
  testAtomicSwap();
  testWildcardRules();
  testNormalizeRule();
  testPopupRules();
  testMainBlocklistMatchForRule();
  testSourceRepoState();

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

  // 3. The allowlist can't override the main blocklist
  const r3 = Core.checkUrlPrecedence("https://allowed.adult-hub.com/home", stores);
  assert(r3.blocked, "allowed.adult-hub.com stays blocked although it is allowlisted");
  assertEqual(r3.reason, "main_blocklist", "Reason is main_blocklist, not allowlisted");

  // 4. Not even an exact-page allowlist rule
  const r4 = Core.checkUrlPrecedence("https://evil.com/safe-portal", stores);
  assert(r4.blocked && r4.reason === "main_blocklist", "evil.com/safe-portal stays blocked by the main blocklist");

  // 4b. Wildcard allowlist rules can't either
  const wild = { ...stores, allowlist: new Set(["*adult*"]) };
  assert(Core.checkUrlPrecedence("https://adult-hub.com/", wild).blocked, "A wildcard allowlist rule can't override the main blocklist");

  // 4c. The allowlist still carves exceptions out of custom blocks
  const carve = { allowlist: new Set(["reddit.com/r/science"]), customBlocks: new Set(["reddit.com"]), mainBlocklistSet: new Set(["nsfw.reddit.com"]) };
  const c1 = Core.checkUrlPrecedence("https://www.reddit.com/r/science", carve);
  assert(c1.blocked && c1.reason === "custom_block", "Page allow rule doesn't match another host (www.)");
  const c2 = Core.checkUrlPrecedence("https://reddit.com/r/science", carve);
  assert(!c2.blocked && c2.reason === "allowlisted", "Allowlist overrides a custom block");
  const carveSite = { ...carve, allowlist: new Set(["reddit.com"]) };
  assert(!Core.checkUrlPrecedence("https://old.reddit.com/", carveSite).blocked, "Allowlisting a site lifts its custom block");
  const c3 = Core.checkUrlPrecedence("https://nsfw.reddit.com/", carveSite);
  assert(c3.blocked && c3.reason === "main_blocklist", "Allowlisting a parent domain doesn't free a main-listed subdomain");

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

function testNoLiveRefresh() {
  print("\n--- 6. No live refresh (bundled list only) ---");
  assert(!("LIVE_BLOCKLIST_URL" in Core), "No live blocklist URL is exported");
  assert(!("calculateBackoffDelay" in Core), "No retry backoff is exported");
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
  print("\n--- 8. Wildcard Rule Tests ---");

  const customBlocks = new Set(["reddit.com/register*", "reddit.com*type=media*", "reddit.com/account/register*"]);
  const stores = { allowlist: new Set(), customBlocks, mainBlocklistSet: new Set() };
  const blocked = (url) => Core.checkUrlPrecedence(url, stores);

  assert(blocked("https://www.reddit.com/register/").blocked, "www.reddit.com/register/ is blocked");
  assert(blocked("https://old.reddit.com/register?dest=https%3A%2F%2Fold.reddit.com%2F").blocked, "old.reddit.com/register?dest=... is blocked");
  assert(blocked("https://reddit.com/account/register/").blocked, "reddit.com/account/register/ is blocked");
  assertEqual(blocked("https://www.reddit.com/register/").reason, "custom_block", "Wildcard rules report custom_block");
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
  assert(!allowed.blocked && allowed.reason === "allowlisted", "Allowlisted wildcard overrides a wildcard block");
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

function testPopupRules() {
  print("\n--- Popup block site / block page rules ---");
  const r = (url) => JSON.stringify(Core.popupRulesForUrl(url));
  const rules = (site, page) => JSON.stringify({ site, page });
  assertEqual(r("https://www.reddit.com/r/foo?sort=new#top"), rules("reddit.com", "www.reddit.com/r/foo?sort=new"),
    "www. is stripped for the site; the page keeps the query and drops the fragment");
  assertEqual(r("https://old.reddit.com/"), rules("old.reddit.com", "old.reddit.com/"), "Other subdomains are kept as is");
  assertEqual(r("https://x.com/home"), rules("x.com", "x.com/home"), "A bare domain stays the same");
  assertEqual(r("https://www.bbc.co.uk/news"), rules("bbc.co.uk", "www.bbc.co.uk/news"), "Multi-part suffixes are never cut down to the suffix");
  assertEqual(r("https://www.YouTube.com/watch?v=AbC"), rules("youtube.com", "www.youtube.com/watch?v=abc"), "Rules are lowercased like typed rules");
  assertEqual(r("http://www.com/"), rules("www.com", "www.com/"), "www. is not stripped if only a TLD would be left");
  assertEqual(r("about:newtab"), "null", "Non-web pages can't be blocked");
  assertEqual(r("moz-extension://abc/popup/popup.html"), "null", "Extension pages can't be blocked");
  assertEqual(r("http://localhost:8080/"), "null", "Hosts without a dot can't be blocked");

  const stores = { allowlist: [], customBlocks: ["reddit.com", "www.youtube.com/watch?v=abc"], mainBlocklistSet: new Set() };
  assert(Core.checkUrlPrecedence("https://old.reddit.com/r/x", stores).blocked, "A site rule blocks the other subdomains");
  assert(Core.checkUrlPrecedence("https://www.youtube.com/watch?v=abc", stores).blocked, "A page rule blocks that page");
  assert(!Core.checkUrlPrecedence("https://www.youtube.com/watch?v=xyz", stores).blocked, "A page rule leaves other queries open");
}

function testMainBlocklistMatchForRule() {
  print("\n--- Allowlist rules that the main blocklist would override ---");
  const main = new Set(["adult-hub.com", "nsfw.reddit.com"]);
  const m = (rule) => Core.mainBlocklistMatchForRule(rule, main);
  assertEqual(m("adult-hub.com"), "adult-hub.com", "A listed domain is refused");
  assertEqual(m("www.adult-hub.com"), "adult-hub.com", "A subdomain of a listed domain is refused");
  assertEqual(m("adult-hub.com/some/page?x=1"), "adult-hub.com", "A page on a listed domain is refused");
  assertEqual(m("adult-hub.com:8080/x"), "adult-hub.com", "A port doesn't hide the host");
  assertEqual(m("nsfw.reddit.com/r/x"), "nsfw.reddit.com", "A listed subdomain is refused");
  assertEqual(m("reddit.com"), null, "A parent of a listed subdomain is allowed (the subdomain stays blocked)");
  assertEqual(m("example.com"), null, "An unlisted domain is allowed");
  assertEqual(m("adult-hub.com*"), null, "A wildcard host can't be checked (precedence still blocks it)");
}

function testSourceRepoState() {
  print("\n--- Main blocklist source repo status ---");
  assertEqual(Core.SOURCE_REPO_API, "https://api.github.com/repos/blocklistproject/Lists", "Checks the repo behind the list URL");
  assertEqual(Core.sourceRepoState(200, { archived: true }), "archived", "Archived repo");
  assertEqual(Core.sourceRepoState(200, { archived: false }), "active", "Active repo");
  assertEqual(Core.sourceRepoState(404, { message: "Not Found" }), "deleted", "Deleted repo (404)");
  assertEqual(Core.sourceRepoState(403, { message: "API rate limit exceeded" }), "unknown", "Rate limited is unknown, not deleted");
  assertEqual(Core.sourceRepoState(0, null), "unknown", "Network failure is unknown");
  assertEqual(Core.sourceRepoState(200, {}), "unknown", "Unexpected answer is unknown");
}

// Execute tests
runTests();
