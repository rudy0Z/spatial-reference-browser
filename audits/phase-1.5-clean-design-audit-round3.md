# Phase 1.5 — LIVE runtime + screenshot anti-slop audit (round 3)

- Auditor: Re-auditor · round 3 (live runtime subagent; no app sources edited)
- Date: 2026-11-13
- App: workspace `app/` (spatial browser, Phase 1.5)
- Server: `npm --prefix "D:/Fivem/new brosser/app" run dev` → Vite v8.3.8 ready in 374 ms on `http://127.0.0.1:5199/` (port confirmed clear of listeners first: `netstat -ano | grep :5199` showed only TIME_WAIT remnants, no LISTENING; exit 1 on the grep for LISTEN)
- Browser: ZCode In-app Browser (IAB, `iab:c95d26a5-…`), tab at 1600×900, first run with `localStorage.clear()` (removed keys `spatial-canvas-phase-1`, `spatial.theme`) + reload → 28-node designer seed reading view.
- Methods: every interaction done against the real running app; Playwright role-locator clicks timed out on the animated chrome, so per the ask the UI controls (rail toggle, theme toggle, help modal open/close, palette command row) were driven with native `.click()` via page evaluate. Zoom tiers driven with `WheelEvent` (`ctrlKey: true`) dispatched **on `.react-flow__pane` itself**.
- **Round-2 report:** preserved verbatim at `audits/phase-1.5-clean-design-audit-round2.md` (this file supersedes it; round 1 remains at `audits/phase-1.5-clean-design-audit-round1.md`).

**Verdict: ok = false.** Every anti-slop checklist item passes on the screenshots, but the FPS gate does not pass: the prescribed rAF benchmark is unrunnable in this harness (0 frames produced) and the one valid supplementary proxy run fails the dropped-frames bar. Details in §4. A headed-browser re-measurement is required before sign-off.

---

## 1. Per-screenshot observations

Screenshot artifacts (harness-saved PNGs, in emission order):

| # | View | Artifact path (`C:\Users\rudra\.zcode\cli\artifacts\…`) |
|---|------|----------------------------------------------------------|
| S1 | Reading view, dark, rail **expanded**, top command bar + floating pill | `sess_dwf-dwfrun-…-actor_8_2\call_c975d7f00bcd4c67a44923b4-tool-result-6557d93f-d328-4090-bb47-ab2011a5c068.png` |
| S2 | Reading view, dark, rail **collapsed** (after UI toggle) | `sess_dwf-dwfrun-…-actor_8_2\call_49eda76867dd4511b7139a48-tool-result-15b46264-3221-4dc0-b8f5-a5a606250df3.png` |
| S3 | Help modal ("Keyboard shortcuts") | `sess_dwf-dwfrun-…-actor_8_2\call_421f10f179d946498cbdb750-tool-result-895d3ea1-04fb-4654-ac0f-fc6bcfc8096a.png` |
| S4 | Warm-paper light theme, **mid-transition frame** (see V1) | `sess_dwf-dwfrun-…-actor_8_2\call_e2ed61bf573e48369cd11435-tool-result-e86dde32-ea61-4902-96a0-e64e598f236c.png` |
| S5 | Warm-paper light theme, settled | `sess_dwf-dwfrun-…-actor_8_2\call_bc3034fc5036478b8e83d8fa-tool-result-9fbfdd27-b568-4305-a5a6-f8fb82df24db.png` |
| S6 | Reading view scrolled to article footer (badge check) | `sess_dwf-dwfrun-…-actor_8_2\call_54a6ced471614675913fd36a-tool-result-71aeb2ca-1d89-4433-8856-aa28185e9f9b.png` |
| S7 | Canvas after `/seed-700`, 30% MACRO (beacons + region titles) | `sess_dwf-dwfrun-…-actor_8_2\call_a54400336c594c28ac1b75e7-tool-result-8d5a89f9-db2b-42e3-a730-e7db3226c91b.png` |
| S8 | MACRO re-shot (30%, `macro` HUD chip visible) | `sess_dwf-dwfrun-…-actor_8_2\call_de015d5cc65840bb93df52af-tool-result-be1c3374-b455-4219-8905-faf906d1e48f.png` |
| S9 | RICH tier, 200% (cards) | `sess_dwf-dwfrun-…-actor_8_2\call_9c10116bbf4c45f5b35a10ba-tool-result-e4635627-be1a-4fa2-aa63-24ea11fd22f3.png` |
| S10 | COMPACT tier, 45% (pills) | `sess_dwf-dwfrun-…-actor_8_2\call_bdb72814a11745e6ad6d8617-tool-result-8cb08b7a-a71c-497b-b7a1-e38e6091e6c0.png` |
| S11 | Discarded: stale compositor frame (duplicate of S9) — harness artifact, not app | `sess_dwf-dwfrun-…-actor_8_2\call_494029edd630485fa02c1cac-tool-result-75c52edf-64ac-4d54-8bfb-46bd5e6265be.png` |

