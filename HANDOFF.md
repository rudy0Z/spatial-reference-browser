# HANDOFF — The Spatial Graph Browser

*Status as of 2026-11-12. Written for the founder (non-developer, vibecoding with AI) and for any fresh AI session picking this up.*

---

## 1. What this project is

An infinite spatial canvas browser: open tabs, hibernated links, and projects are **nodes with edges** on one map. Four core mechanics: (1) unified storage node — tabs hibernate to 0 MB but keep position + edges, (2) automatic mind-mapping — link clicks spawn connected child nodes, (3) drag-and-drop docking, (4) suggest-only semantic clustering (local embeddings).

**Design law (never violate):** *"the system pays, the user confirms."* Auto-spawn, auto-hibernate, suggest-only clustering, search-first retrieval. Manual curation as the primary gesture is the pattern that killed Firefox Panorama (~0.01% usage), Arc Spaces (5.52% DAU), Kosmik (sunset 2026-05-31). Never auto-move pinned nodes. Full rationale: `research/spatial-graph-browser-analysis.md`.

**Base decision (locked):** fork **Blanc** (MIT Electron browser) for the real browser. Phase 1 (done) was the standalone UX prototype per another path — see §4.

---

## 2. Where everything lives

| Path | What it is |
|---|---|
| `app/` | **Phase 1 prototype** — Vite + React 18 + TS strict + `@xyflow/react` + `d3-force` + zustand + framer-motion + Tailwind v4. Runs today. |
| `app/SPEC.md` | The binding Phase 1 spec (design tokens, 6 node states × 3 LOD tiers, shortcuts, edge cases, §8 substitutions). The auditor audited against this. |
| `app/README.md` | Run instructions, shortcut table, stress-test walkthrough, known limitations. |
| `app/src/lib/types.ts` | All shared types incl. component prop contracts. |
| `app/src/store/useGraphStore.ts` | The brain: nodes/edges/regions, LRU live pool (5, audio/pin/recording immunity), hibernate/wake, ghost-echo matcher (0.55·cosine + 0.30·coVisit + 0.15·recency, threshold 0.78), co-visitation, `/seed-600`, collapse/fan macro-stacks. zustand + persist (localStorage). |
| `app/src/lib/embed.ts` | Deterministic toy hash embedder (384-dim) — stands in for MiniLM until Phase 3. |
| `app/src/lib/seed.ts` | 28-tab first-run seed incl. every §7 edge-case node. |
| `app/src/hooks/useHybridForceLayout.ts` | d3-force: pinned anchors (fx/fy locked) + orbiting satellites. |
| `app/src/hooks/useVoiceRecorder.ts` | Real MediaRecorder capture + playback (12-bar waveform). |
| `app/src/components/chrome/FloatingIslandPill.tsx` | Blanc-style pill: resting 36px (favicon, domain, RAM badge, 6 neighbor dots, Alt+N, canvas toggle), morphs into command palette (fuzzy search, slash commands `/canvas /hibernate-all /new /note /cluster /seed-600`), drag-to-anchor drop target. |
| `app/src/components/chrome/NeighbourhoodGlance.tsx` | 300px glass sidebar: 1-hop + 2-hop neighbors + ghost echoes, mini force graph. |
| `app/src/components/canvas/SpatialCanvas.tsx` | `@xyflow/react` canvas: semantic zoom (3 LOD tiers, heavy DOM genuinely unmounted at macro), `onlyRenderVisibleElements`, directional animated edges, bottom HUD (zoom %, LOD lock, Freeze/Relax, Note/Region creators, Active Workbench Tray with tether lines), entry-glide camera that chases the active node until the force layout settles. |
| `app/src/components/canvas/nodes/SpatialTabNode.tsx` | The node card — all 6 states × 3 LOD tiers: live glow + RAM badge, hibernated + 14-day Cold Archive decay, ghost echo (dashed violet, match %, Wake Here/Dismiss), sticky note (inline edit) + voice memo waveform, collapsed macro-stack deck (+N TABS), pin vs satellite, SPA filmstrip, noCapture blur, cached-text modal, query-tag pills. |
| `app/src/components/viewport/MockWebReader.tsx` | Mock pages: normal click navigates in place, ⌘/Ctrl+Click branches a child node, Alt+N quick note, audible toggle, draggable links for drop-onto-pill. |
| `research/blanc-src/` | **Pristine clone of Blanc v1.48.0** (MIT, Electron ^45.2.1, HEAD 07578e7 2026-11-11). Do not modify — copy it when forking. |
| `research/spatial-graph-browser-analysis.md` | 87KB research report: Blanc architecture deep-dive (notch/island with file:line), prior-art timeline, commercial landscape, feasibility verdict per mechanic, ranked risks, original roadmap. |

