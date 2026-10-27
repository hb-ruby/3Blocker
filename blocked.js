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

  if (targetUrl) {
    targetUrlEl.textContent = targetUrl;
    targetUrlEl.title = targetUrl;
  } else {
    targetUrlEl.textContent = "Unknown website";
  }

  if (reason === "time_limit") {
    blockReasonEl.textContent = "Daily Time Limit Reached";
    document.getElementById("blocked-title").textContent = "Time's Up";
    document.getElementById("blocked-subtitle").textContent =
      "You've used today's time allowance for this site. It resets at midnight.";
    // The allowlist doesn't override time limits, so offering it would do nothing
    btnAllowSite.style.display = "none";
  } else if (reason === "custom_block") {
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

    try {
      const browserApi = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
      if (browserApi && browserApi.runtime && browserApi.runtime.sendMessage) {
        await browserApi.runtime.sendMessage({
          type: "ADD_ALLOWLIST",
          rule: hostToAllow
        });
      }
      // Redirect back to target URL
      window.location.href = targetUrl;
    } catch (err) {
      console.warn("Could not add allowlist rule:", err);
      window.location.href = targetUrl;
    }
  });
});
