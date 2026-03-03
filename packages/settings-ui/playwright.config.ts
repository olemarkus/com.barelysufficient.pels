import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PELS_E2E_PORT ?? 4173);
const BASE_URL = process.env.PELS_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const SHOULD_BUILD = process.env.PELS_E2E_BUILD !== '0';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    viewport: { width: 480, height: 900 },
  },
  projects: [
    {
      name: 'chromium-mobile-width',
      use: { browserName: 'chromium' },
    },
    {
      name: 'firefox-mobile-width',
      use: { browserName: 'firefox' },
    },
  ],
  webServer: {
    command: SHOULD_BUILD
      ? `npm run build && node scripts/static-server.mjs --port ${PORT}`
      : `node scripts/static-server.mjs --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
  },
});
