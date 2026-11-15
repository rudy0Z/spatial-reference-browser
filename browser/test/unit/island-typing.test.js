'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { isValidPrefillChar } = require('../../src/main/island-typing');

const ROOT = path.join(__dirname, '../..');

test('exactly one non-whitespace code point is valid', () => {
  assert.equal(isValidPrefillChar('g'), true);
  assert.equal(isValidPrefillChar('/'), true);
  assert.equal(isValidPrefillChar('ą'), true);
  // Counted as one code point, matching the renderer gate.
  assert.equal(isValidPrefillChar('\u{1F600}'), true);
});

test('anything else is rejected', () => {
  assert.equal(isValidPrefillChar(''), false);
  assert.equal(isValidPrefillChar('ab'), false);
  assert.equal(isValidPrefillChar(' '), false);
  assert.equal(isValidPrefillChar('\n'), false);
  assert.equal(isValidPrefillChar('\u00a0'), false); // nbsp
  assert.equal(isValidPrefillChar(null), false);
  assert.equal(isValidPrefillChar(undefined), false);
  assert.equal(isValidPrefillChar(7), false);
  assert.equal(isValidPrefillChar({}), false);
});

// NUL is not whitespace, so trim() alone lets it through and the "printable"
// contract would be a lie. These prove it holds.
test('control and format code points are rejected', () => {
  assert.equal(isValidPrefillChar('\u0000'), false); // NUL
  assert.equal(isValidPrefillChar('\u001b'), false); // ESC
  assert.equal(isValidPrefillChar('\u007f'), false); // DEL
  assert.equal(isValidPrefillChar('\u200b'), false); // zero-width space
  assert.equal(isValidPrefillChar('\ufeff'), false); // BOM
});

// The gate is only worth anything if every path actually goes through it.
test('main funnels all three entry points through the helper', () => {
  const mainSource = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
  assert.match(mainSource, /chromeOn\('chrome:open-island-commands'/);
  assert.match(mainSource, /chromeOn\('chrome:open-island-typing'/);
  // The no-payload channel calls the same helper with a literal '/', so there
  // is never a validated path beside an unvalidated one.
  assert.match(mainSource, /openIslandTyping\('\/'\)/);
  assert.match(mainSource, /isValidPrefillChar/);
});

// contextIsolation + sandbox mean a renderer cannot reach ipcRenderer except
// through these bridges. A channel registered in main with no preload method
// is unreachable and fails silently.
test('both chrome channels have a browserAPI bridge method', () => {
  const preloadSource = fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8');
  assert.match(preloadSource, /openIslandCommands:.*'chrome:open-island-commands'/);
  assert.match(preloadSource, /openIslandTyping:.*'chrome:open-island-typing'/);
});

test('the start page bridge exposes openIsland', () => {
  const tabPreloadSource = fs.readFileSync(path.join(ROOT, 'src/main/tab-preload.js'), 'utf8');
  assert.match(tabPreloadSource, /openIsland:.*'pages:start:open-island'/);
  const pagesSource = fs.readFileSync(path.join(ROOT, 'src/main/pages.js'), 'utf8');
  // Sender-validated to the newtab page, like every other pages:* channel.
  assert.match(pagesSource, /'pages:start:open-island',\s*\n?\s*'newtab'/);
});

// The page handler passes its payload through unchanged, so a non-string
// actually reaches the validator instead of arriving pre-coerced. Coercing
// with String(char ?? '') upstream would turn a numeric 7 into a valid '7'
// and make the typeof check above unreachable on that path.
test('the page handler does not coerce its payload before validating', () => {
  const pagesSource = fs.readFileSync(path.join(ROOT, 'src/main/pages.js'), 'utf8');
  const handler = pagesSource.match(/'pages:start:open-island',[\s\S]*?\n  \);/)?.[0];
  assert.ok(handler, 'pages:start:open-island handler not found');
  assert.doesNotMatch(
    handler,
    /String\(/,
    'pass char through unchanged — coercion defeats the validator type check',
  );
});
