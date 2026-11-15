'use strict';

// SPATIAL FORK — the single brand constant.
//
// "Spatial" is the working title; the final product name is decided later by
// the founder. Renaming the app means changing exactly this constant plus the
// mark assets (see scripts/build-brand-assets.js and assets/), then updating:
//   - package.json `name`, `productName`, and `build.appId` (kept aligned by
//     unit coverage with src/main/app-identity.js);
//   - the message VALUES in src/renderer/pages/strings.*.js (lookup KEYS stay
//     internal, e.g. mini.openInBlanc);
//   - inline prose in the chrome/internal-page HTML documents.
// Internal identifiers (the blanc:// / blanc-chrome:// schemes, the
// blanc-import protocol, the private-session names, the ProgID) are NOT brand
// surfaces and deliberately keep their names.
const BRAND = Object.freeze({
  name: 'Spatial',
  slug: 'spatial',
  appId: 'app.spatial.desktop',
});

module.exports = { BRAND };
