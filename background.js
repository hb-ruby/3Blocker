// 3Blocker Background Service Script
console.log("3Blocker background service initialized.");

// Listen for tab updates or declarativeNetRequest rules in future milestones
if (typeof browser !== "undefined" && browser.runtime) {
  browser.runtime.onInstalled.addListener(() => {
    console.log("3Blocker installed successfully.");
  });
}
