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
  // One retry everywhere: the full-match victory tests can still flake under
  // software-WebGL CPU starvation even with a smaller viewport + heartbeat grace.
  retries: process.env.CI ? 2 : 1,
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
      // Force a 30 Hz sim for e2e only. The default 100 Hz triples the client's
      // prediction + render cost, and under software WebGL (no GPU in CI) the
      // busy player falls seconds behind and misses the server's 30 s WS
      // heartbeat, which terminates the socket mid-match. Sim semantics are
      // identical at any tick rate (balance is rescaled by tickRate), so this
      // only changes pacing/fidelity, not behaviour under test. Production stays
      // at 100 Hz. See the heartbeat-grace follow-up in packages/server/src/server.ts.
      command: 'TICK_RATE=30 npm run dev -w @mech-arena-fight/server',
      url: 'http://localhost:8080/health',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 30_000,
    },
    {
      command: 'npm run dev -w @mech-arena-fight/client',
      url: 'http://localhost:5273',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 30_000,
    },
  ],
});
