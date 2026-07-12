import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("submission retention cleanup operator", () => {
  it("fails closed with one structured marker when the dedicated database is not configured", () => {
    const result = runCleanup({
      DEMO_MODE: "false",
      SUBMISSION_DATABASE_URL: "",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe('{"code":"SUBMISSION_RETENTION_CLEANUP_FAILED"}');
    expect(result.stderr).not.toMatch(/stack|postgres|SUBMISSION_DATABASE_URL_REQUIRED|at .+\(.+\)/i);
  });

  it("rejects an unsafe batch size before attempting a database connection", () => {
    const result = runCleanup({
      DEMO_MODE: "false",
      SUBMISSION_CLEANUP_BATCH_SIZE: "1001",
      SUBMISSION_DATABASE_URL: "postgres://must-not-be-used.invalid/private",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe('{"code":"SUBMISSION_RETENTION_CLEANUP_FAILED"}');
    expect(result.stderr).not.toContain("must-not-be-used");
  });
});

function runCleanup(overrides: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "scripts/cleanup-submissions.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...overrides },
      timeout: 10_000,
      windowsHide: true,
    },
  );
}
