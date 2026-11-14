# Blanc reference clone — provenance

This directory (`research/blanc-src/`) is a pristine clone of the open-source
Blanc browser, kept as the reference implementation for the Spatial Reference
Browser fork (Phase 3 copies it to `browser/`; this clone must stay untouched).

- **Remote:** https://github.com/bnfy/blanc
- **HEAD at clone:** `07578e73b2202dec3aab3e39679cdcebddda1839` (short `07578e7`,
  "iOS: Back, Forward and New Tab on every iPhone Island; version 1.0.2 (#1463)")
  — the desktop app version in `package.json` is **1.48.0**; the `1.0.2` in the
  commit message is the iOS companion app's version.
- **Cloned:** 2026-11-12, `git clone --depth 1` (shallow — no upstream history).
- **License:** MIT (upstream carve-outs in `THIRD-PARTY-NOTICES.md` and
  `ASSET-LICENSE.md`; Blanc/Bananify identity assets are reserved).

## Why this directory has no `.git` of its own

The clone's original inner `.git` was removed on 2026-11-12 (Phase 0 of the
master plan) so the source files are versioned as ordinary files in this
monorepo's git history — `git add` on a nested repository would have recorded
only a gitlink and none of the bytes, defeating the checkpoint. The exact
upstream state is fully reproducible at any time:

```
git clone https://github.com/bnfy/blanc
cd blanc && git checkout 07578e703c99194a58e5a3e7ec0b39923d2db59b
```

`research/blanc-src/.gitattributes` rules were copied to the monorepo root
(rewritten to `**/` globs) so the byte-verified adblock inputs stay `eol=lf`
on Windows — see root `.gitattributes`.
