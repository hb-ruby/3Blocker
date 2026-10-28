# 3Blocker

Browser extension (Manifest V3, Firefox-first: `browser.*` API, `gecko` id, `background.scripts`, Firefox ≥ 140) that blocks adult websites from a large domain list and lets the user add their own block/allow rules. **Firefox compatibility comes before anything else.**

## Firefox event-page rules

Firefox runs the MV3 background as an event page and unloads it after ~30 s idle; the in-memory Sets are then gone until the next event wakes it.

- Register every event listener synchronously at the top level of `background.js` (never after an `await`), or Firefox can't wake the page for it.
- Anything that reads the lists or rules awaits `backgroundReady` first (the blocking listener, the alarm handler, `handleMessage`). Writing rules before they're loaded would overwrite the stored ones.
- Blocking uses `webRequest.onBeforeRequest` with `["blocking"]` for `main_frame`: Firefox holds the request while the listener (and a wake-up) runs, so nothing reaches the site. Tested: ~0.65 s to the block page right after a wake, including reloading the list.
- `data_collection_permissions: none` is required by AMO for new extensions (Firefox 140+, Android 142+).

## Architecture

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Background loads `blocklist-core.js` → `db.js` → `background.js` in that order (they share globals). |
| `blocklist-core.js` | Pure logic, no browser APIs. Exposes `BlocklistCore` (global + CommonJS): hostname validation, list parsing, pre-swap validation, parent-domain expansion, URL precedence check, backoff calc. |
| `db.js` | Exposes `BlocklistDB`. IndexedDB `3BlockerDB` (meta store + chunked domain store) with atomic version swap; user rules in `browser.storage.local` (`user_allowlist`, `user_custom_blocks`). Has a mock DB for tests. |
| `background.js` | Holds in-memory Sets, intercepts top-level requests with blocking `webRequest.onBeforeRequest` and redirects blocked ones to `blocked.html?url=&reason=&match=`. Fetches live list (on start only if never fetched live or >1 day old), daily alarm, exponential-backoff retry alarm. Message API (below). |
| `popup.html/js/css` | Toolbar popup: sync status card + "refresh now", current-tab block slider. |
| `blocked.html/js/css` | Block page: shows URL, reason, matched rule; "Go back" and "Allow site" (adds allowlist rule, then redirects). |
| `blocklist.txt` | ~18 MB bundled fallback list, committed to git (required at runtime — listed in `web_accessible_resources`). |
| `tests/test_blocklist.js` | Test suite for core + DB API surface. Written for `gjs` (uses `print`); with Node run `node -e 'globalThis.print=console.log; require("./tests/test_blocklist.js")'` from the repo root. |

## Blocking rules

Precedence (in `checkUrlPrecedence`): **user allowlist > user custom blocks > main blocklist**. Only `http(s)`. Rules match either an exact `host/path?query` string or the host / any parent domain (never a bare TLD).

Blocklist source: `https://blocklistproject.github.io/Lists/alt-version/porn-nl.txt`, fetched with ETag/If-Modified-Since. A download is rejected if empty, <50% of current size, >2% junk lines (and >50 invalid), or looks like HTML. Backoff: 5 min × 2^n, capped at 24 h.

Popup slider levels: 1 = exact page (`host+path`), 2 = this host/subdomain, 3 = apex domain.

## Message API (`browser.runtime.sendMessage`)

`GET_STATUS`, `REFRESH_BLOCKLIST_NOW`, `CHECK_URL {url}`, `ADD_CUSTOM_BLOCK {rule}`, `REMOVE_CUSTOM_BLOCK {rule}`, `ADD_ALLOWLIST {rule}` (also removes the same rule from custom blocks), `REMOVE_ALLOWLIST {rule}`.

## Current state / known gaps

- Scope is deliberately just blocking sites (no time limits or other features); keep it simple.
- The popup's root-domain guess is the last two labels, so e.g. `bbc.co.uk` becomes `co.uk`.
- Popup has an options button but there is no options page in the manifest yet.
- No Chrome support yet (would need `service_worker` background and `chrome.*` / polyfill).
- Neither `gjs` nor `node` is installed on the dev machine; tests have been run with a portable Node downloaded to a temp dir.
- Firefox checks (not in the repo, run from a temp dir): `web-ext lint` (clean), and a Puppeteer + headless Firefox script covering install, list load, main/custom blocking, "Allow site", allowlist precedence, and blocking after the event page is unloaded (pref `extensions.background.idle.timeout`). WebDriver BiDi needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` to script extension pages, can't navigate directly to `moz-extension://` URLs, and `page.url()` misses extension redirects (read `location.href`).

## Changelog

<!-- Newest first. One line per meaningful change. -->
- 2026-10-28 — Firefox fixes: blocking now uses blocking `webRequest` + `backgroundReady` so it survives the event page being unloaded (before, listed sites loaded after ~30 s idle); listeners moved to top level; messages wait for rules to load; daily alarm no longer reset on each wake; live list not refetched on every wake. Added `data_collection_permissions`, min Firefox 140; replaced popup `innerHTML`. `web-ext lint` clean.
- 2026-10-28 — Restyled popup and block page in a minimal graffiti look (grainy black, spray yellow, chalk white; squiggle, torn edge, paint drips). Replaces the short-lived Bauhaus popup style.
- 2026-10-28 — Removed the daily time limit feature entirely (background counting, popup card, block-page reason, storage helpers, tests). 3Blocker is only about blocking sites.
- 2026-10-27 — Made the popup's time limit functional: background counts per-domain daily usage and redirects to the block page when it runs out. Removed the "simulate" demo toggle. Added time-limit tests.
- 2026-10-27 — Removed `.gitignore` so `blocklist.txt` is committed.
- 2026-10-27 — Added CLAUDE.md project notes.
