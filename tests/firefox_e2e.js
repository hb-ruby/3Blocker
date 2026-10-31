/**
 * 3Blocker end-to-end tests in real (headless) Firefox, driven by Puppeteer over WebDriver BiDi.
 *
 *   npm run test:firefox
 *
 * Env:
 *   FIREFOX_BIN     Firefox executable (default: "firefox" on PATH). Needs Firefox >= 140.
 *   SCREENSHOT_DIR  If set, saves popup/block page screenshots there.
 *
 * Every run uses a fresh temporary profile, so no cleanup between runs is needed.
 * Needs network access (it visits real sites; blocked ones are redirected before any request is sent).
 */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXT = path.resolve(__dirname, "..", "src");
const ADDON_ID = "3blocker@hb-ruby";
// Fixed extension UUID so tests know the moz-extension:// origin in advance
const UUID = "a3b10c4e-0000-4000-8000-3b10c4e3b10c";
const BASE = `moz-extension://${UUID}/`;
const BLOCKED = BASE + "blocked/blocked.html";

const results = [];
const check = (ok, name, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
const consoleErrors = [];

// Puppeteer needs an absolute path, so look "firefox" up on PATH unless FIREFOX_BIN is set
function firefoxPath() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, "firefox");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "firefox";
}

async function launch(extraPrefs = {}) {
  browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: firefoxPath(),
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "3blocker-ff-")),
    // Lets WebDriver run scripts in extension pages (to call the message API)
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({ [ADDON_ID]: UUID }),
      ...extraPrefs
    }
  });
  const id = await browser.installExtension(EXT);
  if (id !== ADDON_ID) throw new Error(`Unexpected add-on id ${id}`);
}

// Each step gets a fresh tab: once a tab shows a moz-extension:// page, WebDriver can't navigate it away.
async function newTab(viewport) {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  if (viewport) await page.setViewport(viewport);
  return page;
}

// page.url() misses redirects done by the extension, so ask the document itself
const currentUrl = (page) => page.evaluate(() => location.href).catch(() => "");

// Wait until the tab shows the block page or a fully loaded web page
async function waitForLanding(page, timeoutMs = 20000) {
  const start = Date.now();
  let url = "";
  while (Date.now() - start < timeoutMs) {
    await sleep(100);
    url = await currentUrl(page);
    if (url.startsWith(BASE)) break;
    if (url.startsWith("http") && (await page.evaluate(() => document.readyState).catch(() => "")) === "complete") break;
  }
  return { url, ms: Date.now() - start };
}

// Visit a web URL in a new tab and report where the tab ends up
async function visit(url, viewport) {
  const page = await newTab(viewport);
  page.goto(url, { timeout: 30000 }).catch(() => {}); // the extension's redirect aborts this navigation
  const landed = await waitForLanding(page);
  return { page, ...landed };
}

// WebDriver BiDi refuses to navigate to moz-extension:// URLs directly, so hop from a blank tab
// into the web-accessible block page, then (from inside the extension) to `file`.
async function openExt(file, viewport) {
  const page = await newTab(viewport);
  await page.evaluate((u) => { location.href = u; }, BLOCKED);
  await page.waitForFunction(() => location.protocol === "moz-extension:", { timeout: 10000 });
  if (file !== "blocked/blocked.html") {
    await page.evaluate((u) => { location.href = u; }, BASE + file);
    await page.waitForFunction((f) => location.pathname.endsWith(f), { timeout: 10000 }, file);
  }
  await sleep(500);
  return page;
}

const send = (page, msg) => page.evaluate((m) => browser.runtime.sendMessage(m), msg);

async function screenshot(page, name) {
  if (!process.env.SCREENSHOT_DIR) return;
  await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, name) })
    .catch((e) => console.log(`  (${name} skipped: ${e.message.split("\n")[0]})`));
}

