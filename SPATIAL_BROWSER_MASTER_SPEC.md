# MASTER EXECUTION SPECIFICATION — SPATIAL BROWSER (A-TO-Z PRODUCTION BUILD)

You are the Principal Browser Systems & Design Engineer building **Spatial Browser** in `D:\Fivem\new brosser` (Git identity: `rudy0Z`)[cite: 2]. Before writing any code, read `HANDOFF.md` and inspect `app/src/` and `research/blanc-src/`[cite: 1, 2, 3].

Your mission is to complete a **fully functional, daily-drivable, A-to-Z desktop web browser** that combines the calm linear ergonomics of **Zen Browser** and **Blanc** with an instant, 120fps infinite spatial canvas[cite: 2].

---

## 0. NON-NEGOTIABLE OPERATING LAWS

### 0.1 Closed-Loop Phase Protocol
- Execute **strictly one phase at a time**[cite: 2]. Never batch phases or skip ahead[cite: 2].
- Every phase is gated by:
  1. **Zero-Error Build Gate:** TypeScript strict (`tsc -b`), Vite production bundle, and Rust release tests (`cargo test --release`)[cite: 2].
  2. **Automated Unit & Security Gate:** Pure-module unit tests (`node --test`) and IPC trust verification[cite: 2].
  3. **Real-World Heavy-Tab & FPS Gate:** Measured frame timings via headless CDP / Electron profiler—never invented numbers[cite: 2].
  4. **Fresh-Session Anti-Slop Visual Audit:** Live screenshots across Mode A, Mode B (all 3 LOD tiers), Dark Graphite, and Warm Paper themes[cite: 2, 3].
  5. **Git Checkpoint Tag:** Clean working tree + annotated `git tag`[cite: 2].

### 0.2 Fresh-State Browser Law (No Pre-Seeded Clutter)
- **100% Clean First Run:** Launching the browser for the first time MUST open a **fresh, empty workspace** with a single clean New Tab (`https://new-tab.spatial/local`) and zero pre-loaded tabs, regions, or dummy notes[cite: 2, 3].
- **Zero Test Commands in User UI:** Remove `/seed-700` from user-facing `SLASH_COMMANDS` in `app/src/lib/types.ts` and `FloatingIslandPill.tsx`[cite: 3]. Stress-test generators (`seed700`) may ONLY be exposed on `window.__devStressSeed` in development/benchmark harnesses so a real user never encounters dummy data[cite: 2, 3].

### 0.3 Flagship Visual & Motion Craft ("Zen × Blanc × Obsidian Minimal")
- **Canonical Surface Hierarchy (`app/src/index.css`):**
  - **Dark Graphite (Default):** Canvas `#0B0B0D`, Chrome `#121215`, Card `#18181C`, Elevated `#202026`, Glass `rgba(18, 18, 21, 0.78)` with `backdrop-filter: blur(20px)`[cite: 2, 3].
  - **Warm Paper (`html[data-theme='paper']`):** Canvas `#F4F1EA`, Chrome `#ECE8DF`, Card `#FAF7F0`, Elevated `#FFFDF7`, Glass `rgba(250, 248, 242, 0.82)`[cite: 2, 3].
  - **Hairline Grammar:** Resting `1px solid var(--border-subtle)` (`rgba(255,255,255,0.065)`), Hover `1px solid var(--border-hover)` (`0.14`), Active `1px solid var(--border-active)` (`0.28`) + soft neutral elevation `var(--shadow-card)`[cite: 2, 3].
- **Color Discipline:** Reference thumbnails and live web content own 100% of the color[cite: 2, 3]. The browser chrome owns **zero hue**[cite: 3].
- **Silent State Grammar:**
  - Live tab = quiet 5px neutral dot (`var(--accent)`)[cite: 2, 3].
  - Hibernated (0 MB) tab = `opacity: 0.60` resting card that restores to `1.0` on hover[cite: 2, 3].
  - Ghost Echo = frosted translucent card (`0.55` wash + 1px hairline)[cite: 2, 3].
  - Edges = static `1px` smooth cubic beziers (`var(--border-subtle)` at rest); hovering any node illuminates its 1-hop lineage to `var(--ink-primary)` at `45%` opacity while dimming unrelated nodes/edges to `0.25`[cite: 2, 3].
- **Anti-Slop Ban List:** Zero neon borders/glows; zero uppercase debug badges (`SLEEP · 0 MB`, `COLD ARCHIVE`, `ANCHOR`, `GHOST ECHO · 92% MATCH`, `WAKE HERE`, `VIA AUTH`, `HUB`); zero marching-ant `strokeDasharray` animations; zero linear easing (use Framer Motion springs `{ type: 'spring', stiffness: 380, damping: 30 }` everywhere); zero clipped text at 100%/125% DPI[cite: 2, 3].
- **Typography:** `Inter Variable` at `-0.015em` tracking in clean sentence case for all UI copy; `JetBrains Mono` strictly reserved for URLs/paths and `<kbd>` shortcut hints[cite: 3].

### 0.4 Windows & Tooling Guardrails
- Always run build tools via direct Node invocation (Windows `.cmd` spawning fails in workflow runners)[cite: 2]:
  `cd app && node node_modules/typescript/bin/tsc -b . && node node_modules/vite/bin/vite.js build .`[cite: 2]
- Keep `research/blanc-src/` untouched as the pristine upstream reference[cite: 2].
- Preserve `.gitattributes` `eol=lf` rules on `adblock/sources/*`, `pinned.json`, and `adblock/generated/*` so Blanc's adblock byte-verification never fails on Windows[cite: 1, 2].

---

## 1. COMPETITIVE ARCHITECTURE & BENCHMARK BASELINE

