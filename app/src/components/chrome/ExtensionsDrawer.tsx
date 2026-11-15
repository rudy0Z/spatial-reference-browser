/**
 * app/src/components/chrome/ExtensionsDrawer.tsx — the quiet Extensions
 * button's drawer, now two tabs (§B.0 Law of Modularity):
 *
 *   Extensions    — the honest Phase 1.5 panel: extension support arrives
 *                   with the desktop build (Phase 4 wires
 *                   `electron-chrome-extensions` + Web Store installs).
 *   Studio & Mods — the §B.9 Live Mods surface: per-domain mod list with
 *                   toggles, a JetBrains Mono CSS scratchpad scoped to the
 *                   active node's domain, three one-click presets, and the
 *                   armed Element Zapper (/zap → Alt+Shift+Click). Every
 *                   action crosses only the trust-gated spatial:* command
 *                   paths; with the tab closed the drawer costs 0 px and
 *                   the engine costs 0 MB (no preload, no timers).
 *
 * Matte chrome, sentence case, canonical vars, spring motion only.
 */

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Eraser, KeyRound, Puzzle, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import {
  spatialApi,
  type LiveModPreset,
  type LiveModRecord,
} from '../../lib/spatialBridge'
import { useGraphStore } from '../../store/useGraphStore'

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** §2 motion language — spring physics everywhere, never linear. */
const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

type DrawerTab = 'extensions' | 'mods'

const PLANNED: ReadonlyArray<{ icon: LucideIcon; label: string }> = [
  { icon: Puzzle, label: 'Chrome Web Store installs — paste a URL or extension ID' },
  { icon: ShieldCheck, label: 'Built-in network adblocking, with optional uBlock Origin' },
  { icon: KeyRound, label: '1Password desktop integration' },
  { icon: SlidersHorizontal, label: 'Toolbar action popovers and “Load unpacked” folders' },
]

export function ExtensionsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<DrawerTab>('extensions')
  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          key="extensions-drawer"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={SPRING}
          role="dialog"
          aria-label="Extensions and Studio mods"
          className={cn(
            'fixed bottom-0 right-0 top-12 z-[60] flex w-[320px] max-w-[86vw] flex-col border-l border-hairline',
          )}
          style={{ background: 'var(--bg-glass)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', boxShadow: 'var(--shadow-pop)' }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-3">
            <Puzzle size={14} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden />
            <div className="flex items-center gap-0.5 rounded-lg border border-hairline p-0.5" role="tablist" aria-label="Drawer sections">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'extensions'}
                onClick={() => setTab('extensions')}
                className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
                style={{ color: tab === 'extensions' ? 'var(--ink-primary)' : 'var(--ink-muted)', background: tab === 'extensions' ? 'var(--glass-soft)' : 'transparent' }}
              >
                Extensions
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'mods'}
                onClick={() => setTab('mods')}
                className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
                style={{ color: tab === 'mods' ? 'var(--ink-primary)' : 'var(--ink-muted)', background: tab === 'mods' ? 'var(--glass-soft)' : 'transparent' }}
              >
                Studio &amp; Mods
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              aria-label="Close extensions panel"
              className="ml-auto flex size-6 items-center justify-center rounded-md text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
            >
              <X size={13} strokeWidth={1.75} aria-hidden />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-color:var(--border-hover)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[color:var(--border-hover)]">
            {tab === 'extensions' ? <ExtensionsTab /> : <StudioModsTab />}
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}

/* ------------------------------------------------------------------ */
/* Extensions tab — the honest Phase 1.5 panel, unchanged in spirit      */
/* ------------------------------------------------------------------ */