### S1 — Reading view, dark, rail expanded
- Top command bar: rail toggle, back/forward (correctly disabled on first run), reload, shield, centered floating pill (`A · are.na · neighbour dots · actions`), right cluster: split view, extensions, theme (sun), help (?), grid.
- Left rail: "Live tabs · 3", groups "Visual References", "Motion & Shaders", "Studios & Projects" — sentence case, quiet.
- Article: "Are.na — Type & Rhythm (channel)", muted teal link accents, hairline section markers, no decoration slop.
- Notes card top-right ("Notes · 1") and bottom audio bar ("Nocturne Oscillator · mock stream · paused") — lowercase statuses.

### S2 — Rail collapsed
- Rail folds cleanly, content reflows full-width; no layout jank, no orphaned borders.

### S3 — Help modal
- Title "Keyboard shortcuts"; groups "Views", "Reading", "General"; entries sentence case ("Toggle canvas ⇄ reading", "Command palette", "Toggle tab rail", "Neighbourhood glance", "Quick sticky note on the active page", "Branch a link into a child node", "Drag a link onto the island to anchor it", "This shortcuts sheet", "Close overlays · dismiss ghost · back to reading").
- Keycaps in mono (`⌘/Ctrl Space · Alt Space`, `⌘/Ctrl L`, `⌘/Ctrl S`, `⌘/Ctrl ⇧ G`, `Alt N`, `Esc`). Footer explainer sentence-case. Close × works (verified). No neon.

### S4/S5 — Warm-paper light theme
- S4 caught the theme **cross-fade mid-flight**: article body text momentarily invisible/blank (see V1).
- S5 (settled, +2 s): correct. Probed computed styles: h1 `rgb(32,30,25)` on paper; body paragraph `rgb(110,106,97)`; hero artwork block stays dark deliberately; dark-theme restore verified afterwards (`data-theme` cleared).

### S6 — Article footer
- Code block header "ts" + "mock · read-only" (lowercase, dim), link cards with favicon dot + domain + sentence-case descriptions, page footer "are.na · mock page · u09ecb357". **No uppercase debug badges anywhere in the reading column.**

### S7/S8 — MACRO (30%)
- Beacon dots + tiny region titles ("Visual References", "Risograph Texture Studies"); HUD bottom bar `30% | macro | LOD lock | Freeze | Note | Region | Tidy grid | Workbench | Risograph Texture Studies | Editorial Grotesque Pairing | Onboarding Checklist Dest…` — all sentence case, all chips matte.
- Region rectangles are extremely subtle; contrast is low by design (restrained), readable on the 2× screenshot.

### S9 — RICH (200%)
- Full cards with abstract muted PreviewArt (circles/blobs, no neon), sentence-case titles ("Brutalist Web Archive — Par…", "Risograph Texture Studi…", "Bento Grid Inspiration — P…", "Kinetic Type Loops —", "Soft Aurora Gradients…"), domain labels (`are.na`, `cosmos.so`, `savee.it`, `godly.website`), active card elevated with a status dot. Inactive cards dimmed (depth-of-field effect) — intentional, not slop.

### S10 — COMPACT (45%)
- Pill nodes with favicon letter + truncated title; faint edges; active pill brighter with dot. Dense pockets have slight label overlap (top edge) — acceptable density tradeoff, noted as minor observation, not a checklist violation.

---

## 2. Anti-slop checklist

| Item | Verdict | Evidence |
|------|---------|----------|
| Zero neon borders/glows | **PASS** | All 10 accepted screenshots: matte surfaces, hairline borders; only hue is muted content accents (teal links, favicon dots, PreviewArt). No glowing outlines on cards, pills, HUD, modal, light or dark. |
| Zero uppercase debug badges | **PASS** | On-screen badges are lowercase: `mock · read-only` (S6), `are.na · mock page · u09ecb357` (S6), HUD chips `macro`/`compact`/`rich` (S7–S10), `paused` audio status (S1). No `SLEEP/GHOST/CACHED/LOADING`-style chips anywhere. |
| Zero dead buttons | **PASS** (scope-limited) | Exercised and confirmed working: rail toggle (S1→S2), theme toggle ×2 (S5, then dark restored), help-modal open + close (S3), palette open via Ctrl+L, `/seed-700` command row (700-node seed landed), zoom/pan. Not exercised: Split view, Extensions, Neighbourhood glance, Back/Forward (disabled-by-design on first run), audio play (clicked via probe only — it is a store-flag mock, `useGraphStore.ts:877-880`). |
| Sentence case everywhere | **PASS** | Every label captured (rail groups, modal rows, HUD, pills, cards, notes, statuses) is sentence case; mono is reserved for URLs/keys/code. |
| Restrained spacing | **PASS** | Consistent hairline rhythm in bar/rail/modal/HUD; no bloated paddings or double-separations observed at any tier. |

## 3. MODE B mechanics verified

