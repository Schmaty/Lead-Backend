import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the API so the app is same-origin with the backend
// (cookies + no CORS). In production the bundled nginx does the same.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/ready': { target: 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
})
