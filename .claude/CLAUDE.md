# 3Blocker (Bolton Browser Blocker)

Firefox MV3 extension (`browser.*` API, `gecko` id `3blocker@hb-ruby`, `background.scripts`, Firefox ≥ 140) that blocks adult sites from a bundled domain list, plus the user's own block/allow rules. **Firefox compatibility comes first.** Scope is deliberately just blocking sites (time limits were tried and removed); keep it simple. Chrome is out of scope.

## Firefox event-page rules

Firefox unloads the background after ~30 s idle, dropping the in-memory Sets until the next event.

- Register every listener synchronously at the top level of `background.js` (never after an `await`), or Firefox can't wake the page for it.
- Anything reading lists or rules (blocking listener, `handleMessage`) awaits `backgroundReady` first; writing rules before they load would overwrite the stored ones.
- Blocking is `webRequest.onBeforeRequest` with `["blocking"]` on `main_frame`: Firefox holds the request through a wake-up, so nothing reaches the site (~0.65 s to the block page after a wake).
- `data_collection_permissions: none` is required by AMO.
- Private windows: Firefox only supports spanning mode, so one background and one `storage.local` serve both; rules are shared.

## Layout

`src/` is the only packaged folder; paths in `manifest.json` and `runtime.getURL()` are relative to it. Top level holds only README, LICENSE and npm files.

| Path | Role |
|---|---|
| `src/manifest.json` | Background loads `background/blocklist-core.js` → `db.js` → `background.js` (shared globals). |
| `background/blocklist-core.js` | Pure logic, no browser APIs (`BlocklistCore`, global + CommonJS): hostname/list validation and parsing, `normalizeRule`, parent-domain expansion, `checkUrlPrecedence`, `popupRulesForUrl`, `sourceRepoState`, `parseBlockMessage` (`BLOCK_MESSAGE_KEY`, max 80 chars, default `Not *here.*`), challenge helpers (`challengeText`, `challengeMatches`, `challengeProgress`, `validateChallengeParagraph`, `cleanReason`). |
| `background/db.js` | `BlocklistDB`: IndexedDB `3BlockerDB` caches the parsed bundled list (chunked, atomic version swap, tagged `bundledVersion`); user rules in `storage.local` (`user_allowlist`, `user_custom_blocks`), `unblock_log`, reads `challenge_paragraph`. Mock DB for tests. |
| `background/background.js` | In-memory Sets, the blocking listener, redirect to `blocked/blocked.html?url=&reason=&match=`, message API. Loads the list from the IndexedDB cache if `bundledVersion` matches the manifest version, else re-parses the bundled file. |
| `challenge/` | Shared loosening challenge UI (`LoosenChallenge.start`), used by the block page (inline) and options (in a `<dialog>`). Step 1: type the paragraph (paste/drop/replacement blocked, text unselectable, live typo mark, fix-and-continue). Step 2: reason. |
| `popup/` | "Block site" / "Block page" for the current tab, then reloads it onto the block page. Only adds blocks. Header button (next to "Active") opens options. |
| `options/` | Options page in a tab: custom blocklist and allowlist (add/remove, live-updates via `storage.onChanged`); main list card (domain count, "bundled, not updated online", source repo status from the GitHub API once per load); collapsible "Block page message" (closed by default, Save / Reset / live preview, writes `storage.local.block_message` directly; Reset removes the key); collapsible "Unblock paragraph" (same pattern, `challenge_paragraph`, must be longer than the default); collapsible "Unblock log" (newest first, no clear button). Allowlist add and custom-block Remove open the challenge dialog. |
| `blocked/` | Block page: headline from `block_message` or default, `*text*` in the yellow `.title-accent`, same font, smaller over 24 chars, hidden until read (no default flash). Shows URL, reason, matched rule, "Go back"; "Allow this site" for custom blocks only, otherwise a "can't be allowed" note. |
| `lists/blocklist.txt` | ~18 MB main list, committed (web-accessible, needed at runtime). |
| `tests/` | `test_blocklist.js` (unit, runs under Node or `gjs`), `firefox_e2e.js` (real headless Firefox). |
| `dev/web-ext-config.mjs` | `sourceDir: src`, `artifactsDir: dist` (gitignored), `channel: unlisted`. npm scripts pass `--config` since web-ext only auto-finds it in the cwd. |

