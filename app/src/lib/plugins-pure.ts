/**
 * app/src/lib/plugins-pure.ts — §B.10 Studio Plugins, PURE layer (Phase 3.6).
 *
 * Everything in the plugin registry that needs no runtime, no IPC and no
 * zustand: the plugin catalog, media-drop detection (Plugin B), the X-Ray
 * token snapshot type + Markdown formatter + sRGB→OKLCH color math
 * (Plugin A), and Plugin D's breakpoint table.
 *
 * Split from `plugins.ts` for the same reason `trails.ts` is self-contained:
 * `node --test` type-stripping resolves relative imports literally, and the
 * registry's runtime half (zustand store + spatialAPI calls) must never load
 * in a test harness. `plugins.ts` re-exports everything from here, so
 * consumers import from the registry and never see this file.
 *
 * Explicit `.ts` extensions on value imports — the one spelling node
 * type-stripping, tsc (allowImportingTsExtensions) and Vite all agree on.
 * (This module has no runtime value imports — only erased type imports.)
 */
import type { MediaClipKind, SpatialMediaDrop } from './types'

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export type StudioPluginId = 'xray' | 'media-clip' | 'shader-hud' | 'split-compare'

export type StudioPluginDescriptor = {
  id: StudioPluginId
  label: string
  /** Omnibox command that toggles the plugin (null = drawer/toolbar only). */
  command: 'xray' | 'shader-hud' | null
  description: string
  /** What "off" guarantees (§B.0 — 0 px, 0 MB). Shown verbatim in the drawer. */
  zeroCost: string
}

export const STUDIO_PLUGINS: readonly StudioPluginDescriptor[] = [
  {
    id: 'xray',
    label: 'Token & Typography X-Ray',
    command: 'xray',
    description:
      'Hover any element on a live page for a compact HUD of its resolved type tokens and colors; click to capture them into a sticky note.',
    zeroCost: 'Off: no page instrumentation, no HUD, no captures.',
  },
  {
    id: 'media-clip',
    label: 'Drag-to-Clip Media Cards',
    command: null,
    description:
      'Drag an image, SVG or video from a live page onto the pill or canvas to spawn a connected media card; the source is cached locally.',
    zeroCost: 'Off: media drags behave like plain link drags; nothing is cached.',
  },
  {
    id: 'shader-hud',
    label: 'Shader & Motion HUD',
    command: 'shader-hud',
    description:
      'Inspect the canvas elements on a live page (context type, pixel resolution, live frame time) and record a 5-second motion loop preview.',
    zeroCost: 'Off: no canvas probes, no frame capture.',
  },
  {
    id: 'split-compare',
    label: 'Responsive & Onion-Skin Compare',
    command: null,
    description:
      'In split view, emulate breakpoints on the right pane and overlay a translucent snapshot of the left pane for pixel matching.',
    zeroCost: 'Off: the split view stays exactly as it was; no overlays.',
  },
]

export const STUDIO_PLUGIN_IDS: readonly StudioPluginId[] = STUDIO_PLUGINS.map((plugin) => plugin.id)

export function studioPluginById(id: string): StudioPluginDescriptor | null {
  return STUDIO_PLUGINS.find((plugin) => plugin.id === id) ?? null
}

/** Plugin D — device-emulation breakpoints (spec §B.10, exact values). */
export const BREAKPOINT_PRESETS: readonly number[] = [1440, 1024, 768, 375]

/* ------------------------------------------------------------------ */
/* Plugin B — media drag detection (pure, unit-testable)                */
/* ------------------------------------------------------------------ */

/** Minimal DataTransfer shape the drop zones hand to `detectMediaDrop`. */
export type DataTransferLike = {
  readonly types: readonly string[]
  getData: (type: string) => string
}

/** Extension → media kind map (the only extensions we cache, mirrored in main's policy). */
export const MEDIA_EXT_KIND: Readonly<Record<string, MediaClipKind>> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'svg',
  webm: 'video',
  mp4: 'video',
}

const MEDIA_URL_PATTERN = /^https?:\/\/\S+$/i

