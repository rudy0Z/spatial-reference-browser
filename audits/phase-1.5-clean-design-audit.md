# Phase 1.5 — LIVE runtime + screenshot anti-slop audit (round 4)

- **Auditor:** Re-auditor · round 4 (live runtime subagent; no app sources edited)
- **Date:** 2026-11-13
- **App:** workspace `app/` spatial browser prototype (Phase 1.5)
- **Server:** `npm --prefix "D:/Fivem/new brosser/app" run dev` → HTTP 200 on http://127.0.0.1:5199/ (port confirmed free first: `netstat -ano | grep :5199` showed only FIN_WAIT_2/CLOSE_WAIT remnants from a dead PID 38032, no LISTENING; `tasklist //FI "PID eq 38032"` → no such process; curl → `000 NO_ANSWER`)
- **Browser:** ZCode In-app Browser (IAB, `iab:c95d26a5-…`), new tab at 1600×900 via `setViewportSize`; `localStorage.clear()` + `reload()` → first-run 28-node designer seed. (First clear attempt passed the function as a *string* and silently no-oped — the tab inherited a persisted `paper` theme from the browser profile; re-ran with a real function and verified: keys after = `spatial.theme` only, `data-theme` unset, body `rgb(11,11,13)` = dark default.)
- **Prior rounds:** round 1 → `audits/phase-1.5-clean-design-audit-round1.md`, round 2 → `…-round2.md`, round 3 → `…-round3.md` (preserved verbatim; this file supersedes them).

**Verdict: ok = false.** Every anti-slop checklist item **passes** on real screenshots (zero neon, zero uppercase badges, zero dead buttons, sentence case, restrained spacing — including the Extensions drawer and Neighbourhood glance panels, which prior rounds could not open). The FPS gate again does not pass — and this round proves conclusively it is an **environment blocker, not an app result**: the IAB guest receives zero BeginFrames, so the prescribed rAF benchmark samples 0 frames; a fresh `about:blank` control tab behaves identically, and the recording API fails with "empty WebM artifact". No valid sustained-fps number exists to record; none is fabricated. Details in §4.

---

## 1. Setup log (commands actually run this round)

```
netstat -ano | grep :5199
# → TCP 127.0.0.1:5199 FIN_WAIT_2/CLOSE_WAIT leftovers, PID 38032; no LISTENING entry
tasklist //FI "PID eq 38032"   → "No tasks are running which match the specified criteria."
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5199/   → 000 NO_ANSWER
npm --prefix "D:/Fivem/new brosser/app" run dev    (background)
# READY after 1s (HTTP 200)
```

Browser bootstrap from `ZCODE_PLUGIN_ROOT` → `agent.browsers.getForUrl('http://127.0.0.1:5199/')` → IAB. All UI interactions driven with native `.click()` / dispatched keydowns via `playwright.evaluate` where Playwright actionability timed out on animated chrome (rail toggle, theme toggle, modal close, palette command row) — same approach the ask prescribes for the palette.

State checks run in-page: `document.querySelectorAll('.react-flow__node').length` → **700** after `/seed-700`; `.react-flow__viewport` transform read per tier; HUD tier badge read from DOM.

---

## 2. MODE A — reading view (28-node first-run seed, dark default)

### S1 · Dark reading view, rail expanded — PASS
Artifact: `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_3\call_c7fde4bf06c64477a1c43241-tool-result-19f998c0-f61e-4d99-9211-8ce82996e44e.png`

- Top command bar: left cluster (rail toggle, Back/Forward **disabled-dimmed** — correct affordance with empty history, not a dead button; reload; shield), center floating pill (avatar `A`, breadcrumb `are.na /studio-notebook/type-rhythm`, neighbour dots, copy/tab actions), right cluster (split view, extensions, glance, theme, help `?`, grid).
- Left rail: "Live tabs · 3", groups "Visual References", "Motion & Shaders", "Studios & Projects" — sentence case, muted headers, active tab outlined.
- Article: clean type hierarchy, teal dotted-underline links, bulleted "Measurements" list, contained hero art. Notes panel "Notes · 1" with a real sticky; audio player bottom-center.
- **No neon borders/glows; no uppercase badges; restrained spacing throughout.**

