// web-ext settings (lint / run / build): leave development files out of the extension.
export default {
  ignoreFiles: [
    "tests",
    "tests/**",
    "package.json",
    "package-lock.json",
    "CLAUDE.md",
    "web-ext-config.mjs"
  ]
};
