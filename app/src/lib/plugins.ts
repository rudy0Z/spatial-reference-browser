/**
 * app/src/lib/plugins.ts — §B.10 Toggleable Studio Plugins registry
 * (Phase 3.6, runtime half).
 *
 * The single catalog of the four studio plugins, their activation state, and
 * the media/preview runtime paths. The pure layer (catalog, drop detection,
 * X-Ray Markdown + OKLCH math, breakpoint table) lives in `plugins-pure.ts`
 * and is re-exported from here — consumers import ONLY from this module.
 *
 * The design law is §B.0's modularity rule, applied per plugin:
 *
 *   • Toggled ON — the plugin's instrumentation is injected into the live
 *     page views through main's trust-gated `spatial:plugins:*` channels
 *     (`browser/src/main/spatial/studio-plugins.js`). Page-side scripts run
 *     ONLY while their plugin is active — armed on activation + on dom-ready
 *     of attached views, torn down on deactivation (the §B.9 zapper posture:
 *     `executeJavaScript`, never a page-context preload), so a deactivated
 *     plugin leaves zero code in any document.
 *   • Toggled OFF — 0 px, 0 MB: no scripts injected, no listeners, no timers,
 *     no cached media, no overlay elements. `active` is session state (never
 *     persisted) and defaults to all-off; main holds the authoritative set.
 *
 * Plugins:
 *   A  `xray`          — Token & Typography X-Ray (/xray). Hover HUD pill on
 *                        the live page; click-to-capture formats the tokens
 *                        into Markdown and lands them in the active node's
 *                        StickyNote (§7.6 url_hash attachment).
 *   B  `media-clip`    — Drag-to-Clip Media Cards. Drag an img/svg/video off
 *                        a live page into the pill/canvas; main caches the
 *                        bytes into `userData/media/` (trust-gated IPC) and a
 *                        node tagged `mediaClip` spawns with a spawn edge.
 *   C  `shader-hud`    — Shader & Motion HUD (/shader-hud). Enumerates
 *                        `<canvas>` elements with context type, pixel
 *                        resolution and a live rAF frame-time probe; "Record
 *                        5s Card Preview" captures a 640×400 WebM compositor
 *                        loop onto the node for RichCard hover playback.
 *   D  `split-compare` — Split-View Responsive & Onion-Skin Compare. Extends
 *                        the 2-pane split with breakpoint presets
 *                        (1440/1024/768/375 via `enableDeviceEmulation`) and
 *                        a translucent left-pane snapshot over the right pane
 *                        (opacity slider + `mix-blend-mode: difference`).
 */
import { create } from 'zustand'
import { spatialApi } from './spatialBridge'

// Pure layer — explicit .ts extension (the node --test / tsc / Vite spelling).
export {
  BREAKPOINT_PRESETS,
  MEDIA_EXT_KIND,
  STUDIO_PLUGIN_IDS,
  STUDIO_PLUGINS,
  detectMediaDrop,
  extractMediaUrlFromHtml,
  firstCubicBezier,
  formatColorPair,
  formatOklch,
  formatXrayMarkdown,
  hexToRgbChannels,
  mediaKindOfUrl,
  rgbToOklch,
  studioPluginById,
} from './plugins-pure.ts'
export type { DataTransferLike, StudioPluginDescriptor, StudioPluginId, XrayTokenSnapshot } from './plugins-pure.ts'

import { STUDIO_PLUGIN_IDS } from './plugins-pure.ts'
import type { MediaClipRef, SpatialMediaDrop } from './types'
import type { StudioPluginId } from './plugins-pure.ts'

/* ------------------------------------------------------------------ */
/* Activation store — session state, never persisted (§B.0: off = 0 MB) */
/* ------------------------------------------------------------------ */

type PluginActivationState = {
  active: Record<StudioPluginId, boolean>
  setEnabled: (id: StudioPluginId, on: boolean) => void
  /** Adopt main's authoritative active set (broadcast echo). */
  setActiveSet: (ids: readonly string[]) => void
}

