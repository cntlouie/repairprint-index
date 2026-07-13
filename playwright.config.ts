import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.WP11_BASE_URL ?? "http://127.0.0.1:3197";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["line"]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
});
