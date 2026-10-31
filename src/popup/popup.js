// 3Blocker popup: block the current tab's site or page.
// Only tightens: unblocking is done on the options page or the block page.
document.addEventListener("DOMContentLoaded", () => {
  const api = (typeof browser !== "undefined") ? browser : null;
  const BLOCK_PAGE = api ? api.runtime.getURL("blocked/blocked.html") : null;

  const hostEl = document.getElementById("current-host");
  const pathEl = document.getElementById("current-path");
  const faviconEl = document.getElementById("site-favicon");
  const badgeEl = document.getElementById("site-block-state");
  const siteRuleEl = document.getElementById("site-rule");
  const pageRuleEl = document.getElementById("page-rule");
  const btnSite = document.getElementById("btn-block-site");
  const btnPage = document.getElementById("btn-block-page");
  const noteEl = document.getElementById("block-note");

  let tab = null;     // the tab the popup acts on
  let rules = null;   // { site, page } for that tab, or null if it can't be blocked

  document.getElementById("btn-open-list").addEventListener("click", () => {
    if (api) api.runtime.openOptionsPage();
  });
  btnSite.addEventListener("click", () => block(rules && rules.site));
  btnPage.addEventListener("click", () => block(rules && rules.page));

  init();

  async function init() {
    if (!api) return showUnblockable("Open this from the 3Blocker toolbar button.");
    const [activeTab] = await api.tabs.query({ active: true, currentWindow: true });
    tab = activeTab || null;
    const url = (tab && tab.url) || "";

    // Our own block page: show the page it stands in for
    if (url.startsWith(BLOCK_PAGE)) {
      const original = new URL(url).searchParams.get("url") || "";
      showTab(original);
      setBadge("Blocked", true);
      return disable("This page is already blocked.");
    }

    showTab(url, tab && tab.favIconUrl);
    rules = BlocklistCore.popupRulesForUrl(url);
    if (!rules) return showUnblockable("Only websites (http/https) can be blocked.");

    siteRuleEl.textContent = siteRuleEl.title = rules.site;
    pageRuleEl.textContent = pageRuleEl.title = rules.page;

    const res = await api.runtime.sendMessage({ type: "CHECK_URL", url }).catch(() => null);
    if (res && res.success && res.blocked) {
      setBadge("Blocked", true);
      disable(`Already blocked by ${res.matchedRule}. Reload the tab to see the block page.`);
    } else if (res && res.success && res.reason === "allowlisted") {
      setBadge("Allowlisted", false);
      setNote(`On your allowlist (${res.matchedRule}), which overrides blocks of this site.`);
    }
  }

  function showTab(url, favIconUrl) {
    let u = null;
    try { u = new URL(url); } catch (e) { /* not a URL */ }
    const isWeb = u && (u.protocol === "http:" || u.protocol === "https:");
    hostEl.textContent = isWeb ? u.hostname : (u ? u.protocol.replace(/:$/, "") + " page" : "No page");
    hostEl.title = url;
    pathEl.textContent = isWeb ? (u.pathname + u.search) : "";
    if (favIconUrl && isWeb) {
      const img = document.createElement("img");
      img.src = favIconUrl;
      img.alt = "";
      img.className = "site-favicon-img";
      faviconEl.replaceChildren(img);
    }
  }

  function showUnblockable(message) {
    setBadge("N/A", false);
    disable(message);
  }

  function setBadge(text, blocked) {
    badgeEl.textContent = text;
    badgeEl.classList.toggle("blocked", blocked);
  }

  function setNote(text) {
    noteEl.textContent = text;
    noteEl.hidden = !text;
  }

  function disable(message) {
    btnSite.disabled = true;
    btnPage.disabled = true;
    setNote(message);
  }

  async function block(rule) {
    if (!rule || !tab) return;
    btnSite.disabled = true;
    btnPage.disabled = true;
    const res = await api.runtime.sendMessage({ type: "ADD_CUSTOM_BLOCK", rule }).catch((e) => ({ error: String(e) }));
    if (!res || !res.success) {
      btnSite.disabled = false;
      btnPage.disabled = false;
      return setNote(`Could not save the rule: ${(res && res.error) || "no answer from the background"}.`);
    }

    const check = await api.runtime.sendMessage({ type: "CHECK_URL", url: tab.url }).catch(() => null);
    if (check && check.success && !check.blocked && check.reason === "allowlisted") {
      setBadge("Allowlisted", false);
      return setNote(`Saved ${rule}, but your allowlist rule ${check.matchedRule} still allows this page.`);
    }

    // Reload the tab through the blocking listener so it lands on the block page
    setBadge("Blocked", true);
    setNote(`Blocked ${rule}.`);
    await api.tabs.update(tab.id, { url: tab.url }).catch(() => {});
    if (api.extension.getViews({ type: "popup" }).includes(window)) window.close();
  }
});