const emptyActiveSet = (): Record<StudioPluginId, boolean> => ({
  xray: false,
  'media-clip': false,
  'shader-hud': false,
  'split-compare': false,
})

export const useStudioPluginStore = create<PluginActivationState>()((set) => ({
  active: emptyActiveSet(),
  setEnabled: (id, on) => {
    // Optimistic local flip, then main's echo settles it. Without the
    // runtime the flip stays local so the vite prototype still demos.
    set((state) => ({ active: { ...state.active, [id]: on } }))
    void spatialApi?.pluginsSetActive(id, on)
  },
  setActiveSet: (ids) => {
    const active = emptyActiveSet()
    for (const id of ids) {
      if ((STUDIO_PLUGIN_IDS as readonly string[]).includes(id)) {
        active[id as StudioPluginId] = true
      }
    }
    set({ active })
  },
}))

/** True while the studio plugin is active — the ONLY gate for its UI/IPC. */
export function isPluginActive(id: StudioPluginId): boolean {
  return useStudioPluginStore.getState().active[id] === true
}

export function toggleStudioPlugin(id: StudioPluginId): void {
  const state = useStudioPluginStore.getState()
  state.setEnabled(id, !state.active[id])
}

/**
 * One-time studio-plugin state sync: adopt main's authoritative active set
 * and follow its broadcasts. Returns a disposer; safe without the runtime.
 */
export function installStudioPluginSync(): () => void {
  const off = spatialApi?.onPluginsUpdated((payload) => {
    useStudioPluginStore.getState().setActiveSet((payload.plugins ?? []).map((plugin) => plugin.id))
  })
  if (spatialApi) {
    void spatialApi.pluginsList().then((result) => {
      if (result?.ok) useStudioPluginStore.getState().setActiveSet((result.plugins ?? []).map((plugin) => plugin.id))
    })
  }
  return off ?? (() => {})
}

/* ------------------------------------------------------------------ */
/* Media clip fetch cache (Plugin B/C rendering)                       */
/* ------------------------------------------------------------------ */

const CLIP_CACHE_LIMIT = 6
const clipCache = new Map<string, string>()

/**
 * Fetch a cached clip's bytes (trust-gated `spatial:media:read`) as a data
 * URL, memoized in a tiny LRU. Only called while a card is actually
 * rendering/hovering media — off means zero fetches and zero bytes held.
 */
export async function getMediaClipUrl(clipId: string): Promise<string | null> {
  const cached = clipCache.get(clipId)
  if (cached) {
    clipCache.delete(clipId)
    clipCache.set(clipId, cached) // LRU touch
    return cached
  }
  if (!spatialApi) return null
  const result = await spatialApi.mediaReadClip(clipId)
  if (!result?.ok || !result.dataUrl) return null
  clipCache.set(clipId, result.dataUrl)
  while (clipCache.size > CLIP_CACHE_LIMIT) {
    const oldest = clipCache.keys().next().value
    if (oldest === undefined) break
    clipCache.delete(oldest)
  }
  return result.dataUrl
}

/** Evict a clip's cached data URL (node deleted / clip removed). */
export function evictMediaClipUrl(clipId: string): void {
  clipCache.delete(clipId)
}

/* ------------------------------------------------------------------ */
/* Plugin C — 5-second card preview recorder (640×400 WebM)            */
/* ------------------------------------------------------------------ */

export const CARD_PREVIEW_WIDTH = 640
export const CARD_PREVIEW_HEIGHT = 400

type CardPreviewCallbacks = {
  onFrame?: (index: number, total: number) => void
  onDone?: (clip: MediaClipRef | null, error?: string) => void
}

/**
 * Record the ACTIVE live view as a 640×400 WebM compositor loop (Plugin C).
 * Main subscribes the compositor and streams base64 PNG frames to the shell
 * (`spatial:plugin-hud:frame`); the shell paints them onto a 640×400 canvas
 * and MediaRecorder captures that stream — no native encoder needed. The
 * resulting WebM is written by main into `userData/media/` (trust-gated) and
 * returned as a MediaClipRef ready for `patchMediaClip(nodeUuid, clip)`.
 *
 * Resolves with the clip, or null + error reason on any failure/timeout.
 */
