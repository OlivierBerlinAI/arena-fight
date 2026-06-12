import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests boot the real server and the Vite client via webServer.
 * Tests run headless; failures keep screenshots and traces.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5273',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run dev -w @precinct/server',
      url: 'http://localhost:8080/health',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 30_000,
    },
    {
      command: 'npm run dev -w @precinct/client',
      url: 'http://localhost:5273',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 30_000,
    },
  ],
});
