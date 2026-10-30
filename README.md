3Blocker
Bolton Browser Blocker

## How blocking works

Every time you open a web page, Firefox pauses the request for a moment and asks
3Blocker whether the page is allowed. 3Blocker checks the address against three lists,
always in the same order, and **the first list that matches decides**. If nothing
matches, the page loads as normal. A blocked page never reaches the site: you are sent
straight to 3Blocker's block page instead.

```
            You open a page
                   │
                   ▼
   ┌───────────────────────────────┐
   │ 1. Your allowlist             │── match ──▶  page loads
   └───────────────────────────────┘
                   │ no match
                   ▼
   ┌───────────────────────────────┐
   │ 2. Your blocklist             │── match ──▶  block page
   └───────────────────────────────┘
                   │ no match
                   ▼
   ┌───────────────────────────────┐
   │ 3. Adult site list            │── match ──▶  block page
   │    (~950,000 domains)         │
   └───────────────────────────────┘
                   │ no match
                   ▼
              page loads
```

Because the allowlist is checked first, allowing a site overrides every block, including
the adult site list. Allowing a site never edits the adult site list, so removing it from
the allowlist brings that block back. A rule can't be on both of your own lists at once:
adding it to one removes it from the other.

### The three lists

| List | Where it comes from | Can you change it? |
|---|---|---|
| Your allowlist | "Allow this site" on the block page, or the options page | Yes |
| Your blocklist | The popup's block slider, or the options page | Yes |
| Adult site list | [Block List Project](https://blocklistproject.github.io/Lists/) porn list, refreshed daily; a bundled copy is used until the first download | No |

### How a rule matches

| Rule | Blocks / allows |
|---|---|
| `example.com` | The whole site and all its subdomains (`www.example.com`, `m.example.com`, …) |
| `www.example.com` | That subdomain only (and anything under it) |
| `example.com/page` | That exact page only |
| `example.com/videos*` | Anything that fits the pattern; `*` matches any text |

The adult site list only contains domains, so it always blocks whole sites.

### Good to know

- Only full page loads over `http`/`https` are checked, not images or scripts inside a page.
- Sites that change their address without reloading the page (common on modern web apps)
  are checked too, and redirected to the block page if needed.
- Pop-ups inside a page that don't change the address can't be blocked.
