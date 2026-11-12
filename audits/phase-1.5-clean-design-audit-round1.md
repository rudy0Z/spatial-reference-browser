# Phase 1.5 — Live runtime + screenshot anti-slop audit (round 1)

- **Date:** 2026-11-13
- **Auditor:** Live auditor subagent (round 1, Phase 1.5)
- **App:** spatial browser prototype, workspace `app/` (spatial-canvas-phase-1@0.0.0, Vite v8.3.8)
- **Environment:** ZCode in-app browser (IAB backend), viewport 1600×900, dark theme default, localStorage cleared before first-run 28-node designer seed
- **Dev server:** `npm --prefix "D:/Fivem/new brosser/app" run dev` → `http://127.0.0.1:5199/` (VITE ready in 1013 ms; port 5199 verified free before start via `netstat -ano | grep :5199` → `NO_LISTENER`)

---

## 1. Per-screenshot observations

Artifact dir (harness-saved PNGs):
`C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_7_1\`

| # | Artifact file | What it shows | Observations |
|---|---|---|---|
| A-1 | `call_86bf5a82bb7f4f99a0f7af1d-tool-result-30ef74ee-1a05-4c74-8f6d-8ddfeb8521f8.png` | Reading view, dark theme, first-run seed. Top command bar (rail toggle, back/forward disabled, reload, connection badge, split, glance, extensions, theme, shortcuts, canvas toggle), floating island pill top-center ("are.na" + neighbour dots ●○○○○○○○), left rail (Live tabs / Visual References / Motion & Shaders / Studios & Projects), article, notes card, audio dock | Hairline borders only, no glow/neon; all labels sentence case; disabled back/forward are dimmed but intentional (no history yet); spacing consistent |
| A-2 | `call_432591d956794531b7e20d1a-tool-result-d008a333-9d6c-4ef1-be8c-4fd08a11257f.png` | Rail collapsed via the UI control | Collapse worked; content reflows; no orphaned borders/leftovers |
| A-3 | `call_6ebe8a97a7d9410493d50801-tool-result-d0a1a8de-0fff-4a70-b6df-b582e0906035.png` | Help modal ("Keyboard shortcuts") opened via the ? control | Three sections (Views / Reading / General), all sentence case, kbd chips lowercase mono, footnote "Split view, extensions and the theme live in the top bar." No neon; single clean dialog |
| A-4 | `call_12296d9503dd4f92aa6d29d3-tool-result-80184fbb-7a5b-4c39-b46e-8afef5006238.png` | Warm-paper light mode via theme toggle (`data-theme="paper"` verified on `<html>`) | Cream background, dark ink, contrast holds; hero figure card stays dark (mock preview art with its own dark canvas — reads as a deliberate editorial figure, not a broken theme) |
| B-0 | `call_3901b805af4d40579e3abb51-tool-result-2f288998-5f09-499d-9000-79a304bded92.png` | Command palette open via dispatched Ctrl+L keydown, input filled `/seed-700` | Row "/seed-700 — 700-node designer seed across 7 clusters", footer hints ↑↓ navigate / ↵ run / esc close, "1 commands". Clean, sentence case |
| B-M1 | `call_ec3c822430e34ccca9a5f4b2-tool-result-19047ee7-0082-49f7-aa32-05307fd0606f.png` | MACRO tier right after `/seed-700` (30%, HUD "30% macro") | Region title "Visual References" + Tidy chip, region zone rect, pure beacons; HUD dock: LOD lock / Freeze / Note / Region / Tidy grid / Workbench chips. No neon |
| B-C1 | `call_aceb487680584569914b05be-tool-result-9a63d1d6-ece3-458d-a55f-ab5b3e09eba1.png` | COMPACT tier (49%) via wheel on `.react-flow__pane` | 180×44 pills with truncated titles ("Soft Aura Gradie…"), HUD "49% compact" |
| B-R1 | `call_6c3eb1884be44f67afaec9fc-tool-result-b3d53468-78fb-4949-90d8-db70c123b6fa.png` | 69% — HUD says "rich" but nodes still render compact pills | **VIOLATION V1 evidence** (session freeze, see §3) |
| B-C2 | `call_d9634a5e064545c290b18c81-tool-result-b5d05794-7343-4be8-b765-12d926264a3f.png` | Clean COMPACT tier (46%) after re-center + physics freeze ("Relax •") | Pills inside region zone, HUD "46% compact" |
| B-C3 | `call_47f31da1cf3e40098a218440-tool-result-339498dc-5853-4451-b70b-630290959af8.png` | COMPACT tier (53%) | Same, stable |
| B-M2 | `call_648969596f36498aa444c5d8-tool-result-89f218a3-7408-4ea0-b70c-e0e78d2ba94a.png` | Clean MACRO tier (32%) | Beacons + big region title "Visual References", tether lines, HUD "32% macro" |
| B-C4 | `call_c8609b5635a8484da94038c2-tool-result-1ddf0d77-ad8f-455b-90c6-d4669ee63980.png` | COMPACT tier (62%) fresh session | Live tier transition worked (62%→74% rich crossing verified programmatically) |
| B-R2 | `call_e72872f2517d4ff8bd03487b-tool-result-fa0d7cbc-3ff4-482b-82ca-38ae47825673.png` | Clean RICH tier (87%) | 260px editorial cards with preview art, domain lines (dribbble.com / are.na / godly.website / siteinspire.com), "3 pages" stack chips, note chips. HUD "87% rich" |

Additional artifacts not in the main flow:
- `call_2b188b60f72a4ab19c7bcbfc-tool-result-7a1ccba6-76c3-41f0-b03d-0dc6a3ab5ab9.png` — empty void at 74% after prolonged physics drift (viewport off-graph; not an app defect, measurement artifact)
- `call_908db37400f54732a1b571a2-tool-result-086e4c2c-4bdc-48ed-8724-0927e601b947.png` — stale compositor frame captured during zoom (environment artifact, not app)

## 2. Anti-slop checklist

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Zero neon borders / glows | **PASS** | All 10 screenshots reviewed: borders are hairline (`border-hairline`), accents muted teal; no `box-shadow` glows or saturated outlines anywhere (A-1…B-R2) |
| 2 | Zero uppercase debug badges | **PASS** | No ALL-CAPS labels anywhere; LOD tier chips render lowercase ("macro", "compact", "rich"), kbd chips lowercase ("esc", "alt n" style), region titles sentence case |
| 3 | Zero dead buttons | **PASS** (10 controls verified live; 5 not exercised) | Verified working: rail toggle (collapse/expand), theme toggle (→ `data-theme="paper"` and back), shortcuts sheet button, palette (Ctrl+L dispatch → opened), `/seed-700` row click (700 nodes + 7 regions + canvas mode verified in persisted store), canvas toggle (Ctrl+Space), LOD lock toggle (active-dot state flips), Freeze/Relax (physics froze, label flipped, layout stopped drifting), workbench chip (re-centered canvas), audio dock visible. Not exercised (no evidence either way): Split view, Neighbourhood glance, Extensions drawer, Note/Branch article buttons, New-tab/ghost-echo pills |
| 4 | Sentence case | **PASS** | Help modal rows ("Toggle canvas ↔ reading", "Quick sticky note on the active page", …), region titles ("Visual References", "Studio Portfolios"), HUD labels ("LOD lock", "Tidy grid", "Workbench"), article headings ("Where this fits", "Measurements") |
| 5 | Restrained spacing | **PASS** | Consistent gutters in reading view; compact HUD dock; palette list spacing even; no cramming or oversized gaps observed |

## 3. Violations

### V1 (serious, functional): 700-node session freeze — node LOD stuck + React re-render pipeline dies
- **Location:** Canvas mode at 700 nodes (seeded via `/seed-700`), while wheel-zooming across the 0.65 rich threshold.
- **Reproduction sequence (session 1):** seed 700 → wheel 30%→49% (macro→compact propagated correctly) → wheel ×2 → 69%.
- **Observed:** Canvas root `data-lod="rich"` and HUD "69%" (store zoom 0.689) while every rendered node remained a compact pill — DOM probe: all 97 rendered `.react-flow__node` at 124×30 screen px = 180×44 world px (`CompactPill`, `app/src/components/canvas/nodes/SpatialTabNode.tsx:836`), vs rich card `w-[260px]` (`SpatialTabNode.tsx:953`). React fiber probe of node props returned `data.lod === "compact"` while the root rendered "rich". Toggling LOD lock and waiting 60s+ did not recover it; afterwards **all React re-renders stopped** (RF viewport scale advanced to 0.814 while HUD stayed frozen at "69%"; clicking Freeze/Relax produced no label change). Only a full page reload recovered the app.
- **Counter-evidence (fresh session):** after reload, a fresh mount at 100% rendered the rich tier correctly (693 × 260px cards + 7 × 220px hub chips, `worldSizes` probe), and a live wheel crossing 62%→74% switched pills→cards correctly. One retry did not reproduce the freeze — it is intermittent but was observed once under exactly the Phase 1.5 demo path (seed 700 → wheel up to rich).
- **Suspect area for the fixer:** the wheel path updates store zoom via `onMove` → `setZoom` (`app/src/components/canvas/SpatialCanvas.tsx:1034-1039`); `flowNodes` memo depends on `lod` (`SpatialCanvas.tsx:985-1021`) and React Flow must propagate `data.lod` into `@xyflow/react` node wrappers. The freeze suggests a dropped store-notification or an interrupted render under the 700-node load.

### V2 (behavioral note, minor): LOD lock semantics vs. wheel tier-stepping
- The ask expected "the wheel steps tiers when LOD lock is on". Actual code: `lodForZoom(zoom, override)` returns `'rich'` whenever `override` is true (`app/src/lib/types.ts:423-429`) — with LOD lock ON the tier is pinned to rich and the wheel does **not** step tiers; tier-stepping via wheel happens only with the lock OFF. Also, toggling canvas mode resets `semanticZoomOverride` via `clearEphemeralFlags` (`app/src/store/useGraphStore.ts:1121-1132`), so the lock does not survive a reading⇄canvas round trip. Not a slop violation; flagging the spec mismatch.

### V3 (observation, minor): rich-tier card overlap in dense clusters
- At 87% zoom inside a cluster, 260px cards overlap heavily (B-R2). Legibility pressure at the richest tier under the 700-node density. Not a checklist violation; worth a layout pass.

### Not violations (audit-environment artifacts, recorded for honesty)
- One screenshot captured a stale compositor frame (HUD 32% while page state was 62%).
- Viewport drift from the still-running physics simulation produced an empty-void screenshot at 74%.

## 4. FPS benchmark at 700 nodes — NOT MEASURABLE (environment)

Method attempted exactly as specified (rAF delta sampler + programmatic wheel dispatch on `.react-flow__pane`, ≥5 s):

1. **Attempt 1 — in-page sampler + `setInterval` wheel dispatcher, 6.5 s idle window:** sampler installed (`requestAnimationFrame` pushing deltas into `window.__fpsLog`, wheel events every 16 ms alternating ±120 at pane center). Result after 6.5 s: `frames: 0`, `logLen: 0`, `wheelCount: 3` — the guest page freezes timers between tool calls (rAF suspended, interval clamped after ~3 fires).
2. **Attempt 2 — keep page engaged:** restarted sampler, then polled the page every 150 ms for 7.5 s (47 polls). Result: `visibilityState` stayed `"visible"`, yet `frames: 0`, `wheels: 3` — rAF callbacks never executed even while evaluates ran.
3. **Attempt 3 — real input via CUA:** `tab.cua.scroll({x:800, y:450, scrollY:±120})` → command hung and hit the 30 s timeout (one input did land: zoom 38%→32%). rAF still 0 frames.
4. **Attempt 4 — capture probe:** during a `tab.screenshot()` capture the rAF chain ran (27 frames), with deltas 118822 ms → 65350 ms → ~143 ms — i.e. frames are only composited on capture demand, at capture pacing. rAF-sampled "sustained fps" in this backend measures the capture pipeline, not the app.

**Conclusion:** the ZCode IAB backend does not schedule compositor frames for the guest page outside capture windows, so the ask's specified rAF delta sampling cannot produce real sustained-fps numbers here. No fps number is reported rather than a fabricated one.

- **avg fps:** not obtainable (n/a)
- **frames slower than 25 ms:** not obtainable (n/a)
- **Gate (avg ≥ 55 fps and dropped < 2 %): FAIL — not run successfully (environment limitation, not an app measurement)**

Suggested re-run on a backend with continuous BeginFrame scheduling (real headed Chromium/CDP with `--browser-use=headless` off, or Playwright headed).

## 5. Verdict

- Design checklist: 5/5 PASS (with the not-exercised-controls caveat on item 3)
- Violations: V1 serious (intermittent 700-node session freeze), V2 spec note, V3 minor observation
- FPS gate: **not passed — unmeasurable in this environment** (4 documented attempts)

**ok = false** — driven by the FPS gate (unmeasurable, honestly reported), not by a design-checklist failure. The visual anti-slop bar is met in every captured state; the functional V1 freeze is the app-side finding the fixer should take.