We benchmark our architecture and UX directly against **Blanc Browser**, **Zen Browser**, **Vivaldi**, and **Min**[cite: 2]:

| Metric / Capability | Standard Browsers (Chrome / Vivaldi) | Zen Browser (Firefox / Gecko) | Upstream Blanc v1.48.0 (Electron 45) | **Spatial Browser Target (Our Build)** |
| :--- | :--- | :--- | :--- | :--- |
| **Engine & Web Parity** | Chromium (100%) | Gecko (Breaks some WebGPU/Figma/CWS)[cite: 2] | Chromium 156 via Electron 45.2.1 (100%)[cite: 2] | **Chromium 156 via Electron 45.2.1 (100%)**[cite: 2] |
| **Idle Cold-Start RAM** | ~220–300 MB | ~210–260 MB | ~145–175 MB | **≤ 180 MB** |
| **10 Heavy Tabs + 100 Sleeping Tabs RAM** | 6.5 GB – 14 GB (Tab strip collapse) | 2.8 GB – 4.5 GB (Unloaded tabs still hold DOM metadata) | ~950 MB (`quietTab` reclaims ~148 MB/tab)[cite: 2] | **≤ 1.1 GB** (Strict ≤6 live views; 0 MB SQLite/WebP hibernation)[cite: 2] |
| **Spatial Organization** | None (Flat tab strip / folders) | Linear vertical workspaces + Split View | Linear tab bar + Floating Island | **Dual-Mode: Zen Linear Rail + 120fps Infinite Spatial Graph**[cite: 2, 3] |
| **Adblock & Privacy** | Extension-dependent | uBlock via Firefox Add-ons | Built-in Ghostery + bundled uBlock + 1Password[cite: 2] | **Built-in Ghostery + bundled uBlock + 1Password + CWS Extensions**[cite: 2] |
| **Canvas Pan/Zoom @ 700 Nodes** | N/A | N/A | N/A | **≥ 60 fps sustained (< 2% dropped frames)**[cite: 2] |

---

## 2. PHASE-BY-PHASE EXECUTION ROADMAP

### PHASE 1.5 — CLEAN FIRST-RUN, BUG FIXES & HEADLESS CDP FPS GATE
**Status:** UI redesign is in working tree (`1668e63`)[cite: 2]. Complete these items to lock the tag:

1. **Enforce Fresh Empty First Run:**
   - In `app/src/store/useGraphStore.ts` (`ensureFirstRunSeed`, `resetToFirstRun`) and `app/src/lib/seed.ts`, replace the 28-node pre-seeded graph with a **clean initial state**: one active `New Tab` (`https://new-tab.spatial/local`) at `(0, 0)` in `reading` mode, 0 edges, 0 regions, 0 notes[cite: 2, 3].
   - Remove `'seed-700'` from `SlashCommandId` and `SLASH_COMMANDS` in `app/src/lib/types.ts` and `FloatingIslandPill.tsx`[cite: 3]. Attach `window.__devStressSeed = () => useGraphStore.getState().seed700()` in `App.tsx` (dev/bench only)[cite: 3].
2. **Fix Pool Eviction Edge Case (`useGraphStore.ts`):**
   - In `enforceLivePool()`, return `{ nodes: next, evicted }` whenever at least one candidate was hibernated (`evicted !== null`), even if `excess > 0` remains because other live tabs were immune (`isPinned`, `isAudible`, `recordingNodeId`)[cite: 3].
3. **Run Real Headless CDP 700-Node FPS Benchmark:**
   - Write `scripts/bench-fps.mjs` using `puppeteer-core` to launch local Chrome/Edge (`--headless=new`) against `http://127.0.0.1:5199/`[cite: 2].
   - Invoke `window.__devStressSeed()`, switch to Mode B (`canvas`), verify 700 nodes in DOM, and pan/zoom across `.react-flow__pane` for 5.0 seconds while sampling `requestAnimationFrame` timestamps[cite: 2].
   - **Gate:** Must record **≥ 55 fps** sustained and **< 2% dropped frames**[cite: 2]. If frame times exceed 16.6ms, optimize `SpatialCanvas.tsx` and `SpatialTabNode.tsx` before tagging[cite: 3].
4. **Tag:** Commit and tag `checkpoint/phase-1.5-clean-design`[cite: 2].

---

### PHASE 2 — RUST + WASM SPATIAL ENGINE (`crates/spatial-core`)
**Goal:** Offload all $O(N)$ and $O(N \log N)$ spatial, layout, and scoring math into a deterministic Rust crate compiled to WebAssembly (`cargo 1.95.0`)[cite: 2].

1. **Build `crates/spatial-core`:**
   - **R-Tree Viewport Culler (`rstar`):** Index all node bounding boxes (`x, y, width, height`). Expose `query_viewport(min_x, min_y, max_x, max_y, margin)` in $O(\log N)$ so `SpatialCanvas.tsx` only pushes position updates to visible React Flow nodes during ticks, plus fast AABB collision checks so Ghost Echoes never spawn on top of existing cards[cite: 2, 3].
   - **Moodboard Contact-Sheet Solver & Local Force Relaxer:** Port `computeMoodboardGrid` (`384×240` 16:10 pitch, `260×199` card size, `12px` pinned keep-out margin, stable reading-order sort) and the hybrid force solver (`fx`/`fy` locked anchors, local satellite relaxation) into Rust[cite: 2, 3].
   - **Batch Fuzzy Search & Ghost Echo Scorer:** Implement subsequence fuzzy search and batch 384-dim cosine similarity + composite Ghost Echo scoring ($\text{Relevance} = 0.55 \cdot \text{cosine} + 0.30 \cdot \text{coVisit} + 0.15 \cdot \text{recency} \ge 0.78$)[cite: 2, 3].
   - **Boids Flocking Engine:** Spatial-hash grid boids simulation (100–500 agents, separation/alignment/cohesion, cursor scatter, < 0.5ms/step) for the New Tab ambient canvas[cite: 2].
