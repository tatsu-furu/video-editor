/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// SharedArrayBuffer（マルチスレッドWASM）を使うため、開発サーバーとプレビューでも
// 本番（netlify.toml）と同じ COOP/COEP ヘッダーを付ける。設計書 3章「ホスティング要件」。
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
})
