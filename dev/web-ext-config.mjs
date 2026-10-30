// web-ext settings (lint / run / build / sign). Run with `--config dev/web-ext-config.mjs` (the npm scripts do).
// Only src/ is the extension, so dev files never end up in the package.
export default {
  sourceDir: "src",
  artifactsDir: "dist",
  // Private, self-distributed signing: AMO signs it but never lists it publicly.
  // API credentials come from WEB_EXT_API_KEY / WEB_EXT_API_SECRET (loaded from .env by `npm run sign`).
  sign: {
    channel: "unlisted"
  }
};
