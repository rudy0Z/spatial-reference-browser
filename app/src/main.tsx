import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App.tsx'
import { initSpatialCore } from './lib/spatialCore'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/* Phase 2 spatial core — kick off the WASM engine load in the background.
 * Fire-and-forget: until it resolves (or fails → permanent TS fallback) every
 * facade call transparently runs the exact-port pure-TS implementations, so
 * first paint and interaction are never gated on this. */
void initSpatialCore()
