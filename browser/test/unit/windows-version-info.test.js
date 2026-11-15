const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const pkg = require(path.join(root, 'package.json'));
const { AppInfo } = require('app-builder-lib/out/appInfo');
const { normalizePackageData } = require('app-builder-lib/out/util/normalizePackageData');

// electron-builder writes Blanc.exe's version resource from AppInfo: it sets
// CompanyName only when package.json names an author, and otherwise leaves
// Electron's own "GitHub, Inc.", which Windows then shows as the publisher in
// its firewall prompt. The same company name becomes the uninstall entry's
// Publisher in Settings > Apps and the default copyright line on every
// platform. This reads electron-builder's own getters over our package.json.
function appInfo() {
  const metadata = structuredClone(pkg);
  normalizePackageData(metadata);
  return new AppInfo({ metadata, devMetadata: metadata, config: pkg.build }, null, pkg.build.win);
}

test('Spatial.exe names the fork as its company, not Electron\'s default', () => {
  const info = appInfo();
  assert.equal(info.companyName, 'Spatial');
  assert.equal(info.productName, 'Spatial');
  assert.match(info.copyright, /^Copyright © \d{4} Spatial$/);
});

test('the company name moves no installer folder or Start Menu entry', () => {
  // NSIS derives a Start Menu folder from the company name only when
  // menuCategory is true; the fork's shortcuts and install path stay as
  // shipped. The appId is the fork's own identity (app-identity.js keeps
  // runtime and packaging aligned).
  assert.equal(pkg.build.nsis?.menuCategory, undefined);
  assert.equal(pkg.build.appId, 'app.spatial.desktop');
  assert.equal(pkg.name, 'spatial');
});
