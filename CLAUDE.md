# 3Blocker

Browser extension (Manifest V3, Firefox-first: `browser.*` API, `gecko` id, `background.scripts`) that blocks adult websites from a large domain list and lets the user add their own block/allow rules.

## Architecture

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Background loads `blocklist-core.js` → `db.js` → `background.js` in that order (they share globals). |
| `blocklist-core.js` | Pure logic, no browser APIs. Exposes `BlocklistCore` (global + CommonJS): hostname validation, list parsing, pre-swap validation, parent-domain expansion, URL precedence check, backoff calc. |
| `db.js` | Exposes `BlocklistDB`. IndexedDB `3BlockerDB` (meta store + chunked domain store) with atomic version swap; user rules in `browser.storage.local` (`user_allowlist`, `user_custom_blocks`) and time limits (`time_limits`, `time_limit_session`). Has a mock DB for tests. |
| `background.js` | Holds in-memory Sets, intercepts top-frame `webNavigation.onBeforeNavigate` and redirects blocked tabs to `blocked.html?url=&reason=&match=`. Fetches live list, daily alarm, exponential-backoff retry alarm. Message API (below). |
| `popup.html/js/css` | Toolbar popup: sync status card + "refresh now", current-tab block slider, daily time limit card (display only; polls `GET_TIME_LIMIT` every second, background does the counting). |
| `blocked.html/js/css` | Block page: shows URL, reason, matched rule; "Go back" and "Allow site" (adds allowlist rule, then redirects). |
| `blocklist.txt` | ~18 MB bundled fallback list, committed to git (required at runtime — listed in `web_accessible_resources`). |
| `tests/test_blocklist.js` | Test suite for core + DB API surface. Written for `gjs` (uses `print`); with Node run `node -e 'globalThis.print=console.log; require("./tests/test_blocklist.js")'` from the repo root. |

## Blocking rules

Precedence (in `checkUrlPrecedence`): **user allowlist > user custom blocks > main blocklist**. Only `http(s)`. Rules match either an exact `host/path?query` string or the host / any parent domain (never a bare TLD).

Blocklist source: `https://blocklistproject.github.io/Lists/alt-version/porn-nl.txt`, fetched with ETag/If-Modified-Since. A download is rejected if empty, <50% of current size, >2% junk lines (and >50 invalid), or looks like HTML. Backoff: 5 min × 2^n, capped at 24 h.

Popup slider levels: 1 = exact page (`host+path`), 2 = this host/subdomain, 3 = apex domain.

## Daily time limits

- Set per root domain from the popup (applies to all subdomains). Entry: `{ limitSeconds, usedSeconds, extraSeconds, day, paused }`; usage and "+5 min" extras reset when the local date changes.
- Time counts only while the limited site is the active tab of the focused window. The running session (`{domain, tabId, startedAt}`) is persisted and flushed on tab/window events and a 1-minute `timeLimitTick` alarm; gaps over 2 min (browser closed, machine asleep) aren't counted.
- A `timeLimitExpire` alarm fires when the allowance runs out → every open tab on that domain is redirected to `blocked.html` with reason `time_limit`. `onBeforeNavigate` also blocks new visits.
- Time limits apply even to allowlisted sites; the block page hides "Allow site" for `time_limit`.
- All updates go through `runTimeLimitTask` (a promise queue) so overlapping events can't double-count.

## Message API (`browser.runtime.sendMessage`)

`GET_STATUS`, `REFRESH_BLOCKLIST_NOW`, `CHECK_URL {url}`, `ADD_CUSTOM_BLOCK {rule}`, `REMOVE_CUSTOM_BLOCK {rule}`, `ADD_ALLOWLIST {rule}` (also removes the same rule from custom blocks), `REMOVE_ALLOWLIST {rule}`.

Time limits: `GET_TIME_LIMIT {url}`, `SET_TIME_LIMIT {domain, minutes}`, `REMOVE_TIME_LIMIT {domain}`, `ADD_TIME_LIMIT_EXTRA {domain, minutes}`, `SET_TIME_LIMIT_PAUSED {domain, paused}`.

## Current state / known gaps

- Time limits don't detect user idleness (would need the `idle` permission); a limited tab left focused keeps counting.
- The popup's root-domain guess is the last two labels, so e.g. `bbc.co.uk` becomes `co.uk`.
- Popup has an options button but there is no options page in the manifest yet.
- No Chrome support yet (would need `service_worker` background and `chrome.*` / polyfill).
- Neither `gjs` nor `node` is installed on the dev machine; tests have been run with a portable Node downloaded to a temp dir.

## Changelog

<!-- Newest first. One line per meaningful change. -->
- 2026-10-27 — Made the popup's time limit functional: background counts per-domain daily usage and redirects to the block page when it runs out. Removed the "simulate" demo toggle. Added time-limit tests.
- 2026-10-27 — Removed `.gitignore` so `blocklist.txt` is committed.
- 2026-10-27 — Added CLAUDE.md project notes.