2. **Wire `app/src/lib/spatialCore.ts`:**
   - Connect `crates/spatial-core` WASM to `useGraphStore.ts`, `moodboard.ts`, `useHybridForceLayout.ts`, and `SpatialCanvas.tsx` with a seamless pure-TS fallback for Node tests[cite: 2, 3].
3. **Gate & Tag:**
   - `cargo test --release` proves **< 2.0 ms** execution at **1,000 nodes**[cite: 2].
   - Re-run `scripts/bench-fps.mjs` at 700 nodes → confirm **≥ 60 fps**[cite: 2].
   - Commit and tag `checkpoint/phase-2-rust-core`[cite: 2].

---

### PHASE 3 — FULL A-TO-Z DESKTOP BROWSER (`browser/` FORKED FROM BLANC)
**Goal:** Fork `research/blanc-src/` into `browser/`, rebrand to **Spatial**, mount our UI on `blanc-chrome://`, and wire every essential daily-driver browser subsystem[cite: 2].

1. **Fork, Rebrand & Security Hardening:**
   - Copy `research/blanc-src/` → `browser/`[cite: 2]. Strip upstream telemetry, auto-updater, sync, and macOS SHA1 preflight[cite: 2]. Replace all branding/icons and pass `brand:check`[cite: 2].
   - Serve the compiled `app/` shell over `blanc-chrome://` protected by `ipc-trust.js` (`main.js:11369-11400`) and `chrome-protocol.js`[cite: 2].
2. **Two-Mode Warm Pool & Z-Order Compositor Synchronization:**
   - **Mode A (`reading`):** Manage **≤ 6 live `WebContentsView`s** (`activeNodeUuid` + `LIVE_POOL_LIMIT = 5`, referencing `tab-view.js:97-804` and `main.js:9819-9967`)[cite: 2, 3]. Dynamically lay out the active view (or two side-by-side `WebContentsView`s in **Split View**, `main.js:7277-7338`) below `BrowserTopBar` (`48px`) and right of `ZenRail` (`224px` open / `0px` collapsed)[cite: 2, 3].
   - **Native View Z-Order Guard:** Because native `WebContentsView` surfaces render above HTML/DOM overlays, whenever `paletteOpen`, `glanceOpen`, `extensionsOpen`, or `shortcutsOpen` is active in Mode A, immediately capture a frame of the active `WebContentsView`, display it as a crisp static backdrop in the viewport container, and call `view.setVisible(false)` until the overlay closes[cite: 2, 3].
   - **Mode B (`canvas`):** On switching to Mode B (`Cmd/Ctrl+Space`), capture a `640×400` WebP thumbnail (`capturePage()` guarded by `navEpoch`, skipping `noCapture` private tabs), hide all `WebContentsView`s, and render real WebP thumbnails inside `RichCard`[cite: 2, 3].
   - **True 0 MB Hibernation (`tab-sleep.js:37-102`):** When `enforceLivePool` or manual sleep hibernates a tab, serialize `{ scrollX, scrollY, mediaTime, excerpt }` via preload, destroy/quiet the renderer (~148 MB reclaimed per tab), and on wake show the cached WebP cover instantly while restoring scroll position on `did-finish-load`[cite: 2, 3]. Debounce `audio-state-changed` by 2.5s so brief media pauses never evict active video/audio tabs.
3. **Link Branching, Document-Policy Fix & Auth Collapse:**
   - Wire `tab-view.js:495-514` (link interception) and `tab-view.js:687-715` (`setWindowOpenHandler`) so `Cmd/Ctrl+Click` and `target="_blank"` links invoke `spawnChildNode(parentUuid, seed)` on the spatial graph[cite: 2, 3].
   - **Fix `src/main/document-policy.js` Trap:** Ordinary link branches must spawn fresh main-process tabs (`noopener` + `parentUuid` edge) and **NEVER** set `inheritsDocumentPolicy` (which prevents hibernation and leaves dead `inert` tabs on restart); restrict `inheritsDocumentPolicy` strictly to sandboxed iframes[cite: 2].
   - Collapse `< 3s` redirect chains and OAuth/SSO/payment popups (`looksLikeAuthOrPaymentUrl`) into a single `viaAuth` node[cite: 3].
4. **Complete A-to-Z Daily-Driver Browser Plumbing:**
   - **Navigation & URL Bar (`FloatingIslandPill` + `BrowserTopBar`):** Full URL/omnibox entry in the command palette (`Cmd/Ctrl+L`), search engine routing + `!bang` shortcuts (`bangs/sources/bangs.json`), real Back/Forward/Reload/Stop per `WebContentsView`, and live TLS certificate/security status on the top-bar `ShieldCheck` indicator[cite: 1, 3].
   - **Adblock & Password Manager:** Keep Blanc's Ghostery network blocker + bundled uBlock Origin (`adblock/generated/blocklist.json`) + 1Password desktop broker active out of the box[cite: 1, 2].
   - **Essential Browser Features:**
     - **Find in Page (`Cmd/Ctrl+F`):** Sleek matte floating find bar wired to `webContents.findInPage()`.
     - **Downloads Manager (`Cmd/Ctrl+J`):** Intercept `session.on('will-download')` with progress toast/drawer, pause/resume/cancel, and "Show in Folder".
     - **Permissions & Media Broker:** Clean permission prompts (Camera, Mic, Geolocation, Notifications, Fullscreen, Pointer Lock) + Picture-in-Picture (PiP) support.
     - **Context Menus & Zoom:** Native/custom right-click context menu ("Branch Link to Canvas", "Copy Link", "Save Image", "Inspect Element" DevTools toggle) + per-site page zoom (`Cmd/Ctrl + +/-/0`).
     - **3-Tier Closed-Tab Undo (`closed-tabs.js:38-56`):** `Cmd/Ctrl+Shift+T` restores closed nodes with their exact coordinates and edges[cite: 2].
