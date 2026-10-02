/*
 * Browser tests for the operations console foundation. Offline: the pages and
 * the real admin-* handlers are served by server.mjs on 127.0.0.1, and every
 * test fails if the page tries to reach any other host.
 *
 *   python3 tools/build.py && (cd tests/console && npm ci && npm test)
 *
 * Uses the Chromium Playwright 1.56.1 expects (pre-installed in this
 * repository's cloud environment; elsewhere, npx playwright install chromium).
 */
import { defineConfig } from '@playwright/test';

const PORT = 4317;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  // One server, one fixture state: tests run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    headless: true,
    serviceWorkers: 'block'
  },
  webServer: {
    command: `node server.mjs --test --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/__test/health`,
    reuseExistingServer: false,
    timeout: 30000
  }
});
