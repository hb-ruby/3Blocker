# 3Blocker

Browser extension (Manifest V3, Firefox-first: `browser.*` API, `gecko` id, `background.scripts`, Firefox ≥ 140) that blocks adult websites from a large domain list and lets the user add their own block/allow rules. **Firefox compatibility comes before anything else.**

## Firefox event-page rules

Firefox runs the MV3 background as an event page and unloads it after ~30 s idle; the in-memory Sets are then gone until the next event wakes it.

- Register every event listener synchronously at the top level of `background.js` (never after an `await`), or Firefox can't wake the page for it.
- Anything that reads the lists or rules awaits `backgroundReady` first (the blocking listener, the alarm handler, `handleMessage`). Writing rules before they're loaded would overwrite the stored ones.
- Blocking uses `webRequest.onBeforeRequest` with `["blocking"]` for `main_frame`: Firefox holds the request while the listener (and a wake-up) runs, so nothing reaches the site. Tested: ~0.65 s to the block page right after a wake, including reloading the list.
- `data_collection_permissions: none` is required by AMO for new extensions (Firefox 140+, Android 142+).

## Architecture

```
README.md            only file at the top level (plus package.json / lock, required there by npm)
.claude/CLAUDE.md    these notes
src/                 the extension itself — the only folder that gets packaged
  manifest.json
  background/        background.js, db.js, blocklist-core.js
  popup/             popup.html/js/css
  options/           options.html/js/css
  blocked/           blocked.html/js/css
  lists/             blocklist.txt
tests/               unit + Firefox e2e tests
dev/                 web-ext-config.mjs
```

All paths in `manifest.json` and `browser.runtime.getURL()` are relative to `src/`.

| File | Role |
|---|---|
| `src/manifest.json` | MV3 manifest. Background loads `background/blocklist-core.js` → `db.js` → `background.js` in that order (they share globals). |
| `background/blocklist-core.js` | Pure logic, no browser APIs. Exposes `BlocklistCore` (global + CommonJS): hostname validation, list parsing, pre-swap validation, user-rule normalization, parent-domain expansion, URL precedence check, backoff calc. |
| `background/db.js` | Exposes `BlocklistDB`. IndexedDB `3BlockerDB` (meta store + chunked domain store) with atomic version swap; user rules in `browser.storage.local` (`user_allowlist`, `user_custom_blocks`). Has a mock DB for tests. |
| `background/background.js` | Holds in-memory Sets, intercepts top-level requests with blocking `webRequest.onBeforeRequest` and redirects blocked ones to `blocked/blocked.html?url=&reason=&match=`. Fetches live list (on start only if never fetched live or >1 day old), daily alarm, exponential-backoff retry alarm. Message API (below). |
| `popup/` | Toolbar popup: current-tab block slider; list button (header, next to "Active") opens the options page. |
| `options/` | Options page (`options_ui`, opens in a tab): shows the user's custom blocklist and allowlist, add/remove rules, live-updates on `storage.onChanged`. Main blocklist card: domain count, status, last check, "Refresh now" (`REFRESH_BLOCKLIST_NOW`). |
| `blocked/` | Block page: shows URL, reason, matched rule; "Go back" and "Allow site" (adds allowlist rule, then redirects). |
| `lists/blocklist.txt` | ~18 MB bundled fallback list, committed to git (required at runtime — listed in `web_accessible_resources`). |
| `tests/test_blocklist.js` | Unit tests for core + DB API surface (uses `print`, works under `gjs` from the repo root, or Node). |
| `tests/firefox_e2e.js` | End-to-end tests in real headless Firefox (Puppeteer over WebDriver BiDi), installs `src/`. |
| `package.json`, `dev/web-ext-config.mjs` | Dev-only: npm scripts and dev dependencies; web-ext config sets `sourceDir: "src"` and `artifactsDir: "dist"` (gitignored). The npm scripts pass `--config dev/web-ext-config.mjs`, since web-ext only auto-finds it in the current folder. The extension itself has no dependencies. |

## Blocking rules

