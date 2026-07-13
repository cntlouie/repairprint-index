import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolvePrivateMediaConfig } from "@/lib/private-media-config";

describe("private media production configuration", () => {
  it("uses explicit non-persisting demo fixtures only in demo mode", () => {
    const config = resolvePrivateMediaConfig({ DEMO_MODE: "true", NODE_ENV: "test" });
    expect(config.retentionVersion).toBe("wp09-demo-retention-v1");
    expect(config.privateBucket).not.toBe(config.quarantineBucket);
  });

  it("fails closed without legal, retention, storage and secret decisions", () => {
    expect(() => resolvePrivateMediaConfig({ DEMO_MODE: "false", NODE_ENV: "test" })).toThrow("MEDIA_UNAVAILABLE");
  });

  it("accepts a complete production contract and rejects one shared bucket", () => {
    const environment = {
      DEMO_MODE: "false", NODE_ENV: "test" as const, MEDIA_CAPABILITY_SECRET: "a".repeat(64), MEDIA_PRIVATE_BUCKET: "repairprint-private",
      MEDIA_QUARANTINE_BUCKET: "repairprint-quarantine", MEDIA_PRIVACY_VERSION: "privacy-v1",
      MEDIA_RETENTION_DAYS: "30", MEDIA_RETENTION_POLICY_VERSION: "retention-v1", MEDIA_TERMS_VERSION: "terms-v1",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "server-secret",
    };
    expect(resolvePrivateMediaConfig(environment).retentionDays).toBe(30);
    expect(() => resolvePrivateMediaConfig({ ...environment, MEDIA_PRIVATE_BUCKET: "repairprint-quarantine" })).toThrow("MEDIA_UNAVAILABLE");
  });
});