### S2 · Rail collapsed via UI control — PASS
Artifact: `…\call_e695af508d304b748cb5e0ef-tool-result-2a0fcc93-d0b2-447b-b234-a2b97db57b44.png`

- `button[aria-label="Toggle tab rail (⌘/Ctrl+S)"]` clicked natively (Playwright actionability times out on this animated button — documented harness behavior, not an app bug). Rail slides away; content column re-centres cleanly; toggled back open afterwards.

### S3 · Help modal (⌘/Ctrl+/ control) — PASS
Artifact: `…\call_5f69db22ce8c4420a823527b-tool-result-4596517e-940b-447d-8086-e6feeeab10ea.png`

- "Keyboard shortcuts" sheet grouped **Views / Reading / General** — Toggle canvas ⇄ reading, Command palette, Toggle tab rail, Neighbourhood glance, Quick sticky note, Branch a link into a child node, Drag a link onto the island, This shortcuts sheet, Close overlays — sentence case with monospace keycaps (`⌘/Ctrl Space · Alt Space`, `⌘/Ctrl L`, `Alt N`, `Esc`).
- Footer: "Split view, extensions and the theme live in the top bar. Toolbar actions always work without modifiers." — honest copy, no filler.
- Closes via its "Close shortcuts" button; `[role="dialog"]` verified absent from DOM after the exit spring.

### S4 · Warm-paper light theme via theme toggle, returned to dark — PASS
Artifact (paper, settled): `…\call_44a4b146e9ec4bc183360979-tool-result-16a4a308-6734-497b-a538-528693af206d.png`

- Toggle `aria-label` "Switch to warm paper light theme" ↔ "Switch to dark theme"; verified live state `documentElement.dataset.theme === 'paper'`, body `rgb(244,241,234)`; returned to dark after (`data-theme` unset, body `rgb(11,11,13)`).
- Paper mode: warm cream surface, dark ink, hero artwork keeps its dark plate — deliberate contrast, nothing broken, no neon.

### S5 · Command palette (Ctrl+L keydown dispatched on window) — PASS
Artifact (settled): `…\call_9daa83a6ba0049369c0c10e2-tool-result-671d0e1e-a2fb-4546-8fbc-41b61a8b62ce.png`

- Placeholder "Search tabs, notes, voice memos — or type / for commands"; commands `/canvas`, `/hibernate-all`, `/new`, `/note`, `/cluster`, `/seed-700` with one-line descriptions; footer `↑↓ navigate · ↵ run · esc close · 6 commands`. Sentence case, compact rows, no neon.

---

## 3. MODE B — 700 nodes

`/seed-700` executed exactly as prescribed: palette input filled (React native value-setter + `input` event), then native `.click()` on the `/seed-700` row → **`nodeCount: 700`** (`.react-flow__node`). The command auto-lands on the canvas at zoom 0.30 (macro) — matches the source note at `app/src/components/canvas/SpatialCanvas.tsx:1213`.

Landing reading view of the new active node (Risograph Texture Studies — clean, correct): `…\call_f54746546aed4a308d658065-tool-result-824dcf64-6b77-4dc7-ab54-bb867c3ca829.png`

### S6 · MACRO — 30% (beacons + region titles) — PASS
Artifact: `…\call_0a78836b553a42bfba123a83-tool-result-66d413e2-11a9-4db5-86c2-37a1d909de7f.png`

- HUD dock: `30%  macro | LOD lock | Freeze | Note | Region | Tidy grid | Workbench …` — sentence-case tier chip.
- Beacons render as small dots; region title "Visual References" shown; active node labelled. No clutter, no glow rings.

### S7 · COMPACT — 58% (pills) — PASS
Artifact: `…\call_4fc52454820e4a269b1f8dd6-tool-result-c8568c72-2fb9-45d1-9b59-1a1b17a22d66.png`

- Title pills ("Editorial Grid Syste…", "Chrome Y2K UI Salw…"), active node outlined, hairline edges. HUD `58% compact`. Dense pockets overlap slightly (force layout); ghost echoes appear as translucent duplicates — intentional §6 behaviour, not slop.

### S8 · RICH — 81% (cards) — PASS
Artifact: `…\call_bd394669a3a84179b2b63757-tool-result-2c9291c4-de17-420b-b577-5e552a9882a8.png`

