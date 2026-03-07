import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [
          // Jotai HMR support: caches atom instances in globalThis.jotaiAtomCache
          'jotai/babel/plugin-debug-label',
          ['jotai/babel/plugin-react-refresh', { customAtomNames: ['atomFamily'] }],
        ],
      },
    }),
    tailwindcss(),
  ],
  root: resolve(__dirname, 'src/client'),
  base: '/',
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyDirBeforeWrite: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      // Share the renderer source from the Electron app
      '@': resolve(__dirname, '../electron/src/renderer'),
      '@config': resolve(__dirname, '../../packages/shared/src/config'),
      // Force single React instance
      'react': resolve(__dirname, '../../node_modules/react'),
      'react-dom': resolve(__dirname, '../../node_modules/react-dom'),
      // Redirect Electron-specific imports to web shims
      '@sentry/electron/renderer': resolve(__dirname, 'src/client/shims/sentry.ts'),
      '@sentry/electron/preload': resolve(__dirname, 'src/client/shims/sentry.ts'),
      '@sentry/electron': resolve(__dirname, 'src/client/shims/sentry.ts'),
      'electron-log/renderer': resolve(__dirname, 'src/client/shims/electron-log-renderer.ts'),
      'electron-log': resolve(__dirname, 'src/client/shims/electron-log.ts'),
      'electron-updater': resolve(__dirname, 'src/client/shims/electron-log.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'jotai'],
    exclude: ['@craft-agent/ui'],
    esbuildOptions: {
      supported: { 'top-level-await': true },
      target: 'esnext',
    },
  },
  server: {
    port: 3000,
    // Proxy API and WebSocket requests to the backend server
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
})
