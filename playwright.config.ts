import { defineConfig, devices } from '@playwright/test'

// E2E はビルド済みの成果物を vite preview（本番と同じ COOP/COEP 付き）で配信して確認する。
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:4173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
})