5. **Ambient Boids New-Tab Experience:**
   - On `https://new-tab.spatial/local`, render the Canvas 2D ASCII/pixel-grid boids simulation driven by `spatial-core` (`< 2ms/frame`, auto-pauses when hidden, toggleable in settings) where dormant creatures represent hibernated nodes and clicking one ("feed the koi") wakes that tab[cite: 2].
6. **Gate & Tag:**
   - Pass all `node --test` unit/trust suites, verify real Task Manager RAM drop on hibernation, verify zero Blanc branding remnants (`brand:check`), and tag `checkpoint/phase-3-real-browser`[cite: 2].

---

### PHASE 4 — CHROME EXTENSIONS RUNTIME
**Goal:** Add Chrome extension support (`electron-chrome-extensions` v4.10+ + `session.extensions.loadExtension()`) while preserving built-in adblocking and 1Password[cite: 2].

1. **Extension Host & Persistence:**
   - Attach `ElectronChromeExtensions` to the main browsing session and register all `WebContentsView` tabs[cite: 2]. Persist installed extensions in `userData/extensions/` across restarts[cite: 2].
2. **Real `ExtensionsDrawer.tsx` & Toolbar Popups:**
   - Replace placeholder copy in `ExtensionsDrawer.tsx` with **Load Unpacked** directory picker, **Chrome Web Store 1-click CRX3 installer** (by URL or extension ID), enable/disable/remove controls, and a subtle capability badge for MV3 service-worker gaps (upstream Electron `#44411`)[cite: 2, 3].
   - Render extension action icons in `BrowserTopBar.tsx` that open `chrome.action` popups cleanly (engaging the `WebContentsView` backdrop guard while open)[cite: 2, 3].
3. **Gate & Tag:**
   - Install and run an unpacked extension on a live site, verify content script injection + popup + restart persistence → commit and tag `checkpoint/phase-4-chrome-extensions`[cite: 2].

---

### PHASE 5 — CRASH-SAFE SQLITE VAULT, LOCAL AI & MULTI-BROWSER IMPORTER
**Goal:** Replace `localStorage` with `better-sqlite3` WAL persistence, store WebP thumbnails on disk, run quantized `all-MiniLM-L6-v2` in a worker thread, and support importing from other browsers[cite: 2].

