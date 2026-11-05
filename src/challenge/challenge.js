// 3Blocker loosening challenge, shared by the block page and the options page.
// Step 1: type the paragraph out exactly (no pasting). Step 2: give a reason for the unblock log.
// The background checks both again, so this UI is only the way in, not the lock.
(function (global) {
  "use strict";

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Typing only: no paste, drop or autocorrect-style replacement into the paragraph box
  function blockShortcuts(input) {
    const stop = (e) => e.preventDefault();
    input.addEventListener("paste", stop);
    input.addEventListener("drop", stop);
    input.addEventListener("beforeinput", (e) => {
      if (/^insertFrom|^insertReplacementText$/.test(e.inputType || "")) e.preventDefault();
    });
  }

  /**
   * Ask the background for the challenge and show it in `container`.
   * opts: { action: "allow" | "unblock", rule, url?, confirmLabel, onDone(res), onCancel() }
   * @returns {Promise<object>} the GET_CHALLENGE answer; on { success: false } nothing is shown
   */
  async function start(container, opts) {
    const ch = await browser.runtime.sendMessage({ type: "GET_CHALLENGE", action: opts.action, rule: opts.rule, url: opts.url })
      .catch((err) => ({ success: false, error: String(err) }));
    if (!ch || !ch.success) return ch || { success: false, error: "Could not start." };

    const expected = ch.text;
    const root = el("div", "challenge");
    root.dataset.step = "type";

    // Step 1: the paragraph
    const typeStep = el("div", "challenge-step");
    const typeLabel = el("p", "challenge-label", "Step 1 of 2 · Type this out exactly to continue");
    const shown = el("p", "challenge-text");
    shown.setAttribute("aria-label", expected);
    shown.addEventListener("copy", (e) => e.preventDefault());
    const done = el("span", "challenge-done");
    const wrong = el("span", "challenge-wrong");
    const rest = el("span", "challenge-rest");
    shown.append(done, wrong, rest);
    const input = el("textarea", "challenge-input");
    input.rows = 4;
    input.spellcheck = false;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("aria-label", "Type the paragraph");
    blockShortcuts(input);
    const typeStatus = el("p", "challenge-status");
    typeStatus.setAttribute("role", "status");
    const typeActions = el("div", "challenge-actions");
    const next = el("button", "btn btn-primary challenge-next", "Next");
    next.type = "button";
    next.disabled = true;
    const cancel1 = el("button", "btn btn-secondary challenge-cancel", "Cancel");
    cancel1.type = "button";
    typeActions.append(next, cancel1);
    typeStep.append(typeLabel, shown, input, typeStatus, typeActions);

    // Step 2: the reason
    const reasonStep = el("div", "challenge-step");
    reasonStep.hidden = true;
    const reasonLabel = el("p", "challenge-label", "Step 2 of 2 · Why? This goes in your unblock log.");
    const reason = el("textarea", "challenge-input challenge-reason");
    reason.rows = 3;
    reason.maxLength = BlocklistCore.REASON_MAX;
    reason.setAttribute("aria-label", "Reason");
    const reasonStatus = el("p", "challenge-status challenge-error");
    reasonStatus.setAttribute("role", "alert");
    const reasonActions = el("div", "challenge-actions");
    const confirm = el("button", "btn btn-primary challenge-confirm", opts.confirmLabel || "Confirm");
    confirm.type = "button";
    confirm.disabled = true;
    const cancel2 = el("button", "btn btn-secondary challenge-cancel", "Cancel");
    cancel2.type = "button";
    reasonActions.append(confirm, cancel2);
    reasonStep.append(reasonLabel, reason, reasonStatus, reasonActions);

    root.append(typeStep, reasonStep);
    container.replaceChildren(root);

    function renderProgress() {
      const p = BlocklistCore.challengeProgress(input.value, expected);
      done.textContent = expected.slice(0, p.correct);
      wrong.textContent = p.mistake ? expected.slice(p.correct, p.correct + 1) || " " : "";
      rest.textContent = expected.slice(p.correct + (p.mistake ? 1 : 0));
      root.classList.toggle("has-mistake", p.mistake);
      typeStatus.textContent = p.done
        ? "Done."
        : p.mistake
          ? `Mistake at character ${p.correct + 1}. Fix it to go on.`
          : `${p.correct} / ${expected.length} characters`;
      next.disabled = !p.done;
    }

    const cancel = () => {
      container.replaceChildren();
      if (opts.onCancel) opts.onCancel();
    };
    cancel1.addEventListener("click", cancel);
    cancel2.addEventListener("click", cancel);
    input.addEventListener("input", renderProgress);
    next.addEventListener("click", () => {
      typeStep.hidden = true;
      reasonStep.hidden = false;
      root.dataset.step = "reason";
      reason.focus();
    });
    reason.addEventListener("input", () => {
      reasonStatus.textContent = "";
      confirm.disabled = !BlocklistCore.cleanReason(reason.value);
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      const res = await browser.runtime.sendMessage({
        type: opts.action === "allow" ? "ADD_ALLOWLIST" : "REMOVE_CUSTOM_BLOCK",
        rule: ch.rule,
        url: opts.url,
        typed: input.value,
        reason: reason.value
      }).catch((err) => ({ success: false, error: String(err) }));
      if (res && res.success) {
        container.replaceChildren();
        if (opts.onDone) opts.onDone(res);
      } else {
        reasonStatus.textContent = (res && res.error) || "Could not save.";
        confirm.disabled = false;
      }
    });

    renderProgress();
    input.focus();
    return ch;
  }

  global.LoosenChallenge = { start };
})(typeof globalThis !== "undefined" ? globalThis : this);
