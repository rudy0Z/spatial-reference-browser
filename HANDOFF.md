# HANDOFF — Spatial Reference Browser

*End of day 2026-11-13. Written for the founder and for any fresh AI session. Read this top to bottom before writing code.*

---

## 1. The 30-second brief

> We are building **a spatial graph desktop browser for a designer with 600–700 open visual-reference tabs**: tabs are nodes on an infinite canvas, sleeping tabs cost 0 MB and keep their position, edges and thumbnail; link clicks spawn connected child nodes; clustering is suggest-only. **The fork base is locked: Blanc** (MIT Electron browser, Chromium 156 via Electron 45). Execution follows **`ZCODE_MASTER_PROMPT.md`** — the binding spec — in strict closed-loop phases, each gated by build + tests + live screenshot anti-slop audit + git tag. **Status: Phase 0 ✅ tagged; Phase 1.5 redesign built + verified except the fps number (measuring instrument limitation — see §4); Phases 2–6 not started.** Next action on resume: measure fps via puppeteer-core + Edge/Chrome headless CDP → tag `checkpoint/phase-1.5-clean-design` → Phase 2 (Rust core).

---

## 2. Binding documents & protocol

- **`SPATIAL_BROWSER_MASTER_SPEC.md` (workspace root) is the binding Master Execution Specification — the FINAL completion goal for a 100% production-grade browser** (adopted 2026-11-15, founder `/goal`). It supersedes `ZCODE_MASTER_PROMPT.md` (kept as history) and this file wherever they conflict. Key deltas it introduces over the old master prompt: the **Fresh-State Browser Law** (empty first run; `/seed-700` removed from user UI, dev-only via `window.__devStressSeed`); the **`enforceLivePool` partial-eviction fix**; a **real headless-CDP fps bench** (`scripts/bench-fps.mjs`, puppeteer-core); the **Native View Z-Order Guard**; expanded **Rust scope** (rstar R-tree, moodboard solver, boids engine); **benchmark targets** (≤180 MB idle, ≤1.1 GB @ 10 heavy + 100 sleeping, ≥60 fps @ 700 nodes); full **A-to-Z daily-driver plumbing** in Phase 3; and the **mandatory torture matrix** (Phase 3/6) + head-to-head benchmark vs upstream Blanc/Zen/Chrome.
- **Closed-loop protocol:** never batch phases; never advance until the current phase passes its build gate, test gate, live runtime + screenshot **Anti-Slop** audit, and git checkpoint tag.
- **Anti-Slop checklist:** zero neon borders/glows; zero uppercase debug badges (`SLEEP · 0 MB`, `COLD ARCHIVE`, `WB`, `ANCHOR`, `GHOST ECHO · 92% MATCH`, `WAKE HERE`…); zero clipped text at 100%/125% DPI; zero marching-ant edge animations (Obsidian-style 1-hop hover illumination instead); pan/zoom ≥55 fps sustained (Phase 1.5) / ≥60 fps (Phase 2+), <2% dropped frames at 700 nodes.
- Supporting docs: `app/SPEC.md` (Phase 1 interaction contracts), `research/spatial-graph-browser-analysis.md` (architecture research, prior art, feasibility), `research/BLANC-CLONE-PROVENANCE.md` (clone provenance), `design/index.html` (design-direction handover attachment).

---

## 3. THE FORK DECISION — Blanc. Locked, with reasons.

**We fork Blanc (`research/blanc-src` → `browser/` in Phase 3). No other base was chosen.**

| Option | Verdict | Why |
|---|---|---|
| **Blanc v1.48.0 (Electron 45 → Chromium 156)** | **LOCKED WINNER** | 100% Chrome rendering parity (Figma, WebGL/WebGPU, passkeys, OAuth); MIT; battle-tested subsystems we inherit *for free*: renderer hibernation (`quietTab`/`wakeTab`, ~148 MB/tab reclaimed), 3-tier closed-tab undo, Split View, floating Glance, Ghostery adblock + bundled uBlock Origin + 1Password broker, strict `ipc-trust.js`/`chrome-protocol.js` security gates, pure-module test culture, all Electron 44/45 platform landmines already debugged (Linux view ownership, Windows occlusion row, Wayland cursor). |
| Raw C++ Chromium fork (Brave/Stedding model) | Rejected | ~150 GB checkout, multi-hour builds per edit — kills solo/AI iteration loops. |
| Zen (Firefox via Surfer) | Rejected | 3 toolchains (Node 21 + Python + Rust), ~30 GB patch treadmill, Firefox extension ecosystem ≠ Chrome Web Store. |
| Tauri v2 / OS WebViews | Rejected | No Chrome extension runtime at all; no tab-discard API → cannot hibernate 700 tabs. |
| Servo | Rejected | Breaks Figma/WebGL/OAuth; experimental. |
| Min browser (Electron, Apache-2.0) | Runner-up only | Same engine, fork-inviting maintainer — but none of Blanc's free subsystems (no hibernation, no overlay island, no trust wrappers); we'd rewrite substantially more. Switch only if Blanc's solo-maintainer churn becomes an active burden. |