1. **SQLite WAL Vault & Rolling Backups (`browser/src/main/vault.ts`):**
   - Store `nodes`, `edges`, `regions`, `notes`, `voice_memos`, and 384-dim `Float32Array` embeddings in SQLite (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`)[cite: 2, 3].
   - Save `640×400` WebP thumbnails to `userData/thumbnails/<urlHash>.webp` served via `spatial-thumb://`[cite: 2].
   - Maintain **5 rolling automatic backups** (`vault.bak.1..5.sqlite`) + `.spatial-backup` export/import. Run `PRAGMA integrity_check` on boot and auto-recover from the newest healthy backup if `graph.sqlite` is corrupted[cite: 2].
2. **Local Quantized `all-MiniLM-L6-v2` ONNX Worker:**
   - Run `all-MiniLM-L6-v2` (int8 ONNX) inside an isolated Node `worker_thread` (`utilityProcess`) so UI frame pacing is never blocked[cite: 2].
   - Embed `[title, domain, keywords, metaDescription, stickyNotes, memoTitles]` on settle/update, caching the 384-dim vector in SQLite and feeding `spatial-core` for `< 1.5ms` Ghost Echo tethering[cite: 2, 3].
3. **Multi-Browser Importer (`browser-data-import.js`, `arc-import.js`, `bookmark-import.js`):**
   - Wire `/import` to ingest sessions, bookmarks, and URLs from **Chrome, Zen Browser / Firefox, Arc, Vivaldi, and HTML/text lists**[cite: 2].
   - All imported tabs MUST be **born hibernated** (`ramState: 'hibernated'`, 0 live renderers), grouped into suggested regions (`tab-import-organizer.js`), and processed by a throttled 1-at-a-time background thumbnail crawler[cite: 2].
4. **Gate & Tag:**
   - Import 700 tabs in **< 3 seconds** with **0 live renderers**; corrupt `graph.sqlite` and prove 100% automatic backup restoration → commit and tag `checkpoint/phase-5-700-tab-vault`[cite: 2].

---

### PHASE 6 — WORLD-CLASS TORTURE SUITE, BENCHMARK VS. ZEN/BLANC & RELEASE CANDIDATE
**Goal:** Complete Undo/Redo, multi-select canvas tools, filter chips, run the full heavy-tab torture matrix and competitive benchmark suite, and package the standalone Windows `.exe`[cite: 2].

1. **Final Polish & Ergonomics:**
   - **Main-Process Undo/Redo (`Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z`):** Reversible command stack for node moves, `tidyToMoodboard` grid snaps, deletions, and pin changes[cite: 2, 3].
   - **Canvas Multi-Select (`Shift+Drag`):** Marquee selection with a floating matte action bar (Pin, Hibernate, Move to Region, Tidy Selection, Delete)[cite: 2].
   - **Filter Chips:** Quiet filter pills in Mode B / Command Palette for Domain, Cold Archive (`> 14 days`), and Annotated (`notes` / `voiceMemos`)[cite: 2, 3].
2. **Execute the World-Class Heavy-Tab & Edge-Case Torture Matrix (Section 3 below):**
   - Run all stress, security, and heavy-web tests and write the measured results to `audits/phase-6-torture-and-benchmark-report.md`[cite: 2].
3. **Package & Final Gate:**
   - Write `FOUNDER_GUIDE.md` and run `electron-builder --dir` to produce the standalone Windows `.exe`[cite: 2].
   - Verify the packaged `.exe` passes every functional, visual, and performance gate → commit and tag `checkpoint/phase-6-release-candidate`[cite: 2].

---

## 3. MANDATORY REAL-WORLD TORTURE & BENCHMARK MATRIX (PHASE 3 & 6 GATES)

Before tagging the final release, the browser MUST pass and log real measurements for every test case below in `audits/phase-6-torture-and-benchmark-report.md`:

1. **Heavy WebGL2 / WebGPU & Design Tool Torture:**
   - Open simultaneous tabs on **Figma** (large multi-page design system), **Shadertoy** (complex raymarching shader), **Compute.Toys** (WebGPU fluid/particle sim), **Three.js** examples, and **Are.na** (infinite image scroll)[cite: 2, 3].
   - Verify 60–120fps WebGL/WebGPU execution in Mode A, clean WebP thumbnail capture on Mode B switch, and instant 0 MB RAM reclamation when evicted past the 6-tab warm pool[cite: 2].
2. **Media, Audio Immunity & Split-View Stress:**
   - Play a **4K 60fps YouTube** stream in Split View alongside a **Figma** or **GitHub** pane while opening 8 additional child branches via `Cmd/Ctrl+Click`[cite: 2, 3].
   - Verify the audible YouTube tab is **never** evicted by `enforceLivePool`, audio never glitches during Mode A ↔ Mode B transitions, and pausing audio for `< 2s` does not prematurely kill the tab[cite: 2, 3].
3. **Complex Auth, OAuth & SPA Navigation Chains:**
   - Test **GitHub / Google OAuth sign-in**, **Stripe checkout redirects**, and **SPA `pushState` navigation** (React.dev, MDN, Figma node-id links)[cite: 2, 3].
   - Verify `< 3s` redirect chains collapse into a single `viaAuth` node without spawning orphan popup nodes, and SPA `did-navigate-in-page` updates `subPages[]` filmstrips cleanly[cite: 3].
4. **Scale & Chaos Torture (1 to 1,000 Nodes):**
   - Verify 1st launch is 100% empty[cite: 2].
   - Bulk-import 700+ URLs: confirm `< 3s` import time, 0 live renderers spawned, `< 1.1 GB` total app RAM with 6 heavy tabs awake, and **≥ 60 fps** sustained pan/zoom across Macro (`< 0.35`), Compact (`0.35–0.65`), and Rich (`≥ 0.65`) LOD tiers[cite: 2, 3].
   - Force-kill the Electron process mid-write, corrupt `graph.sqlite`, relaunch, and verify automatic WAL/backup recovery restores 100% of user data[cite: 2].
5. **Security & Isolation Audit:**
   - Attempt to call `window.browserAPI` / Electron IPC from an untrusted `https://` page and a sandboxed `iframe`—verify `ipc-trust.js` blocks 100% of non-`blanc-chrome://` callers[cite: 2].
   - Verify `noCapture` private tabs never write WebP thumbnails or Readability excerpts to disk[cite: 3].
6. **Head-to-Head Benchmark Table:**
   - Record measured Cold Start (ms), Idle RAM (MB), 6-Heavy-Tab RAM (MB), 100-Sleeping-Tab RAM (MB), and Tab Switch Latency (ms) comparing **Spatial Browser** against **Upstream Blanc** (`research/blanc-src/`) and reference **Zen Browser / Chrome** baselines[cite: 2].

---

## ADDENDUM: LOCAL MCP SERVER BRIDGE (`browser/src/main/mcp-server.js`)

Instead of bloating the UI with an in-browser AI chat sidebar, expose the Spatial Browser as a local Model Context Protocol (MCP) server from the Electron main process (`127.0.0.1` local-only transport + stdio CLI wrapper):

1. **Read Tools:**
   - `get_active_tab`: Returns active node metadata, `excerpt` (Readability markdown), `subPages`, and `StickyNote`s for its `urlHash`.
   - `get_neighbourhood`: Returns the 1-hop and 2-hop connected nodes and edges (`selectNeighbourhood`).
   - `search_spatial_graph`: Searches across all live/hibernated nodes, regions, and sticky notes (`selectSearchResults`).
2. **Write Tools (Honoring "The System Pays, the User Confirms"):**
   - `branch_hibernated_nodes(parentUuid, targets[])`: Spawns child satellite nodes around `parentUuid` with `ramState: 'hibernated'` (0 MB RAM) or `nodeType: 'ghost-echo'` so external agents never evict the user's 6-tab live warm pool.
   - `add_sticky_note(url, text)`: Attaches a sticky note to the canonical `urlHash`.
   - `tidy_region_moodboard(regionId)`: Runs `tidyToMoodboard(regionId)` to snap unpinned cards into the 16:10 contact sheet while preserving `isPinned` anchors and all graph edges.
3. **Security & Privacy Guardrails:**
   - Strictly strip any node where `noCapture === true` or `viaAuth === true` from all MCP responses.
   - Never expose cookies, `sessionStorage`, credentials, or `ipc-trust.js` tokens over MCP.

### Addendum hardening notes (2026-11-15, adopted with the addendum)
- **Per-launch bearer token:** a 127.0.0.1 port is reachable by EVERY local process — the HTTP transport MUST require a bearer token generated at browser launch and handed only to the stdio CLI wrapper (env), and reject unauthenticated calls. Never log the token.
- **Private tabs excluded entirely:** Blanc private-session tabs are never recorded anywhere — MCP responses exclude them in addition to the noCapture/viaAuth strip.
- **Writes route through main-process command paths:** every MCP write tool calls the same store/main actions the UI uses (never direct vault/DB writes) so undo, persistence and edge consistency hold.
- **Unit tests** for the pure handler parts live under `browser/tests/` (stripping rules, token rejection, url_hash dedupe for branch_hibernated_nodes).

---

## ADDENDUM B — 3-STAGE ISLAND CONTINUUM, PATH-PRESERVING TRAILS, INVISIBLE PLUMBING, LIVE MODS & STUDIO PLUGINS (2026-11-15, founder directive — BINDING for Phase 3+)

Read alongside Phases 3–6 above. Integrate into Phase 3 (`browser/` Electron main + `app/src/` shell) and Phase 5 (SQLite vault). Positioning: we are NOT building another chat-sidebar browser — this is the 3-Stage Progressive Spatial Continuum that keeps Blanc's ultra-calm resting pill while solving the 600+ tab problem the moment the user interacts.

### B.0 LAW OF MODULARITY
Every power feature below (Live Mods, Studio Plugins) is a **toggleable, zero-clutter module** managed from a clean "Studio & Mods" tab inside `ExtensionsDrawer.tsx` (quick-toggles `/mods` and `/plugins` in `FloatingIslandPill.tsx`). Toggled off = **0 px screen real estate + 0 MB background overhead**; the resting `BrowserTopBar.tsx` and `SpatialCanvas.tsx` stay 100% matte-neutral.

### B.1 STAGE 0 — RESTING ISLAND PILL + VISUAL DOT-MORPH (Mode A default)
- Geometry: Blanc's floating pill, top-center, 36–40px height, matte graphite (`--bg-glass`/`#121215`), `1px var(--border-subtle)` hairline, Warm-Paper support.
  - Left cluster: `<` Back, `>` Forward, up to **6 Smart Relational Dots** (`selectPillNeighbours`: came-from parent, live siblings, high-confidence Ghost Echo ≥ 0.78).
  - Center trigger: active favicon + domain (`blanc.day` style) → click opens Stage 1; `Cmd/Ctrl+L` opens Stage 1 with input focused. `isLoading` pulse, `isAudible` waveform, `isRecording` dot.
  - Right cluster: `+` (new tab), Adblock Shield w/ blocked count, Reload `↻`, Pin/Heart anchor toggle, Close `×`.
- **Dot-morph hover:** hovering a dot springs it into that tab's 16px favicon (`stiffness 380, damping 30`) and drops a compact matte-glass **Visual Peek Card** (~232px wide): `16:10` cached WebP preview (even if sleeping @ 0 MB), full title, domain, and relationship subtitle in `var(--ink-muted)` (`↳ Branched from Are.na · Live` / `Sleeping · 0 MB`) — the WHY, not just the what.

### B.2 STAGE 1 — EXPANDED DUAL-HORIZON ISLAND DECK (click island or `Cmd/Ctrl+L`)
Morph via `layoutId="floating-island"` into a 720–760px wide (max `calc(100vw-24px)`) matte-glass popover (`var(--bg-elevated)`, `var(--shadow-pop)`, `rounded-[20px]`):
- **Native `WebContentsView` Z-Order Guard (mandatory):** on open, `capturePage()` the active view → crisp static backdrop; `view.setVisible(false)` until close; `backdrop-filter: blur(20px)` renders cleanly above the page.
- **Header row (48px):** security lock + unified omnibox (URL / search / `!bang` / `/command`), `<` `>` `↻`, Live-Mod trigger, Split-View toggle, Pin toggle, Collapse `^`.
- **Horizon 1 — Active Working Session (`ramState === 'live'`):** header `Active session · {n}` + quiet `Park session ☾` action (`parkSessionToArchive()`); horizontal strip of live pills (favicon, readable title, audio indicator, per-pill `☾` = `parkNodeToArchive(uuid)`).
- **Horizon 2 — Sleeping Visual Archive (`ramState === 'hibernated'`, 0 MB):**
  - Filter bar: `All · {count}`, per-Flow/Region chips with counts, `Ghost Echoes · {n}`, `Notes · {n}` + instant fuzzy filter.
  - **3–4 column 16:10 Visual Bento Scrub Grid** (`max-h-[340px]`, smooth scroll): thumbnail cards; **In-Place Stack Scrubbing** — a parent with `childCount > 0` shows a `+N` badge and a segmented scrub bar; sweeping the cursor across the card previews each child's thumbnail+title in place (video-timeline scrub, NOT Vivaldi's nested flyout column); **1-Hop Trail Connectors** — hovering a card lights sibling/parent cards sharing a `spawn`/`visit` edge (`var(--border-active)`) with a subtle 1px hairline between them; `via "Parent Title"` provenance line; click wakes (`openNodeInViewport`) and closes.