async function waitForBlocklist(ext) {
  let status = null;
  for (let i = 0; i < 60; i++) {
    status = await send(ext, { type: "GET_STATUS" }).catch((e) => ({ err: String(e) }));
    if (status && status.domainCount > 0) break;
    await sleep(1000);
  }
  return status || {};
}

async function testBlocking() {
  console.log("\n--- Blocking (Firefox) ---");
  await launch();

  const ext = await openExt("popup/popup.html", { width: 360, height: 640 });
  const status = await waitForBlocklist(ext);
  check(status.domainCount > 900000, "Background loaded blocklist", `${status.domainCount} domains${status.err ? ", " + status.err : ""}`);

  await screenshot(ext, "popup.png");
  const syncCard = await ext.evaluate(() => !!document.getElementById("btn-refresh-blocklist"));
  check(!syncCard, "Popup no longer shows the main blocklist card");
  const layout = await ext.evaluate(() => ({
    footer: !!document.querySelector(".app-footer, #stat-count"),
    listBtnInHeader: !!document.querySelector(".app-header #btn-open-list")
  }));
  check(!layout.footer && layout.listBtnInHeader, "Popup has no 'Sites Blocked' footer; options button is in the header", JSON.stringify(layout));

  // Main blocklist: domain and subdomain
  let r = await visit("http://pornhub.com/");
  check(r.url.startsWith(BLOCKED) && r.url.includes("reason=main_blocklist"), "Listed domain is redirected to block page", r.url.slice(0, 120));

  r = await visit("https://www.xvideos.com/some/path", { width: 900, height: 760 });
  check(r.url.startsWith(BLOCKED), "Subdomain of listed domain is blocked", r.url.slice(0, 120));
  const details = await r.page.evaluate(() => ({
    reason: document.getElementById("block-reason").textContent,
    match: document.getElementById("match-rule").textContent
  }));
  check(details.reason.length > 0 && details.match.endsWith("xvideos.com"), "Block page shows reason and matched rule", JSON.stringify(details));
  await screenshot(r.page, "blocked.png");
  const mainActions = await r.page.evaluate(() => ({
    allowShown: !document.getElementById("btn-allow-site").hidden,
    note: document.getElementById("allow-note").hidden ? "" : document.getElementById("allow-note").textContent
  }));
  check(!mainActions.allowShown && mainActions.note.length > 0, "Block page offers no 'Allow this site' for main-list blocks", JSON.stringify(mainActions));

  // Unlisted site
  r = await visit("https://example.com/");
  check(r.url.startsWith("https://example.com"), "Unlisted site loads normally", r.url);

  // Custom block, then "Allow this site" from the block page
  await send(ext, { type: "ADD_CUSTOM_BLOCK", rule: "example.com" });
  r = await visit("https://example.com/");
  check(r.url.startsWith(BLOCKED) && r.url.includes("reason=custom_block"), "Custom-blocked site is redirected", r.url.slice(0, 120));

  await r.page.click("#btn-allow-site");
  const allowed = await waitForLanding(r.page);
  check(allowed.url.startsWith("https://example.com"), "Allow this site unblocks and continues to the site", allowed.url);
  const afterAllow = await send(ext, { type: "CHECK_URL", url: "https://example.com/" });
  check(afterAllow.blocked === false && afterAllow.reason === "allowlisted", "Allowlist overrides the custom block", JSON.stringify(afterAllow));

  // The main blocklist can't be allowlisted: adds are refused...
  const refused = await send(ext, { type: "ADD_ALLOWLIST", rule: "https://www.pornhub.com/some/page" });
  check(!refused.success && /main blocklist/.test(refused.error || ""), "Allowlist refuses a page on a main-listed domain", JSON.stringify(refused));
  const refusedSite = await send(ext, { type: "ADD_ALLOWLIST", rule: "pornhub.com" });
  check(!refusedSite.success && !(await send(ext, { type: "GET_USER_RULES" })).allowlist.includes("pornhub.com"),
    "Allowlist refuses a main-listed domain and stores nothing", JSON.stringify(refusedSite));
  // ...and an allowlist rule saved before this change is kept but has no effect
  await ext.evaluate(async () => {
    const { user_allowlist = [] } = await browser.storage.local.get("user_allowlist");
    await browser.storage.local.set({ user_allowlist: [...user_allowlist, "pornhub.com"] });
  });
  await sleep(300);
  const ph = await send(ext, { type: "CHECK_URL", url: "https://pornhub.com/" });
  check(ph.blocked && ph.reason === "main_blocklist", "An old allowlist rule can't override the main blocklist", JSON.stringify(ph));
  r = await visit("https://pornhub.com/");
  check(r.url.startsWith(BLOCKED) && r.url.includes("reason=main_blocklist"), "Main-listed site stays blocked with an old allowlist rule", r.url.slice(0, 120));
  check((await send(ext, { type: "GET_USER_RULES" })).allowlist.includes("pornhub.com"), "Old allowlist rules are left in place");
  await send(ext, { type: "REMOVE_ALLOWLIST", rule: "pornhub.com" });

  // In-page (pushState) navigation to a blocked URL. example.com was allowlisted above,
  // and the allowlist overrides custom block rules, so remove that first.
  await send(ext, { type: "REMOVE_ALLOWLIST", rule: "example.com" });
  await send(ext, { type: "ADD_CUSTOM_BLOCK", rule: "example.com*type=media*" });
  r = await visit("https://example.com/");
  // Run pushState from a real page script, the way a single-page app would
  await r.page.evaluate(() => {
    const el = document.createElement("script");
    el.textContent = 'history.pushState({}, "", "/search?q=x&type=media");';
    document.head.appendChild(el);
  });
  // The page is already loaded, so waitForLanding would return at once; wait for the block page itself
  const spaStart = Date.now();
  let spaUrl = "";
  while (Date.now() - spaStart < 5000 && !spaUrl.startsWith(BLOCKED)) {
    await sleep(50);
    spaUrl = await currentUrl(r.page);
  }
  check(spaUrl.startsWith(BLOCKED), "pushState to a blocked URL redirects to block page", `${Date.now() - spaStart} ms`);

  await testOptionsPage(ext);
  await testPopupBlocking(ext);

  check(consoleErrors.length === 0, "No errors in extension pages", consoleErrors.join(" | ").slice(0, 300));
  await browser.close();
}

