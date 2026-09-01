import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3003',
      '/ws': {
        target: 'ws://localhost:3003',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err: any) => {
            if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET' || err?.code === 'ECONNREFUSED') return;
            console.warn('[vite] ws proxy notice:', err?.message || err);
          });
        },
      },
    },
  },
})