- **Footer Utility Dock (40px):** left `+ New tab (Ctrl+T)`, `Sandbox (/sandbox)`, `Sleep session`; right Workspaces/Flows, Notes & Memos, Trail History, Downloads, Split View, **Studio Plugins & Mods (`Puzzle`)**, primary `[ ⤢ Open Spatial Canvas (Cmd+Space) ]`.

### B.3 STAGE 2 — FULL MODE B CONTINUUM
Clicking the Canvas button, pressing `Cmd/Ctrl+Space` (`Alt+Space`), or pinch-zooming out on the Stage 1 popover expands it into the full-viewport `SpatialCanvas.tsx`. The pill remains anchored top-center in Mode B — one consistent anchor across the whole browser.

### B.4 ELASTIC ISLAND DISCLOSURE (3 tabs → 600+ tabs, never a forced mega-grid)
- **Compact Mode (`totalNodes ≤ 8` and `hibernatedCount === 0`):** Blanc-minimal `480px`: omnibox header + clean vertical open-tab list (1-level indent for branched children) + utility row. Hide all Archive headers/filter bars when nothing is hibernated.
- **Expanded Deck Mode (`totalNodes > 8` or `hibernatedCount > 0`):** spring-widen (`760px`) to the dual-horizon deck of B.2.