// The popup acts on the active tab. Opened as a tab it is the active tab itself, so to point it at
// another tab: make the newest tab whose URL starts with `urlPrefix` active, then reload the popup
// tab (now in the background) and read what it shows.
async function popupFor(popup, urlPrefix) {
  await popup.evaluate(async (prefix) => {
    const tabs = await browser.tabs.query({});
    const target = tabs.filter((t) => t.url.startsWith(prefix)).sort((x, y) => y.id - x.id)[0];
    await browser.tabs.update(target.id, { active: true });
  }, urlPrefix);
  await popup.evaluate(() => location.reload());
  await popup.waitForFunction(() => document.readyState === "complete", { timeout: 10000 });
  await sleep(800); // let the popup's async init (tab query + CHECK_URL) finish
  return popup.evaluate(() => ({
    host: document.getElementById("current-host").textContent,
    badge: document.getElementById("site-block-state").textContent,
    site: document.getElementById("site-rule").textContent,
    page: document.getElementById("page-rule").textContent,
    disabled: document.getElementById("btn-block-site").disabled && document.getElementById("btn-block-page").disabled,
    note: document.getElementById("block-note").hidden ? "" : document.getElementById("block-note").textContent
  }));
}

// Popup: "Block site" (host without www.) and "Block page" (exact address incl. query)
async function testPopupBlocking(ext) {
  const popup = await openExt("popup/popup.html", { width: 360, height: 640 });
  let state = await popup.evaluate(() => ({
    slider: !!document.getElementById("domain-level-slider"),
    disabled: document.getElementById("btn-block-site").disabled && document.getElementById("btn-block-page").disabled,
    note: document.getElementById("block-note").textContent
  }));
  check(!state.slider, "Popup has no block-level slider");
  check(state.disabled && state.note.length > 0, "Popup can't block non-web pages (buttons disabled)", state.note);

  const pageTab = await visit("https://www.example.net/?from=popup");
  state = await popupFor(popup, "https://www.example.net/?from=popup");
  check(state.site === "example.net" && state.page === "www.example.net/?from=popup" && !state.disabled,
    "Popup offers the site without www. and the exact page with its query", JSON.stringify(state));
  await screenshot(popup, "popup.png");

  await popup.evaluate(() => document.getElementById("btn-block-page").click());
  const landed = await waitForLanding(pageTab.page, 10000);
  check(landed.url.startsWith(BLOCKED) && landed.url.includes("match=" + encodeURIComponent("www.example.net/?from=popup")),
    "'Block page' saves the page rule and sends the tab to the block page", landed.url.slice(0, 160));
  let r = await visit("https://www.example.net/?from=elsewhere");
  check(r.url.startsWith("https://www.example.net"), "A page block leaves the same path with another query open", r.url);

  state = await popupFor(popup, "https://www.example.net/?from=elsewhere");
  await popup.evaluate(() => document.getElementById("btn-block-site").click());
  const siteLanded = await waitForLanding(r.page, 10000);
  check(siteLanded.url.startsWith(BLOCKED) && siteLanded.url.includes("match=example.net"),
    "'Block site' saves the host without www. and sends the tab to the block page", siteLanded.url.slice(0, 160));
  r = await visit("https://example.net/");
  check(r.url.startsWith(BLOCKED), "The site rule also blocks the bare domain", r.url.slice(0, 120));

  // On the block page, the popup shows the blocked address and offers nothing
  state = await popupFor(popup, BLOCKED);
  check(state.host === "example.net" && state.badge === "Blocked" && state.disabled && state.site === "—" && state.page === "—",
    "Popup on the block page shows the blocked site and disables both buttons", JSON.stringify(state));

  const rules = await send(ext, { type: "GET_USER_RULES" });
  check(!rules.allowlist.includes("example.net") && rules.customBlocks.includes("example.net"), "Popup only adds block rules");
  await send(ext, { type: "REMOVE_CUSTOM_BLOCK", rule: "example.net" });
  await send(ext, { type: "REMOVE_CUSTOM_BLOCK", rule: "www.example.net/?from=popup" });
}