Precedence (in `checkUrlPrecedence`): **user allowlist > user custom blocks > main blocklist** (first match wins). Only `http(s)`. Allowlist and custom rules match an exact `host/path?query` string, the host / any parent domain (never a bare TLD), or — if the rule contains `*` — a wildcard pattern tested against `domain/path?query` for the host and each parent domain (so `reddit.com/register*` covers `www.`/`old.reddit.com`, but not `notreddit.com`). The main blocklist is domains only.

Besides page requests, `webNavigation.onHistoryStateUpdated` catches single-page-app URL changes (`pushState`, e.g. Reddit switching search tabs) and redirects the tab. In-page modals that don't change the URL can't be caught.

Blocklist source: `https://blocklistproject.github.io/Lists/alt-version/porn-nl.txt`, fetched with ETag/If-Modified-Since. A download is rejected if empty, <50% of current size, >2% junk lines (and >50 invalid), or looks like HTML. Backoff: 5 min × 2^n, capped at 24 h.

Popup slider levels: 1 = exact page (`host+path`), 2 = this host/subdomain, 3 = apex domain.

## Message API (`browser.runtime.sendMessage`)

`GET_STATUS`, `REFRESH_BLOCKLIST_NOW`, `CHECK_URL {url}`, `GET_USER_RULES` (→ sorted `allowlist`, `customBlocks` arrays), `ADD_CUSTOM_BLOCK {rule}` (also removes the same rule from the allowlist), `REMOVE_CUSTOM_BLOCK {rule}`, `ADD_ALLOWLIST {rule}` (also removes the same rule from custom blocks), `REMOVE_ALLOWLIST {rule}`.

Adds run the rule through `BlocklistCore.normalizeRule` (lowercase, trim, strip `scheme://` and `#fragment`; reject empty, whitespace, or no `.`/`*`) and answer `{success:false, error:"Not a valid rule"}` if it fails. Removes take the stored string as-is.

## Current state / known gaps

- Scope is deliberately just blocking sites (no time limits or other features); keep it simple.
- The popup's root-domain guess is the last two labels, so e.g. `bbc.co.uk` becomes `co.uk`.
- No Chrome support yet (would need `service_worker` background and `chrome.*` / polyfill).

## Testing

**Run the saved suite after every change; extend the test files for new behavior instead of writing throwaway scripts.**

```
npm install          # once: dev deps (puppeteer-core, web-ext)
npm test             # unit tests -> web-ext lint -> Firefox e2e
npm run test:unit | npm run lint | npm run test:firefox
npm start            # web-ext run: launch Firefox with the extension loaded
npm run build        # web-ext build: zip src/ into dist/
npm run sign         # AMO unlisted signing -> signed .xpi in dist/
```

## Signing / private install

- Add-on ID `3blocker@hb-ruby` is permanent: storage (user rules) is tied to it, and AMO owns it under the user's account.
- `npm run sign` = `web-ext sign` with `channel: "unlisted"` (in `dev/web-ext-config.mjs`): AMO validates and signs, never lists publicly. Credentials come from `.env` (gitignored; template in `.env.example`) via `node --env-file`. **Never read or print `.env`.**
- Each signing needs a new `version` in `src/manifest.json` (AMO rejects re-signing a version). Install the `.xpi` via `about:addons` → gear → Install Add-on From File; same ID keeps the user's rules.

- `test:firefox` needs Firefox ≥ 140 and network access. `FIREFOX_BIN` picks the binary (default `firefox` on PATH); `SCREENSHOT_DIR` saves popup/block-page screenshots. Each run uses a fresh temp profile.
- E2E covers: list load, popup styling, main-list domain/subdomain blocking, block page details, custom block, options page (list/add/remove/invalid input/live update, main-list count + "Refresh now"), "Allow this site", allowlist precedence, pushState blocking, no console errors, and blocking after Firefox unloads the idle event page.
- WebDriver BiDi quirks the e2e works around: scripting extension pages needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`; it can't navigate directly to `moz-extension://` URLs (hop via the web-accessible `blocked.html`); a tab showing an extension page can't be navigated away (use a new tab per step); `page.url()` misses extension redirects (read `location.href`).
- Dev machine has system Node 20 / npm 9 and Firefox ESR 153 (`/usr/bin/firefox`), installed via apt. `npm test` works with no env vars.

