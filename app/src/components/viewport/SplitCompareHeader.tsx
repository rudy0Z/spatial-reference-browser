/**
 * app/src/components/viewport/SplitCompareHeader.tsx — §B.10 Plugin D:
 * Split-View Responsive & Onion-Skin Compare.
 *
 * A 30px matte header strip above the split view's RIGHT pane, mounted only
 * while the `split-compare` plugin is active:
 *   - Breakpoint presets (1440 / 1024 / 768 / 375 px) — each resolves through
 *     the trust-gated `spatial:plugins:emulate` channel onto the right pane's
 *     live view via `webContents.enableDeviceEmulation()`; "Auto" disables.
 *   - Onion-Skin overlay — captures the LEFT pane (`capturePage` → PNG data
 *     URL) and superimposes it over the right pane with an opacity slider
 *     (0.0–1.0) and a `mix-blend-mode: difference` toggle for pixel matching.
 *
 * Zero-footprint rule: without the plugin there is no header, no overlay and
 * no emulation state — the split view renders exactly as before.
 *
 * Matte chrome, sentence case, canonical vars — no neon, no badges.
 */
import { useCallback, useEffect, useState } from 'react'
import { Eye, Gauge, Scan } from 'lucide-react'
import { BREAKPOINT_PRESETS } from '../../lib/plugins'
import { spatialApi } from '../../lib/spatialBridge'
import { useToastStore } from '../../store/useToastStore'
import type { NodeUuid } from '../../lib/types'

const HEADER_HEIGHT = 30

const noRuntimeHint = (what: string) => {
  useToastStore.getState().pushToast({
    kind: 'ghost-echo',
    title: `${what} needs the desktop runtime`,
    body: 'Device emulation and pane capture live in the Spatial shell',
  })
}

export default function SplitCompareHeader({ leftUuid, rightUuid }: { leftUuid: NodeUuid; rightUuid: NodeUuid }) {
  const [emulatedWidth, setEmulatedWidth] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [opacity, setOpacity] = useState(0.5)
  const [difference, setDifference] = useState(false)
  const [capturing, setCapturing] = useState(false)

  const setEmulation = useCallback(
    (width: number | null) => {
      setEmulatedWidth(width)
      if (!spatialApi) {
        noRuntimeHint('Breakpoint emulation')
        return
      }
      void spatialApi.pluginsEmulate(rightUuid, width).then((result) => {
        if (!result?.ok) noRuntimeHint('Breakpoint emulation')
      })
    },
    [rightUuid],
  )

  // Leaving the plugin (or the split) never leaves device emulation behind.
  useEffect(() => {
    return () => {
      void spatialApi?.pluginsEmulate(rightUuid, null)
    }
  }, [rightUuid])

  const captureLeft = useCallback(() => {
    if (!spatialApi) {
      noRuntimeHint('Onion-skin snapshot')
      return
    }
    setCapturing(true)
    void spatialApi
      .pluginsCapturePane(leftUuid)
      .then((result) => {
        if (result?.ok && result.dataUrl) setSnapshot(result.dataUrl)
        else noRuntimeHint('Onion-skin snapshot')
      })
      .finally(() => setCapturing(false))
  }, [leftUuid])

  const presetButton = (width: number) => {
    const active = emulatedWidth === width
    return (
      <button
        key={width}
        type="button"
        onClick={() => setEmulation(active ? null : width)}
        className={cnPill(active)}
        title={active ? `Device emulation ${width}px — click to disable` : `Emulate ${width}px viewport`}
      >
        {width}
      </button>
    )
  }

  return (
    <>
      <div
        className="flex shrink-0 items-center gap-2 border-b border-hairline px-2"
        style={{ height: HEADER_HEIGHT, background: 'var(--bg-elevated)' }}
        role="toolbar"
        aria-label="Responsive and onion-skin compare tools"
      >
        <Gauge size={11} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden />
        <div className="flex items-center gap-1">
          {BREAKPOINT_PRESETS.map(presetButton)}
          <button
            type="button"
            onClick={() => setEmulation(null)}
            className={cnPill(emulatedWidth === null)}
            title="No device emulation — full pane width"
          >
            Auto
          </button>
        </div>

        <div className="mx-1 h-4 w-px shrink-0 bg-hairline" aria-hidden />

        {/* Onion-skin — translucent left-pane snapshot over this pane */}
        <button
          type="button"
          onClick={captureLeft}
          disabled={capturing}
          className={cnPill(false)}
          title="Snapshot the left pane for the onion-skin overlay"
        >
          <Scan size={10} strokeWidth={1.75} aria-hidden />
          {capturing ? 'Capturing…' : snapshot ? 'Re-snapshot' : 'Snapshot left'}
        </button>
        {snapshot ? (
          <>
            <Eye size={11} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(event) => setOpacity(Number(event.target.value))}
              aria-label="Onion-skin opacity"
              className="h-1 w-20 accent-[color:var(--ink-secondary)]"
            />
            <button
              type="button"
              onClick={() => setDifference((value) => !value)}
              className={cnPill(difference)}
              title="Blend the snapshot with mix-blend-mode: difference"
            >
              Difference
            </button>
            <button type="button" onClick={() => setSnapshot(null)} className={cnPill(false)} title="Remove the overlay">
              Clear
            </button>
          </>
        ) : null}
      </div>

      {/* the overlay itself — painted over the pane content, never interactive */}
      {snapshot ? (
        <img
          src={snapshot}
          alt="Left pane snapshot (onion-skin overlay)"
          className="pointer-events-none absolute inset-x-0 bottom-0 w-full object-cover"
          style={{
            top: HEADER_HEIGHT,
            height: `calc(100% - ${HEADER_HEIGHT}px)`,
            opacity,
            mixBlendMode: difference ? 'difference' : 'normal',
          }}
        />
      ) : null}
    </>
  )
}

/** Matte pill button shared by the toolbar controls. */
function cnPill(active: boolean): string {
  return [
    'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums transition-colors',
    active
      ? 'border-transparent bg-[color:var(--glass-soft)] text-[color:var(--ink-primary)]'
      : 'border-hairline text-[color:var(--ink-secondary)] hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]',
  ].join(' ')
}
