'use strict';

// Stage the compiled app/ spatial shell into src/renderer/spatial/ so the
// blanc-chrome://spatial/ host (chrome-protocol.js) serves it.
//
// Run after every app/ build:
//   cd ../app && node node_modules/vite/bin/vite.js build .
//   node scripts/stage-spatial-shell.js

const fs = require('node:fs');
const path = require('node:path');

const APP_DIST = path.join(__dirname, '../../app/dist');
const DEST = path.join(__dirname, '../src/renderer/spatial');

function stage() {
  if (!fs.existsSync(APP_DIST)) {
    console.error(`stage-spatial-shell: missing ${APP_DIST} — build app/ first`);
    process.exitCode = 1;
    return;
  }
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.cpSync(APP_DIST, DEST, { recursive: true });
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) files.push(`${prefix}${entry.name}`);
      else if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    }
  };
  walk(DEST, '');
  console.log(`stage-spatial-shell: staged ${files.length} files → src/renderer/spatial/`);
  for (const file of files) console.log(`  /${file}`);
}

stage();
