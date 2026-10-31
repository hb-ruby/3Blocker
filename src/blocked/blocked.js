document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const targetUrl = params.get("url") || "";
  const reason = params.get("reason") || "main_blocklist";
  const matchedRule = params.get("match") || "";

  const targetUrlEl = document.getElementById("target-url");
  const blockReasonEl = document.getElementById("block-reason");
  const matchRuleEl = document.getElementById("match-rule");
  const matchRowEl = document.getElementById("match-row");
  const btnGoBack = document.getElementById("btn-go-back");
  const btnAllowSite = document.getElementById("btn-allow-site");

  // Headline: the user's own message from the options page, or the default "Not here."
  const titleEl = document.getElementById("blocked-title");
  browser.storage.local.get(BlocklistCore.BLOCK_MESSAGE_KEY)
    .then((data) => renderTitle(data[BlocklistCore.BLOCK_MESSAGE_KEY]))
    .catch(() => renderTitle(""));

  function renderTitle(message) {
    const parts = BlocklistCore.parseBlockMessage(message);
    titleEl.replaceChildren(...parts.map((part) => {
      if (!part.accent) return document.createTextNode(part.text);
      const span = document.createElement("span");
      span.className = "title-accent";
      span.textContent = part.text;
      return span;
    }));
    // Long messages get a smaller size of the same font so they still fit
    const length = parts.reduce((n, part) => n + part.text.length, 0);
    titleEl.classList.toggle("long", length > 24);
    titleEl.classList.remove("pending");
  }

  if (targetUrl) {
    targetUrlEl.textContent = targetUrl;
    targetUrlEl.title = targetUrl;
  } else {
    targetUrlEl.textContent = "Unknown website";
  }

  if (reason === "custom_block") {
    blockReasonEl.textContent = "Custom Blocklist Rule";
  } else if (reason === "main_blocklist") {
    blockReasonEl.textContent = "Adult / Explicit Domain List";
  } else {
    blockReasonEl.textContent = "Restricted Website";
  }

  if (matchedRule) {
    matchRuleEl.textContent = matchedRule;
  } else {
    matchRowEl.style.display = "none";
  }

  const allowNoteEl = document.getElementById("allow-note");
  const showNote = (text) => {
    allowNoteEl.textContent = text;
    allowNoteEl.hidden = !text;
  };

  // The allowlist only carves exceptions out of the user's own blocks; the main blocklist
  // always wins, so offer "Allow this site" for custom blocks only.
  if (reason === "custom_block") {
    btnAllowSite.hidden = false;
  } else if (reason === "main_blocklist") {
    showNote("Sites on the main blocklist can't be allowed.");
  }

  btnGoBack.addEventListener("click", () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = "about:blank";
    }
  });

  btnAllowSite.addEventListener("click", async () => {
    if (!targetUrl) return;

    let hostToAllow = matchedRule;
    if (!hostToAllow) {
      try {
        hostToAllow = new URL(targetUrl).hostname;
      } catch (e) {
        hostToAllow = targetUrl;
      }
    }

    const res = await browser.runtime.sendMessage({ type: "ADD_ALLOWLIST", rule: hostToAllow })
      .catch((err) => ({ success: false, error: String(err) }));
    if (res && res.success) {
      window.location.href = targetUrl;
    } else {
      showNote((res && res.error) || "Could not allow this site.");
    }
  });
});
