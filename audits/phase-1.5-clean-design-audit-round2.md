# Phase 1.5 — Live Runtime + Screenshot Anti-Slop Audit (Round 2)

- **Date:** 2026-11-13
- **Auditor:** Re-auditor · round 2 (live runtime audit; no app sources were edited)
- **App:** spatial browser Phase 1.5 prototype, `app/` workspace
- **Server:** `npm --prefix "D:/Fivem/new brosser/app" run dev` → Vite v8.3.8 at `http://127.0.0.1:5199/` (log: ready in 424 ms; HTTP 200 confirmed via curl loop after 1 s; stale listener on 5199 from a previous session was killed first: `taskkill //PID 28004 //F` after `netstat -ano | grep :5199`)
- **Viewport:** 1600×900 (ZCode in-app browser, `setViewportSize`)
- **Round-1 report:** preserved verbatim at `audits/phase-1.5-clean-design-audit-round1.md` (this file supersedes it).
- **State prep:** a stale IAB tab from the previous round was still connected to the origin and kept re-writing a 700-node `stress-*` state into `localStorage` between the clear and the reload; fixed by making `localStorage.clear()` + `location.reload()` atomic inside one page evaluate, after which the first-run 28-node designer seed applied cleanly (full reading chrome mounted, persisted `viewMode: 'reading'`, document title following the seed's active node).

---

## 1. Per-screenshot observations

### 1.1 Mode A — reading view, rail OPEN
Artifact: `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_1\call_00910e1db96d49cb9bacb11a-tool-result-0eb31596-d90a-4358-b80b-3579fc0e5d14.png`

- Top command bar renders as three quiet clusters: left (rail toggle, back, forward, reload, shield), centre island pill (favicon chip, `are.na` URL, silent tab dots, copy, canvas toggle), right (split view, neighbourhood glance, extensions, theme sun icon, `?` shortcuts, canvas toggle). All icon-only with tooltip/aria labels — no text noise.
- Zen rail (open): "Live tabs · 3" heading, tab list with muted secondary text, audio icon on the audible tab. Hairline separators only.
- Reader: "Are.na — Type & Rhythm (channel)" mock article — byline row (`Cato Bergström · Nov 7 2026 · 7 min read · 3 visits`), full-width chart block in a muted teal-on-dark panel, section rules, teal inline links, bullet list. Notes card top-right ("Refresh this channel before Thursday's moodboard review — pull the two kinetic type entries." with timestamp + dismiss `×`).
- Floating mock audio player card bottom-centre: "Nocturne Oscillator · mock stream · paused", 0:00/5:33, waveform bars. Sits over the article as a floating island; does not collide with the Notes card.
- **No neon, no glow, no uppercase badges, sentence case throughout, spacing restrained.**

### 1.2 Mode A — rail CLOSED (toggled via UI control)
Artifact: `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_1\call_5b6a779836f44769911f3b5a-tool-result-7854d91e-4761-410d-894f-eb480c0a9dbf.png`

- Clicking `Toggle tab rail (⌘/Ctrl+S)` collapsed the rail; the reader went full-bleed (headline starts further left; no dead gutter). Collapse spring settles cleanly; toggle control confirmed live.

### 1.3 Help modal (Keyboard shortcuts sheet)
Artifact: `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_1\call_09ac8a578cba444d86f5d3fd-tool-result-e00a0014-b773-423f-abc8-288bc2c5439d.png`

- Opened via the `?` (Keyboard shortcuts ⌘/Ctrl+/) top-bar control. Content grouped "Views / Reading / General"; every row sentence case ("Toggle canvas ⇄ reading", "Branch a link into a child node", "Drag a link onto the island to anchor it", "Close overlays · dismiss ghost · back to reading"); keycaps in mono (`⌘/Ctrl Space · Alt Space`, `⌘/Ctrl L`, `Alt N`). Footnote: "Split view, extensions and the theme live in the top bar. Toolbar actions always work without modifiers." Dimmed scrim, centred modal, `×` close — closing via the `×` control worked.

### 1.4 Warm-paper light mode
Artifact: `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_1\call_8263d7e76f774340b30719d8-tool-result-ef5d5c44-ace0-418e-9b44-9d92eab965b2.png`

- `Switch to warm paper light theme` applied instantly: warm cream paper, dark ink, teal accents retained, notes card and audio player re-skin correctly, toggle icon flips to moon ("Switch to dark theme"). Reverted to dark via the same control (verified `data-theme` unset and body `rgb(9, 10, 12)` after revert).

### 1.5 Mode B — 700-node canvas, stale-state first contact (environment finding)
Artifact: `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_1\call_6e25369624514e73a4da7dd5-tool-result-2e19fa97-0549-48a9-8555-e4b583efbb6a.png`

- The first canvas view this session (a 700-node state rehydrated from a previous round's `localStorage` at zoom 100 % / identity camera) showed **an almost empty canvas** — only faint crossing edges. Measured: React Flow viewport `translate(0px, 0px) scale(1)`; region rects at flow coordinates −2996..−717, −4660… etc. (±3000–5000 units), all off-screen; zero `.react-flow__node` in DOM (visible-only culling). `grep -rn "fitView\|setViewport" app/src` returns **nothing** — there is no fit-to-view/focus-on-active anywhere.
- After the atomic reset + fresh `/seed-700` the canvas lands legibly (zoom 30 %, graph cloud in view, §1.7), so this is a resumed/identity-camera entry defect, not a fresh-seed defect.

### 1.6 Command palette + /seed-700
- Palette opened by dispatching a `Ctrl+L` keydown (window + document). Input: "Search tabs, notes, voice memos — or type / for commands", auto-focused. `/seed` typed via native value setter + `input` event; exactly one row rendered: "/seed-700 — 700-node designer seed across 7 clusters". Native `.click()` applied the seed (verified `viewMode: 'canvas'`, 700 nodes persisted, title switched to the stress seed's active node). Note: a `Escape` dispatched after seeding triggered the app's documented "back to reading" shortcut, so canvas re-entry was done via the documented `Toggle spatial canvas` control.

### 1.7 Mode B — MACRO tier (30 %, beacons + region titles)
Artifacts:
- `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_1\call_cfbbea66bf1d4e26944289f1-tool-result-6d67d08a-c15a-4d3c-bdea-314eb65812ca.png`
- Retake at the same neighbourhood: `...\call_2e46c98342b14ea2ba09e327-tool-result-8e771fb4-d7a3-4c2a-8b31-2dca1e1dbf79.png`

- Pill reads "30 % macro"; wheel events on `.react-flow__pane` step zoom and the tier label follows (see §3 item 5 for the desync caveat under suspension).
- Visible: one large region backdrop rectangle (subtle lighter panel), region title "Visual References", the active node's beacon + label ("Risograph Texture Studies"), faint edge web. **Observation (minor):** at this tier the other ~690 beacons are sub-pixel specks — the canvas reads as near-empty dark space with line clutter. Legible anchors exist (region title + active beacon), but information density is extremely low and could read as "broken" to a first-time user.

### 1.8 Mode B — COMPACT tier (49 %, pills)
Artifact: `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_1\call_d2c3680cba94454eb1ca3ca2-tool-result-359b2ba2-66a0-46f6-846c-3ddd6678df02.png`

- Pill reads "49 % compact". Dozens of pill nodes with truncated tab titles ("Risograph Texture S…", "Chrome Y2K UI Salv…", "Editorial Grid Syste…"), status dots, faint edges, region backdrop. Muted, tidy, sentence case; bottom island pill complete ("49 % | compact | LOD lock | Freeze | Note | Region | Tidy grid | Workbench | Risograph Texture Studies | Editorial Grotesque Pairing | Onboarding Checklist Desi…"). No neon, no badges, no glow.

### 1.9 Mode B — RICH tier (69 %, cards)
Artifact: `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_1\call_101706087dfa45a3b0ad4819-tool-result-be259705-77d3-45b3-b190-5d68a923f551.png`

- Pill reads "69 % rich". Full preview cards (monochrome placeholder art), title + domain labels, "3 pages" stack badges, a sticky note ("in the five channels with the sparsest spatial pagination, the audit rolls into the next quarter's purge."), edges retained. Dense (cards overlap heavily at 700 nodes) but monochrome and restrained — no neon, no uppercase debug text.

---

## 2. Anti-slop checklist

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Zero neon borders / glows | **PASS** | All 8 screenshots: hairline borders, muted greys, single teal accent; no glow shadows or saturated rims anywhere |
| 2 | Zero uppercase debug badges | **PASS** | Every label sentence case ("Live tabs", "Field notes · are.na", "LOD lock", "Workbench", "3 pages"); mono used only for keycaps/URL paths |
| 3 | Zero dead buttons | **PASS** | Exercised live: rail toggle (layout re-flowed), shortcuts `?` (modal opened), modal `×` (closed), theme toggle (paper ⇄ dark verified via `data-theme`/body bg), reader Note (notes count 2→3), glance (panel opened), canvas toggle (mode switched), palette `/seed-700` (700 nodes seeded), LOD lock (toggles), Freeze ("Freeze"→"Relax"→"Freeze"), Tidy grid (100 cluster-0 nodes moved off seed positions, e.g. stress-0-0 −2000,−2000 → −3728,−2050), pill Note (clicked) |
| 4 | Sentence case | **PASS** | All headings, buttons, tooltips, modal rows, pill labels |
| 5 | Restrained spacing | **PASS** | Consistent 8–24 px rhythm in bar/rail/pill/modal; no sprawling paddings or cramped stacks in any screenshot |

Checklist result: **5 / 5 PASS**.

---

## 3. FPS benchmark at 700 nodes — FAILED (environment-suspended rendering; numbers are real)

Method per spec: page-side `requestAnimationFrame` delta sampler installed via page evaluate; a page-side interval dispatched pan wheel events (`WheelEvent` with `deltaX`/`deltaY`) on `.react-flow__pane` for ≥5.5 s; sustained average fps and % of frames slower than 25 ms computed page-side. Pass = avg ≥ 55 fps AND dropped < 2 %.

**Run A — exactly as specified (no capture assistance):**

```
wheelsSent=6, framesSampled=0, avgFps=0, droppedPct=0 (no frames), windowMs=0
```

- rAF fired **zero times** during the 5.5 s window; even the wheel-driver interval only emitted 6 of the planned ~88 events (timers throttled with the renderer).

**Run B — supplementary capture-assisted probe (NOT the gate measurement):**
17 forced screenshot captures at ~350 ms cadence during a 6 s wheel storm (each capture forces Chromium `BeginFrame`s, producing catch-up bursts):

```
framesSampled=1074 over a 24.3 s window, avgFps=44.1, droppedPct=11.45,
medianDeltaMs=1, p95DeltaMs=81.4, wheelsSent=67
```

- Burst frames run unthrottled (median delta 1 ms — the app's per-frame work completes fast when frames are actually produced); the 11.45 % "dropped" and sub-55 average are dominated by the multi-hundred-ms gaps between forced captures, i.e. by the environment, not by app jank. This run also cannot satisfy the gate and is reported for transparency only.

**Gate verdict: FAIL — avg 0 fps (Run A).** `fps.pass = false`, avg = 0, dropped = 0 (no frames sampled → denominator zero).

**Root cause (documented, reproducible):** the ZCode in-app-browser webview suspends continuous rendering while the ZCode window is occluded by other windows:
1. `document.visibilityState === 'visible'` yet a rAF probe counted **0 frames in 1500 ms** (repeated 4×).
2. Identical result in a brand-new tab and after `visibility` capability `set(false)`→`set(true)`.
3. Windows-level checks: ZCode window not minimized (`IsIconic=False`), on-screen (`rect 244,78 → 1462,888`); the foreground occluder was identified as the user's Vivaldi window (playing a YouTube video). Minimizing Vivaldi once made ZCode foreground, but the webview still produced 0 rAF frames (suspension persists in the WebView2 layer).
4. A single `tab.screenshot()` (CDP capture) forces a catch-up burst: **1044 rAF ticks in <300 ms**, then 0 again (measured: afterCapture1=1044, +300 ms=1044, +800 ms=1044, afterCapture2=1944).
5. Because the app's `onMove`→`setZoom` write is rAF-coalesced (`app/src/components/canvas/SpatialCanvas.tsx:1050-1078`) and the zoom-divergence watchdog is `setInterval`-based (`app/src/components/canvas/SpatialCanvas.tsx:1089-1107`), the HUD % and LOD tier lag the live camera by seconds under suspension and re-sync only when throttled timers fire. In a normally visible browser (rAF at 60 Hz) this pipeline would write within one frame — this desync could **not** be reproduced as an app defect here; it is reported as an observation tied to the suspension.
6. All Mode B tier screenshots remain valid: each capture draws the current DOM state (camera/tier changes are reflected truthfully at capture time).

The benchmark therefore could not be validly run to a pass/fail conclusion about app rendering performance. Per the audit contract this is reported as a failed gate with `ok=false`, plainly attributed to the hosting-environment rendering suspension rather than measured app jank.

---

## 4. Violations & on-screen locations

1. **[App] No fit-to-view / focus-on-active on canvas mount** — `grep -rn "fitView|setViewport" app/src` returns nothing; first-run seed regions sit at flow coords ±3000–5000 (measured via `getBoundingClientRect`); with an identity camera (`translate(0px,0px) scale(1)`, measured) a resumed/identity state shows an empty canvas — on-screen location: the entire canvas area (all four quadrants empty, only edge lines visible). Evidence artifact: §1.5 screenshot. Fresh `/seed-700` (zoom 0.3) and first-run reading mode land legibly, so the defect is limited to resumed/identity-camera entry into the canvas.
2. **[App, minor] Macro-tier beacon legibility** — at 30 % zoom only the active node's beacon + region title are clearly visible; ~690 other beacons are sub-pixel specks (on-screen location: whole canvas except the two anchors). Artifacts: §1.7.
3. **[Environment] fps gate unmeasurable** — webview rendering suspension (see §3 items 1–4). Not an app violation; it forces `fps.pass=false` and hence `ok=false` this round.
4. **[Environment hazard] Stale-tab localStorage poisoning** — a leftover tab from a previous round re-persisted a 700-node state between `clear()` and reload, so the first-run reset silently failed once. Workaround (atomic clear+reload in one evaluate) applied. Future audit runs should kill stale tabs or reset atomically.

---

## 5. Verdict

- Anti-slop visual checklist: **5/5 PASS**.
- FPS gate at 700 nodes: **FAIL (environment-suspended rendering; 0 frames sampled in the in-spec run; 44.1 fps / 11.45 % dropped even when capture-assisted)**.
- **`ok = false`** — the audit contract requires the fps gate to pass; it failed for hosting-environment reasons documented above. The visual/design checklist itself is clean.

Recommended next step: re-run the fps benchmark in a session where the ZCode window (with the in-app browser pane) is genuinely visible/foreground on the desktop, or measure in a headed CDP browser; the app-side per-frame cost during forced bursts (median 1 ms) suggests the render loop is fast when frames are produced, but the sustained 60 Hz number must be measured honestly.
