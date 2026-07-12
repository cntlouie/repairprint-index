import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const preload = pathToFileURL(path.join(process.cwd(), "scripts", "turnstile-integration-preload.mjs")).href;
const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const integrationEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  CI: "true",
  DATABASE_TEST_URL: "postgres://owner:test@127.0.0.1:5432/repairprint_test",
  DEMO_MODE: "false",
  NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3197",
  NODE_ENV: "production",
  NODE_OPTIONS: "",
  REPAIRPRINT_HTTP_TEST_NONCE: nonce,
  SUBMISSION_DATABASE_URL: "postgres://repairprint_submission_service:test@127.0.0.1:5432/repairprint_test",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  VERCEL: "1",
  VERCEL_ENV: "integration-test",
};

describe("Turnstile production-render interceptor", () => {
  it("binds a test token to one action and rejects replay", () => {
    const script = `
      const endpoint = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
      const token = "wp08.${nonce}.missing_part.00000000-0000-4000-8000-000000000001";
      const ipv6Token = "wp08.${nonce}.missing_part.00000000-0000-4000-8000-000000000003";
      const body = (response = token, remoteip = "203.0.113.42") => new URLSearchParams({
        idempotency_key: "00000000-0000-4000-8000-000000000002",
        remoteip,
        response,
        secret: "1x0000000000000000000000000000000AA",
      });
      const first = await fetch(endpoint, { method: "POST", body: body() }).then((response) => response.json());
      const replay = await fetch(endpoint, { method: "POST", body: body() }).then((response) => response.json());
      const ipv6 = await fetch(endpoint, { method: "POST", body: body(ipv6Token, "2001:db8::1") })
        .then((response) => response.json());
      if (first.success !== true || first.action !== "missing_part" || first.hostname !== "127.0.0.1") process.exit(2);
      if (replay.success !== false || !replay["error-codes"].includes("timeout-or-duplicate")) process.exit(3);
      if (ipv6.success !== true || ipv6.action !== "missing_part") process.exit(4);
    `;
    const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: integrationEnvironment,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("refuses to activate under a deployed production environment", () => {
    const result = spawnSync(process.execPath, ["--import", preload, "--eval", "process.exit(0)"], {
      encoding: "utf8",
      env: { ...integrationEnvironment, VERCEL_ENV: "production" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Turnstile integration preload refused a non-test process.");
  });
});
