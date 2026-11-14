# Spatial Canvas — Phase 1 MVP (founder's guide)

This is the interactive Phase 1 prototype of the spatial browser: an infinite spatial canvas of tab "nodes" plus a floating island pill over a **mocked** browser viewport. Its whole job is to let us feel the spatial UX — semantic zoom, physics, sticky/voice notes, pill-to-canvas transitions — before any real browser code exists.

**No real websites in this phase.** Every "webpage" is a simulated mock reader, but everything is functional: navigation, spawning child nodes, hibernation, notes, voice memos. Real live websites arrive in **Phase 2**, when this UI gets wired onto the Blanc fork's Electron `WebContentsView` pool (see `app/SPEC.md`).

## Run it

You need [Node.js](https://nodejs.org) installed. Then, in a terminal in the project folder:

```bash
cd app
npm install     # first time only (or after package.json changes)
npm run dev
```

The app opens at **http://127.0.0.1:5199/** — that address is fixed in `app/vite.config.ts` (host `127.0.0.1`, port `5199`, `strictPort: true`), so Vite prints `Local: http://127.0.0.1:5199/` and will refuse to start if that port is already taken by something else, rather than silently picking a different one.

*Verified during this handoff: `npm run dev` started in ~0.5s, printed the URL above, and `curl http://127.0.0.1:5199/` returned HTTP 200.*

**First launch** pre-seeds 28 curated tabs across 4 spatial islands — 3 live, 22 hibernated (some visibly "cold"), 2 Ghost Echo suggestions, sample sticky notes, one audible tab, one private blurred node, one Google search hub with query-tagged children, and one duplicate-URL pair sharing notes (`app/SPEC.md` §9; `app/src/lib/seed.ts:61`). It opens in reading mode so it looks alive immediately.

State persists in the browser's `localStorage` (`app/src/store/useGraphStore.ts:1109`), so your graph survives a refresh. To start clean, clear the site's storage in your browser (DevTools → Application → Local Storage → delete).

## Keyboard shortcuts

`Cmd` = ⌘ on Mac, `Ctrl` on Windows. From `app/SPEC.md` §10 — these are all implemented, with on-screen hint chips so nothing conflicts silently with the host OS:

| Shortcut | Action | Guard |
|---|---|---|
| `Cmd/Ctrl+Space` **and** `Alt+Space` | Toggle Canvas ⇄ Reading | `preventDefault`; Alt+Space exists because the browser test rig may swallow Cmd/Ctrl+Space |
| `Cmd/Ctrl+L` | Command palette | preventDefault (browser address bar) |
| `Alt+N` | Quick sticky note on active node | preventDefault |
| `Cmd/Ctrl+Shift+G` | Neighbourhood Glance | preventDefault |
| `Esc` | Close palette / dismiss ghost / back to reading | layered dismissal |

The command palette (`Cmd/Ctrl+L`, or click the pill's center) also takes six slash commands (`app/src/lib/types.ts:256-263`):

| Command | What it does |
|---|---|
| `/canvas` | Toggle reading viewport ⇄ spatial canvas |
| `/hibernate-all` | Hibernate every non-immune live tab |
| `/new` | Spawn a fresh live tab near the active node |
| `/note` | Quick sticky note on the active node |
| `/cluster` | Wrap the active 1-hop neighbourhood into a region |
| `/seed-600` | 600-tab stress seed across 6 regions |

## The `/seed-600` stress test — what to check at each zoom level

1. Open the command palette (`Cmd/Ctrl+L`) and type `/seed-600`.
2. It **replaces** the whole graph with exactly 600 nodes across 6 regions — UI Systems, Browser Architecture, WebGPU & Shaders, AI Agents, F1 Data Viz, Career & Docs (`app/src/lib/seed.ts:520-601`) — and deliberately lands at **0.3x zoom** so you start at the macro tier (`app/src/components/canvas/SpatialCanvas.tsx:795`).
3. The seed includes: 6 Google search hubs (one per region), pinned anchors that never drift, exactly 5 live tabs (the LRU pool limit), one audible tab immune to hibernation, ages spread over 0–45 simulated days (so the >14-day "cold archive" dimming is visible), blurred private nodes, SPA filmstrip trails, cached-snapshot nodes, and one LinkedIn "via auth" node (`app/src/lib/seed.ts:618-689`).

Now zoom with the scroll wheel / trackpad and watch the **zoom indicator in the bottom HUD** — the cards change shape at two thresholds:

| Zoom tier | Range | What you should see | What to verify |
|---|---|---|---|
| **Macro Constellation** | below 0.35x | Pure colored dot beacons (~24px), no cards; big region titles appear | All 6 region titles readable; panning 600 nodes stays smooth — this tier strips the heavy DOM on purpose |
| **Compact Pill** | 0.35x – 0.65x | Sleek 180×44px pills: favicon + truncated title + note/audio micro-dot + pin icon | Pills render crisply at 600; pinned vs orbiting nodes distinguishable |
| **Rich Spatial Card** | 0.65x and above | Full 260px cards with 16:9 thumbnail, metadata bar, hover actions | Hover actions (Open Viewport, Hibernate, Pin Anchor, + Note); `LIVE · xxx MB` vs `SLEEP · 0 MB` badges; old nodes visibly dimmed |

Thresholds come from `app/SPEC.md` §4 and are implemented in `app/src/lib/types.ts:358`. While you're there, also try: the **semantic-zoom override toggle** in the HUD (pins the richest tier), the **physics Freeze/Relax toggle**, and dragging a node (it anchors in place). If panning ever stutters, that's a finding — this seed exists to catch exactly that.

## What's mocked vs. what ships later

Everything in `app/SPEC.md` §8 ("honest scope") — plus the underlying premise that all webpages are simulations:

| In this MVP (mocked) | Ships later (real thing) |
|---|---|
| Toy hash "embeddings" (`app/src/lib/embed.ts` — same interface the real model will have) | Real `all-MiniLM-L6-v2` via transformers.js (Phase 2/3) |
| Voice notes searchable by **title/duration only** | Local Whisper speech-to-text |
| State in `localStorage` via zustand persist | SQLite, with the Electron phase |
| **RAM badges are mock numbers** (stable per tab; hibernated always `0 MB`) | Real per-tab memory from the browser |
| Mock reader pages with clickable outbound links | Real websites via the Blanc fork's `WebContentsView` pool (Phase 2) |

RAM numbers, page content, and URLs are realistic but fabricated — don't read anything into the specific figures.

## Known limitations (all cosmetic or edge-case; none block the demo)

From the Phase 1 run checks — every finding verified against the code during this handoff:

1. **Dot grid doesn't fade with zoom** (§2) — `app/src/components/canvas/SpatialCanvas.tsx:845-861`. The background dot grid renders statically at every zoom level; the only fade is a fixed radial vignette. The spec's "fading out at low zoom" isn't implemented. Cosmetic only.
2. **Pin glyph sits in the wrong corner** (§4 state 6) — `app/src/components/canvas/nodes/SpatialTabNode.tsx:1281`. At rich-card zoom the pin shows in the bottom badges row instead of the card's top-right. Pin *behavior* (drag to lock, Pin/Unpin action) is fully correct; only the glyph's position is off.
3. **"Under 3 seconds" redirect collapse not modeled** (§7.2) — `app/src/lib/types.ts:351-355`, `app/src/store/useGraphStore.ts:596-608`. OAuth/payment domains do collapse into one "via auth" node (and the seeder includes an example, `seed-career-linkedin-via-auth` at `app/src/lib/seed.ts:396`), but the time-based half of the rule has no counterpart — defensible, since mock navigation is instantaneous.
4. **Rare voice-recorder race** (§1) — `app/src/hooks/useVoiceRecorder.ts:236-263, 310-322`. If the recording panel closes while the mic permission is still pending, the pending recording can start "attached to nothing" and the node stays marked as recording until you reopen the mic panel or close the page. Edge case; recoverable.
5. **Voice-memo progress bar stays at 0** (§4.4) — `app/src/hooks/useVoiceRecorder.ts:411-414`. During playback the thin progress underline doesn't move (a WebM/Opus duration quirk, safely guarded so nothing crashes); the 12-bar waveform still animates and the audio plays.
6. **One dead store function** (§6) — `app/src/store/useGraphStore.ts:969-987`. `refreshGhostEchoes()` is fully implemented but never called; ghosts still refresh correctly through node activation, so no behavior gap — it's just unused public API.
7. **Storage quota ceiling for voice memos** (§1/§8) — `app/src/store/useGraphStore.ts:1107-1109`, `app/src/hooks/useVoiceRecorder.ts:177-187`. Memos save as base64 in `localStorage` (the spec allows "localStorage or IndexedDB"). A handful of long memos can exhaust the ~5 MB quota, after which persistence silently stops writing. Small memos round-trip fine (confirmed in the run checks). No IndexedDB fallback yet.

## Where things live

- **Spec:** `app/SPEC.md` — the contract this build was measured against; section numbers (§) in this file refer to it.
- **Source:** `app/src/` — `store/useGraphStore.ts` (all state), `lib/seed.ts` (first-run + stress seeds), `components/canvas/` (canvas and node cards), `components/chrome/` (floating pill), `components/viewport/` (mock reader), `hooks/useVoiceRecorder.ts` (voice memos).