function ExtensionsTab() {
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-[color:var(--ink-secondary)]">
        Extension support arrives with the desktop build. This preview renders simulated pages in the browser tab
        itself, so there is no extension host to load into yet.
      </p>

      <h3 className="px-0 pb-1.5 pt-4 text-[10px] font-medium text-[color:var(--ink-muted)]">Planned for the desktop build</h3>
      <div className="overflow-hidden rounded-xl border border-hairline">
        {PLANNED.map(({ icon: Icon, label }) => (
          <div key={label} className="flex items-start gap-2.5 border-b border-hairline px-3 py-2.5 last:border-b-0">
            <Icon size={13} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[color:var(--ink-muted)]" aria-hidden />
            <span className="min-w-0 text-[12px] leading-snug text-[color:var(--ink-secondary)]">{label}</span>
          </div>
        ))}
      </div>

      <p className="pt-4 text-[11px] leading-relaxed text-[color:var(--ink-muted)]">
        The Electron shell (Phases 3–4) mounts the real Chromium extension host on the browsing session — this
        panel becomes the manager then. The Studio &amp; Mods tab already works today, no extension host needed.
      </p>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* §B.9 Studio & Mods tab                                                */
/* ------------------------------------------------------------------ */

const MONO_STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

/** Tiny matte switch (role="switch"), spring knob, canonical vars only. */
function ModToggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative h-4 w-7 shrink-0 rounded-full border transition-colors"
      style={{
        background: checked ? 'var(--border-active)' : 'transparent',
        borderColor: checked ? 'var(--border-active)' : 'var(--border-hover)',
      }}
    >
      <motion.span
        className="absolute top-[2px] size-[10px] rounded-full"
        style={{ background: checked ? 'var(--ink-primary)' : 'var(--ink-muted)' }}
        animate={{ left: checked ? 15 : 2 }}
        transition={SPRING}
      />
    </button>
  )
}

