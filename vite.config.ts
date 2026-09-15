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
    target: 'es2021',
  },
})
