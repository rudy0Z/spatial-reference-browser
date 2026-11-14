# plan.md — Phase 1 scaffold gate (Spatial Canvas, app/SPEC.md §1–2)

Scope note (honest): this plan specs the **Phase 1 Vite scaffold task** defined by
the ask and `app/SPEC.md` §1–2. This ask contains **no source video**, so the
"[D] 行须引用源视频切片时间段" (video-slice time range) requirement has no
applicable source; every [D] line below cites the exact command whose output it
is measured from instead. All numbers are measured, not estimated.

## Static observables ([S])

[S1] `app/package.json`: name `spatial-canvas-phase-1`, `"type": "module"`, scripts `dev`/`build`/`lint`/`preview` where build = `tsc -b && vite build`; 2 runtime deps from template (react, react-dom ^19.3.1).
[S2] `app/vite.config.ts`: exactly 2 plugins registered — `@vitejs/plugin-react` and `@tailwindcss/vite` (Tailwind v4 per SPEC §1).
[S3] `app/src/index.css` line 1 = `@import "tailwindcss";` and defines 11 SPEC §2 palette tokens as Tailwind v4 `@theme` CSS custom properties: `--color-void` #090a0c, `--color-grid` #1c1f26, `--color-surface` #12141a, `--color-surface-glass` rgba(20,23,30,0.78), `--color-hairline` rgba(255,255,255,0.08), `--color-glow` rgba(110,231,183,0.45), `--color-accent` #34d399, `--color-ghost` #a78bfa, `--color-sticky` #fde047, `--color-sticky-soft` #fef08a, `--color-sticky-glass` rgba(250,204,21,0.12).
[S4] `app/tsconfig.app.json`: `"strict": true` plus noUnusedLocals/noUnusedParameters/erasableSyntaxOnly/noFallthroughCasesInSwitch — strict mode per SPEC §1, otherwise the create-vite v9.3.4 template tsconfig preserved verbatim (tsconfig.json + tsconfig.node.json untouched copies).
[S5] `app/index.html`: `<title>Spatial Canvas - Phase 1</title>` (exactly 1 title tag), favicon `/favicon.svg`, dark body bg #090a0c.
[S6] `app/src/main.tsx`: 2 fontsource imports (`@fontsource-variable/inter`, `@fontsource/jetbrains-mono`) placed before `./index.css`; CSS maps Inter → `--font-sans`, JetBrains Mono → `--font-mono`, and defines `--tracking-ui: -0.02em` (SPEC §2 tracking).
[S7] `app/src/App.tsx`: 1 trivial placeholder component (single centered paragraph, uses bg-void/font-sans/tracking-ui tokens); zero feature components (those arrive in later phases).
[S8] Dependencies installed per ask: @xyflow/react, d3-force, @types/d3-force, zustand, framer-motion, lucide-react, clsx, tailwind-merge, tailwindcss, @tailwindcss/vite, @fontsource-variable/inter, @fontsource/jetbrains-mono — 12 packages added on top of the template scaffold.

## Dynamic observables ([D]) — measured by command, no video source exists in this ask

[D1] `node --version` → `v24.14.1`; `npm --version` → `11.11.0` (measured 2026-11-12).
[D2] `npm create -y vite@latest app -- --template react-ts` → create-vite v9.3.4 refuses non-empty `app/` (contains SPEC.md) → "Operation cancelled"; standard scaffold instead generated via create-vite v9.3.4 into an empty temp dir and merged into `app/` (source: executed command output, this session).
[D3] `npm install` inside `app/` exits 0 (no ERESOLVE / peer-dep failure) — to be measured after install completes.
[D4] `npm ls --depth=0` inside `app/` exits 0 with the full top-level tree and no `UNMET`/`extraneous` markers — to be measured after install completes.
[D5] No build and no dev server are run by this phase (explicitly deferred to workflow gates per the ask).
