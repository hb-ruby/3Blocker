# 3Blocker

Bolton Browser Blocker

A simple Firefox extension that blocks adult websites, plus any other sites you add yourself.
It only blocks: there are no timers, schedules or statistics.

To install, clone the repo and build a signed `.xpi` (needs Firefox 140+ and Node 20+):

1. `git clone https://github.com/hb-ruby/3Blocker.git && cd 3Blocker && npm install`
2. Put your [AMO API keys](https://addons.mozilla.org/developers/addon/api/key/) in a `.env` file as
   `WEB_EXT_API_KEY=…` and `WEB_EXT_API_SECRET=…`. If you're not the owner of this add-on, also change
   the add-on ID (`browser_specific_settings.gecko.id`) in `src/manifest.json` to one of your own.
3. Run `npm run sign`. Mozilla signs it privately (it isn't published on addons.mozilla.org)
   and the signed `.xpi` lands in `dist/`.
4. In Firefox, open `about:addons` → gear icon → **Install Add-on From File…** and pick the `.xpi`.

Updating works the same way: raise `version` in `src/manifest.json`, sign again and install over
the old one. Your own rules are kept.

## Usage

The main blocklist is the [Block List Project](https://blocklistproject.github.io/Lists/) porn list
(about 950,000 domains). It's always on and **can't be overridden**: nothing you do in 3Blocker
unblocks a site on it.

On top of that you have two lists of your own:

- **Your blocklist** for any other site or page you want blocked. Click the toolbar button on
  the site and choose **Block site** (the whole site, e.g. `reddit.com` and all its subdomains) or
  **Block page** (just that exact address).
- **Your allowlist** for exceptions to your own blocks, e.g. block `reddit.com` but allow
  `reddit.com/r/science*`. Use **Allow this site** on the block page, or add it on the options page.

Both lists can be viewed and edited on the options page (the list button in the popup).

### How it works

Every time you open a page, Firefox holds the request while 3Blocker checks the address. The first
match decides:

1. **Main blocklist**: blocked.
2. **Your allowlist**: the page loads.
3. **Your blocklist**: blocked.
4. **No match**: the page loads.

A blocked page never reaches the site. You're sent straight to 3Blocker's block page, which shows
the address, the reason and the rule that matched.

Rules on your own lists match like this:

| Rule | Matches |
|---|---|
| `example.com` | The whole site and all its subdomains (`www.example.com`, `m.example.com`, …) |
| `www.example.com` | That subdomain only (and anything under it) |
| `example.com/page?id=1` | That exact address only |
| `example.com/videos*` | Anything that fits the pattern, on any subdomain; `*` matches any text |

The main blocklist only contains domains, so it always blocks whole sites (and their subdomains).
It's refreshed from the Block List Project once a day; the options page shows its size and when it
was last checked, and has a **Refresh now** button. A copy is bundled with the extension, so
blocking works offline and before the first download.

- Only full page loads over `http`/`https` are checked, not images or scripts inside a page.
- Sites that change their address without reloading the page (common on modern web apps)
  are checked too, and redirected to the block page if needed.
- Pop-ups inside a page that don't change the address can't be blocked.

### Development and license

The extension itself is everything in `src/` and has no dependencies; the npm packages are only
for testing and building.

```
npm install          # once
npm start            # open Firefox with the extension loaded (temporary, from src/)
npm test             # unit tests, web-ext lint, then end-to-end tests in headless Firefox
npm run build        # zip src/ into dist/ (unsigned)
npm run sign         # signed .xpi in dist/ (see install above)
```

The end-to-end tests need Firefox 140+ on `PATH` (or set `FIREFOX_BIN`) and network access.

The main blocklist comes from the [Block List Project](https://github.com/blocklistproject/Lists).
3Blocker itself has no license yet, so all rights are reserved.
