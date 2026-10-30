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
  const appearance = await ext.evaluate(() => getComputedStyle(document.getElementById("domain-level-slider")).appearance);
  check(appearance === "none", "Popup slider uses custom styling in Firefox", appearance);

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

  await send(ext, { type: "ADD_ALLOWLIST", rule: "pornhub.com" });
  const ph = await send(ext, { type: "CHECK_URL", url: "https://pornhub.com/" });
  check(ph.blocked === false, "Allowlist overrides the main blocklist", JSON.stringify(ph));
  await send(ext, { type: "REMOVE_ALLOWLIST", rule: "pornhub.com" });

  // In-page (pushState) navigation to a blocked URL. example.com was allowlisted above,
  // and the allowlist overrides every block rule, so remove that first.
  await send(ext, { type: "REMOVE_ALLOWLIST", rule: "example.com" });
  await send(ext, { type: "ADD_CUSTOM_BLOCK", rule: "example.com*type=media*" });
  r = await visit("https://example.com/");
  // Run pushState from a real page script, the way a single-page app would
  await r.page.evaluate(() => {
    const el = document.createElement("script");
    el.textContent = 'history.pushState({}, "", "/search?q=x&type=media");';
    document.head.appendChild(el);
  });
  const spa = await waitForLanding(r.page, 5000);
  check(spa.url.startsWith(BLOCKED), "pushState to a blocked URL redirects to block page", `${spa.ms} ms`);

  await testOptionsPage(ext);

  check(consoleErrors.length === 0, "No errors in extension pages", consoleErrors.join(" | ").slice(0, 300));
  await browser.close();
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
