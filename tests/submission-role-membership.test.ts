import { describe, expect, it } from "vitest";

import {
  assessSubmissionRoleMemberships,
  SUBMISSION_MAINTENANCE_ROLE,
  SUBMISSION_SERVICE_ROLE,
  type SubmissionRoleMembership,
} from "../src/domain/submission-role-membership";

const allowedServiceRow: SubmissionRoleMembership = {
    adminOption: true,
    grantedRole: SUBMISSION_SERVICE_ROLE,
    grantorRole: "supabase_admin",
    inheritOption: false,
    memberRole: "postgres",
    setOption: false,
};
const allowedMaintenanceRow: SubmissionRoleMembership = {
    adminOption: true,
    grantedRole: SUBMISSION_MAINTENANCE_ROLE,
    grantorRole: "supabase_admin",
    inheritOption: false,
    memberRole: "postgres",
    setOption: false,
};
const allowedRows: readonly SubmissionRoleMembership[] = [allowedServiceRow, allowedMaintenanceRow];

describe("WP-08 submission role membership boundary", () => {
  it("allows local PostgreSQL with no provider memberships", () => {
    expect(assessSubmissionRoleMemberships([])).toEqual({ valid: true, violations: [] });
  });

  it("allows only the complete PostgreSQL 17 Supabase administration pair", () => {
    expect(assessSubmissionRoleMemberships(allowedRows)).toEqual({ valid: true, violations: [] });
  });

  it.each([
    ["reversed membership", { ...allowedServiceRow, grantedRole: "postgres", memberRole: SUBMISSION_SERVICE_ROLE }],
    ["anonymous public-role membership", { ...allowedServiceRow, memberRole: "anon" }],
    ["authenticated public-role membership", { ...allowedServiceRow, memberRole: "authenticated" }],
    ["service-role membership", { ...allowedServiceRow, memberRole: "service_role" }],
    ["wrong grantor", { ...allowedServiceRow, grantorRole: "postgres" }],
    ["missing admin option", { ...allowedServiceRow, adminOption: false }],
    ["unsafe SET option", { ...allowedServiceRow, setOption: true }],
    ["unsafe INHERIT option", { ...allowedServiceRow, inheritOption: true }],
  ])("rejects %s", (_label, unsafeRow) => {
    expect(assessSubmissionRoleMemberships([unsafeRow, allowedMaintenanceRow])).toMatchObject({ valid: false });
  });

  it("rejects an extra membership beyond the exact provider pair", () => {
    const result = assessSubmissionRoleMemberships([
      ...allowedRows,
      { ...allowedServiceRow, memberRole: "dashboard_user" },
    ]);
    expect(result.valid).toBe(false);
  });

  it("rejects an incomplete provider administration pair", () => {
    expect(assessSubmissionRoleMemberships([allowedServiceRow])).toMatchObject({ valid: false });
  });
});