Style: minimal graffiti look on popup and block page (grainy black, spray yellow, chalk white; squiggle, torn edge, paint drips). Use `textContent`, not `innerHTML`.

LICENSE is MIT (hb-ruby) for the code only. The bundled list is public domain (Block List Project's Unlicense), even though its file header says "MIT".

README is user-facing (install, usage, how it works, development); technical notes belong here.

## Blocking rules

Precedence (`checkUrlPrecedence`, first match wins): **main blocklist > user allowlist > user custom blocks**. Nothing allows a main-listed site; the allowlist only carves exceptions out of custom blocks. `ADD_ALLOWLIST` refuses a rule whose host or a parent is main-listed (`mainBlocklistMatchForRule`; wildcard hosts can't be checked, but precedence still blocks them). Older allowlist rules for main-listed hosts are kept but inert.

Only `http(s)`. User rules match an exact `host/path?query`, the host or any parent domain (never a bare TLD), or, if the rule contains `*`, a wildcard tested against `domain/path?query` for the host and each parent (`reddit.com/register*` covers `old.reddit.com`, not `notreddit.com`). The main list is domains only.

`webNavigation.onHistoryStateUpdated` catches SPA `pushState` URL changes and redirects the tab; in-page modals that don't change the URL can't be caught.

Popup (`popupRulesForUrl`): **Block site** = host minus a leading `www.` (`www.bbc.co.uk` → `bbc.co.uk`; `old.reddit.com` stays, so it blocks only that subdomain). **Block page** = exact `host/path?query` (fragment dropped). Disabled on non-http(s) pages and on the block page. Warns if an allowlist rule still overrides the new block.

Main list source: `blocklistproject.github.io/Lists/alt-version/porn-nl.txt` (repo archived 2026-10-27, unchanged since 2026-07-20; bundled copy SHA-256-identical as of 2026-10-31). **Never fetched** (since v1.0.2: no alarms or `alarms` permission, no refresh message). To update: replace `src/lists/blocklist.txt` and bump the version. Still validated on load (non-empty, ≤2% junk lines, not HTML).

## Loosening challenge

Allowing (`ADD_ALLOWLIST`) and removing a custom block (`REMOVE_CUSTOM_BLOCK`) need `typed` (the paragraph) and `reason`; the background checks both, so the UI isn't the lock. Tightening (add block, remove allow) stays instant. No delay afterwards.

- Default paragraph: `I am willingly disabling <target>`; target = the blocked page's full URL (fragment dropped) when allowing from the block page and the URL really is blocked by that custom rule, else the rule.
- Custom paragraph (`storage.local.challenge_paragraph`, written by options): used only if longer than `DEFAULT_CHALLENGE` ("I am willingly disabling [full website url]", 43 chars) and ≤ 2000; `[url]` is replaced by the target. A too-short stored value falls back to the default.
- Match: exact and case-sensitive, whitespace runs collapsed. Reason: required, ≤ 500 chars.
- Each success appends `{at, action: "allow"|"unblock", rule, url?, reason}` to `storage.local.unblock_log` (capped at 1000).
- Stateless (no challenge ids), so it survives the event page unloading.

## Message API (`runtime.sendMessage`)

`GET_STATUS` (→ `domainCount`, `bundledVersion`, rule counts), `CHECK_URL {url}`, `GET_USER_RULES` (→ sorted `allowlist`, `customBlocks`), `ADD_CUSTOM_BLOCK {rule}` / `ADD_ALLOWLIST {rule, url?, typed, reason}` (each removes the same rule from the other list; the allowlist add refuses main-listed hosts with `{success:false, error, mainBlocklist}` before checking the paragraph), `REMOVE_CUSTOM_BLOCK {rule, typed, reason}`, `REMOVE_ALLOWLIST {rule}`, `GET_CHALLENGE {action: "allow"|"unblock", rule, url?}` (→ `text`, `rule`, `target`, or the same refusals), `GET_UNBLOCK_LOG` (→ `entries`, newest first). A wrong paragraph → `{success:false, error, challenge: <expected>}`; no reason → `{success:false, error, reasonRequired:true}`.

Adds go through `normalizeRule` (lowercase, trim, strip `scheme://` and `#fragment`; reject empty, whitespace, or no `.`/`*`) → `{success:false, error:"Not a valid rule"}` on failure. Removes take the stored string as-is.

## Status and ideas

- Version **1.0.2**, signed. The dev decides when to bump and sign.
- Loosening challenge (typed paragraph + logged reason) is implemented, unreleased. Time delays were considered and left out.
- Idea: accountability partner passcode, only once removal/disable is reported to the partner (otherwise uninstalling is easier than the passcode). Same for a daily cap.
- Idea: removal page. `runtime.setUninstallURL` (top level, no permission) opens a tab after uninstall; it must be http(s), e.g. a static page on GitHub Pages from a `docs/` folder outside `src/`. Use no query params so nothing about the user is sent. Firefox gives no hook before removal or on disable.
- Idea: re-enable notice. `storage.session` is cleared on disable, browser restart and install/update; if its flag is missing at startup and neither `onStartup` nor `onInstalled` fires (wait briefly, they can arrive late), it was a re-enable, so open an extension page saying 3Blocker was off (approximate duration from a saved last-active timestamp). Needs testing in Firefox.
- Idea: notify an accountability partner of removal / re-enable. Needs a sending service (removal can only report via the hosted page) and changes `data_collection_permissions: none`, so it should be opt-in.

## Testing

**Run the suite after every change; extend the test files for new behavior instead of writing throwaway scripts.**

```
npm install          # once
npm test             # unit -> web-ext lint -> Firefox e2e
npm run test:unit | npm run lint | npm run test:firefox
npm start            # launch Firefox with the extension
npm run build        # zip src/ into dist/
npm run sign         # AMO unlisted signing -> signed .xpi in dist/
```

- Dev machine: Node 22 / npm 10 (NodeSource; web-ext needs Node ≥ 20, Ubuntu's apt only has 18), Firefox 158 at `/usr/bin/firefox`. `npm test` needs no env vars.
- E2E needs network. `FIREFOX_BIN` picks the binary (default `firefox` on PATH); `SCREENSHOT_DIR` saves screenshots. Each run uses a fresh ~70 MB temp profile, deleted at the end; leftovers can fill a small `/tmp` tmpfs and crash Firefox (set `TMPDIR` elsewhere).
- Firefox WebDriver can't screenshot extension pages (`SCREENSHOT_DIR` shots are skipped); to see a page, copy it with a stub `browser` object and use `firefox --headless --screenshot` (drive it from `DOMContentLoaded`, timers run too late).
- E2E covers every feature above, no console errors, and blocking after Firefox unloads the idle event page.
- WebDriver BiDi quirks: scripting extension pages needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`; no direct navigation to `moz-extension://` (hop via web-accessible `blocked.html`); a tab showing an extension page can't navigate away (new tab per step); `page.url()` misses extension redirects (read `location.href`).

## Signing / private install

- Add-on ID `3blocker@hb-ruby` is permanent: user rules are tied to it and AMO owns it under the user's account.
- `npm run sign` uses credentials from `.env` (gitignored, dev machine only) via `node --env-file`. **Never read or print `.env`.**
- Each signing needs a new `version` in `src/manifest.json`. Install the `.xpi` via `about:addons` → gear → Install Add-on From File; the same ID keeps the user's rules.
