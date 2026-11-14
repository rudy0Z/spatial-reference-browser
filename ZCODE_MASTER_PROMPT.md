# MASTER EXECUTION PROMPT — Spatial Reference Browser (Phase 1 Checkpoint → Shipping Desktop Release Candidate)

You are picking up an existing workspace (`D:\Fivem\new brosser`) to take a new kind of spatial graph browser from its Phase 1 mock prototype all the way to a **clean, modern, daily-driver desktop browser** built for a **designer power-user with 600–700+ open reference tabs**.

Read `HANDOFF.md`, `app/SPEC.md`, `research/spatial-graph-browser-analysis.md`, and `research/blanc-src/AGENTS.md` before writing any code. Where this Master Prompt updates or overrides `HANDOFF.md` or `app/SPEC.md` (specifically on **visual design**, **warm-pool canvas architecture**, **Rust core**, and **Chrome extension support**), **THIS DOCUMENT WINS.**

---

## 1. WHO THIS IS FOR & WHY THE CURRENT UI MUST BE REDESIGNED A-TO-Z

### The User & Core Problem
The founder is a **designer and power user** who naturally accumulates **600–700 open tabs** (visual references, Are.na boards, Dribbble/Cosmos/Behance shots, live studio websites, typography foundries, Figma files, shaders, docs) because designers need their visual references nearby and accessible. Traditional tab strips collapse at 600 tabs. An **Obsidian-like spatial node graph**—where sleeping tabs cost `0 MB` RAM, keep their visual preview and parent→child trail, and live inside calm spatial neighborhoods—solves this.

### Brutal Design Verdict on Current `app/`: Fix the "AI Slop" Completely
Although `app/` passed functional TypeScript checks, visually it looks like **cheap sci-fi AI slop** rather than a real browser a designer would ever bear to use:
1. **Kill the cyber-dashboard neon palette:** Remove all neon emerald (`#34D399`) borders and glowing box-shadows, purple dashed `GHOST ECHO · 92% MATCH` boxes, yellow-tinted sticky boxes, rainbow procedural gradient fake thumbnails, and glowing radial region circles (`textShadow: 0 0 26px`).
2. **Kill the debug-badge diarrhea on cards:** Currently a 260px card screams up to 8 uppercase `9px` monospace pills (`LIVE · 138 MB`, `SLEEP · 0 MB`, `UNREGIONED`, `COLD ARCHIVE · 22d`, `VIA AUTH`, `WB`, `ANCHOR`, `⚡ WAKE HERE`). **Never print internal database states as uppercase pills across 700 cards.** A designer looking at 700 visual references needs **quiet frames where the website preview image is the hero**, not server-monitoring telemetry badges.
3. **Kill marching-ants animated lines:** Endless dashed `stroke-dasharray` animations across hundreds of edges cause visual fatigue. Use **Obsidian Minimal** graph physics: calm `1px` static curves (`rgba(255,255,255,0.07)`) at rest; hovering a node softly illuminates its 1-hop lineage (`rgba(255,255,255,0.45)`) and dims unrelated clusters (`opacity: 0.25`).
4. **Make Mode A feel like a real flagship minimal browser (Zen Browser × Blanc Browser):** Mode A cannot feel like a toy demo screen with a tacky shortcut-legend pill stuck at the bottom-left. It must have real browser ergonomics: ultra-clean frameless chrome, Back / Forward / Reload, unified URL & Command Bar (`Cmd/Ctrl+L`), optional **Zen-style ultra-slim collapsible sidebar** (`Cmd/Ctrl+S`) alongside **Blanc-style minimal floating top pill**, Split View, Glance peek, quiet Extensions overflow popover, and instant Canvas toggle (`Cmd/Ctrl+Space` / `Alt+Space`).

---

## 2. LOCKED TECHNICAL ARCHITECTURE (ENGINE + RUST + CHROME EXTENSIONS)

