import { readFileSync } from "node:fs";
import path from "node:path";

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
  it("validates existing hosted roles without issuing protected attribute changes", () => {
    const migration = readFileSync(
      path.join(process.cwd(), "drizzle/0006_anonymous_contributions.sql"),
      "utf8",
    );

    expect(migration).not.toMatch(/ALTER ROLE repairprint_submission_(?:service|maintenance)/);
    for (const attribute of [
      "role.rolsuper",
      "role.rolcreatedb",
      "role.rolcreaterole",
      "role.rolinherit",
      "role.rolreplication",
      "role.rolbypassrls",
    ]) {
      expect(migration).toContain(attribute);
    }
    expect(migration).toMatch(
      /role\.rolname = 'repairprint_submission_maintenance'\s+AND role\.rolcanlogin/,
    );
    expect(migration).toContain(
      "pg_has_role(current_user, 'repairprint_submission_maintenance', 'SET')",
    );
    expect(migration).toContain(
      "GRANT repairprint_submission_maintenance TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    );
    expect(migration).toContain(
      "REVOKE repairprint_submission_maintenance FROM %I GRANTED BY %I",
    );
    expect(migration).toContain("unsafe role membership after ownership transfer");
  });

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
