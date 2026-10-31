// 3Blocker options page: view and edit the user's custom blocklist and allowlist
document.addEventListener("DOMContentLoaded", () => {
  // One entry per list: the message types it uses and its elements
  const lists = {
    customBlocks: {
      add: "ADD_CUSTOM_BLOCK",
      remove: "REMOVE_CUSTOM_BLOCK",
      prefix: "blocklist"
    },
    allowlist: {
      add: "ADD_ALLOWLIST",
      remove: "REMOVE_ALLOWLIST",
      prefix: "allowlist"
    }
  };

  for (const [key, list] of Object.entries(lists)) {
    const el = (suffix) => document.getElementById(`${list.prefix}-${suffix}`);
    list.key = key; // field name in the GET_USER_RULES response
    list.form = el("form");
    list.input = el("input");
    list.error = el("error");
    list.ul = el("list");
    list.empty = el("empty");
    list.count = el("count");

    list.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      list.error.textContent = "";
      const res = await send({ type: list.add, rule: list.input.value });
      if (res && res.success) {
        list.input.value = "";
        await refresh();
      } else {
        list.error.textContent = res && res.error === "Not a valid rule"
          ? "Enter a domain like example.com, a page, or a pattern with *."
          : (res && res.error) || "Could not save the rule.";
      }
      list.input.focus();
    });
  }

  async function send(message) {
    try {
      return await browser.runtime.sendMessage(message);
    } catch (err) {
      console.warn("3Blocker message failed:", err);
      return null;
    }
  }

  async function refresh() {
    const res = await send({ type: "GET_USER_RULES" });
    if (!res || !res.success) return;
    for (const list of Object.values(lists)) {
      render(list, res[list.key]);
    }
  }

  function render(list, rules) {
    list.count.textContent = String(rules.length);
    list.empty.hidden = rules.length > 0;
    list.ul.replaceChildren(...rules.map((rule) => {
      const li = document.createElement("li");
      li.className = "rule-item";

      const text = document.createElement("span");
      text.className = "rule-text";
      text.textContent = rule;
      text.title = rule;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "remove-btn";
      btn.textContent = "Remove";
      btn.setAttribute("aria-label", `Remove ${rule}`);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await send({ type: list.remove, rule });
        await refresh();
      });

      li.append(text, btn);
      return li;
    }));
  }

  // Main blocklist: size, last update and a manual "Refresh now"
  const mainlist = {
    count: document.getElementById("mainlist-count"),
    status: document.getElementById("mainlist-status"),
    time: document.getElementById("mainlist-time"),
    error: document.getElementById("mainlist-error"),
    button: document.getElementById("mainlist-refresh")
  };

  async function refreshStatus() {
    const status = await send({ type: "GET_STATUS" });
    if (!status || !status.success) return;

    const count = status.domainCount || 0;
    mainlist.count.textContent = count > 0 ? `${count.toLocaleString()} domains` : "Empty";

    if (status.status === "updating") {
      mainlist.status.textContent = "Updating…";
      mainlist.status.className = "sync-status updating";
    } else if (status.status === "error") {
      mainlist.status.textContent = "Last update failed";
      mainlist.status.className = "sync-status error";
    } else {
      mainlist.status.textContent = "Up to date";
      mainlist.status.className = "sync-status";
    }
    mainlist.error.textContent = status.status === "error" && status.lastError ? status.lastError : "";

    mainlist.time.textContent = status.fetchedAt
      ? `Last checked ${new Date(status.fetchedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
      : "Using the bundled list (not updated online yet)";
  }

  // Is the list's GitHub repo still maintained? Asked once per page load (GitHub allows 60 unauthenticated requests an hour).
  const SOURCE_STATES = {
    active: ["Active", ""],
    archived: ["Archived (read-only): the list no longer gets updates", "warn"],
    deleted: ["Deleted: the last downloaded list stays in use", "error"],
    unknown: ["Couldn't check", "muted"]
  };

  async function refreshSourceState() {
    const el = document.getElementById("source-state");
    let httpStatus = 0;
    let body = null;
    try {
      const res = await fetch(BlocklistCore.SOURCE_REPO_API, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
      httpStatus = res.status;
      body = await res.json().catch(() => null);
    } catch (e) {
      // offline: stays unknown
    }
    const state = BlocklistCore.sourceRepoState(httpStatus, body);
    const [text, cls] = SOURCE_STATES[state];
    el.textContent = text;
    el.className = `source-state ${cls}`.trim();
    el.dataset.state = state;
  }

  mainlist.button.addEventListener("click", async () => {
    mainlist.button.disabled = true;
    mainlist.button.textContent = "Updating…";
    mainlist.status.textContent = "Updating…";
    mainlist.status.className = "sync-status updating";
    mainlist.error.textContent = "";

    const res = await send({ type: "REFRESH_BLOCKLIST_NOW" });
    await refreshStatus();
    if (res && !res.success && res.error) {
      mainlist.error.textContent = res.error;
    }

    mainlist.button.disabled = false;
    mainlist.button.textContent = "Refresh now";
  });

  // Stay in sync when rules change elsewhere (popup buttons, block page "Allow this site")
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.user_allowlist || changes.user_custom_blocks)) {
      refresh();
    }
  });

  refresh();
  refreshStatus();
  refreshSourceState();
});