## Changelog

<!-- Newest first. One line per meaningful change. -->
- 2026-10-31 — Removed the popup's "Sites Blocked" footer; the list/options button moved into the header next to the "Active" status. E2E checks the footer is gone and the button is in the header.
- 2026-10-31 — v1.0.1. Moved the main blocklist status card (domain count, status, last check, "Refresh now") from the popup to the options page. Popup keeps the "Sites Blocked" count. E2E checks the popup card is gone and the options-page refresh works. Private windows: Firefox only supports spanning mode, so one background and one `storage.local` serve both; rules are shared (kept as is).
- 2026-10-30 — Add-on ID changed to `3blocker@hb-ruby` (permanent). Added `npm run sign` (AMO unlisted), `.env.example`, `.env` gitignored. v1.0.0 signed and installed privately.
- 2026-10-30 — Removed the bundled `custom-blocklist.txt` and its code (`loadBundledCustomBlocks`, `extraBlocks`, `parseRuleList`): the user's own blocklist covers it, and the allowlist overrode it anyway. Precedence is now three tiers. Wildcard rules still work in user rules. Next: delay on loosening actions (allow / remove block).
- 2026-10-30 — `custom-blocklist.txt` now blocks Reddit completely (`reddit.com`, `redd.it`) instead of only sign-up and media search. Wildcard rule support is unchanged (still unit-tested).
- 2026-10-30 — Restructured: extension in `src/` (per-part folders `background/ popup/ options/ blocked/ lists/`), notes in `.claude/CLAUDE.md`, web-ext config in `dev/` (now just `sourceDir: src`, no ignore list). Added `npm start` / `npm run build`; `dist/` gitignored.
- 2026-10-30 — Added the options page (`options.html/js/css`, `options_ui` in the manifest), opened by the popup's list button: view, add and remove custom block and allowlist rules. New `GET_USER_RULES` message; adds are validated with `normalizeRule`, and adding a custom block now drops the same rule from the allowlist. Unit + e2e tests for it. E2E now finds `firefox` on PATH itself (Puppeteer needs an absolute path).
- 2026-10-28 — Saved the Firefox e2e tests in `tests/firefox_e2e.js` (incl. idle-unload check) and added `package.json` so `npm test` runs unit tests, lint and Firefox e2e. Unit tests now exit non-zero on failure. Added `.gitignore` (node_modules only) and `web-ext-config.mjs`.
- 2026-10-28 — Added wildcard (`*`) rules, bundled `custom-blocklist.txt` (Reddit `/register`, `/account/register`, `reddit.com*type=media*`), and pushState navigation blocking via `webNavigation.onHistoryStateUpdated`. Tests for wildcard matching.
- 2026-10-28 — Firefox fixes: blocking now uses blocking `webRequest` + `backgroundReady` so it survives the event page being unloaded (before, listed sites loaded after ~30 s idle); listeners moved to top level; messages wait for rules to load; daily alarm no longer reset on each wake; live list not refetched on every wake. Added `data_collection_permissions`, min Firefox 140; replaced popup `innerHTML`. `web-ext lint` clean.
- 2026-10-28 — Restyled popup and block page in a minimal graffiti look (grainy black, spray yellow, chalk white; squiggle, torn edge, paint drips). Replaces the short-lived Bauhaus popup style.
- 2026-10-28 — Removed the daily time limit feature entirely (background counting, popup card, block-page reason, storage helpers, tests). 3Blocker is only about blocking sites.
- 2026-10-27 — Made the popup's time limit functional: background counts per-domain daily usage and redirects to the block page when it runs out. Removed the "simulate" demo toggle. Added time-limit tests.
- 2026-10-27 — Removed `.gitignore` so `blocklist.txt` is committed.
- 2026-10-27 — Added CLAUDE.md project notes.
