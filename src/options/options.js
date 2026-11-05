// 3Blocker options page: view and edit the user's custom blocklist and allowlist
document.addEventListener("DOMContentLoaded", () => {
  // One entry per list: the message types it uses and its elements
  const lists = {
    // Removing a block loosens it, so it goes through the challenge
    customBlocks: {
      add: "ADD_CUSTOM_BLOCK",
      remove: "REMOVE_CUSTOM_BLOCK",
      removeChallenge: "unblock",
      prefix: "blocklist"
    },
    // Adding to the allowlist loosens it, so it goes through the challenge
    allowlist: {
      add: "ADD_ALLOWLIST",
      addChallenge: "allow",
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
      const res = list.addChallenge
        ? await challenge(list.addChallenge, list.input.value, `Allow ${list.input.value.trim()}`, "Allow")
        : await send({ type: list.add, rule: list.input.value });
      if (res && res.cancelled) return;
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

  // Loosening goes through the typed paragraph and a reason, in a dialog.
  // Resolves with the action's answer, { cancelled: true }, or the error that kept it from starting.
  const dialog = document.getElementById("challenge-dialog");
  const dialogBox = document.getElementById("challenge-box");
  let closeDialog = null;
  dialog.addEventListener("close", () => {
    dialogBox.replaceChildren();
    if (closeDialog) closeDialog({ cancelled: true });
  });

  function challenge(action, rule, title, confirmLabel) {
    return new Promise((resolve) => {
      const finish = (res) => {
        closeDialog = null;
        if (dialog.open) dialog.close();
        resolve(res);
      };
      LoosenChallenge.start(dialogBox, {
        action,
        rule,
        confirmLabel,
        onDone: finish,
        onCancel: () => finish({ cancelled: true })
      }).then((ch) => {
        if (!ch || !ch.success) return resolve(ch || { success: false });
        closeDialog = finish;
        document.getElementById("challenge-title").textContent = title;
        dialog.showModal();
        dialogBox.querySelector(".challenge-input").focus();
      });
    });
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
        if (list.removeChallenge) {
          const res = await challenge(list.removeChallenge, rule, `Remove ${rule}`, "Remove");
          if (res && !res.success && !res.cancelled) list.error.textContent = res.error || "Could not remove the rule.";
        } else {
          await send({ type: list.remove, rule });
        }
        btn.disabled = false;
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

  // Unblock paragraph: the user's own text to type before loosening (longer than the default)
  const paragraph = {
    form: document.getElementById("paragraph-form"),
    input: document.getElementById("paragraph-input"),
    reset: document.getElementById("paragraph-reset"),
    status: document.getElementById("paragraph-status"),
    count: document.getElementById("paragraph-count")
  };
  const PARAGRAPH_KEY = BlocklistCore.CHALLENGE_KEY;
  const PARAGRAPH_MIN = BlocklistCore.DEFAULT_CHALLENGE.length + 1;

  function renderParagraphCount() {
    const n = paragraph.input.value.replace(/\s+/g, " ").trim().length;
    paragraph.count.textContent = n ? `${n} characters (at least ${PARAGRAPH_MIN})` : `Using the default`;
    paragraph.count.classList.toggle("short", n > 0 && n < PARAGRAPH_MIN);
  }

  paragraph.input.addEventListener("input", () => {
    paragraph.status.textContent = "";
    renderParagraphCount();
  });
  paragraph.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const check = BlocklistCore.validateChallengeParagraph(paragraph.input.value);
    if (!check.valid) {
      paragraph.status.textContent = check.error;
      return;
    }
    try {
      await browser.storage.local.set({ [PARAGRAPH_KEY]: check.text });
      paragraph.input.value = check.text;
      paragraph.status.textContent = "Saved.";
    } catch (err) {
      paragraph.status.textContent = "Could not save the paragraph.";
    }
    renderParagraphCount();
  });
  paragraph.reset.addEventListener("click", async () => {
    try {
      await browser.storage.local.remove(PARAGRAPH_KEY);
      paragraph.input.value = "";
      paragraph.status.textContent = "Back to the default paragraph.";
    } catch (err) {
      paragraph.status.textContent = "Could not reset the paragraph.";
    }
    renderParagraphCount();
  });
  browser.storage.local.get(PARAGRAPH_KEY).then((data) => {
    paragraph.input.value = data[PARAGRAPH_KEY] || "";
    renderParagraphCount();
  }).catch(() => renderParagraphCount());

  // Unblock log: newest first
  async function refreshLog() {
    const res = await send({ type: "GET_UNBLOCK_LOG" });
    if (!res || !res.success) return;
    document.getElementById("log-count").textContent = String(res.entries.length);
    document.getElementById("log-empty").hidden = res.entries.length > 0;
    document.getElementById("log-list").replaceChildren(...res.entries.map((entry) => {
      const li = document.createElement("li");
      li.className = "log-item";
      const head = document.createElement("div");
      head.className = "log-head";
      const action = document.createElement("span");
      action.className = "log-action";
      action.textContent = entry.action === "allow" ? "Allowed" : "Removed block";
      const rule = document.createElement("span");
      rule.className = "log-rule";
      rule.textContent = entry.url || entry.rule;
      const when = document.createElement("time");
      when.dateTime = new Date(entry.at).toISOString();
      when.textContent = new Date(entry.at).toLocaleString();
      head.append(action, rule, when);
      const reason = document.createElement("p");
      reason.className = "log-reason";
      reason.textContent = entry.reason;
      li.append(head, reason);
      return li;
    }));
  }

  // Stay in sync when rules change elsewhere (popup buttons, block page "Allow this site")
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.user_allowlist || changes.user_custom_blocks)) {
      refresh();
    }
    if (area === "local" && changes[BlocklistCore.UNBLOCK_LOG_KEY]) refreshLog();
  });

  refresh();
  refreshLog();
  refreshStatus();
  refreshSourceState();
});