### B.5 FLOWS REPLACE WALLED WORKSPACES & BOOKMARKS
- A `Region` is reframed as a **Flow — a non-exclusive rooted tab tree** living in the same global session. Wake and work tabs from multiple Flows simultaneously; no workspace switcher, no context switch, nothing hidden.
- **Pinning replaces bookmarks:** the Heart/Pin (`pinNode`) marks a permanent anchor in its Flow; parked-to-0MB pinned nodes keep their 16:10 thumbnail + StickyNotes in the Flow tree. No separate bookmark folders.
- **Satellite Flow Notches:** with ≥2 active Flows (or a pinned Flow), render compact Satellite Pills (32px, `rounded-full`, `bg-surface-glass`, hairline) flanking the main island: 6px `region.color` dot + Flow name + `· count`. Hover → focused 320px mini-tree popover (root anchor + branched child thumbnails). Click a node → wakes into the current session without hiding other Flows. Click the pill header → Mode B pans (`fitView`) to that Flow's bounding box.

### B.6 WORKING-SESSION GUARDRAILS (`useGraphStore.ts`)
- Replace the hard `LIVE_POOL_LIMIT = 5` with user-configurable `performanceGuardrail: { maxLiveSessionTabs: 25 | number('5..100') | 'unlimited'; idleHibernateMinutes: 60 | 15|30|60|'never'; ramCeilingMb?: number }`.
- `enforceLivePool` evicts the oldest non-immune live tab only past the ceiling; **immune: `isPinned`, `isAudible` (2.5s pause debounce), `recordingNodeId`** — never killed behind the user's back.
- New actions: `parkNodeToArchive(uuid)` (hibernate + leave `workbenchUuids`), `parkSessionToArchive()` (all non-active, non-immune live tabs → 0 MB).
- Startup restoration: persisted tabs boot `hibernated` (0 MB), showing cached WebPs in Stage 1/2. First run stays 1 clean New Tab (`https://new-tab.spatial/local`); `/seed-700` stays out of user UI (Phase 1.5 law); `window.__devStressSeed` is bench-only.
- Fix `browser/`'s `document-policy.js` so `Cmd/Ctrl+Click` / `target="_blank"` branches spawn fresh main-process tabs (`noopener` + `parentUuid`) and are NEVER `inheritsDocumentPolicy`.

### B.7 PATH-PRESERVING TRAILS (core graph lineage)
1. **Rich provenance on every spawn edge** (`GraphEdgeRecord`/`SpatialTabNodeRecord` in `types.ts`; `spawnChildNode` in `useGraphStore.ts`; Electron link interceptor `tab-view.js:495-514, 687-715`): capture `anchorText` (exact clicked text/alt), `contextSnippet` (≤140 chars of surrounding sentence), `scrollYAtSpawn`. Hovering a spawn edge / node in `NeighbourhoodGlance.tsx` surfaces `via "Klim Söhne specimen"` in muted `var(--ink-muted)`.
2. **Cross-Domain In-Place Navigation Guard:** in `navigateActiveNode(url, title)` — same-domain click → append previous URL/title to `subPages[]` filmstrip (cap 20); cross-domain click (`domainOf(newUrl) !== node.domain`) → do NOT overwrite: freeze the previous domain as a hibernated parent node (0 MB) at the current `(x, y)` and spawn the new domain as the active connected child (`kind: 'spawn'`) one step forward — the breadcrumb chain preserves itself.
3. **Trace Rabbit Hole (full-chain lineage illumination):** hover = 1-hop neighbors (`opacity 1`, stroke `var(--ink-primary)` @ 0.45); **Alt+Hover** (or "Trace trail" in Glance) walks `parentUuid` + incoming `spawn`/`visit` edges upstream to the root hub and downstream to all descendants — the entire chronological research chain illuminates while unrelated clusters dim to `opacity 0.18`.

### B.8 THE 6 INVISIBLE PLUMBING GATES (`browser/` main + `tab-view.js`) — MANDATORY PHASE 3 EXIT ITEMS
1. **Keyboard focus arbitration:** `webContents.on('before-input-event')` on EVERY `WebContentsView` intercepts shell shortcuts before the page sees them and forwards to the `blanc-chrome://` shell: `Cmd/Ctrl+Space` & `Alt+Space` → canvas, `Cmd/Ctrl+L` → palette, `Cmd/Ctrl+S` → rail, `Cmd/Ctrl+Shift+G` → glance, `Cmd/Ctrl+/` → shortcuts, `Alt+N` → quick note, `Cmd/Ctrl+F` → find bar, `Esc` → layered dismissal.
2. **External OS protocol handoff:** in `will-navigate`/`setWindowOpenHandler`, route non-HTTP(S) app schemes (`figma://`, `vscode://`, `cursor://`, `mailto:`, `discord://`, `spotify://`, `slack://`) to `shell.openExternal(url)` behind a clean confirmation toast — never a broken blank node.
3. **Builder ergonomics:** `Cmd/Ctrl+Shift+R` → `reloadIgnoringCache()`; `Cmd/Ctrl+Alt+I`/`F12` → `toggleDevTools()` for the focused pane; "Inspect Element" at cursor on right-click.
4. **Session partitions:** optional `partition` field on `SpatialTabNodeRecord` (`'default' | 'sandbox'` / `persist:region-<id>`); `/sandbox` spawns a live tab in isolated `session.fromPartition('temp:sandbox')` for logged-out localhost/client testing.
5. **Native file drag-and-drop:** OS file drags pass into `WebContentsView` upload dropzones; drag-out of a view to the desktop triggers native Chromium download; `will-download` progress UI + `Cmd/Ctrl+J`.
6. **Widevine DRM & hardware decode:** when stripping telemetry/updaters, preserve castLabs ECS Electron 45.2.1 Widevine CDM init + GPU rasterization flags (Spotify Web, Apple Music, 4K) + Ghostery/uBlock + 1Password.

