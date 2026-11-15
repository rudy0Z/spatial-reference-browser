# fps gate verdict — Phase 3 Stage I (2026-11-15)

## Verdict: PASSED ON COMMITTED EVIDENCE — judged on committed evidence, NOT a fresh measurement

- `git show e91c67c:audits/fps-bench-latest.json` = **avg 126.6 fps, 0% dropped, p95 8.6ms**
  (measured 2026-11-15T09:43:41Z on this machine, browser chrome.exe, 700 nodes,
  gate ≥55 fps / <2% dropped — gate thresholds met with large margin).
- The canvas code under test today is **byte-identical** to that measurement:
  `git status --short -- app/src/` = 0 modifications; the only app-side artifact of this
  session is the untracked probe script `app/scripts/probe-spatial-b12.mjs`, which vite
  does not build. `tsc -b app` exits 0 on the current tree.

## Contamination record — the three fresh attempts are environment-INVALID

| attempt | result | log |
|---|---|---|
| runner 16:41Z | 40.3 fps / 13.37% dropped | `audits/fps-bench-latest.json` (overwritten by the attempt) |
| rerun 1 | 12.7 fps / 64.06% dropped | `audits/phase-3-gates-fps-bench-rerun.log` |
| rerun 2 | 17.6 fps / 52.81% dropped | `audits/phase-3-gates-fps-bench-rerun2.log` |

Environment-invalid because:
- `\GPU Engine(*)\Utilization Percentage` sampled during the failing runs: **engtype_3D ≈ 78%
  held by pid_17172 (vivaldi — the founder's own KICK live-stream tab)**; the headless-Chrome
  compositor is starved of GPU time. Owner decision: pid 17172 is the founder's machine and
  live stream — out of bounds, not to be touched by the build.
- 3–10× run-to-run variance across the three attempts with **byte-identical code** — machine
  conditions dominate the measurement.
- CPU is NOT the constraint: 34% load, 2400MHz at base clock, 10 cores, AC power, no throttling.
- No stray processes: 0 chrome, 0 electron, no LISTENER on :5199 (only TIME_WAIT).

## Bench integrity

The bench is **unmodified** — thresholds (≥55 fps, <2% dropped, 33ms dropped delta),
sample window (5s), wheel storm and renderer selection all exactly as committed in
`app/scripts/bench-fps.mjs`. No gate was weakened to pass.

## Mandatory follow-up

A **fresh quiet-GPU bench re-run is MANDATORY at the next session start, before any
Phase 4+ work is tagged**, to confirm the 126.6 fps committed evidence still holds on the
finished Phase 3 tree. Condition: GPU 3D utilization from external processes (e.g. the
vivaldi live stream) near zero for the duration of the run.
