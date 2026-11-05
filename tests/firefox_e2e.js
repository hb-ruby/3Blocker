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

// Each launch gets a fresh profile (~70 MB); remove them all when the run ends, even after a crash,
// or they fill up /tmp (a small tmpfs on the dev machine).
const profileDirs = [];
process.on("exit", () => {
  for (const dir of profileDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function launch(extraPrefs = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "3blocker-ff-"));
  profileDirs.push(userDataDir);
  browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: firefoxPath(),
    headless: true,
    userDataDir,
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

// Loosening through the message API: get the paragraph, then send it back typed, with a reason
async function loosen(ext, type, rule, reason = "e2e cleanup") {
  const action = type === "ADD_ALLOWLIST" ? "allow" : "unblock";
  const ch = await send(ext, { type: "GET_CHALLENGE", action, rule });
  if (!ch || !ch.success) return ch;
  return send(ext, { type, rule, typed: ch.text, reason });
}

// Fill in an open challenge (block page or options dialog) the way a person would: type, Next, reason, confirm
async function completeChallenge(page, reason) {
  await page.waitForSelector(".challenge .challenge-input", { timeout: 5000 });
  const text = await page.evaluate(() => document.querySelector(".challenge-text").getAttribute("aria-label"));
  await page.type(".challenge-input:not(.challenge-reason)", text);
  await page.click(".challenge-next");
  await page.type(".challenge-reason", reason);
  await page.click(".challenge-confirm");
  return text;
}

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

  // The main list is only ever the bundled copy: no online refresh, alarms or refresh message
  const manifestVersion = await ext.evaluate(() => browser.runtime.getManifest().version);
  check(status.bundledVersion === manifestVersion, "Main blocklist comes from the bundled file", `${status.bundledVersion} vs ${manifestVersion}`);
  const noRefresh = await ext.evaluate(async () => ({
    alarmsApi: typeof browser.alarms,
    refreshMsg: await browser.runtime.sendMessage({ type: "REFRESH_BLOCKLIST_NOW" })
  }));
  check(noRefresh.alarmsApi === "undefined" && noRefresh.refreshMsg && !noRefresh.refreshMsg.success,
    "No refresh alarms or 'refresh now' message", JSON.stringify(noRefresh));

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
  const defaultTitle = await r.page.evaluate(() => ({
    text: document.getElementById("blocked-title").textContent,
    accent: [...document.querySelectorAll("#blocked-title .title-accent")].map((e) => e.textContent)
  }));
  check(defaultTitle.text === "Not here." && defaultTitle.accent.join() === "here.",
    "Block page shows the default 'Not here.' headline", JSON.stringify(defaultTitle));
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

  // Allowing needs the paragraph and a reason, and the message API checks both itself
  let refusedAllow = await send(ext, { type: "ADD_ALLOWLIST", rule: "example.com", reason: "skip it" });
  check(!refusedAllow.success && refusedAllow.challenge === "I am willingly disabling example.com",
    "ADD_ALLOWLIST without the typed paragraph is refused", JSON.stringify(refusedAllow));
  refusedAllow = await send(ext, { type: "ADD_ALLOWLIST", rule: "example.com", typed: "I am willingly disabling example.com", reason: "  " });
  check(!refusedAllow.success && refusedAllow.reasonRequired, "ADD_ALLOWLIST without a reason is refused", JSON.stringify(refusedAllow));
  check((await send(ext, { type: "CHECK_URL", url: "https://example.com/" })).blocked, "Refused allows change nothing");

  await r.page.click("#btn-allow-site");
  await r.page.waitForSelector(".challenge", { timeout: 5000 });
  const ui = await r.page.evaluate(() => {
    const input = document.querySelector(".challenge-input");
    const paste = new ClipboardEvent("paste", { cancelable: true, bubbles: true });
    input.dispatchEvent(paste);
    const drop = new DragEvent("drop", { cancelable: true, bubbles: true });
    input.dispatchEvent(drop);
    return {
      text: document.querySelector(".challenge-text").textContent,
      nextDisabled: document.querySelector(".challenge-next").disabled,
      actionsHidden: document.querySelector(".actions-group").hidden,
      pasteBlocked: paste.defaultPrevented,
      dropBlocked: drop.defaultPrevented,
      unselectable: getComputedStyle(document.querySelector(".challenge-text")).userSelect
    };
  });
  check(ui.text === "I am willingly disabling https://example.com/" && ui.nextDisabled && ui.actionsHidden,
    "Allow this site asks to type 'I am willingly disabling <full URL>'", JSON.stringify(ui));
  check(ui.pasteBlocked && ui.dropBlocked && ui.unselectable === "none", "The paragraph can't be pasted, dropped or selected", JSON.stringify(ui));
  await r.page.type(".challenge-input", "I am wx");
  const mistake = await r.page.evaluate(() => ({
    status: document.querySelector(".challenge-status").textContent,
    wrong: document.querySelector(".challenge-wrong").textContent,
    next: document.querySelector(".challenge-next").disabled
  }));
  check(/Mistake at character 7/.test(mistake.status) && mistake.wrong === "i" && mistake.next,
    "A typo is marked and keeps Next disabled", JSON.stringify(mistake));
  for (let i = 0; i < 2; i++) await r.page.keyboard.press("Backspace");
  await r.page.type(".challenge-input", "willingly disabling https://example.com/");
  check(!(await r.page.evaluate(() => document.querySelector(".challenge-next").disabled)), "Fixing the typo and finishing enables Next");
  await r.page.click(".challenge-next");
  check(await r.page.evaluate(() => document.querySelector(".challenge-confirm").disabled), "Confirm waits for a reason");
  await screenshot(r.page, "blocked-challenge.png");
  await r.page.type(".challenge-reason", "Need it for work");
  await r.page.click(".challenge-confirm");
  const allowed = await waitForLanding(r.page);
  check(allowed.url.startsWith("https://example.com"), "Allow this site unblocks and continues to the site", allowed.url);
  const log = await send(ext, { type: "GET_UNBLOCK_LOG" });
  const last = log.entries[0] || {};
  check(last.action === "allow" && last.rule === "example.com" && last.url === "https://example.com/" && last.reason === "Need it for work" && last.at > 0,
    "The allow and its reason are in the unblock log", JSON.stringify(last));
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
  await loosen(ext, "REMOVE_CUSTOM_BLOCK", "example.net");
  await loosen(ext, "REMOVE_CUSTOM_BLOCK", "www.example.net/?from=popup");
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

  // Allowing opens the challenge dialog; cancelling it saves nothing
  await opts.type("#allowlist-input", "allowed.example.org");
  await opts.click("#allowlist-form button");
  await opts.waitForSelector("#challenge-dialog[open] .challenge", { timeout: 5000 }).catch(() => {});
  const dlg = await opts.evaluate(() => ({
    open: document.getElementById("challenge-dialog").open,
    title: document.getElementById("challenge-title").textContent,
    text: document.querySelector("#challenge-dialog .challenge-text").textContent
  }));
  check(dlg.open && dlg.title === "Allow allowed.example.org" && dlg.text === "I am willingly disabling allowed.example.org",
    "Options page asks for the paragraph before allowing", JSON.stringify(dlg));
  await screenshot(opts, "options-challenge.png");
  await opts.click("#challenge-dialog .challenge-cancel");
  await sleep(300);
  check(!(await opts.evaluate(() => document.getElementById("challenge-dialog").open)) && !(await listed("allowlist-list")).includes("allowed.example.org"),
    "Cancelling the challenge closes it and allows nothing");

  await opts.click("#allowlist-form button");
  await completeChallenge(opts, "testing the allowlist");
  await sleep(300);
  check((await listed("allowlist-list")).includes("allowed.example.org"), "Options page adds an allowlist rule after the challenge");

  // A rule added elsewhere (e.g. from the block page) shows up without reloading
  await loosen(ext, "ADD_ALLOWLIST", "from-popup.example.org");
  await sleep(300);
  check((await listed("allowlist-list")).includes("from-popup.example.org"), "Options page updates when rules change elsewhere");
  await screenshot(opts, "options.png");

  const noChallenge = await send(ext, { type: "REMOVE_CUSTOM_BLOCK", rule: "options-test.example.org/" });
  check(!noChallenge.success && (await listed("blocklist-list")).includes("options-test.example.org/"),
    "REMOVE_CUSTOM_BLOCK without the typed paragraph is refused", JSON.stringify(noChallenge));
  await opts.click('#blocklist-list button[aria-label="Remove options-test.example.org/"]');
  const removeText = await completeChallenge(opts, "done testing");
  await sleep(300);
  check(removeText === "I am willingly disabling options-test.example.org/" && !(await listed("blocklist-list")).includes("options-test.example.org/"),
    "Options page removes a block rule after the challenge", removeText);
  res = await send(ext, { type: "CHECK_URL", url: "https://options-test.example.org/" });
  check(!res.blocked, "Removed rule no longer blocks", JSON.stringify(res));

  await opts.click('#allowlist-list button[aria-label="Remove allowed.example.org"]');
  await sleep(300);
  check(!(await listed("allowlist-list")).includes("allowed.example.org") && !(await opts.evaluate(() => document.getElementById("challenge-dialog").open)),
    "Options page removes an allowlist rule right away (tightening needs no challenge)");

  // Unblock log card lists every loosening, newest first, with its reason
  await opts.click("#log-card summary");
  const logView = await opts.evaluate(() => ({
    count: document.getElementById("log-count").textContent,
    rules: [...document.querySelectorAll("#log-list .log-rule")].map((e) => e.textContent),
    reasons: [...document.querySelectorAll("#log-list .log-reason")].map((e) => e.textContent)
  }));
  check(logView.rules[0] === "options-test.example.org/" && logView.reasons[0] === "done testing" &&
    logView.rules.includes("https://example.com/") && logView.reasons.includes("Need it for work") && Number(logView.count) === logView.rules.length,
    "Options page shows the unblock log, newest first", JSON.stringify(logView));
  await screenshot(opts, "options-log.png");
  await send(ext, { type: "REMOVE_ALLOWLIST", rule: "from-popup.example.org" });

  // Main blocklist card: size and source repo status (the bundled list is never refreshed)
  const count = await opts.evaluate(() => document.getElementById("mainlist-count").textContent);
  check(/^[\d,.\s]+ domains$/.test(count), "Options page shows the main blocklist size", count);
  await opts.waitForFunction(() => document.getElementById("source-state").dataset.state, { timeout: 15000 }).catch(() => {});
  const source = await opts.evaluate(() => ({
    state: document.getElementById("source-state").dataset.state || "",
    text: document.getElementById("source-state").textContent
  }));
  // The real answer changes with upstream, so only check that it resolved to a known state
  check(["active", "archived", "deleted", "unknown"].includes(source.state) && source.text !== "Checking…",
    "Options page shows the source repo status", JSON.stringify(source));
  const card = await opts.evaluate(() => ({
    refreshButton: !!document.getElementById("mainlist-refresh"),
    note: document.getElementById("mainlist-note").textContent
  }));
  check(!card.refreshButton && /bundled/.test(card.note) && /isn't downloaded/.test(card.note),
    "Options page has no 'Refresh now' and says the list is bundled", JSON.stringify(card));
  await testBlockMessage(opts);
  await testChallengeParagraph(ext, opts);
  await opts.close();
}

// Options page "Block page message" dropdown -> custom headline on the block page
async function testBlockMessage(opts) {
  const titleOf = async () => {
    const r = await visit("http://pornhub.com/");
    const t = await r.page.evaluate(() => {
      const el = document.getElementById("blocked-title");
      const accent = el.querySelector(".title-accent");
      return {
        text: el.textContent,
        accent: [...el.querySelectorAll(".title-accent")].map((e) => e.textContent),
        font: getComputedStyle(el).fontFamily,
        plainColor: getComputedStyle(el).color,
        accentColor: accent ? getComputedStyle(accent).color : ""
      };
    });
    return { r, t };
  };
  const before = await titleOf();
  await before.r.page.close().catch(() => {});

  const closed = await opts.evaluate(() => !document.getElementById("message-card").open);
  check(closed, "Block page message section is collapsed by default");
  await opts.click("#message-card summary");
  const opened = await opts.evaluate(() => document.getElementById("message-card").open);
  check(opened, "Clicking the section header reveals the message option");

  await opts.type("#message-input", "Go *outside*, touch *grass*");
  const preview = await opts.evaluate(() => ({
    text: document.getElementById("message-preview").textContent,
    accent: [...document.querySelectorAll("#message-preview .title-accent")].map((e) => e.textContent)
  }));
  check(preview.text === "Go outside, touch grass" && preview.accent.join() === "outside,grass",
    "Options page previews the message with *words* accented", JSON.stringify(preview));
  await opts.click("#message-form button[type=submit]");
  await opts.waitForFunction(() => document.getElementById("message-status").textContent === "Saved.", { timeout: 5000 }).catch(() => {});
  const stored = await opts.evaluate(() => browser.storage.local.get("block_message"));
  check(stored.block_message === "Go *outside*, touch *grass*", "Options page saves the message", JSON.stringify(stored));
  await screenshot(opts, "options-message.png");

  const custom = await titleOf();
  check(custom.t.text === "Go outside, touch grass" && custom.t.accent.join() === "outside,grass",
    "Block page shows the custom message with *words* accented", JSON.stringify(custom.t));
  check(custom.t.font === before.t.font && custom.t.accentColor === before.t.accentColor && custom.t.accentColor !== custom.t.plainColor,
    "Custom message keeps the headline font and the yellow accent", `${custom.t.font} / ${custom.t.accentColor}`);
  await screenshot(custom.r.page, "blocked-custom-message.png");
  await custom.r.page.close().catch(() => {});

  await opts.click("#message-reset");
  await opts.waitForFunction(() => document.getElementById("message-input").value === "", { timeout: 5000 }).catch(() => {});
  const reset = await titleOf();
  check(reset.t.text === "Not here." && reset.t.accent.join() === "here.", "Reset brings back the default headline", JSON.stringify(reset.t));
  await reset.r.page.close().catch(() => {});
}

// Options page "Unblock paragraph": a custom paragraph (longer than the default) replaces it
async function testChallengeParagraph(ext, opts) {
  const closed = await opts.evaluate(() => !document.getElementById("paragraph-card").open);
  check(closed, "Unblock paragraph section is collapsed by default");
  await opts.click("#paragraph-card summary");

  await opts.type("#paragraph-input", "Too short to count");
  await opts.click("#paragraph-form button[type=submit]");
  await sleep(300);
  let state = await opts.evaluate(async () => ({
    status: document.getElementById("paragraph-status").textContent,
    stored: (await browser.storage.local.get("challenge_paragraph")).challenge_paragraph || ""
  }));
  check(/longer than the default/.test(state.status) && !state.stored, "A paragraph not longer than the default is refused", JSON.stringify(state));

  const custom = "I set this block up for a reason, and I am still choosing to open [url] right now.";
  await opts.evaluate(() => { document.getElementById("paragraph-input").value = ""; });
  await opts.type("#paragraph-input", custom);
  await opts.click("#paragraph-form button[type=submit]");
  await opts.waitForFunction(() => document.getElementById("paragraph-status").textContent === "Saved.", { timeout: 5000 }).catch(() => {});
  state = await opts.evaluate(async () => (await browser.storage.local.get("challenge_paragraph")).challenge_paragraph);
  check(state === custom, "Options page saves a custom paragraph", state);
  await screenshot(opts, "options-paragraph.png");

  await send(ext, { type: "ADD_CUSTOM_BLOCK", rule: "paragraph.example.org" });
  const ch = await send(ext, { type: "GET_CHALLENGE", action: "unblock", rule: "paragraph.example.org" });
  check(ch.text === custom.replace("[url]", "paragraph.example.org"), "The custom paragraph is asked for, with [url] filled in", ch.text);
  const old = await send(ext, { type: "REMOVE_CUSTOM_BLOCK", rule: "paragraph.example.org", typed: "I am willingly disabling paragraph.example.org", reason: "x" });
  check(!old.success, "The default paragraph no longer works once a custom one is set", JSON.stringify(old));
  check((await loosen(ext, "REMOVE_CUSTOM_BLOCK", "paragraph.example.org")).success, "The custom paragraph unblocks");

  await opts.click("#paragraph-reset");
  await opts.waitForFunction(() => document.getElementById("paragraph-input").value === "", { timeout: 5000 }).catch(() => {});
  const reset = await opts.evaluate(async () => (await browser.storage.local.get("challenge_paragraph")).challenge_paragraph);
  check(reset === undefined, "Reset goes back to the default paragraph", String(reset));
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
