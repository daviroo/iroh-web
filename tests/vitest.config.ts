import { defineConfig } from 'vitest/config'
import wasm from 'vite-plugin-wasm'
import { nodeDial, nodeDialAndClose, nodeParseTicket, startNodePeer, stopNodePeer } from './node/peer.js'
import { nativeDial, startNativePeer, stopNativePeer } from './node/native-peer.js'

export default defineConfig({
  plugins: [wasm()],
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['@daviroo/iroh-web'] },
  test: {
    include: ['browser/**/*.test.ts'],
    globalSetup: ['./setup/global.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    browser: {
      enabled: true,
      headless: true,
      provider: 'playwright',
      instances: [{ browser: 'chromium' }],
      commands: { startNodePeer, nodeDial, nodeDialAndClose, nodeParseTicket, stopNodePeer, startNativePeer, nativeDial, stopNativePeer },
    },
  },
})
