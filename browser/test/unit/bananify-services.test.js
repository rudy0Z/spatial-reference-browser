'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const {
  OFFICIAL_APP_NAME,
  isBananifyServiceUrl,
  bananifyServiceAllowed,
} = require('../../src/main/bananify-services');
const { PING_ENDPOINT, EVENT_ENDPOINT, createTelemetrySender } = require('../../src/main/telemetry');
const { TAB_IMPORT_RELAY_ORIGIN, tabImportClaimUrl } = require('../../src/main/tab-import-handoff');
const pkg = require('../../package.json');

const ROOT = path.join(__dirname, '..', '..');
const syncSource = fs.readFileSync(path.join(ROOT, 'src/main/sync.js'), 'utf8');
const SYNC_ENDPOINT = syncSource.match(/const SYNC_ENDPOINT = '([^']+)'/)?.[1];

const bananifyEndpoints = [
  ['sync', SYNC_ENDPOINT],
  ['launch ping', PING_ENDPOINT],
  ['usage event', EVENT_ENDPOINT],
  ['tab-import relay', TAB_IMPORT_RELAY_ORIGIN],
];

test('every endpoint Bananify hosts is recognized as a Bananify service', () => {
  assert.ok(SYNC_ENDPOINT, 'sync.js must still declare SYNC_ENDPOINT as a string literal');
  for (const [label, url] of bananifyEndpoints) {
    assert.equal(isBananifyServiceUrl(url), true, `${label} (${url})`);
  }
});

test('an official build may call Bananify services', () => {
  for (const [label, url] of bananifyEndpoints) {
    assert.equal(bananifyServiceAllowed(url, OFFICIAL_APP_NAME), true, label);
  }
});

test('a renamed build may not call Bananify services', () => {
  for (const [label, url] of bananifyEndpoints) {
    assert.equal(bananifyServiceAllowed(url, 'Foo Browser'), false, label);
  }
  assert.equal(bananifyServiceAllowed(PING_ENDPOINT, null), false, 'a build with no product name');
});

test('a renamed build may still call servers it runs itself', () => {
  assert.equal(bananifyServiceAllowed('https://sync.foo.example/v1/blob', 'Foo Browser'), true);
  assert.equal(bananifyServiceAllowed('http://127.0.0.1:8787', 'Foo Browser'), true);
});

test('blanc.day and its subdomains are Bananify services, and so is the former domain', () => {
  for (const url of [
    'https://blanc.day/',
    'https://www.blanc.day/mail',
    'https://downloads.blanc.day/mail/BlancMail-1.0.0.zip',
    'https://blancbrowser.com/',
    'https://tabs.blancbrowser.com/v1/handoffs/x',
  ]) assert.equal(isBananifyServiceUrl(url), true, url);
});

test('lookalike hosts are not Bananify services, and unreadable URLs fail closed', () => {
  assert.equal(isBananifyServiceUrl('https://blanc.day.example/'), false);
  assert.equal(isBananifyServiceUrl('https://notblanc.day/'), false);
  assert.equal(isBananifyServiceUrl('https://blancbrowser.com.example/'), false);
  assert.equal(isBananifyServiceUrl('https://notblancbrowser.com/'), false);
  assert.equal(isBananifyServiceUrl('https://bnfy-441.workers.dev.example/'), false);
  assert.equal(bananifyServiceAllowed('not a url', 'Foo Browser'), false);
});

// SPATIAL FORK contract (was: "the shipped product name is the official
// name"): this fork ships under the working title "Spatial", which is
// deliberately NOT the official upstream name, so every Bananify-hosted
// service must be refused by default — the rename is the fork's phone-home
// kill switch, on top of the explicit module-level stubs (telemetry.js
// disabled sender, sync.js guard shim, patron.js stub, updater.js
// UPDATES_DISABLED). This test must keep failing loudly if anyone re-points
// the product name at the official one without meaning to re-enable those
// services.
test('the fork ships a non-official product name, so Bananify services are refused by default', () => {
  assert.notEqual(pkg.productName, OFFICIAL_APP_NAME);
  assert.notEqual(pkg.build.productName, OFFICIAL_APP_NAME);
  assert.equal(bananifyServiceAllowed(PING_ENDPOINT), false, 'the default refuses Bananify endpoints for the fork name');
});

test('a renamed build sends no launch ping or usage event to Bananify', () => {
  const calls = [];
  const sender = createTelemetrySender({
    isPackaged: () => true,
    fetchImpl: async (url) => { calls.push(url); },
    getInstallId: () => '01234567-89ab-4cde-8f01-23456789abcd',
    getVersion: () => '1.10.0',
    platform: 'darwin',
    arch: 'arm64',
    getSystemVersion: () => '26.4.1',
    newtabLayouts: ['ledger'],
    serviceAllowed: (url) => bananifyServiceAllowed(url, 'Foo Browser'),
    warn: () => {},
  });

  assert.equal(sender.sendLaunchPing(), false);
  assert.equal(sender.sendMahjongPlay(), false);
  assert.equal(sender.sendNewtabLayoutUsed('ledger'), false);
  assert.deepEqual(calls, []);
});

// Run the real claim function from main.js with a fake network boundary.
const mainSource = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
const claimStart = mainSource.indexOf('function tabHandoffErrorMessage(');
const claimEnd = mainSource.indexOf('async function processTabHandoff(');

function claimHarness({ origin, appName }) {
  const fetched = [];
  const context = {
    AbortController, setTimeout, clearTimeout,
    tabImportClaimUrl,
    tabImportRelayOrigin: () => origin,
    bananifyServiceAllowed: (url) => bananifyServiceAllowed(url, appName),
    net: { fetch: async (url) => { fetched.push(url); return { ok: false }; } },
    // Error text comes from the interface catalog (F44); English here.
    mainI18n: { t: require('../support/english-t').englishT },
    MAX_TAB_IMPORT_TABS: 100,
  };
  vm.createContext(context);
  vm.runInContext(mainSource.slice(claimStart, claimEnd), context);
  return { context, fetched };
}

const handoff = { id: 'AAAAAAAAAAAAAAAAAAAAAA', key: 'A'.repeat(43) };

test('main.js still defines the tab handoff claim functions this test runs', () => {
  assert.ok(claimStart > 0 && claimEnd > claimStart, 'claim source slice not found in main.js');
  const { context } = claimHarness({ origin: TAB_IMPORT_RELAY_ORIGIN, appName: OFFICIAL_APP_NAME });
  assert.equal(typeof context.claimTabHandoff, 'function');
  assert.equal(typeof context.tabHandoffErrorMessage, 'function');
});

test('a renamed build refuses a tab handoff before contacting the relay', async () => {
  const { context, fetched } = claimHarness({ origin: TAB_IMPORT_RELAY_ORIGIN, appName: 'Foo Browser' });
  await assert.rejects(context.claimTabHandoff(handoff), { message: 'service-unavailable' });
  assert.deepEqual(fetched, []);
  assert.match(context.tabHandoffErrorMessage('service-unavailable'), /official Spatial builds/);
});

test('an official build still claims tab handoffs from the relay', async () => {
  const { context, fetched } = claimHarness({ origin: TAB_IMPORT_RELAY_ORIGIN, appName: OFFICIAL_APP_NAME });
  await assert.rejects(context.claimTabHandoff(handoff), { message: 'unavailable' });
  assert.equal(fetched.length, 1);
  assert.ok(fetched[0].startsWith(`${TAB_IMPORT_RELAY_ORIGIN}/v1/handoffs/`));
});