Do **not** attempt a 150 GB C++ Chromium source build or an experimental engine like Servo/Tauri (Tauri/OS WebViews cannot run Chrome extensions or control multi-tab renderer hibernation, and Servo breaks Figma/WebGL/OAuth). Instead, build this exact **three-layer hybrid stack** (both `node v24.14.1`, `git 2.53`, and **`cargo 1.95.0` (Rust)** are already installed on this machine):

1. **Browser Engine & OS Shell → Fork Blanc v1.48.0 (`research/blanc-src` → `browser/`):**
   - Electron 45.2.1 (**Chromium 156**): 100% Chrome rendering parity on Figma, Framer, WebGL/WebGPU, passkeys, and OAuth.
   - Inherit Blanc's battle-tested subsystems unchanged: network-layer Ghostery adblocking, bundled optional **uBlock Origin**, **1Password** desktop integration, `quietTab`/`wakeTab` renderer hibernation, 3-tier `closed-tabs.js` undo, Split View, Floating Glance, and strict `ipc-trust.js` / `chrome-protocol.js` security gates.
2. **High-Performance Graph, Layout & Search Core → Rust (`crates/spatial-core`):**
   - Compile a dedicated Rust crate (`cargo 1.95.0` → WebAssembly SIMD for the canvas renderer + Node/IPC bindings where needed) that owns every hot path that slows down at 700–2,000+ tabs:
     - **Spatial R-Tree / Quadtree** for `<0.5ms` frustum culling & hit-testing at 1,000+ nodes.
     - **Hybrid Force + Moodboard Grid Solver** (`fx`/`fy` pinned anchors strictly locked; satellite relaxation + clean non-overlapping masonry/contact-sheet grid tidy for reference clusters in `<1ms`/tick with zero JS GC pauses).
     - **Vector Cosine + Co-Visitation + Fuzzy Search Index** (`<1.5ms` search and Ghost Echo scoring across 2,000+ tabs, URLs, domains, and notes).
3. **Two-Mode Warm-Pool Rendering (DO NOT put 8 live `WebContentsView`s on the zoomed canvas):**
   - *Correction to `HANDOFF.md` §7.4–7.6:* In Electron, child `WebContentsView`s are native compositor surfaces painted **above** the window's HTML DOM—placing 6–8 live views on a zoomable canvas punches over React UI/hover buttons/notes, hijacks scroll-wheel zoom, and stutters on per-frame `setBounds()`.
   - **Instead:**
     - **Mode A (Browsing / Split / Glance):** Uses real native `WebContentsView`s at full 120fps (keeping an LRU warm pool of 5–6 live tabs in RAM; auto-quieting the oldest non-audible, unpinned tab beyond the cap).
     - **Mode B (Spatial Graph Canvas):** Hides child `WebContentsView`s on toggle after capturing crisp retina WebP snapshots (`capturePage()` guarded by `navEpoch`, stored on disk, never bloating JSON). Mode B runs as **100% pure GPU-accelerated DOM/Canvas at locked 120fps across 700+ nodes**. Clicking any node swaps back to Mode A in `<16ms` if warm in the pool, or wakes it lazily via `wakeTab`.
4. **Chromium Extensions Support → Electron `session.extensions` + `electron-chrome-extensions`:**
   - Wire `electron-chrome-extensions` + Electron's `session.extensions.loadExtension()` onto the regular profile session so `chrome.tabs`, `chrome.windows`, `chrome.scripting`, `chrome.storage`, `chrome.contextMenus`, and `chrome.action` / `chrome.browserAction` toolbar popups work.
   - Build a clean **`Settings → Extensions`** manager + quiet toolbar popover supporting both **Load Unpacked Folder** and **1-Click Install via Chrome Web Store URL / Extension ID** (fetches CRX3, strips header, extracts to `userData/extensions/<id>`, validates `manifest.json`, and displays a clear capability badge if an extension requests unsupported Google-proprietary APIs like `chrome.identity`).

---

## 3. MANDATORY CLOSED-LOOP WORKFLOW PROTOCOL

You must execute the phases below **strictly one by one, in order**. Never batch multiple phases without verification, and never advance to Phase `N+1` until Phase `N` passes **every** gate in this loop:

1. **Implement** cleanly with strict types, modular boundaries, zero `any`, zero `TODO` stubs, and zero dead UI buttons.
2. **Deterministic Build & Test Gate:**
   - *Windows machine note:* If `npm` `.cmd` spawning fails in your runner, invoke `node` entrypoints directly (`node .../typescript/bin/tsc`, `node .../vite/bin/vite.js`, `node --test`, `cargo test --release`). Every check must exit `0`.
3. **Live Runtime + Visual Screenshot & Anti-Slop Gate:**
   - Launch the actual running app (Vite in Phase 1.5; real Electron `browser/` from Phase 3 onward).
   - Capture screenshots in both **Mode A (Browsing)** and **Mode B (Canvas at Macro, Compact, and Rich zoom on 700 nodes)**.
   - Inspect the screenshots critically against the **Anti-Slop Checklist**:
     - [ ] Zero neon emerald/violet/amber glowing borders or sci-fi pills.
     - [ ] Zero uppercase debug badges (`SLEEP · 0 MB`, `UNREGIONED`, `WB`, `ANCHOR`, `COLD ARCHIVE`, `WAKE HERE`).
     - [ ] Zero clipped, colliding, or unreadable text at 100% and 125% Windows DPI scaling.
     - [ ] Zero marching-ants edge animations; Obsidian-style 1-hop hover illumination works smoothly.
     - [ ] Pan/zoom frame pacing measured via `requestAnimationFrame` delta benchmark at 700 nodes (`≥55 fps` sustained, `<2%` dropped frames).
   - **If anything fails or looks cheap, fix it inside the same phase loop and re-verify before moving on.**
4. **Git Checkpoint Commit & Tag:**
   - Commit clean working state and create the phase's annotated git tag (`checkpoint/phase-...`) so every milestone is permanently recoverable.

---

## 4. PHASE-BY-PHASE EXECUTION PLAN