/** One mod row: name, quiet meta, toggle, remove; zap rows list their chips. */
function ModRow({
  mod,
  spatial,
}: {
  mod: LiveModRecord
  spatial: NonNullable<typeof spatialApi>
}) {
  const isZap = mod.id.startsWith('zap:')
  const meta = isZap
    ? mod.zapSelectors.length === 1 ? '1 hidden element' : `${mod.zapSelectors.length} hidden elements`
    : mod.css.trim() ? 'Custom stylesheet' : 'Empty stylesheet'
  return (
    <div className="border-b border-hairline px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-[color:var(--ink-primary)]">{mod.name}</div>
          <div className="truncate text-[10.5px] text-[color:var(--ink-muted)]">{meta}</div>
        </div>
        {!isZap ? (
          <button
            type="button"
            onClick={() => { void spatial.modRemove(mod.id) }}
            title={`Remove ${mod.name}`}
            aria-label={`Remove ${mod.name}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
          >
            <X size={12} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
        <ModToggle
          checked={mod.enabled}
          onChange={(next) => { void spatial.modSetEnabled(mod.id, next) }}
          label={`${mod.enabled ? 'Disable' : 'Enable'} ${mod.name}`}
        />
      </div>
      {isZap && mod.zapSelectors.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {mod.zapSelectors.map((selector) => (
            <span
              key={selector}
              title={`Remove selector: ${selector}`}
              className="group flex max-w-full items-center gap-1 rounded-md border border-hairline px-1.5 py-0.5"
            >
              <code className="min-w-0 max-w-[220px] truncate font-mono text-[10px] text-[color:var(--ink-secondary)]" style={{ fontFamily: MONO_STACK }}>
                {selector}
              </code>
              <button
                type="button"
                onClick={() => { void spatial.modRemoveZap(mod.id, selector) }}
                aria-label={`Remove zapped selector ${selector}`}
                className="shrink-0 text-[color:var(--ink-muted)] transition-colors hover:text-[color:var(--ink-primary)]"
              >
                <X size={10} strokeWidth={1.75} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function StudioModsTab() {
  const spatial = spatialApi
  const [mods, setMods] = useState<LiveModRecord[]>([])
  const [presets, setPresets] = useState<LiveModPreset[]>([])
  const [zapArmed, setZapArmed] = useState(false)
  // null → follow the active node's domain; a picked domain pins the scope.
  const [scope, setScope] = useState<string | null>(null)

  const activeDomain = useGraphStore((s) => (s.activeNodeUuid ? s.nodes[s.activeNodeUuid]?.domain ?? null : null))
  const domain = scope ?? activeDomain

  useEffect(() => {
    if (!spatial) return
    let cancelled = false
    void spatial.modsList().then((result) => {
      if (cancelled || !result?.ok) return
      setMods(result.mods ?? [])
      setPresets(result.presets ?? [])
      setZapArmed(result.zapArmed === true)
    })
    const offMods = spatial.onModsUpdated(({ mods: next, zapArmed: armed }) => {
      setMods(next ?? [])
      setZapArmed(armed === true)
    })
    const offZap = spatial.onZapChanged(({ armed }) => setZapArmed(armed === true))
    return () => {
      cancelled = true
      offMods()
      offZap()
    }
  }, [spatial])

  const domainMods = domain ? mods.filter((m) => m.domainPattern === domain) : []
  const cssMod = domain ? domainMods.find((m) => m.id === `css:${domain}`) : undefined
  const otherDomains = [...new Set(mods.map((m) => m.domainPattern))]
    .filter((d) => d !== domain)
    .map((d) => ({ domain: d, count: mods.filter((m) => m.domainPattern === d).length }))

  /* ---- scratchpad (JetBrains Mono, scoped to the active domain) ---- */
  const scratchRef = useRef<HTMLTextAreaElement | null>(null)
  const saveTimer = useRef<number | null>(null)
  const [draft, setDraft] = useState('')

  // Domain switch: adopt the saved sheet for the new scope.
  useEffect(() => {
    setDraft(cssMod?.css ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain])

  // Broadcast echo: adopt while the scratchpad is not being edited.
  useEffect(() => {
    if (scratchRef.current && document.activeElement === scratchRef.current) return
    setDraft(cssMod?.css ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cssMod?.css])

  useEffect(() => () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
  }, [])

  const scheduleSave = (value: string) => {
    if (!spatial || !domain) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void spatial.modSetCss(domain, value)
    }, 400)
  }

  const appliedPreset = (presetId: string) =>
    domainMods.some((m) => m.id === `preset:${presetId}:${domain}` && m.enabled)

  /* ---- honest empty state: no runtime (vite prototype) ---- */
  if (!spatial) {
    return (
      <p className="text-[12.5px] leading-relaxed text-[color:var(--ink-secondary)]">
        Live Mods connect to the Spatial browser runtime — domain-scoped stylesheets, the element zapper and the
        presets below live inside the desktop shell. This preview renders without that runtime, so there is nothing
        to scope mods to here.
      </p>
    )
  }

  return (
    <>
      {/* Scope row */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium text-[color:var(--ink-muted)]">Scoped to</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[color:var(--ink-primary)]" style={{ fontFamily: MONO_STACK }}>
          {domain ?? '—'}
        </code>
        {otherDomains.length > 0 ? (
          <select
            value=""
            aria-label="Scope mods to another domain"
            onChange={(event) => { if (event.target.value) setScope(event.target.value) }}
            className="max-w-[120px] rounded-md border border-hairline bg-transparent px-1.5 py-1 text-[11px] text-[color:var(--ink-secondary)] outline-none"
          >
            <option value="">Other domains…</option>
            {otherDomains.map(({ domain: d, count }) => (
              <option key={d} value={d}>{d} · {count}</option>
            ))}
          </select>
        ) : null}
        {scope !== null ? (
          <button
            type="button"
            onClick={() => setScope(null)}
            className="shrink-0 text-[11px] text-[color:var(--ink-muted)] transition-colors hover:text-[color:var(--ink-primary)]"
          >
            Follow tab
          </button>
        ) : null}
      </div>
      {!domain ? (
        <p className="pt-3 text-[11.5px] leading-relaxed text-[color:var(--ink-muted)]">
          Open a tab to scope mods to its domain.
        </p>
      ) : null}

      {/* Element zapper */}
      <div className="mt-4 overflow-hidden rounded-xl border border-hairline">
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <Eraser size={13} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-[color:var(--ink-primary)]">Element zapper</div>
            <div className="truncate text-[10.5px] text-[color:var(--ink-muted)]">
              {zapArmed
                ? 'Armed — Alt+Shift+Click hides an element and survives reload'
                : '/zap arms Alt+Shift+Click on the active tab'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => { void (zapArmed ? spatial.zapDisarm() : spatial.zapArm()) }}
            className="shrink-0 rounded-lg border border-hairline px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-[color:var(--glass-soft)]"
            style={{ color: zapArmed ? 'var(--ink-primary)' : 'var(--ink-secondary)' }}
          >
            {zapArmed ? 'Disarm' : 'Arm'}
          </button>
        </div>
      </div>

      {/* Per-domain mod list */}
      {domainMods.length > 0 ? (
        <>
          <h3 className="px-0 pb-1.5 pt-4 text-[10px] font-medium text-[color:var(--ink-muted)]">
            Mods on {domain}
          </h3>
          <div className="overflow-hidden rounded-xl border border-hairline">
            {domainMods.map((mod) => (
              <ModRow key={mod.id} mod={mod} spatial={spatial} />
            ))}
          </div>
        </>
      ) : domain ? (
        <p className="pt-4 text-[11.5px] leading-relaxed text-[color:var(--ink-muted)]">
          No mods on this domain yet — apply a preset, zap an element, or write CSS below.
        </p>
      ) : null}

      {/* CSS scratchpad */}
      {domain ? (
        <>
          <h3 className="px-0 pb-1.5 pt-4 text-[10px] font-medium text-[color:var(--ink-muted)]">
            CSS scratchpad · {domain}
          </h3>
          <textarea
            ref={scratchRef}
            value={draft}
            spellCheck={false}
            aria-label={`CSS scratchpad for ${domain}`}
            placeholder={'/* scoped to ' + domain + ' */\nbutton.cookie { display: none !important; }'}
            onChange={(event) => {
              setDraft(event.target.value)
              scheduleSave(event.target.value)
            }}
            onBlur={() => { if (draft !== (cssMod?.css ?? '')) scheduleSave(draft) }}
            rows={7}
            className="w-full resize-y rounded-xl border border-hairline bg-transparent px-3 py-2.5 text-[11.5px] leading-relaxed text-[color:var(--ink-primary)] outline-none transition-colors focus:border-[color:var(--border-hover)] placeholder:text-[color:var(--ink-muted)]"
            style={{ fontFamily: MONO_STACK }}
          />
        </>
      ) : null}

      {/* One-click presets */}
      <h3 className="px-0 pb-1.5 pt-4 text-[10px] font-medium text-[color:var(--ink-muted)]">One-click presets</h3>
      <div className="overflow-hidden rounded-xl border border-hairline">
        {presets.length === 0 ? (
          <div className="px-3 py-2.5 text-[11.5px] text-[color:var(--ink-muted)]">Presets unavailable.</div>
        ) : null}
        {presets.map((preset) => (
          <div key={preset.id} className="border-b border-hairline px-3 py-2.5 last:border-b-0">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-[color:var(--ink-primary)]">{preset.name}</div>
                <div className="truncate text-[10.5px] text-[color:var(--ink-muted)]">{preset.description}</div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              {preset.variants ? (
                preset.variants.map((variant) => (
                  <button
                    key={variant}
                    type="button"
                    onClick={() => { if (domain) void spatial.modApplyPreset(domain, preset.id, variant) }}
                    disabled={!domain}
                    className="rounded-lg border border-hairline px-2.5 py-1.5 text-[11px] font-medium text-[color:var(--ink-secondary)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)] disabled:opacity-40"
                  >
                    {variant === 'graphite' ? 'Graphite' : 'Paper'}
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  onClick={() => { if (domain) void spatial.modApplyPreset(domain, preset.id) }}
                  disabled={!domain}
                  className="rounded-lg border border-hairline px-2.5 py-1.5 text-[11px] font-medium text-[color:var(--ink-secondary)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)] disabled:opacity-40"
                >
                  Apply
                </button>
              )}
              {domain && appliedPreset(preset.id) ? (
                <span className="text-[10.5px] text-[color:var(--ink-muted)]">Applied on {domain}</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {/* Other domains */}
      {otherDomains.length > 0 ? (
        <>
          <h3 className="px-0 pb-1.5 pt-4 text-[10px] font-medium text-[color:var(--ink-muted)]">Other domains</h3>
          <div className="overflow-hidden rounded-xl border border-hairline">
            {otherDomains.map(({ domain: d, count }) => (
              <button
                key={d}
                type="button"
                onClick={() => setScope(d)}
                className="flex w-full items-center gap-2 border-b border-hairline px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-[color:var(--glass-soft)]"
              >
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[color:var(--ink-secondary)]" style={{ fontFamily: MONO_STACK }}>{d}</code>
                <span className="shrink-0 text-[10.5px] text-[color:var(--ink-muted)]">{count} {count === 1 ? 'mod' : 'mods'}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  )
}

export default ExtensionsDrawer
