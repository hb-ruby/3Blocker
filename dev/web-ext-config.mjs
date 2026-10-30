// web-ext settings (lint / run / build). Run with `--config dev/web-ext-config.mjs` (the npm scripts do).
// Only src/ is the extension, so dev files never end up in the package.
export default {
  sourceDir: "src",
  artifactsDir: "dist"
};