- Palette: `Ctrl+L` keydown (window + document dispatch) opened the palette (input placeholder "Search tabs, notes, voice memos — or type / for commands").
- `/seed-700`: palette input filled via native value setter + `input` event; command row `"/seed-700 — 700-node designer seed across 7 clusters"` matched exactly 1 element and was native-clicked → `document.querySelectorAll('.react-flow__node').length === 700`, canvas present.
- LOD tiers (`types.ts:428-433`: `<0.35 macro`, `<0.65 compact`, else `rich`; override null) crossed by ctrl+wheel on `.react-flow__pane`: 30% → macro (S8), 45% → compact (S10), 200% → rich (S9). Viewport culling confirmed in code (`SpatialCanvas.tsx:1313` `onlyRenderVisibleElements`) — mounted DOM nodes 67–75 during panning at compact, 700 right after reload at macro.
- Fresh page after the mid-audit reload restored the 700-node seed from localStorage (persist works).

## 4. FPS benchmark at 700 nodes — **FAIL / NOT RUNNABLE AS PRESCRIBED**

Prescribed check (run verbatim, twice): page-evaluate installs a `requestAnimationFrame` delta sampler; a 16 ms interval dispatches pan `WheelEvent`s on `.react-flow__pane` for 5.5 s; compute sustained avg fps and % frames > 25 ms.

| Run | Wheel events dispatched | rAF frames | durationMs | avgFps | dropped% |
|-----|------------------------|-----------|-----------|--------|----------|
| 1 | 326 | **0** | 0 | 0 | n/a |
| 2 (fresh page) | 6 (timers throttled) | **0** | 0 | 0 | n/a |

Pass requires avg ≥ 55 fps and dropped < 2% — the sampler received **zero frames**, so the prescribed check cannot pass here.

Root-cause experiments (all page-evaluate, on the live tab):

1. **Visibility probe**: `document.visibilityState === "visible"`, `document.hidden === false`, yet rAF fired **0 times in 500 ms**, 0 in 2 s (with active input), 0 in 1 s.
2. **Screenshot-burst test**: persistent rAF counter → 0 ticks across a 1.5 s quiet window; a forced `tab.screenshot()` immediately pumps a burst (counter +45 then +34 around two screenshots). Conclusion: the IAB compositor issues BeginFrames **only on capture** (on-demand rendering) — rAF-based fps measurement is structurally impossible in this harness, regardless of app performance.
3. **Audio-exemption attempt**: real `AudioContext` oscillator (gain 0.001) started, `state === "running"` — rAF still 0/1 s. (The app's own "audio-immunity" play control is a store flag only, no real audio, `useGraphStore.ts:877-880`.)
4. **Backend inventory**: `agent.browsers.list()` → only `iab`; no cdp/headless alternative to switch to.
5. **Supplementary proxy** (not the prescribed method): self-scheduled 60 Hz `setTimeout` frame loop dispatching the same pan wheels. During the window when the host allowed 60 Hz timers: **331 iterations / 5.48 s, avg 60.19 fps-equivalent servicing, dropped (Δ>25 ms) = 7.27%, p95 27.4 ms, max 48.5 ms, 0 long tasks (>50 ms)**. This **fails the dropped < 2% bar**. A matched idle control could not be obtained: immediately after, the host flipped into deep timer throttling (1 Hz — 6 iterations/5.5 s; a second attempt probed 2 timer ticks/s), so environment-vs-app attribution of the 7.27% is not possible. Mid-audit the page also reloaded itself once (fresh `performance.now()` epoch, `navType: "navigate"`; dev-server log shows no HMR update lines), which destroyed the first idle-control run.

Recorded numbers for the fixer: prescribed rAF check = 0 frames (unrunnable in harness); proxy run = avg 60.19, dropped 7.27%, p95 27.4 ms, max 48.5 ms, 0 long tasks. **Re-measure in a headed browser (real compositor) before treating either number as the app's true fps.**

## 5. Violations

- **V1 (minor, visual, on-screen: article column, light theme transition)** — During the dark→paper cross-fade the article body renders blank/invisible for roughly 1–2 s (S4 catches it; S5 settled is correct with h1 `rgb(32,30,25)` on paper). Either the fade passes through a low-contrast midpoint or content opacity animates late. Fixer should verify the transition never drops text below readable contrast.
- **V2 (blocking gate, benchmark, canvas @700 nodes)** — FPS gate not passed: prescribed rAF benchmark produces no frames in this harness (see §4); the supplementary proxy run fails the dropped bar (7.27% > 2%) under uncontrolled host throttling. ok=false stands until a headed-browser measurement passes.
- **V3 (harness, not app)** — The IAB screenshot pipeline intermittently returns a stale compositor frame (S11 duplicated S9 despite the page being at 45%/compact; re-capture returned the true frame). Screenshots used for judgment were re-verified against DOM/HUD state.

## 6. What was not run / not verified

- Every button in the chrome was not clicked individually (see scope note in §2); "dead button" pass covers the controls listed.
- No source edits were made by this auditor; `git status` modified files were pre-existing.
- The prescribed fps check is reported as **not runnable** in this environment, not as passed by substitution — the proxy numbers are supplementary evidence only.
