# 3Blocker

Bolton Browser Blocker

Yet another website blocker

How to clone and install xpi

## Usage

The main blocklist is pulled from ___ and connot be overriden - always blocks.

Additional webistes can be blocked and sections of those websites carved out with the allowlist.

### How it works

cover as much as possible but keep concise and plain

- Only full page loads over `http`/`https` are checked, not images or scripts inside a page.
- Sites that change their address without reloading the page (common on modern web apps)
  are checked too, and redirected to the block page if needed.
- Pop-ups inside a page that don't change the address can't be blocked.

### Developemnt and license 