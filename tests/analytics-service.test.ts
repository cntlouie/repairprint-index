import { describe, expect, it, vi } from "vitest";

import {
  bestEffortRecordAnalyticsEvent,
  resolveAnalyticsConfiguration,
  type AnalyticsRecorderDependencies,
} from "@/lib/analytics";

const validEvent = {
  name: "search_submitted",
  properties: { normalizedCategory: "identifier", queryLength: 6, identifierLike: true },
} as const;

describe("analytics configuration", () => {
  it.each([
    [{}, "demo_locked"],
    [{ DEMO_MODE: "true", ANALYTICS_MODE: "aggregate_database", ANALYTICS_DATABASE_URL: "postgres://private" }, "demo_locked"],
    [{ DEMO_MODE: "false" }, "disabled"],
    [{ DEMO_MODE: "false", ANALYTICS_MODE: "disabled" }, "disabled"],
    [{ DEMO_MODE: "false", ANALYTICS_MODE: "vendor" }, "invalid_mode"],
    [{ DEMO_MODE: "false", ANALYTICS_MODE: "aggregate_database" }, "database_url_missing"],
    [{ DEMO_MODE: "false", ANALYTICS_MODE: "aggregate_database", ANALYTICS_DATABASE_URL: " postgres://private" }, "database_url_missing"],
  ] as const)("fails closed for %j", (environment, reason) => {
    expect(resolveAnalyticsConfiguration(environment)).toEqual({ enabled: false, reason });
  });

  it("enables only the explicit private aggregate database mode", () => {
    expect(resolveAnalyticsConfiguration({
      DEMO_MODE: "false",
      ANALYTICS_MODE: "aggregate_database",
      ANALYTICS_DATABASE_URL: "postgres://private",
    })).toEqual({ enabled: true, reason: "enabled" });
  });
});

describe("best-effort analytics recorder", () => {
  it("persists a schema-validated event in explicit production mode", async () => {
    const harness = dependencies();
    await expect(bestEffortRecordAnalyticsEvent(validEvent, harness)).resolves.toBe("recorded");
    expect(harness.persist).toHaveBeenCalledWith(validEvent);
    expect(harness.reportFailure).not.toHaveBeenCalled();
  });

  it("does not call persistence while analytics is disabled", async () => {
    const harness = dependencies({ DEMO_MODE: "true" });
    await expect(bestEffortRecordAnalyticsEvent(validEvent, harness)).resolves.toBe("disabled");
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it("rejects unknown or sensitive properties before configuration is considered", async () => {
    const harness = dependencies({ DEMO_MODE: "true" });
    await expect(bestEffortRecordAnalyticsEvent({
      ...validEvent,
      properties: { ...validEvent.properties, query: "PRIVATE-100" },
    }, harness)).resolves.toBe("dropped");
    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.reportFailure).toHaveBeenCalledWith({ code: "ANALYTICS_EVENT_REJECTED" });
  });

  it("suppresses persistence failures and logs only an allowlisted event name", async () => {
    const harness = dependencies();
    vi.mocked(harness.persist).mockRejectedValueOnce(new Error("private payload PRIVATE-100"));
    await expect(bestEffortRecordAnalyticsEvent(validEvent, harness)).resolves.toBe("dropped");
    expect(harness.reportFailure).toHaveBeenCalledWith({
      code: "ANALYTICS_EVENT_DROPPED",
      eventName: "search_submitted",
    });
    expect(JSON.stringify(vi.mocked(harness.reportFailure).mock.calls)).not.toContain("PRIVATE-100");
  });
});

function dependencies(
  environment: Readonly<Record<string, string | undefined>> = {
    DEMO_MODE: "false",
    ANALYTICS_MODE: "aggregate_database",
    ANALYTICS_DATABASE_URL: "postgres://private",
  },
): AnalyticsRecorderDependencies & {
  persist: ReturnType<typeof vi.fn<AnalyticsRecorderDependencies["persist"]>>;
  reportFailure: ReturnType<typeof vi.fn<AnalyticsRecorderDependencies["reportFailure"]>>;
} {
  return {
    environment,
    persist: vi.fn<AnalyticsRecorderDependencies["persist"]>().mockResolvedValue(undefined),
    reportFailure: vi.fn<AnalyticsRecorderDependencies["reportFailure"]>(),
  };
}
