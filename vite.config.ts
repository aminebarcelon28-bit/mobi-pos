import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// Tauri mobile requires a LAN-reachable dev server with fixed port.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
    hmr: {
      protocol: 'ws',
      port: 1421,
    },
    watch: {
      // Rust build output churns constantly during `tauri dev` — watching it
      ignored: ['**/target/**', '**/src-tauri/target/**', '**/src-tauri/gen/**', '**/node_modules/**', '**/dist/**'],
    },
  },
  build: {
    // LCP: the entry's dynamic-import map (sync-engine, excel, …) is
    // post-paint/post-interaction code — never let the build emit
    // <link rel=modulepreload> for it. Preloading 360KB of sync engine +
    // excel up front buys nothing but pre-paint network contention and JS
    // parse on the main thread (web.dev: eliminate delay phases for
    // anything first paint doesn't need). Static entry deps
    // (vendor-react, lucide, platform) keep their preloads.
    modulePreload: {
      polyfill: true,
      resolveDependencies: (_filename, deps) =>
        deps.filter((d) => !/(sync-engine|excel)-[^/]*\.js$/.test(d)),
    },
    // es2020 = Chrome 80+: parses on old-but-updated Android WebViews.
    // (CSS floor stays Chrome 111 per Tailwind v4 — enforced by the
    // webviewCompat boot gate, which routes to the Play Store update.)
    target: 'es2020',
    rollupOptions: {
      output: {
        // Entry-chunk diet: heavy, rarely-together deps ride separate chunks.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('\\react\\') ||
              id.includes('\\react-dom\\') ||
              id.includes('react/jsx-runtime')
            ) {
              return 'vendor-react';
            }
            if (id.includes('qrcode')) return 'qrcode';
            // Heavy cloud-sync stack — reachable ONLY via dynamic import()
            // (App boot post-paint, settings, diagnostics). One static edge
            // drags all of it (incl. the libsql WASM loader) into the entry
            // <link rel=modulepreload> and stalls first paint, so this rule
            // names the heavy files exactly. Small sync helpers
            // (eventInterceptor, keychain, device, outboxFlusher,
            // genericApply) stay in the entry graph — adapters import them
            // statically and boot reads through them.
            if (id.includes('@libsql')) {
              return 'sync-engine';
            }
          }
          const norm = id.replace(/\\/g, '/');
          if (
            norm.includes('src/sync/SyncManager') ||
            norm.includes('src/sync/tursoClient')
          ) {
            return 'sync-engine';
          }
          if (id.includes('src/utils/excel') || id.includes('src\\utils\\excel')) return 'excel';
          return undefined;
        },
      },
    },
  },
})
