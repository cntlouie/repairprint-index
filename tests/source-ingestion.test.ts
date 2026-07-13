import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  canTransitionSourceIngestion,
  sourceContentChecksum,
  sourceRunFingerprint,
} from "../src/domain/source-ingestion";
import { FixtureThingiverseAdapter, SourceAdapterError, loadSourceAdapterMode } from "../src/lib/source-adapters";

describe("source candidate ingestion", () => {
  it("enforces the documented state machine without machine approval shortcuts", () => {
    expect(canTransitionSourceIngestion("discovered", "fetched")).toBe(true);
    expect(canTransitionSourceIngestion("fetched", "parsed")).toBe(true);
    expect(canTransitionSourceIngestion("parsed", "normalized")).toBe(true);
    expect(canTransitionSourceIngestion("normalized", "ambiguous")).toBe(true);
    expect(canTransitionSourceIngestion("normalized", "safety_screened")).toBe(true);
    expect(canTransitionSourceIngestion("safety_screened", "review_ready")).toBe(true);
    expect(canTransitionSourceIngestion("review_ready", "approved")).toBe(true);
    expect(canTransitionSourceIngestion("normalized", "approved")).toBe(false);
    expect(canTransitionSourceIngestion("approved", "review_ready")).toBe(false);
  });

  it("canonicalizes payload identity independently of object key order", () => {
    expect(sourceContentChecksum({ b: 2, a: 1 })).toBe(sourceContentChecksum({ a: 1, b: 2 }));
  });

  it("changes run identity when content changes", () => {
    const base = {
      platform: "thingiverse",
      externalId: "123",
      adapterVersion: "fixture-v1",
      policyVersion: "policy-v1",
    };
    const first = sourceRunFingerprint({ ...base, contentChecksum: "a".repeat(64) });
    expect(sourceRunFingerprint({ ...base, contentChecksum: "a".repeat(64) })).toBe(first);
    expect(sourceRunFingerprint({ ...base, contentChecksum: "b".repeat(64) })).not.toBe(first);
  });

  it("uses fixture records and strips every field outside the reviewed allowlist", async () => {
    const adapter = new FixtureThingiverseAdapter(
      { "123": { external_id: "123", title: "Latch", description: "not retained", files: ["part.stl"] } },
      ["external_id", "title"],
      () => new Date("2026-07-13T00:00:00.000Z"),
    );
    await expect(adapter.fetchCandidate("123")).resolves.toMatchObject({
      externalId: "123",
      payload: { external_id: "123", title: "Latch" },
      retrievedAt: new Date("2026-07-13T00:00:00.000Z"),
    });
    await expect(adapter.fetchCandidate("missing")).rejects.toEqual(
      expect.objectContaining<Partial<SourceAdapterError>>({ code: "SOURCE_FIXTURE_NOT_FOUND" }),
    );
  });

  it("keeps production adapters disabled and permits fixtures only in explicit demo/test mode", () => {
    expect(loadSourceAdapterMode({})).toBe("disabled");
    expect(loadSourceAdapterMode({ SOURCE_ADAPTER_MODE: "fixture", DEMO_MODE: "true" })).toBe("fixture");
    expect(() => loadSourceAdapterMode({ SOURCE_ADAPTER_MODE: "fixture", DEMO_MODE: "false" })).toThrow(
      "SOURCE_ADAPTER_CONFIGURATION_BLOCKED",
    );
    expect(() => loadSourceAdapterMode({ SOURCE_ADAPTER_MODE: "official", DEMO_MODE: "true" })).toThrow(
      "SOURCE_ADAPTER_CONFIGURATION_BLOCKED",
    );
  });
});
