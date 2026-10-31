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

  // Main blocklist: size of the bundled list
  async function refreshStatus() {
    const status = await send({ type: "GET_STATUS" });
    if (!status || !status.success) return;
    const count = status.domainCount || 0;
    document.getElementById("mainlist-count").textContent = count > 0 ? `${count.toLocaleString()} domains` : "Empty";
  }

  // Is the list's GitHub repo still maintained? Asked once per page load (GitHub allows 60 unauthenticated requests an hour).
  const SOURCE_STATES = {
    active: ["Active", ""],
    archived: ["Archived (read-only): the list no longer gets updates", "warn"],
    deleted: ["Deleted: the bundled list stays in use", "error"],
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

  // Block page message: saved straight to storage.local, previewed as you type
  const message = {
    form: document.getElementById("message-form"),
    input: document.getElementById("message-input"),
    reset: document.getElementById("message-reset"),
    status: document.getElementById("message-status"),
    preview: document.getElementById("message-preview")
  };
  const MESSAGE_KEY = BlocklistCore.BLOCK_MESSAGE_KEY;

  function renderPreview() {
    message.preview.replaceChildren(...BlocklistCore.parseBlockMessage(message.input.value).map((part) => {
      if (!part.accent) return document.createTextNode(part.text);
      const span = document.createElement("span");
      span.className = "title-accent";
      span.textContent = part.text;
      return span;
    }));
  }

  async function saveMessage(value) {
    const text = value.replace(/\s+/g, " ").trim().slice(0, BlocklistCore.BLOCK_MESSAGE_MAX);
    try {
      if (text) await browser.storage.local.set({ [MESSAGE_KEY]: text });
      else await browser.storage.local.remove(MESSAGE_KEY);
      message.input.value = text;
      message.status.textContent = text ? "Saved." : "Back to the default message.";
    } catch (err) {
      message.status.textContent = "Could not save the message.";
    }
    renderPreview();
  }

  message.input.addEventListener("input", () => {
    message.status.textContent = "";
    renderPreview();
  });
  message.form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveMessage(message.input.value);
  });
  message.reset.addEventListener("click", () => saveMessage(""));

  browser.storage.local.get(MESSAGE_KEY).then((data) => {
    message.input.value = data[MESSAGE_KEY] || "";
    renderPreview();
  }).catch(() => renderPreview());

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