---

## 3. How much is actually built (honest accounting)

| Layer | Status | Toward the full product |
|---|---|---|
| Design system + pill + palette + glance | **Built** (mock-backed) | UI done; real input-focus/z-order wiring in Phase 2 (Blanc's island code is the pattern library) |
| Canvas, physics, LOD, regions, workbench | **Built** | ~90% of prototype scope; 600-node fps never *measured*, only eyeballed — Phase 2 gates it |
| Node cards, all 6 states + edge cases | **Built** | Thumbnails are gradient placeholders — real `capturePage()` WebP is Phase 2 |
| State core (LRU, ghost math, co-visitation, seeds) | **Built, executed & verified** in sandboxed Node by the spec reviewer | Logic is real; data is mock; persistence is localStorage (quota risk — IndexedDB/SQLite later) |
| Mock reader | **Built** (test rig only) | Becomes irrelevant once real views exist |
| **Real browsing (Electron, WebContentsView, navigation, real hibernation, real thumbnails)** | **0% — not started** | This is Phase 2 |
| Real intelligence (MiniLM, Whisper, SQLite) | **0%** | Phase 3 |
| Trust/security layer | **0% integrated** (but banked: Blanc's `chromeOn` pattern is audited and copy-ready) | Phase 2 |
| Business layer (signing, updates, pricing) | **0%** | Phase 4 |

**Bottom line:** the spatial UX layer is ~done and verified; the browser itself is ~25% of the full vision — the platform-hard part (engine integration, real hibernation, capture, perf-at-cap) is all ahead. What de-risks it: the Blanc reverse-engineering is complete and evidence-backed (18/18 claims confirmed), so Phase 2 integrates *known* code instead of exploring.

### Blanc assets already banked for Phase 2 (verified file:line anchors)

- **Island/notch patterns** (the overlay you'll adapt): `src/main/main.js:5554-5605` (createOverlay — one transparent sandboxed WebContentsView), `:5781-5824` (showOverlay — atomic payload, restack), `island-autohide.js` (pure policy), `chrome-layout.js:58-158` (one pure geometry function — copy this style for `canvas-layout.js`).
- **Per-tab views**: `tab-view.js:97-108` (sole constructor), `:182-804` (replayable wiring — teardown by listener diff, never `removeAllListeners`), `main.js:9819-9967` (setActiveTab), `:7277-7338` (`resizeActiveView` — the single re-layout entry point your `resizeNodes()` clones).
- **Hibernation ≈ 80% of mechanic 1, free**: `tab-sleep.js:37-102` (pure eligibility policy), `main.js:2644-2704` (two-path renderer discard), `:3124-3226` (wakeTab with coalescing).
- **Link interception ≈ mechanic 2 skeleton**: `tab-view.js:495-514` (`will-navigate` → `preventDefault` → `setImmediate(createTab)`), `:687-715` (`setWindowOpenHandler` for popups/OAuth carve-outs).
- **Clustering ≈ half of mechanic 4**: `tab-import-organizer.js:237` (`clusterIndices`), `:370` (`proposeFromEmbeddings`) — feed it real MiniLM vectors.
- **Trust model (copy verbatim)**: `main.js:11369-11400` (`chromeOn`/`chromeHandle`), `ipc-trust.js:15-24` (three-way sender identity), `chrome-protocol.js` (fail-closed per-host allowlist), `island-typing.js:6-33` ("a renderer is never trusted to have run its check").
- **Persistence**: one `JsonStore` primitive (`store.js`, 250ms debounced, temp-file + fsync + sequence-checked rename); session v2 schema (`session-workspace.js:11`, deliberately Electron-free for testability).
- **Platform landmines already solved**: Linux window-owned views + 1×1 nudge (`tab-view-lifecycle.js:10-39`), Windows occlusion 1px row (`island-autohide.js:157-198`), send-hide-before-detach (`main.js:5842-5895`), Wayland cursor fallback (`main.js:3844-3882`).
- **Brand gate**: `predist` runs `brand:check` (`package.json:11`) — rebrand in week 1 of Phase 2 or every build fails. Ad lists are CC BY-SA. No Chrome extension support by design (`README.md:310`).

---

## 4. Path taken so far (so you don't re-litigate)

1. **Research run** (workflow, 18/18 code claims independently confirmed): verdict — fork Blanc; prior art exists (Panorama, Arc, Kosmik) but the "system pays" variant is untried; report at `research/spatial-graph-browser-analysis.md`.
2. **Founder refined the concept** (ghost echoes, co-visitation score, edge cases, hybrid anchor+gravity physics) → pinned into `app/SPEC.md`.
3. **Phase 1 build run** (11-phase workflow): scaffold → state core → 5 parallel component builders → integration → deterministic gates → fresh-eyes spec review (0 high/medium gaps; reviewer executed the store logic in sandboxed Node: LRU eviction, immunity, ghost math 1.0000 on perfect inputs, persistence round-trips all confirmed) → smoke test → README.
4. **Visual pass** (this session): found and fixed 4 issues — see §6.

---

## 5. Environment & run book

- **Toolchain:** Node v24.14.1, npm 11.11.0 (Git Bash on Windows 11). Node LTS from nodejs.org is all a fresh machine needs.
- **Run the prototype:** `npm --prefix "D:/Fivem/new brosser/app" run dev` → **http://127.0.0.1:5199/** (port pinned in vite config, `strictPort`).
- **Gates (run after any code change):** `cd app && node node_modules/typescript/bin/tsc -b . && node node_modules/vite/bin/vite.js build .` — both must exit 0.
- **Port 5199 stuck?** A killed dev server can leave an orphan: `netstat -ano | grep :5199` → `taskkill //PID <pid> //F` (Git Bash double-slashes).
- **Fresh demo state:** clear localStorage in the app (DevTools → Application → Local Storage → clear) and reload → the 28-tab first-run seed returns. `/seed-600` replaces the graph with the 600-node stress state.
- **Workflow-runner quirk (this machine):** `world.run("npm", …)` fails (Windows `.cmd` spawn) — workflow build gates use the node-direct invocations shown above.
- **Browser-automation quirks found the hard way:** synthetic wheel events must be dispatched on `.react-flow__pane` (not the `.react-flow` wrapper); Vite HMR can silently serve stale components after edits — full-reload before measuring; the palette's framer-motion animations defeat Playwright click-actionability — use native `.click()` via evaluate on snapshot-proven buttons.

---

## 6. Verification status & open (low) findings

- Gates green after every change; `tsc` strict, zero `any`/TODO/console in `app/src`.
- Spec review: **0 high/medium gaps**; the following 7 low findings are recorded in `app/README.md` and deliberately deferred — clear them opportunistically in Phase 2/3:
  1. Dot grid doesn't fade at low zoom (`SpatialCanvas.tsx:845`).
  2. Pin glyph in badge row, not top-right, at rich zoom (`SpatialTabNode.tsx:1281`).
  3. OAuth collapse models domains, not the <3s time rule (`types.ts:351`, `useGraphStore.ts:596`).
  4. Recorder race if the mic panel unmounts mid-`getUserMedia` (`useVoiceRecorder.ts:236`).
  5. WebM blob duration `Infinity` → progress underline static (`useVoiceRecorder.ts:411`).
  6. `refreshGhostEchoes()` exported but uncalled (`useGraphStore.ts:969`).
  7. localStorage-only persistence; long voice memos risk the ~5 MB quota (`useGraphStore.ts:1107`) — IndexedDB in Phase 2, SQLite in Phase 3.

---

## 7. Remaining phases (with exit checks)

### Phase 2 — The real browser (Blanc fork + WebContentsView integration) — the big one
1. Copy `research/blanc-src` → `browser/` (keep the clone pristine). `npm install && npm start`. **Exit: stock Blanc browses.**
2. Rebrand immediately (name, icons, `brand:check`). **Exit: `npm run dist:dir` ships under your mark.**
3. Extend the tab record with `{x, y, w, h, parentId, edges}` + persist through session v2. **Exit: restart round-trips the fields; pre-fork sessions still load.**
4. Mount the React canvas as a new `blanc-chrome://` document (fail-closed per-host pattern of `chrome-protocol.js`) — the window's own document becomes the canvas; live pages are child WebContentsViews positioned at node rects via a `resizeNodes()` clone of `resizeActiveView` (`main.js:7277`). Port the Phase-1 store into the main process (pure modules: `node-model.js`, `canvas-layout.js`, `graph-ipc.js` copying `chromeOn`). **Exit: canvas + ONE live real website at its node rect; pan/zoom 60fps.**
5. Real hibernation: node close → `quietTab` (`main.js:2721`) + `capturePage()` → 480×270 lossy WebP (~15-25 KB) with the `navEpoch` staleness guard (`main.js:7852`); thumbnails in their own store. **Exit: docked node shows a real thumbnail; RAM drops in Task Manager; lazy wake restores at position.**
6. **The cap test:** pan at 60fps with **6–8 open live views** (zoom = CSS transform + re-layout on settle; coalesced bounds sends per the proximity throttle pattern `main.js:3646-3713`). If it stutters at 8, cut the cap to 6. The 9th node auto-quiets the LRU open node with an undo toast — never refuse. **Exit: measured, not eyeballed.**
7. Mechanic 2 behind a settings toggle: generalize `tab-view.js:495-514` — click-tag before forking, never fork POSTs/redirect chains, popup/OAuth carve-outs unchanged, global "linear mode" escape hatch. **Exit: child nodes + edges on 3 real sites without breaking login flows.**

### Phase 3 — Intelligence & polish
- Real embeddings: `@huggingface/transformers`, all-MiniLM-L6-v2 quantized ONNX (~23 MB, bundled, `worker_thread`), replacing `embed.ts`; feed `proposeFromEmbeddings` (`tab-import-organizer.js:370`). Suggest-only — animate to centroids on explicit confirm, never auto-move. **Exit: 15 docked nodes → ≥1 sensible named cluster; <500 ms per embed on this machine.**
- Whisper-tiny voice transcription (searchable voice notes), IndexedDB for blobs, SQLite (`better-sqlite3`) for nodes/vectors/thumbs.
- Reader snapshots (Mozilla Readability — already a Blanc dep) for dead-link survival; drag-to-anchor via main-side pointer tracking; undo for every canvas mutation (route node deletion through Blanc's 3-tier closed-tab undo, `closed-tabs.js:38-56`).
- Export canvas (JSON + thumbs folder) + rolling backups — the canvas IS the user's memory; atomic ≠ recoverable. **Exit: delete session.json, restore, full canvas intact.**
- Clear the 7 low findings opportunistically. Pure modules into `node --test`; trust-gate rejection tests for every new channel.

### Phase 4 — Business realities (before strangers)
- Code signing (unsigned = SmartScreen death for a browser), update-feed decision (don't leave `electron-updater` pointing at Blanc's feed), pricing (niche reference: $5–13/mo; best hard number in the category ≈ $1.5M ARR, one company).
- **The gate: spend nothing until ~10 strangers use it weekly and one volunteers to pay.**

---

## 8. The 30-second brief for the next AI session

> Read `HANDOFF.md`. Phase 1 prototype is done and verified (`app/`, runs on :5199, spec in `app/SPEC.md`). Blanc clone is pristine at `research/blanc-src` with a verified architecture map in `research/spatial-graph-browser-analysis.md`. Next: Phase 2 — copy the clone to `browser/`, rebrand (brand:check), add `{x,y,w,h,parentId,edges}` to the tab record, mount the canvas as a `blanc-chrome://` document, host one live WebContentsView at its node rect, then hibernation + real WebP thumbnails + the 6–8 live-view pan test. Design law: the system pays, the user confirms; never auto-move pinned nodes; search-first is non-negotiable.