**Two clarifications that matter:**
1. **"Fork" means an Electron-app fork, not a C++ engine fork.** We inherit Chromium 156 through Electron 45.2.1 (castLabs ECS build) — we never compile Chromium.
2. **Upstream Blanc deliberately has NO Chrome-extension support** (its owner declined a Chromium fork in Oct 2026 and ships only a managed uBlock). **Our fork diverges from upstream on purpose:** Phase 4 adds `electron-chrome-extensions` + `session.extensions.loadExtension()` on our fork. Upstream's platform direction does not bind us; we maintain our own rebase policy (fork-and-freeze, cherry-pick Electron security bumps).

---

## 4. What is built, and how verified

### Phase 0 — ✅ DONE, TAGGED
- Git monorepo at `D:\Fivem\new brosser`; commit `86ab4e5`; tag **`checkpoint/phase-1-prototype`** + branch `archive/phase-1-prototype`; 4,901 files; working tree clean.
- Root `.gitattributes`: every byte-verification `eol=lf` rule from Blanc, rewritten to `**/` globs (protects `adblock/sources/*`, `pinned.json`, `adblock/generated/*` on Windows — a CRLF checkout makes Blanc's packaged adblocker fail closed). Verified with `git check-attr` on the three critical paths.
- Blanc's inner `.git` removed so its bytes are versioned here (provenance: `research/BLANC-CLONE-PROVENANCE.md`; upstream HEAD `07578e73b2202dec3aab3e39679cdcebddda1839`, v1.48.0).

### Phase 1 prototype — ✅ FROZEN AT ITS TAG
The spatial canvas + floating pill MVP (Vite + React 18 + TS strict + `@xyflow/react` + `d3-force` + zustand + framer-motion + Tailwind v4). Verified: 18/18 research claims confirmed; spec review 0 high/medium gaps; 4 visual-pass fixes (xyflow stylesheet import, live-position focus, settle glide, `w-fit`).

### Phase 1.5 — 🟡 BUILT + VERIFIED EXCEPT ONE GATE (untagged; committed as WIP `1668e63`)
The full Zen × Blanc × Obsidian Minimal redesign exists in the working tree (17 files: token overhaul, `PreviewArt.tsx`, `SpatialTabNode.tsx` rewrite, `moodboard.ts`, `ZenRail.tsx`, `BrowserTopBar.tsx`, `ExtensionsDrawer.tsx`, `ShortcutsSheet.tsx`, seed-700, store actions).

| Gate | Status | Evidence |
|---|---|---|
| `tsc -b` + `vite build` | ✅ green, round 1 | deterministic (`node`-direct invocations) |
| Deterministic slop sweep of `app/src` | ✅ clean — 0 violations | grep + reads: no neon hexes, no uppercase badges, no `strokeDasharray` animations |
| Live screenshot audit (4 rounds, fresh auditor each) | ✅ **ALL anti-slop checklist items pass** | `audits/phase-1.5-clean-design-audit.md` (rounds 1–3 preserved as `…-round1/2/3.md`): Mode A (top bar, rail both states, help modal, warm-paper light) + Mode B at macro/compact/rich on **700 nodes** (`/seed-700` → nodeCount 700 confirmed in DOM); 12 controls exercised, zero dead buttons; zero neon/badges/clipping |
| FPS at 700 nodes | ⚠️ **UNMEASURABLE in this harness — not an app failure** | The in-app browser's host suspends rAF/BeginFrames: sampler recorded **0 frames in 5.5s on the app tab, a fresh tab, AND an about:blank control tab**; `tab.recording` failed with "empty WebM artifact" (independent proof). Mitigations (SetForegroundWindow, visibility cycles) all no-ops. Real numbers only, none invented → gate honestly FAILS as unmeasurable |
| Git tag `checkpoint/phase-1.5-clean-design` | ⏸ **deliberately NOT created** | Only fires when every gate passes. Day's work preserved as WIP commit `1668e63` |

### What the founder validated along the way
- **Empty first run is a requirement** (founder, 2026-11-13): the shipping browser starts clean — no seeded tabs. `/seed-700` is a dev/stress fixture, never a default; the real 700 tabs arrive via the Phase 5 importer, born hibernated. *This must be enforced in Phase 3's build (initial state = empty canvas/new-tab with a quiet invitation).*
- FPS must be a real measured number, never invented.

---

## 5. Locked decisions (do not re-litigate)

1. **Design law v2:** dead-neutral matte graphite (`#0B0B0D` canvas, `#121215` chrome, `#18181C` cards, `1px rgba(255,255,255,0.07)` hairlines) + warm-paper light mode; reference thumbnails own 100% of the color; **silent state grammar** (5px live dot, opacity-0.58 decay, frosted 0.55 ghosts, hover 4-icon micro-bar); Obsidian 1px edges with 1-hop hover illumination; moodboard grid tidy; Zen collapsible rail.
2. **"The system pays, the user confirms."** Auto-spawn, auto-hibernate, suggest-only clustering, search-first retrieval. Never auto-move pinned nodes.
3. **Two-Mode Warm-Pool architecture:** Mode A = ≤6 live `WebContentsView`s (LRU, auto-quiet oldest non-audible/unpinned beyond cap); Mode B = hide views after capturing crisp `640×400` WebP (`capturePage()` + `navEpoch` guard), pure DOM canvas at 120fps. Never put 8 live views on the zoomable canvas.
4. **Base = Blanc fork** (see §3); upstream telemetry/updater/sync/Mac-SHA1 preflight get stripped in Phase 3; `brand:check` must pass under our own mark.
5. **Rust core** (`crates/spatial-core`, cargo 1.95.0 confirmed installed): R-tree culling, hybrid force + moodboard solver, <1.5ms search/ghost scorer; `<2ms` at 1,000 nodes proven by `cargo test --release`.
6. **Chrome extensions** via `electron-chrome-extensions` + `session.extensions.loadExtension()` (Load Unpacked + Web Store CRX3 1-click install), while keeping Blanc's Ghostery blocker, bundled uBlock, and 1Password working.
7. **Phase 3 must fix Blanc's `document-policy.js` trap:** `Cmd/Ctrl+Click`/`target=_blank` children marked `inheritsDocumentPolicy` can never hibernate and become dead `inert` pages on restart — ordinary link branches must spawn fresh main-process tabs (`noopener` + `parentId` edge); keep the mark strictly for sandboxed-iframe cases.
8. **SQLite vault + Local AI** in Phase 5 (`better-sqlite3` WAL, disk WebP, 5 rolling backups, `.spatial-backup` export; quantized `all-MiniLM-L6-v2` ONNX in a `worker_thread`); 700-tab importer creates nodes **born hibernated** with a throttled 1-at-a-time thumbnail crawler.
9. Empty first-run state in the real browser (see §4).
10. **Delight layer (founder-directed, 2026-11-14):** the new-tab experience gets ambient life — flocking "creature" animations rendered as ASCII/pixel grid characters on Canvas 2D (inspired by a viral indie new-tab: species selector, click-to-scatter, feed-the-koi). **Our twist: the creatures ARE the spatial graph** — sleeping nodes drift as dormant life; clicking one wakes it into a real node ("feed the koi" = wake a tab you've been ignoring). Implementation: boids flocking sim (~100–500 agents, spatial-hash grid, <0.5ms/frame) + glyph-buffer render (~1–2ms/frame on Canvas 2D; WebGL unnecessary); rAF auto-pauses when hidden; a pure, unit-testable module per Blanc's culture (`src/main`-style or renderer-local). Ships in Phase 3's new-tab, off-by-default knob in Tweaks. Perf math verified via research (spicyyoghurt.com boids tutorial; MDN rAF throttling).
11. **Chrome-extension support constraint (researched 2026-11-14):** `electron-chrome-extensions` v4.10.0 (Samuel Maddock, MIT, ~38.5k weekly downloads, actively maintained, requires Electron 35+) supports `chrome.action` popups, `tabs`, `windows`, `contextMenus`, `storage`, `cookies`, `webNavigation`, `runtime`, `notifications` — but **no Manifest V3 service-worker backgrounds yet** (pending upstream electron/electron#44411) and no `chrome.scripting`/`downloads`/`commands`. MV2 extensions (uBlock Origin!) work well. Rambox ships a production fork of it. Phase 4 therefore: MV2 + content-script/MV3-best-effort, with the master prompt's "capability badge" for unsupported APIs; full Web Store parity is the documented "revisit if" trigger (Wavebox left Electron for direct Chromium in v10 for exactly this — we don't unless the founder demands it later).

---

## 6. File map

| Path | What |
|---|---|
| `ZCODE_MASTER_PROMPT.md` | Binding spec — read first |
| `HANDOFF.md` | This file |
| `app/` | Phase 1.5 prototype (redesigned). `npm run dev` → http://127.0.0.1:5199/ |
| `app/SPEC.md` | Phase 1 interaction contracts + §7 edge cases + §8 substitutions |
| `app/src/index.css` | Matte-graphite + warm-paper token system |
| `app/src/store/useGraphStore.ts` | Brain: LRU pool, ghost scorer (0.55·cosine + 0.30·coVisit + 0.15·recency @ 0.78), co-visitation, seed700, tidyToMoodboard |
| `app/src/lib/` | `types.ts` (incl. PreviewSpec), `seed.ts`, `embed.ts` (toy embedder until Phase 5), `moodboard.ts` (pure grid math) |
| `app/src/components/chrome/` | `FloatingIslandPill`, `BrowserTopBar`, `ZenRail`, `NeighbourhoodGlance`, `ExtensionsDrawer`, `ShortcutsSheet`, `ToastStack` |
| `app/src/components/canvas/` | `SpatialCanvas.tsx` (LOD tiers, calm edges, HUD), `nodes/SpatialTabNode.tsx` + `nodes/PreviewArt.tsx` |
| `app/src/components/viewport/MockWebReader.tsx` | Mock pages (click vs ⌘/Ctrl+Click branching, audible toggle, drag-to-anchor) |
| `audits/phase-1.5-clean-design-audit*.md` | Live audit evidence (round 4 = final; 1–3 preserved) |
| `research/blanc-src/` | Pristine Blanc v1.48.0 reference (upstream `07578e7`) — **do not modify** |
| `research/spatial-graph-browser-analysis.md` | 87KB research report (architecture, prior art, feasibility, risks) |
| `research/BLANC-CLONE-PROVENANCE.md` | Clone provenance + why inner `.git` was removed |
| `design/index.html` | Design-direction handover (anti-slop specimens) |

**Blanc integration anchors (verified `file:line`, use in Phase 3):** island overlay `main.js:5554-5605, 5781-5824`; per-tab views `tab-view.js:97-108, 182-804`; switching `main.js:9819-9967`; re-layout `main.js:7277-7338`; hibernation `tab-sleep.js:37-102`, `main.js:2644-2704, 3124-3226`; closed-tab undo `closed-tabs.js:38-56`; link-interception skeleton `tab-view.js:495-514`; window-open handler `tab-view.js:687-715`; trust gates `main.js:11369-11400`, `ipc-trust.js:15-24`, `chrome-protocol.js`; persistence `store.js`, `session-workspace.js:11`; document-policy trap `src/main/document-policy.js`; clustering `tab-import-organizer.js:237, 370`; importers `browser-data-import.js`, `arc-import.js`, `bookmark-import.js`.

---

## 7. Environment & run book

- **Toolchain:** Node v24.14.1 · npm 11.11.0 · git 2.53 · **cargo 1.95.0** (Phase 2 ready). Git identity: `rudy0Z`.
- **Run prototype:** `npm --prefix "D:/Fivem/new brosser/app" run dev` → **http://127.0.0.1:5199/** (port pinned, `strictPort`).
- **Build gates (always node-direct; `npm` cannot be spawned by the workflow runner here):** `cd app && node node_modules/typescript/bin/tsc -b . && node node_modules/vite/bin/vite.js build .`
- **Rust gates (Phase 2):** `cargo test --release` inside `crates/spatial-core`.
- **Port 5199 orphaned?** `netstat -ano | grep :5199` → `taskkill //PID <pid> //F` (Git Bash double-slashes).
- **Browser-automation quirks (learned the hard way):** synthetic `WheelEvent`s must be dispatched on `.react-flow__pane` (descendants never see events dispatched on an ancestor); Playwright actionability times out on framer-motion-animated chrome — use native `.click()` via page evaluate on snapshot-proven buttons; Vite HMR can serve stale components after edits — full-reload before measuring; **the in-app browser delivers zero rAF frames** (see §4) — fps must be measured via puppeteer-core/CDP or Electron.
- **Workflow-runner quirk:** `world.run("npm", …)` fails (Windows `.cmd` spawn) — use the node-direct gates above.

---

## 8. Remaining phases (in strict order)

| Phase | Tag | Status | What it delivers | Exit gate |
|---|---|---|---|---|
| 0 — repo + prototype checkpoint | `checkpoint/phase-1-prototype` | ✅ done | git monorepo, eol protection, frozen baseline | tag exists, clean tree |
| 1.5 — anti-slop redesign | `checkpoint/phase-1.5-clean-design` | 🟡 built + verified, **tag pending fps** | matte-graphite redesign, silent grammar, Zen chrome, /seed-700 | **NEXT ACTION:** fps via puppeteer-core + Edge/Chrome headless CDP (≥55fps, <2% dropped at 700 nodes) → commit + tag. Also fold in: flip first-run to empty state before tagging |
| 2 — Rust spatial core | `checkpoint/phase-2-rust-core` | ⬜ not started | `crates/spatial-core`: R-tree, force+grid solver, fuzzy search + ghost scorer; TS wrapper `src/lib/spatialCore.ts` wired into `app/` | `cargo test --release`; <2ms @ 1,000 nodes; 700-node pan ≥55–60fps |
| 3 — real browser | `checkpoint/phase-3-real-browser` | ⬜ not started | fork `research/blanc-src` → `browser/` (keep clone pristine), rebrand (`brand:check`), strip telemetry/updater/sync/Mac-SHA1 preflight, mount redesigned shell on `blanc-chrome://` via `ipc-trust` gates, Two-Mode Warm Pool (6 live views / WebP-hidden canvas mode), **empty first run**, document-policy fix, real link-branching | real sites (Figma, Are.na, YouTube-audio, GitHub login) load + branch + hibernate with real Task-Manager RAM drop + survive restart; `node --test` pure-module & trust tests |
| 4 — Chrome extensions | `checkpoint/phase-4-chrome-extensions` | ⬜ not started | `electron-chrome-extensions` v4.10+ + `session.extensions.loadExtension()`; toolbar popover; Settings → Extensions (Load Unpacked + Web Store CRX3 1-click); keep Ghostery/uBO/1Password working. Known constraint: MV3 service-worker backgrounds pending upstream Electron (#44411) — MV2 + best-effort MV3, capability badge for gaps | unpacked extension (MV2 or MV3 content-script) injects into a real page, popup opens, survives restart |
| 5 — 700-tab vault & local AI | `checkpoint/phase-5-700-tab-vault` | ⬜ not started | `better-sqlite3` WAL vault + disk WebP + 5 rolling backups + `.spatial-backup` export; MiniLM ONNX in `worker_thread`; importer from Chrome/Arc/bookmarks/URL-paste → nodes **born hibernated**, throttled thumbnail crawler | 700-tab import <3s with 0 live renderers; kill + corrupt `graph.sqlite` → backup recovery restores 100% |
| 6 — release candidate | `checkpoint/phase-6-release-candidate` | ⬜ not started | main-process undo/redo, `Shift+Drag` marquee, domain/age/notes filter chips, `FOUNDER_GUIDE.md`, `electron-builder --dir` packaged Windows app | packaged `.exe` passes functional + perf + visual + zero-branding-remnant sweep |

**Order after resuming:** fps measure → tag 1.5 → Phase 2 → Phase 3 → 4 → 5 → 6. Never batch; every gate before every tag.

---

## 9. Next-session starter prompt

> Read `HANDOFF.md` and `ZCODE_MASTER_PROMPT.md`. Phase 1.5 is built and verified except the fps gate (unmeasurable in the in-app browser — evidence in `audits/`). Step 1: write a puppeteer-core bench (drive installed Edge/Chrome headless-new over CDP against the Vite server on :5199), measure sustained fps + dropped % at 700 nodes while panning; if ≥55fps and <2% dropped, flip the first-run state to empty (no seeded tabs), re-run build gates, commit and tag `checkpoint/phase-1.5-clean-design`. Then start Phase 2 (Rust `crates/spatial-core`).
