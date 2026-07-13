import { describe, expect, it } from "vitest";

import {
  evaluateSourceAdapterPolicy,
  selectAllowedSourceFields,
  type SourcePolicySnapshot,
} from "../src/domain/source-policy";

const now = new Date("2026-07-13T00:00:00.000Z");
const currentPolicy: SourcePolicySnapshot = {
  platform: "fixture",
  policy: "api",
  policyVersion: "fixture-policy-v1",
  termsCheckedAt: new Date("2026-07-12T00:00:00.000Z"),
  expiresAt: new Date("2027-07-13T00:00:00.000Z"),
  allowedFields: ["external_id", "landing_page_url", "title"],
  automationAllowed: true,
  commercialUseAllowed: true,
  adapterEnabled: true,
  currentPolicyMatches: true,
};

describe("source adapter policy enforcement", () => {
  it("allows only exact reviewed fields under a current enabled API policy", () => {
    expect(evaluateSourceAdapterPolicy(currentPolicy, ["external_id", "title"], now)).toEqual({
      allowed: true,
      policyVersion: "fixture-policy-v1",
      allowedFields: ["external_id", "landing_page_url", "title"],
    });
  });

  it.each([
    ["missing", null, "SOURCE_POLICY_MISSING"],
    ["blocked", { ...currentPolicy, policy: "blocked" }, "SOURCE_POLICY_BLOCKED"],
    ["disabled", { ...currentPolicy, adapterEnabled: false }, "SOURCE_POLICY_DISABLED"],
    ["snapshot mismatch", { ...currentPolicy, currentPolicyMatches: false }, "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
    ["automation forbidden", { ...currentPolicy, automationAllowed: false }, "SOURCE_AUTOMATION_FORBIDDEN"],
    ["commercial use false", { ...currentPolicy, commercialUseAllowed: false }, "SOURCE_COMMERCIAL_USE_INCOMPATIBLE"],
    ["commercial use unresolved", { ...currentPolicy, commercialUseAllowed: null }, "SOURCE_COMMERCIAL_USE_INCOMPATIBLE"],
    ["explicit expiry", { ...currentPolicy, expiresAt: new Date("2026-07-12T23:59:59.999Z") }, "SOURCE_POLICY_STALE"],
    [
      "366-day maximum exceeded",
      {
        ...currentPolicy,
        termsCheckedAt: new Date("2025-07-11T23:59:59.999Z"),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
      "SOURCE_POLICY_STALE",
    ],
  ] as const)("fails closed for %s", (_label, policy, code) => {
    expect(evaluateSourceAdapterPolicy(policy, ["external_id"], now)).toEqual({ allowed: false, code });
  });

  it("rejects fields outside the reviewed exact allowlist", () => {
    expect(evaluateSourceAdapterPolicy(currentPolicy, ["description"], now)).toEqual({
      allowed: false,
      code: "SOURCE_FIELD_NOT_ALLOWED",
    });
  });

  it("projects only allowed fields and never copies descriptions, images or files", () => {
    expect(
      selectAllowedSourceFields(
        { external_id: "123", title: "Latch", description: "full text", images: ["secret"], files: ["part.stl"] },
        ["external_id", "title"],
      ),
    ).toEqual({ external_id: "123", title: "Latch" });
  });
});
