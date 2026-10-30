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

  // Sync Card Elements
  const blocklistCountBadge = document.getElementById("blocklist-count-badge");
  const blocklistSyncStatus = document.getElementById("blocklist-sync-status");
  const blocklistSyncTime = document.getElementById("blocklist-sync-time");
  const btnRefreshBlocklist = document.getElementById("btn-refresh-blocklist");
  const refreshIcon = document.getElementById("refresh-icon");
  const refreshBtnText = document.getElementById("refresh-btn-text");
  const statCountEl = document.getElementById("stat-count");

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

  // Initialize
  initCurrentTab();
  initSlider();
  initOptionsButton();
  initSyncCard();
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
   * Blocklist Sync Status & "Refresh now" button logic
   */
  async function initSyncCard() {
    await updateSyncDisplay();

    if (btnRefreshBlocklist) {
      btnRefreshBlocklist.addEventListener("click", async () => {
        setSyncRefreshingState(true);
        try {
          const browserApi = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
          if (browserApi && browserApi.runtime && browserApi.runtime.sendMessage) {
            const res = await browserApi.runtime.sendMessage({ type: "REFRESH_BLOCKLIST_NOW" });
            if (res && !res.success) {
              blocklistSyncStatus.textContent = res.error ? "Failed" : "Error";
              blocklistSyncStatus.className = "sync-status error";
            }
          }
        } catch (e) {
          console.warn("Refresh request failed:", e);
        } finally {
          await updateSyncDisplay();
          setSyncRefreshingState(false);
        }
      });
    }
  }

  function setSyncRefreshingState(isRefreshing) {
    if (!btnRefreshBlocklist) return;
    btnRefreshBlocklist.disabled = isRefreshing;
    if (isRefreshing) {
      refreshIcon.classList.add("spinning");
      refreshBtnText.textContent = "Updating...";
      blocklistSyncStatus.textContent = "Updating...";
      blocklistSyncStatus.className = "sync-status updating";
    } else {
      refreshIcon.classList.remove("spinning");
      refreshBtnText.textContent = "Refresh now";
    }
  }

  async function updateSyncDisplay() {
    try {
      const browserApi = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
      if (browserApi && browserApi.runtime && browserApi.runtime.sendMessage) {
        const status = await browserApi.runtime.sendMessage({ type: "GET_STATUS" });
        if (status && status.success) {
          const count = status.domainCount || 0;
          blocklistCountBadge.textContent = count > 0 ? `${count.toLocaleString()} domains` : "Empty";

          if (statCountEl) {
            statCountEl.textContent = (status.customBlocksCount || 0).toString();
          }

          if (status.status === "updating") {
            blocklistSyncStatus.textContent = "Updating...";
            blocklistSyncStatus.className = "sync-status updating";
          } else if (status.status === "error") {
            blocklistSyncStatus.textContent = "Update failed";
            blocklistSyncStatus.className = "sync-status error";
            if (status.lastError) {
              blocklistSyncStatus.title = status.lastError;
            }
          } else {
            blocklistSyncStatus.textContent = "Up to date";
            blocklistSyncStatus.className = "sync-status";
          }

          if (status.fetchedAt) {
            const date = new Date(status.fetchedAt);
            blocklistSyncTime.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          } else {
            blocklistSyncTime.textContent = "Bundled fallback";
          }
          return;
        }
      }
    } catch (e) {
      console.log("Could not query background status, using default preview values.");
    }

    // Default preview fallback
    blocklistCountBadge.textContent = "953,393 domains";
    blocklistSyncStatus.textContent = "Up to date";
    blocklistSyncTime.textContent = "Just now";
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
        const img = document.createElement("img");
        img.src = favIconUrl;
        img.alt = "favicon";
        img.style.cssText = "width:18px;height:18px;border-radius:2px;";
        siteFaviconEl.replaceChildren(img);
      } else {
        siteFaviconEl.textContent = "🌐";
      }
    } catch (e) {
      currentHostEl.textContent = "sample-site.com";
      currentPathEl.textContent = "/path";
    }

    checkCurrentUrlStatus(parsedDomain.fullUrl);
    updateSliderPreview(parseInt(sliderEl.value, 10));
  }

  async function checkCurrentUrlStatus(url) {
    try {
      const browserApi = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
      if (browserApi && browserApi.runtime && browserApi.runtime.sendMessage) {
        const res = await browserApi.runtime.sendMessage({ type: "CHECK_URL", url });
        if (res && res.success && res.blocked) {
          isBlocked = true;
          siteBlockStateEl.textContent = res.reason === "custom_block" ? "Custom Blocked" : "Blocked";
          siteBlockStateEl.classList.add("blocked");
          btnBlockLevel.classList.add("blocked-state");
          btnBlockText.textContent = `Unblock Level ${sliderEl.value}`;
          return;
        }
      }
    } catch (e) {
      console.log("Could not query tab status from background.");
    }
    renderBlockStatus();
  }

  function getTargetRuleForLevel(level) {
    if (level === 1) {
      return `${parsedDomain.host}${parsedDomain.path}`;
    } else if (level === 2) {
      return `${parsedDomain.subdomain}`;
    } else {
      return `${parsedDomain.rootDomain}`;
    }
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
    btnBlockLevel.addEventListener("click", async () => {
      const level = parseInt(sliderEl.value, 10);
      const rule = getTargetRuleForLevel(level);
      const browserApi = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);

      isBlocked = !isBlocked;
      renderBlockStatus();

      if (browserApi && browserApi.runtime && browserApi.runtime.sendMessage) {
        try {
          await browserApi.runtime.sendMessage({
            type: isBlocked ? "ADD_CUSTOM_BLOCK" : "REMOVE_CUSTOM_BLOCK",
            rule: rule
          });
          await updateSyncDisplay();
        } catch (err) {
          console.warn("Could not sync block rule with background:", err);
        }
      }
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
    sliderEl.style.background = `linear-gradient(to right, var(--yellow) 0%, var(--yellow) ${percentage}%, var(--track) ${percentage}%, var(--track) 100%)`;
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
});
