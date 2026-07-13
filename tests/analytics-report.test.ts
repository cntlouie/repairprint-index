import { describe, expect, it } from "vitest";
import {
  canRunPrivateAnalyticsReport,
  parsePrivateAnalyticsReportOptions,
  PRIVATE_ANALYTICS_REPORT_EVENTS,
} from "../src/domain/analytics-report";

describe("private analytics report policy", () => {
  it("uses bounded privacy-preserving defaults and accepts explicit limits", () => {
    expect(parsePrivateAnalyticsReportOptions([])).toEqual({ days: 30, minimumCellCount: 5 });
    expect(parsePrivateAnalyticsReportOptions(["--days=366", "--minimum-cell-count=100"]))
      .toEqual({ days: 366, minimumCellCount: 100 });
    expect(PRIVATE_ANALYTICS_REPORT_EVENTS).toEqual([
      "zero_result",
      "search_resolved",
      "variant_disambiguation_shown",
      "missing_part_submitted",
    ]);
  });

  it.each([
    ["--days=0"],
    ["--days=1.5"],
    ["--days=367"],
    ["--minimum-cell-count=4"],
    ["--minimum-cell-count=101"],
    ["--days=2", "--days=3"],
    ["--raw=true"],
  ])("rejects malformed, duplicate, or unsupported arguments: %j", (...arguments_) => {
    expect(() => parsePrivateAnalyticsReportOptions(arguments_)).toThrow();
  });

  it("allows only a non-privileged, non-owning, explicitly granted reporting role", () => {
    expect(canRunPrivateAnalyticsReport({
      canRead: true,
      currentUser: "repairprint_analytics_reporter",
      ownsAggregateTable: false,
      privileged: false,
    })).toBe(true);
  });

  it.each([
    { canRead: false, currentUser: "repairprint_analytics_reporter", ownsAggregateTable: false, privileged: false },
    { canRead: true, currentUser: "repairprint_analytics_service", ownsAggregateTable: false, privileged: false },
    { canRead: true, currentUser: "repairprint_analytics_maintenance", ownsAggregateTable: true, privileged: false },
    { canRead: true, currentUser: "owner", ownsAggregateTable: false, privileged: true },
  ])("refuses unsafe reporting access: %j", (access) => {
    expect(canRunPrivateAnalyticsReport(access)).toBe(false);
  });
});