/** First `<source>`-independent media URL found in an HTML drag fragment. */
export function extractMediaUrlFromHtml(html: string): { url: string; tag: 'img' | 'video' | 'svg' } | null {
  if (!html || html.length > 20_000) return null
  const lower = html.toLowerCase()
  if (!lower.includes('<img') && !lower.includes('<video') && !lower.includes('<svg')) return null
  // src="…" / src='…' on the first img/video; svg drags carry the document itself.
  const srcMatch = /<(?:img|video)[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(html)
  if (srcMatch) {
    const url = (srcMatch[1] ?? srcMatch[2] ?? '').trim()
    if (MEDIA_URL_PATTERN.test(url)) return { url, tag: lower.includes('<video') ? 'video' : 'img' }
  }
  const sourceMatch = /<source[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(html)
  if (sourceMatch) {
    const url = (sourceMatch[1] ?? sourceMatch[2] ?? '').trim()
    if (MEDIA_URL_PATTERN.test(url)) return { url, tag: 'video' }
  }
  return null
}

/** Classify a bare URL as a media kind by extension, or null. */
export function mediaKindOfUrl(url: string): MediaClipKind | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const ext = (parsed.pathname.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
    return ext ? (MEDIA_EXT_KIND[ext] ?? null) : null
  } catch {
    return null
  }
}

/**
 * Detect a Drag-to-Clip payload in a native drop. Priority:
 *   1. `text/html` carrying an img/video element (the usual page drag);
 *   2. inline `<svg>` document markup (svg drags carry the document itself);
 *   3. `text/uri-list` whose target is a media file;
 *   4. bare media types (`image/…`, `video/…` — OS file drags).
 * `src` may be empty when the payload IS the media (inline svg) — the drop
 * handler passes the markup to main's cache; `sourcePageUrl` is the drag's
 * provenance for the RichCard hover attribution.
 */
export function detectMediaDrop(dataTransfer: DataTransferLike, fallbackPageUrl: string | null): SpatialMediaDrop | null {
  const types = dataTransfer.types ?? []
  const has = (type: string) => types.includes(type)

  if (has('text/html')) {
    const html = dataTransfer.getData('text/html')
    if (/^\s*<svg[\s>]/i.test(html)) {
      return { kind: 'media-clip', mediaKind: 'svg', src: '', sourcePageUrl: fallbackPageUrl, markup: html }
    }
    const found = extractMediaUrlFromHtml(html)
    if (found) {
      return {
        kind: 'media-clip',
        mediaKind: found.tag === 'video' ? 'video' : found.url.toLowerCase().endsWith('.svg') ? 'svg' : 'image',
        src: found.url,
        sourcePageUrl: fallbackPageUrl,
      }
    }
  }

  if (has('text/uri-list') || has('text/plain')) {
    for (const type of ['text/uri-list', 'text/plain']) {
      if (!has(type)) continue
      const candidate = dataTransfer
        .getData(type)
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '' && !line.startsWith('#'))
      if (!candidate) continue
      const kind = mediaKindOfUrl(candidate)
      if (kind) return { kind: 'media-clip', mediaKind: kind, src: candidate, sourcePageUrl: fallbackPageUrl }
    }
  }

  if (types.some((type) => type.startsWith('image/') || type.startsWith('video/'))) {
    const mediaType = types.find((type) => type.startsWith('image/') || type.startsWith('video/')) as string
    return {
      kind: 'media-clip',
      mediaKind: mediaType.startsWith('image/') ? 'image' : 'video',
      src: '',
      sourcePageUrl: fallbackPageUrl,
    }
  }

  return null
}

/* ------------------------------------------------------------------ */
/* Plugin A — X-Ray token snapshot → Markdown                          */
/* ------------------------------------------------------------------ */

/** One hovered element's resolved tokens, as the in-page X-Ray reports them. */
export type XrayTokenSnapshot = {
  /** Short CSS-ish selector of the hovered element. */
  selector: string
  /** Computed font-family stack, verbatim. */
  fontFamily: string
  /** The resolved @font-face family (the face actually painted), when known. */
  resolvedFamily: string | null
  fontWeight: string
  fontSize: string
  lineHeight: string
  letterSpacing: string
  /** Computed color, as a css color string (rgb/rgba). */
  color: string
  /** Computed background-color. */
  backgroundColor: string
  /** Computed transition shorthand, or 'none'. */
  transition: string
  /** First cubic-bezier() found in the transition, or null. */
  easing: string | null
  /** Page the element lives on. */
  url: string | null
}

/* ---- color math: sRGB hex ⇄ OKLCH (CSS Color 4 OKLab) ---- */

const srgbToLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** Parse `#rgb`/`#rrggbb` (and 4/8-digit alpha) to 0-255 channels; null if not hex. */
export function hexToRgbChannels(hex: string): { r: number; g: number; b: number; a: number } | null {
  const match = /^#([0-9a-f]{3,8})$/i.exec(hex.trim())
  if (!match) return null
  const body = match[1]
  const expand = (part: string) => parseInt(part.length === 1 ? part + part : part, 16)
  if (body.length === 3 || body.length === 4) {
    return {
      r: expand(body[0]),
      g: expand(body[1]),
      b: expand(body[2]),
      a: body.length === 4 ? expand(body[3]) / 255 : 1,
    }
  }
  if (body.length === 6 || body.length === 8) {
    return {
      r: expand(body.slice(0, 2)),
      g: expand(body.slice(2, 4)),
      b: expand(body.slice(4, 6)),
      a: body.length === 8 ? expand(body.slice(6, 8)) / 255 : 1,
    }
  }
  return null
}