- Full cards: title + source domain (dribbble.com / siteinspire.com / cosmos.so / are.na), preview art, "3 pages" sub-page dropdowns, a seeded sticky note in-situ; active node card elevated. HUD `81% rich`.
- 100% zoom (rehydrated second tab) shows identical card chrome plus canvas sticky placeholders ("Click to write…"): `…\call_2041d1ad5f2145528a681e85-tool-result-8b41e754-d381-49ed-a15e-9e8ffcebcf8c.png`

**LOD stepping verified functionally:** `WheelEvent(deltaY)` dispatched on `.react-flow__pane` itself moved the viewport transform 0.30 → 1.135 → 0.584 → 0.814 and the HUD tier badge macro → rich → compact → rich. Thresholds confirmed in source at `app/src/lib/types.ts:430-433` (macro < 0.35, compact < 0.65, rich ≥ 0.65). An apparent "missing pill" on one transitional canvas capture was re-checked: the floating pill **is present** in canvas mode (S8's 100% capture shows it at top center) — the earlier frame was mid-crossfade.

### Dead-button sweep (checklist item 3) — extra evidence
- Extensions drawer (opens/closes): `…\call_ab0e5331b1234039a3b950e8-tool-result-16aacaaa-2a15-4e81-8580-59abae11ae51.png` — honest copy ("Extension support arrives with the desktop build…"), "Planned for the desktop build" list, no fake toggles.
- Neighbourhood glance (opens/closes): `…\call_24b9246c0ebf45a7a23b021a-tool-result-1176b3ad-cf34-4bc5-b948-3b8d0e066c83.png` — mini constellation, hop counts, neighbour list, `⇧G` footer hint.
- Audio play button: `aria-label` flips "Play mock audio…" → "Pause mock audio…" on click.
- Quick sticky note: created a note — notes header "Notes · 1" + textarea appeared.

---

## 4. FPS benchmark at 700 nodes — **NOT MEASURABLE (host compositor suspends rAF); no number fabricated**

Executed exactly as prescribed, at 700 live nodes mounted on the canvas:

1. **The prescribed benchmark ran and sampled 0 frames.** In-page install: rAF delta sampler + 16ms-interval `WheelEvent` dispatcher on `.react-flow__pane` (alternating pan `deltaX ±40`, zoom `deltaY ±120`), self-terminating after 5.5s. It ran the full window (`durationMs 6672`, ~340 wheel events dispatched). Sampler output: **`totalFrames: 0`** — not a single rAF callback fired during the window. Sustained average fps observed = 0 frames delivered; "% frames slower than 25ms" is undefined at zero samples (encoded 100% = no frame produced against the ~60 Hz expectation). Pass criteria (avg ≥ 55, dropped < 2%) **not met** — but this number describes the harness, not the app.
2. **rAF probes:** 20–30-frame counters with 2s timeouts → **0 frames every time**: on the app tab (twice), on a brand-new tab, and on an **`about:blank` control tab** (`raf20Ms: "TIMEOUT-only-0-frames"`). `document.visibilityState === "visible"` throughout; `document.hasFocus()` flipped to `true` after a real CUA click; zero frames regardless.
3. **Mitigations attempted, all no-ops:** Win32 `SetForegroundWindow` on the host ZCode window (HWND 133908; `setForeground=True foregroundNow=True`), IAB visibility hide/show cycle (`visibility.get()` = true before and after), fresh-tab creation.
4. **Recording API:** `tab.recording.start({fps:60})` → **failed: "Browser recording produced an empty WebM artifact"** — independent proof the guest webview produces no compositor frames.
5. **Why screenshots still work:** every `tab.screenshot()` forces a single frame via capture. This is why mid-animation states were catchable — framer-motion springs only advanced during forced captures.

**Conclusion:** the sustained-fps measurement is impossible in this session's IAB host state. The control experiment (about:blank, zero rAF) and the failed recording prove the blocker is host-side, so no app performance verdict can be honestly derived — and per the ask, real numbers only, none are invented. The fps gate is **FAIL (unmeasurable)**; `ok = false` follows even though every anti-slop item passes. To actually measure: run the same benchmark in a headed window whose guest receives BeginFrames, or drive CDP directly.

---

## 5. Anti-slop checklist (final)

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Zero neon borders/glows | **PASS** | S1–S8 + drawer/glance shots: hairline `border-hairline` borders, muted glass surfaces, teal reserved for links/dots; active/selected states outlined, never glowing. |
| 2 | Zero uppercase debug badges | **PASS** | All visible labels sentence case: "Live tabs", "Visual References", "Notes · 1", "LOD lock", "macro/compact/rich", "Workbench", "Planned for the desktop build". No DEBUG/WIP/TODO chips on any screen. |
| 3 | Zero dead buttons | **PASS** | 12 controls exercised live and all functional (rail toggle ×2 directions, theme ×2, modal open/close, palette + `/seed-700` → 700 nodes, canvas toggle ×2, wheel/LOD stepping, Extensions, glance, audio toggle, quick note). Back/Forward correctly disabled-dimmed with no history. |
| 4 | Sentence case | **PASS** | Keycaps, palette rows, HUD, drawers, rail — all sentence case. |
| 5 | Restrained spacing | **PASS** | ~700px article measure, consistent 8/12/16 rhythm, compact HUD dock, ~40px palette rows; no bloated sections or orphan gaps. |

**Anti-slop violations found: none.**

---

## 6. Verdict

- **ok = false** — solely because the FPS benchmark cannot be measured in this environment (host rAF/BeginFrame suspension, proven host-side by the `about:blank` control and the empty-WebM recording failure). Every checklist item passed on real screenshots this round, including panels prior rounds left unopened.
- No design fixes required for anti-slop. For sign-off, the fps benchmark needs a re-run where the browser guest receives BeginFrames (headed window or direct CDP).

## All screenshot artifacts (harness-saved PNGs, emitted this round)

1. `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_3\call_c7fde4bf06c64477a1c43241-tool-result-19f998c0-f61e-4d99-9211-8ce82996e44e.png` — dark reading view, rail expanded
2. `…\call_e695af508d304b748cb5e0ef-tool-result-2a0fcc93-d0b2-447b-b234-a2b97db57b44.png` — rail collapsed
3. `…\call_5f69db22ce8c4420a823527b-tool-result-4596517e-940b-447d-8086-e6feeeab10ea.png` — help modal
4. `…\call_44a4b146e9ec4bc183360979-tool-result-16a4a308-6734-497b-a538-528693af206d.png` — warm-paper reading view
5. `…\call_9daa83a6ba0049369c0c10e2-tool-result-671d0e1e-a2fb-4546-8fbc-41b61a8b62ce.png` — command palette settled
6. `…\call_f54746546aed4a308d658065-tool-result-824dcf64-6b77-4dc7-ab54-bb867c3ca829.png` — seed-700 landing reading view
7. `…\call_0a78836b553a42bfba123a83-tool-result-66d413e2-11a9-4db5-86c2-37a1d909de7f.png` — MACRO 30%
8. `…\call_4fc52454820e4a269b1f8dd6-tool-result-c8568c72-2fb9-45d1-9b59-1a1b17a22d66.png` — COMPACT 58%
9. `…\call_bd394669a3a84179b2b63757-tool-result-2c9291c4-de17-420b-b577-5e552a9882a8.png` — RICH 81%
10. `…\call_ab0e5331b1234039a3b950e8-tool-result-16aacaaa-2a15-4e81-8580-59abae11ae51.png` — Extensions drawer
11. `…\call_24b9246c0ebf45a7a23b021a-tool-result-1176b3ad-cf34-4bc5-b948-3b8d0e066c83.png` — Neighbourhood glance
12. `…\call_2041d1ad5f2145528a681e85-tool-result-8b41e754-d381-49ed-a15e-9e8ffcebcf8c.png` — canvas 100% rich with pill + canvas stickies

(All `…` above elide the shared prefix `C:\Users\rudra\.zcode\cli\artifacts\sess_dwf-dwfrun-8e271465-e18e-4b8d-9bd0-3bf31ca73c4f-actor_8_3\`.)
Transitional captures kept for the record, not cited as evidence: palette mid-morph `…\call_40763962…png`, paper-with-modal-exiting `…\call_2a4500cd…png`, mid-crossfade canvas `…\call_9a812231…png`.