export function recordCardPreview(
  sourcePageUrl: string | null,
  callbacks: CardPreviewCallbacks = {},
): Promise<MediaClipRef | null> {
  return new Promise((resolve) => {
    if (!spatialApi) {
      callbacks.onDone?.(null, 'no-runtime')
      resolve(null)
      return
    }
    let recorder: MediaRecorder | null = null
    let canvas: HTMLCanvasElement | null = null
    let stream: MediaStream | null = null
    let chunks: Blob[] = []
    let framesSeen = 0
    let finished = false
    const timeout = window.setTimeout(() => finish('timeout'), 9_000)

    const cleanup = () => {
      window.clearTimeout(timeout)
      offFrame()
      offDone()
    }

    const finish = (error?: string) => {
      if (finished) return
      finished = true
      cleanup()
      try {
        recorder?.stop()
      } catch {
        /* already stopped */
      }
      stream?.getTracks().forEach((track) => track.stop())
      canvas?.remove()
      if (error) {
        callbacks.onDone?.(null, error)
        resolve(null)
        return
      }
    }

    const stopAndStore = () => {
      const grab = new Blob(chunks, { type: 'video/webm' })
      if (grab.size === 0) {
        finish('empty-recording')
        return
      }
      void grab.arrayBuffer().then(async (buffer) => {
        let binary = ''
        const bytes = new Uint8Array(buffer)
        const chunk = 0x8000
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
        }
        const result = await spatialApi!.mediaStoreWebm(btoa(binary), sourcePageUrl)
        if (!result?.ok || !result.clip) {
          finish(result?.error ?? 'store-failed')
          return
        }
        finished = true
        cleanup()
        const clip = result.clip as MediaClipRef
        callbacks.onDone?.(clip)
        resolve(clip)
      })
    }

    const offFrame = spatialApi.onShaderHudFrame(({ frame }) => {
      if (finished || !canvas) return
      const image = new Image()
      image.onload = () => {
        if (finished || !canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(image, 0, 0, CARD_PREVIEW_WIDTH, CARD_PREVIEW_HEIGHT)
        framesSeen += 1
        callbacks.onFrame?.(framesSeen, 0)
        if (framesSeen === 1) {
          try {
            recorder?.start(250)
          } catch {
            finish('recorder-failed')
          }
        }
      }
      image.src = frame
    })

    const offDone = spatialApi.onShaderHudCaptureDone(({ ok }) => {
      if (finished) return
      if (!ok || framesSeen === 0) {
        finish('no-frames')
        return
      }
      // Give the recorder a beat to flush the tail frame, then store.
      window.setTimeout(() => {
        if (recorder && recorder.state !== 'inactive') {
          recorder.onstop = () => stopAndStore()
          try {
            recorder.stop()
          } catch {
            stopAndStore()
          }
        } else {
          stopAndStore()
        }
      }, 350)
    })

    canvas = document.createElement('canvas')
    canvas.width = CARD_PREVIEW_WIDTH
    canvas.height = CARD_PREVIEW_HEIGHT
    try {
      stream = canvas.captureStream(30)
      recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
      chunks = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
    } catch {
      finish('recorder-unsupported')
      return
    }

    void spatialApi.shaderHudCapturePreview().then((result) => {
      if (!result?.ok && !finished) finish(result?.error ?? 'capture-refused')
    })
  })
}

/** Drop-handler helper: cache a detected media drop through the trust-gated
 *  IPC and return the clip record, or null. Keeps the drop zones thin. */
export async function cacheMediaDrop(drop: SpatialMediaDrop): Promise<MediaClipRef | null> {
  if (!spatialApi) return null
  const markup = drop.src === '' ? (drop.markup ?? undefined) : undefined
  const result = await spatialApi.mediaCacheClip(drop.src, drop.sourcePageUrl, drop.mediaKind, markup)
  if (!result?.ok || !result.clip) return null
  return { ...result.clip, kind: drop.mediaKind }
}
