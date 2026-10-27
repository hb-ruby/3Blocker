// 3Blocker Popup Visuals & Controller
document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const currentHostEl = document.getElementById("current-host");
  const currentPathEl = document.getElementById("current-path");
  const siteFaviconEl = document.getElementById("site-favicon");
  const siteBlockStateEl = document.getElementById("site-block-state");
  
  const sliderEl = document.getElementById("domain-level-slider");
  const levelPillEl = document.getElementById("level-pill");
  const targetHighlightEl = document.getElementById("target-highlight");
  const previewDescEl = document.getElementById("preview-desc");
  const tickMarks = document.querySelectorAll(".tick-mark");
  const btnBlockLevel = document.getElementById("btn-block-level");
  const btnBlockText = document.getElementById("btn-block-text");
  const btnOpenList = document.getElementById("btn-open-list");

  // Timer Elements
  const timerSection = document.getElementById("timer-section");
  const timerBadge = document.getElementById("timer-badge");
  const timerActiveView = document.getElementById("timer-active-view");
  const timerInactiveView = document.getElementById("timer-inactive-view");
  const toggleHasLimit = document.getElementById("toggle-has-limit");
  const timerTimeDisplay = document.getElementById("timer-time-display");
  const timerProgressRing = document.getElementById("timer-progress-ring");
  const timerAllowanceEl = document.getElementById("timer-allowance");
  const timerSpentEl = document.getElementById("timer-spent");
  const btnAddTime = document.getElementById("btn-add-time");
  const btnPauseTimer = document.getElementById("btn-pause-timer");
  const btnSetLimit = document.getElementById("btn-set-limit");

  // State
  let currentUrl = null;
  let parsedDomain = {
    fullUrl: "https://video.reddit.com/r/technology/comments/123",
    protocol: "https://",
    host: "video.reddit.com",
    rootDomain: "reddit.com",
    subdomain: "video.reddit.com",
    path: "/r/technology/comments/123"
  };

  let isBlocked = false;
  let isTimerRunning = true;
  let totalAllowanceSeconds = 30 * 60; // 30 minutes
  let remainingSeconds = 18 * 60 + 42; // 18m 42s
  let timerInterval = null;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 42; // r = 42 => ~263.89

  // Initialize
  initCurrentTab();
  initSlider();
  initTimer();
  initOptionsButton();
  updateSliderTrackBackground();

  function initOptionsButton() {
    if (btnOpenList) {
      btnOpenList.addEventListener("click", () => {
        const browserApi = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
        if (browserApi && browserApi.runtime && browserApi.runtime.openOptionsPage) {
          browserApi.runtime.openOptionsPage();
        } else {
          console.log("Open Options Page requested.");
        }
      });
    }
  }

  /**
   * Detect current active tab in Firefox / WebExtension context,
   * with fallback to a realistic sample tab when testing in a standalone browser tab.
   */
  async function initCurrentTab() {
    try {
      const browserApi = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
      if (browserApi && browserApi.tabs && browserApi.tabs.query) {
        const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs.length > 0 && tabs[0].url) {
          parseTabUrl(tabs[0].url, tabs[0].favIconUrl);
          return;
        }
      }
    } catch (e) {
      console.log("Not in WebExtension context, using fallback demo tab.");
    }

    // Fallback for visual previewing
    parseTabUrl("https://video.reddit.com/r/technology/comments/123");
  }

  function parseTabUrl(rawUrl, favIconUrl) {
    try {
      currentUrl = new URL(rawUrl);
      const hostParts = currentUrl.hostname.split(".");
      
      // Determine apex / root domain (e.g. video.reddit.com -> reddit.com)
      let rootDomain = currentUrl.hostname;
      if (hostParts.length > 2) {
        rootDomain = hostParts.slice(-2).join(".");
      }

      parsedDomain = {
        fullUrl: currentUrl.href,
        protocol: currentUrl.protocol + "//",
        host: currentUrl.hostname,
        rootDomain: rootDomain,
        subdomain: currentUrl.hostname,
        path: currentUrl.pathname + (currentUrl.search || "")
      };

      currentHostEl.textContent = parsedDomain.host;
      currentPathEl.textContent = parsedDomain.path || "/";
      
      if (favIconUrl) {
        siteFaviconEl.innerHTML = `<img src="${favIconUrl}" alt="favicon" style="width:18px;height:18px;border-radius:2px;">`;
      } else {
        siteFaviconEl.textContent = "🌐";
      }
    } catch (e) {
      currentHostEl.textContent = "sample-site.com";
      currentPathEl.textContent = "/path";
    }

    updateSliderPreview(parseInt(sliderEl.value, 10));
  }

  /**
   * Domain Level Slider Logic
   * Level 1: Page / Specific Path
   * Level 2: Subdomain / Specific Host
   * Level 3: Entire Apex Domain & Wildcard
   */
  function initSlider() {
    sliderEl.addEventListener("input", (e) => {
      const level = parseInt(e.target.value, 10);
      updateSliderPreview(level);
      updateSliderTrackBackground();
    });

    // Clicking tick marks sets slider directly
    tickMarks.forEach((mark) => {
      mark.addEventListener("click", () => {
        const step = parseInt(mark.getAttribute("data-step"), 10);
        sliderEl.value = step;
        updateSliderPreview(step);
        updateSliderTrackBackground();
      });
    });

    // Block button interaction
    btnBlockLevel.addEventListener("click", () => {
      isBlocked = !isBlocked;
      renderBlockStatus();
    });
  }

  function updateSliderPreview(level) {
    // Update active tick mark
    tickMarks.forEach((mark) => {
      const step = parseInt(mark.getAttribute("data-step"), 10);
      if (step === level) {
        mark.classList.add("active");
      } else {
        mark.classList.remove("active");
      }
    });

    if (level === 1) {
      levelPillEl.textContent = "Level 1 • Page";
      targetHighlightEl.textContent = `${parsedDomain.host}${parsedDomain.path}`;
      previewDescEl.textContent = "Blocks this exact URL path only. Other pages on this site remain accessible.";
    } else if (level === 2) {
      levelPillEl.textContent = "Level 2 • Subdomain";
      targetHighlightEl.textContent = `${parsedDomain.subdomain}/*`;
      previewDescEl.textContent = "Blocks all pages on this specific subdomain. Other subdomains remain accessible.";
    } else if (level === 3) {
      levelPillEl.textContent = "Level 3 • Root Domain";
      targetHighlightEl.textContent = `*.${parsedDomain.rootDomain}/*`;
      previewDescEl.textContent = "Blocks the entire domain and all associated subdomains completely.";
    }

    if (isBlocked) {
      btnBlockText.textContent = `Unblock Level ${level}`;
    } else {
      btnBlockText.textContent = `Block Level ${level}`;
    }
  }

  function updateSliderTrackBackground() {
    const val = parseInt(sliderEl.value, 10);
    const min = parseInt(sliderEl.min, 10);
    const max = parseInt(sliderEl.max, 10);
    const percentage = ((val - min) / (max - min)) * 100;
    sliderEl.style.background = `linear-gradient(to right, #6366f1 0%, #06b6d4 ${percentage}%, #23293b ${percentage}%, #23293b 100%)`;
  }

  function renderBlockStatus() {
    const level = parseInt(sliderEl.value, 10);
    if (isBlocked) {
      siteBlockStateEl.textContent = "Blocked";
      siteBlockStateEl.classList.add("blocked");
      btnBlockLevel.classList.add("blocked-state");
      btnBlockText.textContent = `Unblock Level ${level}`;
    } else {
      siteBlockStateEl.textContent = "Allowed";
      siteBlockStateEl.classList.remove("blocked");
      btnBlockLevel.classList.remove("blocked-state");
      btnBlockText.textContent = `Block Level ${level}`;
    }
  }

  /**
   * Site Time Limit & Countdown Timer Logic
   */
  function initTimer() {
    updateTimerVisuals();
    startTimer();

    // Toggle switch for demonstrating site with or without active time limit
    toggleHasLimit.addEventListener("change", (e) => {
      const hasLimit = e.target.checked;
      if (hasLimit) {
        timerActiveView.classList.remove("hidden");
        timerInactiveView.classList.add("hidden");
        timerBadge.classList.remove("hidden");
        startTimer();
      } else {
        timerActiveView.classList.add("hidden");
        timerInactiveView.classList.remove("hidden");
        timerBadge.classList.add("hidden");
        stopTimer();
      }
    });

    // Add +5 min
    btnAddTime.addEventListener("click", () => {
      remainingSeconds += 300;
      totalAllowanceSeconds += 300;
      updateTimerVisuals();
    });

    // Pause / Resume
    btnPauseTimer.addEventListener("click", () => {
      isTimerRunning = !isTimerRunning;
      if (isTimerRunning) {
        btnPauseTimer.textContent = "Pause";
        timerBadge.textContent = "Running";
        timerBadge.className = "timer-badge active";
      } else {
        btnPauseTimer.textContent = "Resume";
        timerBadge.textContent = "Paused";
        timerBadge.className = "timer-badge";
        timerBadge.style.background = "rgba(100, 116, 139, 0.2)";
        timerBadge.style.color = "#94a3b8";
        timerBadge.style.borderColor = "#334155";
      }
    });

    // Set Limit button from inactive view
    btnSetLimit.addEventListener("click", () => {
      toggleHasLimit.checked = true;
      toggleHasLimit.dispatchEvent(new Event("change"));
      totalAllowanceSeconds = 20 * 60;
      remainingSeconds = 20 * 60;
      updateTimerVisuals();
    });
  }

  function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!isTimerRunning) return;

      if (remainingSeconds > 0) {
        remainingSeconds--;
        updateTimerVisuals();
      } else {
        // Expired
        remainingSeconds = 0;
        updateTimerVisuals();
        handleTimerExpired();
        clearInterval(timerInterval);
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function formatTime(totalSecs) {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function updateTimerVisuals() {
    timerTimeDisplay.textContent = formatTime(remainingSeconds);

    const spentSeconds = Math.max(0, totalAllowanceSeconds - remainingSeconds);
    timerAllowanceEl.textContent = `${Math.floor(totalAllowanceSeconds / 60)}m 00s`;
    timerSpentEl.textContent = `${Math.floor(spentSeconds / 60)}m ${spentSeconds % 60}s`;

    // Progress ring calculation (offset from 0 to RING_CIRCUMFERENCE)
    // As remaining drops to 0, ring empties or fills
    const fractionRemaining = remainingSeconds / totalAllowanceSeconds;
    const offset = RING_CIRCUMFERENCE * (1 - fractionRemaining);
    timerProgressRing.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
    timerProgressRing.style.strokeDashoffset = `${offset}`;

    // Color alert when low on time
    if (remainingSeconds <= 120 && remainingSeconds > 0) {
      timerProgressRing.style.stroke = "var(--danger-color)";
      timerBadge.textContent = "Low Time";
      timerBadge.className = "timer-badge expired";
    } else if (remainingSeconds === 0) {
      timerProgressRing.style.stroke = "var(--danger-color)";
      timerBadge.textContent = "Expired";
      timerBadge.className = "timer-badge expired";
    } else {
      timerProgressRing.style.stroke = "var(--warning-color)";
      if (isTimerRunning) {
        timerBadge.textContent = "Running";
        timerBadge.className = "timer-badge active";
      }
    }
  }

  function handleTimerExpired() {
    isBlocked = true;
    renderBlockStatus();
    siteBlockStateEl.textContent = "Time Up (Blocked)";
  }
});