### PHASE 0 — Git Repo Setup & Phase 1 Prototype Checkpoint
**Goal:** Preserve the existing Phase 1 prototype untouched as a permanent checkpoint before changing a single line of product code.
1. Initialize a git repository at `D:\Fivem\new brosser` (`git init`).
2. Copy `research/blanc-src/.gitattributes` rules to root `.gitattributes` (specifically enforcing `eol=lf` on `**/adblock/sources/*.txt`, `**/adblock/sources/pinned.json`, and `**/adblock/generated/*.json` — without this, Windows CRLF conversion makes Blanc's packaged adblocker fail closed!). Add a sensible root `.gitignore` (`**/node_modules/`, `**/dist/`, `**/target/`, `.zcode/workflow-runs/`).
3. Stage and commit the current baseline (`app/`, `HANDOFF.md`, `out/`, `research/`) and tag it **`checkpoint/phase-1-prototype`** + create branch **`archive/phase-1-prototype`**.
- **Exit Gate:** `git tag -l` lists `checkpoint/phase-1-prototype`; `git status` is clean.

---

### PHASE 1.5 — Complete A-to-Z Visual Redesign ("Zen × Blanc × Obsidian Minimal")
**Goal:** Transform `app/` from a sci-fi prototype into a studio-grade, minimalist designer browser UI before wiring it into Electron.
1. ** Palette & Token System (`app/src/index.css`):**
   - Replace the tactical-neon theme with a refined, dead-neutral architectural palette (supporting Dark default + crisp Warm Paper Light mode):
     - Dark surfaces: `--bg-canvas: #0B0B0D`, `--bg-chrome: #121215`, `--bg-card: #18181C`, `--bg-elevated: #202026`, `--border-subtle: rgba(255,255,255,0.065)`, `--border-hover: rgba(255,255,255,0.14)`, `--ink-primary: #F3F3F5`, `--ink-secondary: #8E8E96`, `--ink-muted: #5A5A63`.
     - **Reference thumbnails own 100% of the color.** Active state uses a crisp `1px solid rgba(255,255,255,0.28)` hairline + subtle soft elevation shadow—never neon green glows.
   - Typography: `Instrument Sans` or `Inter Variable` (`-0.015em`) in clean sentence case; `JetBrains Mono` strictly for URLs and `<kbd>` hints.
2. **Redesigned Browser Chrome (Mode A):**
   - Build a cohesive **Zen / Blanc hybrid shell**:
     - Sleek top command bar OR user-toggleable **Zen-style compact vertical tab/cluster rail (`Cmd/Ctrl+S`)** that collapses cleanly to full-bleed reading.
     - Real browser controls: Back, Forward, Reload, Security/Shield indicator, clean centered domain/title trigger (`Cmd/Ctrl+L` morphs into a fast Raycast/Blanc command & search palette), Split View toggle, Neighbourhood Glance drawer (`Cmd/Ctrl+Shift+G`), Extensions button, and Canvas toggle (`Cmd/Ctrl+Space` / `Alt+Space`).
     - Remove the permanent bottom-left `ShortcutLegend` pill; move shortcuts into a clean `?` / `Cmd+/` modal sheet.
3. **Redesigned Spatial Graph & Designer Reference Cards (Mode B):**
   - **Visual-first Reference Card (`260px` wide):** Edge-to-edge `16:10` preview image at top (`rounded-t-[10px]`), clean `36px` minimal footer with `14px` site favicon, 1-line truncated title (`12.5px`), and muted domain (`11px`).
   - **Silent State Grammar (Zero Badge Spam):**
     - Live tab = tiny `5px` subtle indicator dot next to favicon.
     - Hibernated tab = clean resting card, zero `SLEEP · 0 MB` badge.
     - Cold Archive (>14 days untouched) = smooth `opacity: 0.58` + slight desaturation, zero `COLD ARCHIVE` text chip.
     - Pinned anchor = tiny subtle corner pin icon visible when pinned or hovered; never show `<PinOff/>` or `UNREGIONED` or `WB`.
     - Ghost Echo = subtle translucent frosted card (`opacity: 0.55`, `1px solid rgba(255,255,255,0.12)`) softly tethered nearby with a quiet *"Related earlier"* hover action (`Open` / `×`).
     - Hovering a card reveals a clean floating 4-icon micro-toolbar in the top-right corner of the thumbnail: `Open`, `Pin`, `Note`, `Sleep/Close`.
   - **Obsidian-Style Calm Graph Edges & Regions:**
     - Static `1px` smooth curves (`rgba(255,255,255,0.07)`). Hovering a node highlights its 1-hop parent/child path (`rgba(255,255,255,0.45)`) and softly dims non-neighbors.
     - Regions render as understated, soft matte architectural zones with clean editorial labels—no glowing neon circles.
     - Add **"Tidy to Moodboard Grid"** action on any Region/selection so a designer can snap scattered reference cards into a crisp aligned contact-sheet grid while preserving all graph edges!
   - ** realistic 700-Tab Designer Seed (`/seed-700`):** Replace tech-bro filler in `seed.ts` with 700 realistic designer/creative-director tabs across 7 authentic clusters (Visual References, Typography & Foundries, Studio Portfolios, Product UI Benchmarks, Shaders & Motion, Active Figma Projects, Technical Docs) with realistic clean editorial SVG/canvas preview renders (no garish rainbow gradients).
- **Exit Gate:** `tsc -b` + `vite build` exit 0; screenshot audit in headless/live browser confirms zero AI slop and Zen/Blanc-grade restraint; tag **`checkpoint/phase-1.5-clean-design`**.

---

### PHASE 2 — Rust Spatial, Physics & Search Core (`crates/spatial-core`)
**Goal:** Guarantee effortless 120fps responsiveness at 700–2,000+ reference nodes by moving spatial indexing, layout math, and search/similarity scoring into compiled Rust.
1. Create `crates/spatial-core` using the installed `cargo 1.95.0` toolchain (compile to WebAssembly via `wasm32-unknown-unknown` / `wasm-bindgen` or native Node addon so both the canvas and main process can use it, with a clean typed TypeScript wrapper in `src/lib/spatialCore.ts`).
2. Implement in Rust:
   - **2D R-Tree / Grid Spatial Index:** Sub-millisecond viewport bounding-box queries + nearest-neighbor hit-testing for 2,000+ nodes.
   - **Hybrid Force + Moodboard Layout Engine:** Enforces `fx`/`fy` immobility on pinned anchors (never auto-move user-placed nodes!), relaxes newly spawned child satellites around parents, and computes non-overlapping **Moodboard Grid / Pack** coordinates for selected clusters.
   - **Fast Search & Ghost Echo Scorer:** Tokenized fuzzy search + 384-dim cosine similarity + co-visitation matrix + recency decay (`0.55·cosine + 0.30·coVisit + 0.15·recency`) executing in `<1.5ms` at 1,000 nodes.
3. Wire `app/` to `spatial-core` and add deterministic Rust unit + micro-benchmark tests (`cargo test --release`).
- **Exit Gate:** `cargo test --release` passes; benchmark logs `<2ms` for 1,000-node layout + search; 700-node `/seed-700` pans at sustained `≥55–60fps`; tag **`checkpoint/phase-2-rust-core`**.

---

### PHASE 3 — Real Browser Engine Integration (Blanc Fork + Two-Mode Warm Pool)
**Goal:** Turn the redesigned UI + Rust core into a real Chromium 156 desktop browser by forking `research/blanc-src` into `browser/`.
1. **Clean Fork & De-Branding (`research/blanc-src` → `browser/`):**
   - Keep `research/blanc-src` 100% untouched. Copy it into `browser/`.
   - Rebrand `name`, `productName`, icons, and UI strings to a clean new browser identity so `brand:check` passes.
   - **Strip upstream phone-homes immediately:** Disable `src/main/telemetry.js` network pings, disable `electron-updater` pointing at Blanc's GitHub repo, stub/disable `blanc.day` Sync/Patron endpoints, and decouple Blanc's hardcoded Apple SHA-1 certificate check (`preflight-mac-signing.mjs`) for local Windows builds while keeping `adblock:check` green.
   - Verify stock `browser/` launches and browses real websites cleanly first.
2. **Mount the Redesigned Spatial Shell (`blanc-chrome://`):**
   - Build `app/` assets into `browser/src/renderer/spatial/` and register it under Blanc's fail-closed `chrome-protocol.js` + `ipc-trust.js` (`chromeOn` / `chromeHandle` sender verification—never weaken `contextIsolation: true, sandbox: true, nodeIntegration: false`).
   - Make the main process the **single source of truth** (`node-model.js`, `canvas-layout.js`, `graph-ipc.js` written as pure unit-testable modules in Blanc's style).
3. **Implement Two-Mode Warm-Pool Views + Real WebP Thumbnails:**
   - **Mode A:** Active tab (or 2–4 tabs in Blanc's Split View + Floating Glance) renders via real `WebContentsView` positioned cleanly below the minimal top bar / beside the collapsible Zen rail. Maintain an LRU warm pool of **6 live tabs**; opening a 7th automatically calls `quietTab` on the oldest non-audible, non-recording, unpinned tab.
   - **Mode B (`Cmd/Ctrl+Space` / `Alt+Space`):** Capture a fresh `640×400` WebP thumbnail (`webContents.capturePage()`, guarded by `navEpoch` so stale navigations never overwrite thumbnails; blur/skip `private` and `noCapture` tabs), hide child `WebContentsView`s (`setVisible(false)` respecting Blanc's Windows/Linux lifecycle rules in `tab-view-lifecycle.js`), and cross-fade into the pure 120fps Spatial Graph Canvas. Clicking any node wakes/focuses its `WebContentsView` seamlessly.
4. **Real Link-Branching & Fix the `inheritsDocumentPolicy` Trap:**
   - Tag user link clicks in preload; `Cmd/Ctrl+Click`, middle-click, or Graph-Branch mode spawns a connected child satellite node + directional edge. Never fork `POST` submissions, rapid `<3s` redirect chains, or OAuth/SSO popups (`accounts.google.com`, `github.com/login/oauth`, Stripe, etc. keep Blanc's native `setWindowOpenHandler` carve-outs).
   - **Critical Blanc fix (`src/main/document-policy.js`):** In stock Blanc, `Cmd/Ctrl+Click` / `target="_blank"` marks child tabs `inheritsDocumentPolicy = true`, which **blocks them from ever hibernating ("Marked tabs never go quiet") and turns them into dead `inert` error pages on restart**. For ordinary (non-sandboxed) user link branches, spawn a fresh main-process tab (`noopener` + `parentId` graph edge) so every branched reference tab can hibernate to `0 MB` and survive restarts! Preserve `inheritsDocumentPolicy` strictly for sandboxed iframes and scripts needing `window.opener`.
   - Record real SPA in-domain navigation (`did-navigate-in-page`) onto `subPages[]`.
- **Exit Gate:** Real websites (Figma, Are.na, YouTube with audio immunity, GitHub login) load, branch child nodes, hibernate with real Task Manager RAM drop, display crisp real WebP screenshots on the canvas, and survive full app restart; `node --test` pure module & IPC trust tests pass; tag **`checkpoint/phase-3-real-browser`**.

---

### PHASE 4 — Chromium Extensions Support (`electron-chrome-extensions` + Web Store Installer)
**Goal:** Let a designer install and use essential Chrome extensions (CSS Peeper, WhatFont/Fontanello, ColorPick, Are.na/Raindrop clippers, Dark Reader, Stylus, React DevTools) alongside Blanc's built-in adblocker and 1Password support.
1. Install and wire **`electron-chrome-extensions`** onto the regular browsing `session` in `browser/`, bridging `chrome.tabs`, `chrome.windows`, `chrome.action` / `chrome.browserAction` popups, and `chrome.contextMenus` to your tab/node model, plus Electron's native `session.extensions.loadExtension()`.
2. Build a clean **Extension Action Popover** in the browser bar (pin up to 3 icons; tuck the rest into a clean puzzle-icon overflow menu so the chrome stays minimal; clicking an extension icon opens its popup in a properly positioned sandboxed child view).
3. Build **`Settings → Extensions`**:
   - **Load Unpacked** folder picker (`manifest.json` MV2/MV3).
   - **Install from Chrome Web Store URL or Extension ID:** Downloads the `.crx` package over HTTPS, validates and strips the CRX3 binary header, unpacks into `userData/extensions/<extensionId>/`, parses `manifest.json`, loads it into the session, and persists enabled state across restarts. If an extension requires unsupported Google-account C++ APIs (`chrome.identity`), surface a clear non-crashing compatibility note instead of failing silently.
   - Keep Blanc's native Ghostery network blocker + bundled uBlock Origin + 1Password integration working cleanly.
- **Exit Gate:** Automated + live smoke test installing an unpacked MV3 extension (content script + `chrome.tabs` + `chrome.action` popup) and verifying it injects into a real webpage, opens its popup UI, and survives browser restart; tag **`checkpoint/phase-4-chrome-extensions`**.

---

### PHASE 5 — The "700-Tab Designer Rescue" Importer, SQLite Vault & Local AI
**Goal:** Solve the founder's immediate real-world 700-tab overload on Day 1 with crash-proof storage, zero-RAM bulk import, and real local semantic intelligence.
1. **SQLite Vault + Crash-Safe Backups (`better-sqlite3`):**
   - Replace JSON/localStorage graph persistence with a fast local SQLite database (`graph.sqlite` in WAL mode) storing nodes, edges, regions, sticky notes, voice memo metadata, Readability text excerpts, and 384-dim `FLOAT32` vectors. Store WebP thumbnails and audio blobs as content-addressed files on disk.
   - Build **Automatic Rolling Backups** (keep last 5 healthy SQLite snapshots on startup/quit) + **1-Click Export / Import Canvas Bundle** (`.spatial-backup` zip/folder). Delete-and-restore must recover 100% of nodes, positions, notes, and thumbnails.
2. **Real On-Device Semantic Embeddings (`all-MiniLM-L6-v2`):**
   - Run quantized `all-MiniLM-L6-v2` ONNX via `@huggingface/transformers` inside a background Node `worker_thread` (never blocking the main or UI thread).
   - At page load / hibernate time, extract clean title + meta description + Readability excerpt (`@mozilla/readability` is already in Blanc), compute the 384-dim embedding, store in SQLite, and feed both the Rust **Ghost Echo** matcher and Blanc's `proposeFromEmbeddings` (`src/main/tab-import-organizer.js:370`) suggest-only clusterer. **Never auto-move existing user-placed nodes—clustering is always preview-and-confirm.**
3. **700-Tab Zero-RAM Rescue Importer:**
   - Connect Blanc's existing `browser-data-import.js`, `arc-import.js`, `bookmark-import.js`, and `tab-import-organizer.js` + a **"Paste URL List / Import Session JSON / Bookmarks HTML"** flow directly to the Spatial Graph.
   - All imported tabs are created **born hibernated (`0 MB` renderer RAM)**, automatically grouped into clean suggested spatial regions by semantic embedding + domain (e.g., *Are.na & Moodboards*, *Typography*, *Figma*, *GitHub & Docs*), with an optional **gentle background thumbnail crawler** (1 hidden offscreen muted renderer at a time, throttled, cancellable) that populates real visual reference cards for sleeping imports without spiking RAM above ~600 MB.
- **Exit Gate:** Import a 700-tab test dataset in `<3 seconds` with `0` live renderers spawned (verified low RAM), confirm semantic clusters form sensible named neighborhoods, kill & corrupt `graph.sqlite` and prove automatic backup recovery restores all 700 nodes intact; tag **`checkpoint/phase-5-700-tab-vault`**.

---

### PHASE 6 — Workflow Polish, Undo/Redo, & Unpacked Desktop Release Build
**Goal:** Deliver a rock-solid, daily-driver desktop application executable ready for the founder's real work.
1. **Designer Canvas Power Tools:**
   - Full **`Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` Undo/Redo** stack in main process covering node moves, region tidying, bulk deletes (routed through Blanc's 3-tier `closed-tabs.js` recovery), and cluster confirmations.
   - Multi-select marquee drag (`Shift+Drag` on canvas) → batch Pin, Move to Region, Tidy to Moodboard Contact Sheet, Sleep, or Archive.
   - Quick visual filter pill on canvas: filter/highlight by **Domain** (`arena.na`, `figma.com`, `dribbble.com`), **Age**, or **Has Notes** so finding one visual reference among 700 takes `<2 seconds`.
2. **Packaged Desktop Build & Final Audit:**
   - Run `electron-builder --dir` (`dist:dir`) inside `browser/` to produce a real standalone Windows unpacked app binary.
   - Launch the packaged `.exe` (not dev mode!), verify adblocking compiles and runs, verify cold startup `<1.5s`, verify 700-node canvas smoothness, verify Chrome extension loading in packaged mode, and run a final sweep for zero console errors, zero Blanc branding remnants, and zero visual slop.
   - Write an updated, crystal-clear `FOUNDER_GUIDE.md` at workspace root explaining how to launch the `.exe`, import your 700 real tabs, install Chrome extensions, and use keyboard shortcuts.
- **Exit Gate:** Packaged Windows `.exe` launches and passes every functional, performance, and visual check; commit and tag **`checkpoint/phase-6-release-candidate`**.

---

## START NOW
Begin immediately with **Phase 0** (verify git + cargo + node versions, set `.gitattributes`, commit and tag `checkpoint/phase-1-prototype`), report Phase 0 gate evidence concisely, and proceed sequentially through **Phase 1.5 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6**, completing every build, runtime, screenshot, anti-slop, and git-tag gate at the end of each phase before starting the next.