### B.9 ZERO-EXTENSION "LIVE MODS" ENGINE (`browser/src/main/live-mods.js`)
- Domain-keyed mod records `{ id, domainPattern, name, enabled, css, zapSelectors: string[] }` in the store / Phase 5 vault. On `dom-ready` + `did-navigate-in-page` of a matching view, inject `zapSelectors.join(', ') + ' { display: none !important; }\n' + css` via `webContents.insertCSS(compiled, { cssOrigin: 'user' })`; `removeInsertedCSS(key)` on toggle-off.
- **Interactive Element Zapper (`/zap`, armed `Alt+Shift+Click`):** hovered elements get a crisp `1px solid rgba(255,255,255,0.35)` outline; clicking a sticky banner/modal generates a resilient CSS selector, hides it immediately, and saves to that domain's `zapSelectors[]`. Survives reload.
- **Per-domain CSS scratchpad** (JetBrains Mono, scoped to `activeNode.domain`) + 3 one-click presets: **Matte Reader** (strip sidebars/ads, `65ch` measure, clean type), **Desaturate Chrome** (dims noisy UI until hover), **Force Paper / Graphite Surface** (clean dark/warm-paper override for unstyled docs).

### B.10 TOGGLEABLE STUDIO PLUGINS (`app/src/lib/plugins.ts` + preload injected only while active)
- **Plugin A — Token & Typography X-Ray (`/xray`):** hovering any element shows a compact matte HUD pill (`#18181C`, 1px hairline): resolved `@font-face` family, weight, size, line-height, letter-spacing; text/bg color in HEX **and** OKLCH; computed `transition`/`cubic-bezier()`. **Click to capture:** formats the tokens to Markdown → `addStickyNote(activeNode.urlHash, spec)`.
- **Plugin B — Drag-to-Clip Media Cards:** extends `parseSpatialDrop` (Pill) + drop handler (Canvas): dragging `<img>`/`<svg>`/`<video>` from a live page extracts the source URL, caches a local copy into `userData/media/`, and spawns a node tagged `mediaClip: { kind: 'image'|'video'|'svg', src, sourcePageUrl }` connected to `activeNodeUuid` via a `spawn` edge. Media cards render edge-to-edge art with source-domain attribution on hover — zero-friction Eagle/Are.na moodboarding beside full web tabs.
- **Plugin C — Shader & Motion HUD (`/shader-hud`):** detects `<canvas>` elements, reports context type (`2d`/`webgl2`/`webgpu`), pixel resolution, live frame time (ms/fps); **5-Second Motion Loop Capture** records a `640×400` WebM compositor loop attached to the node so `RichCard` plays it on hover in Mode B.
- **Plugin D — Split-View Responsive & Onion-Skin Compare:** extends the existing 2-pane split: right-pane header with breakpoint presets (`1440/1024/768/375`) via `webContents.enableDeviceEmulation()`; **Onion-Skin Overlay** superimposes a translucent snapshot of the left reference pane over the right pane (`opacity 0.0–1.0` slider + `mix-blend-mode: difference` toggle) for pixel-matching.

### B.11 RESOURCE & CHECKPOINT PROTOCOL (founder directive, 2026-11-15)
- **Envelope: ~200M tokens / ~12 hours** for Phases 3–6. Budget discipline is mandatory: agents read only named spec sections/files (never >400-line whole files), ALL build/install/test output is piped to files (read exit code + last 40 lines only), no raw tool-output flooding.
- **Every stage ends with a git commit (checkpoint)** so no completed work is ever lost between token pools; phase tags (`checkpoint/phase-N-*`) remain the only release boundaries. Work interrupted mid-stage survives on disk and the next session audits-then-completes, never restarts from scratch.
- The goal, scope, and workflow are documented in-repo: this addendum + `HANDOFF.md` §8 stage table.

### B.12 VERIFICATION & EXIT CRITERIA FOR THIS ADDENDUM (Phase 3 gates)
1. **Trail Preservation Test:** a 4-step cross-domain research chain + 3 branched children shows `anchorText`/`contextSnippet` in Glance; cross-domain in-place clicks preserve the prior domain as a hibernated parent; `Alt+Hover` illuminates the full multi-hop chain.
2. **Plumbing Test:** focused inside a live YouTube/Figma view, `Cmd/Ctrl+Space` and `Cmd/Ctrl+L` still fire (before-input-event); `figma://` hands off to the OS with a toast.
3. **Live Mods & Plugins Test:** zap an element → reload → stays hidden; X-Ray a heading → typography spec lands in the node's StickyNote; drag an image onto the pill → a connected media card spawns on the canvas.
4. **Island Continuum Test:** resting pill dot-morph peek cards; Stage 1 dual-horizon deck with live strip + 0 MB scrub grid; elastic compact↔expanded transition; satellite flow notch hover/click behaviors; Stage 1 → Stage 2 expansion. All under the Anti-Slop checklist (matte, sentence case, canonical vars, spring motion only).