// Options page: shows the user's lists and edits them through the same message API
async function testOptionsPage(ext) {
  const opts = await openExt("options/options.html", { width: 900, height: 900 });
  const listed = (id) => opts.evaluate((i) => [...document.querySelectorAll(`#${i} .rule-text`)].map((e) => e.textContent), id);

  const blocks = await listed("blocklist-list");
  check(blocks.includes("example.com*type=media*"), "Options page lists existing custom blocks", JSON.stringify(blocks));

  await opts.type("#blocklist-input", "https://Options-Test.example.org/");
  await opts.click("#blocklist-form button");
  await opts.waitForFunction(() => document.querySelector("#blocklist-input").value === "", { timeout: 5000 }).catch(() => {});
  const afterAdd = await listed("blocklist-list");
  check(afterAdd.includes("options-test.example.org/"), "Options page adds a block rule (scheme stripped, lowercased)", JSON.stringify(afterAdd));
  let res = await send(ext, { type: "CHECK_URL", url: "https://options-test.example.org/" });
  check(res.blocked && res.reason === "custom_block", "Rule added on the options page blocks the site", JSON.stringify(res));

  await opts.type("#blocklist-input", "not a rule");
  await opts.click("#blocklist-form button");
  await sleep(300);
  const err = await opts.evaluate(() => document.getElementById("blocklist-error").textContent);
  check(err.length > 0, "Options page rejects an invalid rule", err);

  await opts.type("#allowlist-input", "xvideos.com");
  await opts.click("#allowlist-form button");
  await sleep(300);
  const mainErr = await opts.evaluate(() => document.getElementById("allowlist-error").textContent);
  check(/main blocklist/.test(mainErr) && !(await listed("allowlist-list")).includes("xvideos.com"),
    "Options page explains that main-listed sites can't be allowed", mainErr);
  await opts.evaluate(() => { document.getElementById("allowlist-input").value = ""; });

  await opts.type("#allowlist-input", "allowed.example.org");
  await opts.click("#allowlist-form button");
  await sleep(300);
  check((await listed("allowlist-list")).includes("allowed.example.org"), "Options page adds an allowlist rule");

  // A rule added elsewhere (e.g. from the popup) shows up without reloading
  await send(ext, { type: "ADD_ALLOWLIST", rule: "from-popup.example.org" });
  await sleep(300);
  check((await listed("allowlist-list")).includes("from-popup.example.org"), "Options page updates when rules change elsewhere");
  await screenshot(opts, "options.png");

  await opts.click('#blocklist-list button[aria-label="Remove options-test.example.org/"]');
  await sleep(300);
  check(!(await listed("blocklist-list")).includes("options-test.example.org/"), "Options page removes a block rule");
  res = await send(ext, { type: "CHECK_URL", url: "https://options-test.example.org/" });
  check(!res.blocked, "Removed rule no longer blocks", JSON.stringify(res));

  await opts.click('#allowlist-list button[aria-label="Remove allowed.example.org"]');
  await sleep(300);
  check(!(await listed("allowlist-list")).includes("allowed.example.org"), "Options page removes an allowlist rule");
  await send(ext, { type: "REMOVE_ALLOWLIST", rule: "from-popup.example.org" });

  // Main blocklist card: size, last update, and "Refresh now" (moved here from the popup)
  const count = await opts.evaluate(() => document.getElementById("mainlist-count").textContent);
  check(/^[\d,.\s]+ domains$/.test(count), "Options page shows the main blocklist size", count);
  await opts.click("#mainlist-refresh");
  await opts.waitForFunction(() => document.getElementById("mainlist-refresh").disabled, { timeout: 2000 }).catch(() => {});
  await opts.waitForFunction(() => !document.getElementById("mainlist-refresh").disabled, { timeout: 90000 }).catch(() => {});
  const sync = await opts.evaluate(() => ({
    status: document.getElementById("mainlist-status").textContent,
    time: document.getElementById("mainlist-time").textContent,
    error: document.getElementById("mainlist-error").textContent
  }));
  check(sync.status === "Up to date" && sync.time.startsWith("Last checked") && !sync.error,
    "Options page 'Refresh now' updates the main blocklist", JSON.stringify(sync));
  await opts.close();
}

// Firefox unloads idle MV3 event pages (normally after 30 s). Blocking must still work when a
// navigation wakes the background before its lists are back in memory.
async function testAfterIdleUnload() {
  console.log("\n--- Blocking after the background is unloaded (Firefox) ---");
  await launch({ "extensions.background.idle.timeout": 3000 });

  // First visit also waits for the bundled list to be stored on first run
  let r = { url: "" };
  for (let i = 0; i < 6 && !r.url.startsWith(BLOCKED); i++) {
    r = await visit("http://pornhub.com/");
    await r.page.close().catch(() => {});
  }
  check(r.url.startsWith(BLOCKED), "Blocked once the list is loaded", r.url.slice(0, 80));

  for (const idleMs of [8000, 15000]) {
    await sleep(idleMs);
    r = await visit("http://pornhub.com/");
    await r.page.close().catch(() => {});
    check(r.url.startsWith(BLOCKED) && r.ms < 5000, `Blocked after ${idleMs / 1000}s idle`, `${r.ms} ms`);
  }
  await browser.close();
}

(async () => {
  await testBlocking();
  await testAfterIdleUnload();

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} Firefox checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error("Firefox test run crashed:", e);
  if (browser) await browser.close().catch(() => {});
  process.exit(2);
});
