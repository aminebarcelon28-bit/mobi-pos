import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Tauri mobile requires a LAN-reachable dev server with fixed port.
export default defineConfig({
  plugins: [react()],
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
    // es2020 = Chrome 80+: parses on old-but-updated Android WebViews.
    // (CSS floor stays Chrome 111 per Tailwind v4 — enforced by the
    // webviewCompat boot gate, which routes to the Play Store update.)
    target: 'es2020',
  },
})
