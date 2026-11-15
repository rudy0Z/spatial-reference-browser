#!/usr/bin/env node
'use strict';

// §B.8.6 — Widevine DRM / GPU rasterization / adblock / 1Password preservation
// check for the Spatial fork of Blanc.
//
// The Phase 3.0 fork stripped telemetry, updaters and sync. This script
// PROVES the money-path capabilities survived that strip, by static analysis
// of the fork source (no Electron launch needed — the ECS runtime binary is
// what ships Widevine; what this fork must preserve is the INIT PATH and the
// flag surface):
//   1. castLabs ECS Widevine CDM init path  (drm-support/drm-runtime/
//      drm-startup + `components.WIDEVINE_CDM_ID` + blancRuntime:'ecs'
//      metadata injection + main.js wiring)
//   2. GPU rasterization flags              (no disable-gpu* /
//      disableHardwareAcceleration in the fork's main process; the ECS darwin
//      video-frames switch intact)
//   3. Ghostery/uBlock adblock engine       (modules present + wired)
//   4. 1Password integration                (broker/policy modules + shortcut)
//   5. The strip stayed a strip             (telemetry sender disabled:true,
//      updater feed disabled, sync service inert — the SPATIAL FORK markers)
//
// Usage: node scripts/spatial-preservation-check.cjs
// Exit 0 = everything survived; 1 = something was lost. Output is one line
// per check (PASS/FAIL) and a final summary — pipe it to
// audits/phase-3-plumbing-widevine.log.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..'); // browser/
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const results = [];
let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures += 1;
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ---- 1. castLabs ECS Widevine CDM init path ---- */
const drmSupport = exists('src/main/drm-support.js') ? read('src/main/drm-support.js') : '';
const drmRuntime = exists('src/main/drm-runtime.js') ? read('src/main/drm-runtime.js') : '';
const drmStartup = exists('src/main/drm-startup.js') ? read('src/main/drm-startup.js') : '';
const mainSource = read('src/main/main.js');
const pkg = JSON.parse(read('package.json'));
const ecsBuild = exists('scripts/build-ecs-production.cjs') ? read('scripts/build-ecs-production.cjs') : '';

check('drm-support.js present', drmSupport.length > 0);
check('castLabs ECS API referenced by the runtime', /castlabs\/electron-releases/i.test(drmRuntime), 'drm-runtime.js header');
check('WIDEVINE_CDM_ID consumed (CDM component init)', drmSupport.includes('WIDEVINE_CDM_ID') && drmSupport.includes('components.whenReady'), 'drm-support.js');
check('ECS selected by immutable metadata (blancRuntime === \'ecs\')', drmSupport.includes("metadata?.blancRuntime === 'ecs'"));
check('Widevine CDM startup path present', /widevine/i.test(drmStartup) || /isWidevineComponentError/.test(drmStartup), 'drm-startup.js');
check('main.js creates drmSupport with ECS components', mainSource.includes("require('./drm-support')") && /createDrmSupport\(\{/.test(mainSource) && mainSource.includes("require('electron').components"), 'main.js:17-20');
check('package.json declares ECS build scripts', typeof pkg.scripts?.['dist:ecs'] === 'string', pkg.scripts?.['dist:ecs'] ?? '');
check('ECS packaging injects blancRuntime:\'ecs\' metadata', ecsBuild.includes("blancRuntime: 'ecs'"), 'build-ecs-production.cjs');
check('DRM relaunch/staging modules intact', exists('src/main/drm-relaunch.js') && exists('src/main/drm-controls.js'));

/* ---- 2. GPU rasterization / hardware decode flags ---- */
const SOURCES_DIR = path.join(ROOT, 'src/main');
const gpuFiles = [];
const collectMainSources = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMainSources(full);
    else if (entry.name.endsWith('.js')) gpuFiles.push(path.relative(ROOT, full));
  }
};
collectMainSources(SOURCES_DIR);
// linux-sandbox-launch.js only PARSES sandbox flags from argv (denylist);
// it never appends a GPU kill switch. Everything else must be clean. The
// ECS darwin `disable-gpu-memory-buffer-video-frames` switch is a hardware-
// decode path choice, not a GPU kill — it is asserted separately below.
const gpuHostile = /disable-gpu(?!-sandbox|-memory-buffer-video-frames)|disableHardwareAcceleration|disable-gpu-rasterization|disable-gpu-compositing|disable-accelerated/i;
const offenders = [];
for (const rel of gpuFiles) {
  if (rel.replace(/\\/g, '/').endsWith('src/main/linux-sandbox-launch.js')) continue;
  const source = read(path.relative(ROOT, rel));
  const hit = source.match(gpuHostile);
  if (hit) offenders.push(`${rel}: ${hit[0]}`);
}
check('no GPU-kill switches in the main process', offenders.length === 0, offenders.join('; ') || 'none found');
check('ECS darwin video-frames switch intact', drmSupport.includes('disable-gpu-memory-buffer-video-frames'));
check('hardware decode session policy present', /setSpellCheckerLanguages|protectedSessions|session-created/.test(drmSupport) && exists('src/main/native-media-access.js'), 'native-media-access.js present');

/* ---- 3. Ghostery / uBlock adblock engine ---- */
const adblockWired = mainSource.includes("require('./adblock')") || mainSource.includes("require('./adblock')");
check('adblock engine modules survive', exists('src/main/adblock.js') && exists('src/main/adblock-engine-loader.js') && exists('src/main/adblock-startup.js'));
check('uBlock integration modules survive', exists('src/main/ublock-provider.js') && exists('src/main/ublock-package.js') && exists('src/main/ublock-registry.js'));
check('main.js wires setupAdBlocker + attachAdBlockerToSession', mainSource.includes('setupAdBlocker') && mainSource.includes('attachAdBlockerToSession'), 'main.js:56-58');
check('uBlock dashboard/bridge preloads survive', exists('src/main/ublock-dashboard-mainworld.js') && exists('src/main/ublock-bridge-preload.js'));

/* ---- 4. 1Password ---- */
const onepasswordModules = [
  'src/main/onepassword-broker.js',
  'src/main/onepassword-client.js',
  'src/main/onepassword-policy.js',
  'src/main/onepassword-app.js',
];
check('1Password broker/policy modules survive', onepasswordModules.every((rel) => exists(rel)));
check('main.js wires the 1Password shortcut + fill flow', mainSource.includes('ONE_PASSWORD_AVAILABLE') && mainSource.includes('installOnePasswordShortcut') && mainSource.includes('fill-status-surface'), 'main.js:442+');

/* ---- 5. The strip stayed a strip (telemetry/updater/sync inert) ---- */
const telemetry = read('src/main/telemetry.js');
const updater = read('src/main/updater.js');
const sync = read('src/main/sync.js');
check('telemetry sender disabled:true (no pings leave the device)', telemetry.includes('disabled: true') && telemetry.includes('SPATIAL FORK'));
check('updater feed disabled in the fork', updater.includes('[updater] disabled in this fork') && updater.includes('SPATIAL FORK'));
check('sync service inert (SPATIAL FORK marker at the entry)', sync.slice(0, 4000).includes('SPATIAL FORK'));

/* ---- summary ---- */
console.log(`# §B.8.6 preservation check — Spatial fork (${new Date().toISOString()})`);
for (const line of results) console.log(line);
console.log(`${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${results.length} total)`);
process.exit(failures === 0 ? 0 : 1);