/**
 * sRGB channels (0-255) → OKLCH per CSS Color 4: linear sRGB → OKLab matrix
 * → LCH (cylindrical). Returns `{ l (0-1), c, h (deg) }`.
 */
export function rgbToOklch(r: number, g: number, b: number): { l: number; c: number; h: number } {
  const rl = srgbToLinear(clamp01(r / 255))
  const gl = srgbToLinear(clamp01(g / 255))
  const bl = srgbToLinear(clamp01(b / 255))

  // linear sRGB → OKLab (Björn Ottosson's reference matrices)
  const l_ = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl
  const m_ = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl
  const s_ = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl
  const l_c = Math.cbrt(l_)
  const m_c = Math.cbrt(m_)
  const s_c = Math.cbrt(s_)

  const L = 0.2104542553 * l_c + 0.793617785 * m_c - 0.0040720468 * s_c
  const A = 1.9779984951 * l_c - 2.428592205 * m_c + 0.4505937099 * s_c
  const B = 0.0259040371 * l_c + 0.7827717662 * m_c - 0.808675766 * s_c

  const c = Math.sqrt(A * A + B * B)
  let h = (Math.atan2(B, A) * 180) / Math.PI
  if (h < 0) h += 360
  return { l: L, c, h }
}

/** OKLCH as a CSS `oklch()` string, quantized for compact display. */
export function formatOklch(r: number, g: number, b: number, alpha = 1): string {
  const { l, c, h } = rgbToOklch(r, g, b)
  const lPct = `${(l * 100).toFixed(1)}%`
  const cStr = c.toFixed(4)
  const hStr = h.toFixed(1)
  if (alpha < 1) return `oklch(${lPct} ${cStr} ${hStr} / ${alpha.toFixed(2)})`
  return `oklch(${lPct} ${cStr} ${hStr})`
}

/**
 * A computed CSS color → "HEX · OKLCH" pair (X-Ray HUD pill + Markdown).
 * Handles rgb()/rgba() computed values and already-hex values; anything else
 * passes through verbatim once — never a fabricated value.
 */
export function formatColorPair(color: string): string {
  const value = color.trim()
  const rgbMatch = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i.exec(value)
  if (rgbMatch) {
    const r = Math.round(parseFloat(rgbMatch[1]))
    const g = Math.round(parseFloat(rgbMatch[2]))
    const b = Math.round(parseFloat(rgbMatch[3]))
    const a = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1
    const hex = `#${[r, g, b].map((ch) => ch.toString(16).padStart(2, '0')).join('')}${a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : ''}`
    return `${hex} · ${formatOklch(r, g, b, a)}`
  }
  const channels = hexToRgbChannels(value)
  if (channels) {
    return `${value.toLowerCase()} · ${formatOklch(channels.r, channels.g, channels.b, channels.a)}`
  }
  return value
}

/** First cubic-bezier() in a transition/easing string, or null. */
export function firstCubicBezier(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /cubic-bezier\([^)]*\)/i.exec(value)
  return match ? match[0] : null
}

/** Format a hovered element's tokens as the capture Markdown (Plugin A). */
export function formatXrayMarkdown(snapshot: XrayTokenSnapshot): string {
  const lines: string[] = []
  lines.push(`## Token capture — \`${snapshot.selector}\``)
  lines.push('')
  lines.push('**Typography**')
  const family = snapshot.resolvedFamily
    ? `"${snapshot.resolvedFamily}" (from ${snapshot.fontFamily})`
    : snapshot.fontFamily
  lines.push(`- family: ${family}`)
  lines.push(`- weight: ${snapshot.fontWeight} · size: ${snapshot.fontSize} · line-height: ${snapshot.lineHeight}`)
  lines.push(`- letter-spacing: ${snapshot.letterSpacing || 'normal'}`)
  lines.push('')
  lines.push('**Color**')
  lines.push(`- text: ${formatColorPair(snapshot.color)}`)
  lines.push(`- background: ${formatColorPair(snapshot.backgroundColor)}`)
  const easing = firstCubicBezier(snapshot.transition) ?? snapshot.easing
  lines.push('')
  lines.push('**Motion**')
  lines.push(
    `- transition: ${snapshot.transition && snapshot.transition !== 'none' ? snapshot.transition : 'none'}${
      easing && snapshot.transition !== 'none' ? ` · easing: ${easing}` : ''
    }`,
  )
  if (snapshot.url) {
    lines.push('')
    lines.push(`Captured from ${snapshot.url}`)
  }
  return lines.join('\n')
}
