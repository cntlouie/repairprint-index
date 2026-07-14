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

const phaseTwoCleanupRoutines = [
  [
    "public.claim_expired_private_media(integer,uuid)",
    "e808d6497297b83a2ef835f53f418cf3ac1c4f77dbbd5b864c27d067f0faad05",
  ],
  [
    "public.complete_private_media_cleanup(uuid,uuid[])",
    "4fec04ddc768c40e03477b2c236a90658bc4b37ccbdd244a98d22c6c6ceba053",
  ],
  [
    "public.claim_private_media_quarantine_cleanup(integer,uuid)",
    "1ce25e27485ded40bb340216e16f128e73f779a961243a60f2ae826a1ebbeca0",
  ],
  [
    "public.complete_private_media_quarantine_cleanup(uuid,uuid[])",
    "b8bddc9ad048742f5f49de926c8e08d9c14acc25ce7fca3cb0983a72908c2a1b",
  ],
  [
    "public.claim_private_media_pending_object_cleanup(integer,uuid)",
    "443b45a000763e985fae74255f858f0808fbd778f30adb1a6b0c5cef5cda021f",
  ],
  [
    "public.complete_private_media_pending_object_cleanup(uuid,uuid[])",
    "541809a72285659cbfc0120364d4e625c2bc701edd93127e56b91cbcc03b1de4",
  ],
] as const;

function readRoutineSignatures(sql: string) {
  return [...sql.matchAll(/public\.[a-z_]+\([^)]*\)/gu)].map((match) =>
    match[0].replaceAll(/\s+/gu, ""),
  );
}

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

  it("repairs only the six exposed cleanup ACLs from their owner context in migration 0012", () => {
    const migration = readFileSync(
      path.join(process.cwd(), "drizzle/0012_eager_earthquake.sql"),
      "utf8",
    );
    const setRoleOffset = migration.indexOf("SET ROLE repairprint_submission_maintenance;");
    const resetRoleOffset = migration.indexOf("RESET ROLE;", setRoleOffset);

    expect(setRoleOffset).toBeGreaterThan(-1);
    expect(resetRoleOffset).toBeGreaterThan(setRoleOffset);
    const ownerContext = migration.slice(setRoleOffset, resetRoleOffset);
    const expectedSignatures = phaseTwoCleanupRoutines.map(([signature]) => signature);
    const expectedHashes = phaseTwoCleanupRoutines.map(([, definitionHash]) => definitionHash);
    const signatureArray = migration.match(
      /expected_signatures constant text\[\] := ARRAY\[([\s\S]*?)\];/u,
    )?.[1];
    const hashArray = migration.match(
      /expected_hashes constant text\[\] := ARRAY\[([\s\S]*?)\];/u,
    )?.[1];

    expect(signatureArray).toBeDefined();
    expect(hashArray).toBeDefined();
    expect([...signatureArray!.matchAll(/'([^']+)'/gu)].map((match) => match[1])).toEqual(
      expectedSignatures,
    );
    expect([...hashArray!.matchAll(/'([0-9a-f]{64})'/gu)].map((match) => match[1])).toEqual(
      expectedHashes,
    );
    expect(migration).toMatch(
      /procedure\.proowner <> maintenance_oid[\s\S]*?procedure\.prokind <> 'f'[\s\S]*?NOT procedure\.prosecdef[\s\S]*?procedure\.proconfig IS DISTINCT FROM ARRAY\['search_path=pg_catalog'\]::text\[\][\s\S]*?pg_get_functiondef\(procedure\.oid\)[\s\S]*?expected_hashes\[signature_index\]/u,
    );

    const revokeStatements = [...ownerContext.matchAll(
      /REVOKE EXECUTE ON FUNCTION([\s\S]*?)FROM (PUBLIC|anon|authenticated)\s+GRANTED BY CURRENT_USER;/gu,
    )];
    expect(revokeStatements.map((match) => match[2])).toEqual([
      "PUBLIC",
      "anon",
      "authenticated",
    ]);
    for (const revokeStatement of revokeStatements) {
      expect(readRoutineSignatures(revokeStatement[1]!)).toEqual(expectedSignatures);
    }
    const serviceGrantList = ownerContext.match(
      /GRANT EXECUTE ON FUNCTION([\s\S]*?)TO repairprint_submission_service\s+GRANTED BY CURRENT_USER;/u,
    )?.[1];
    expect(serviceGrantList).toBeDefined();
    expect(readRoutineSignatures(serviceGrantList!)).toEqual(expectedSignatures);

    expect(ownerContext).toMatch(
      /ALTER DEFAULT PRIVILEGES\s+REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;/u,
    );
    expect(migration).toContain("repairprint.wp11_submission_membership_baseline");
    expect(migration).toContain("repairprint.wp11_submission_temporary_membership");
    expect(migration).toContain("repairprint.wp11_submission_unrelated_routine_fingerprint");
    expect(migration).toContain("repairprint.wp11_submission_table_acl_fingerprint");
    expect(migration).toContain(
      "REVOKE repairprint_submission_maintenance FROM %I GRANTED BY %I",
    );
    for (const failureMarker of [
      "SUBMISSION_CLEANUP_ACL_OVERLOAD_SET_INVALID",
      "SUBMISSION_CLEANUP_ACL_DEFINITION_INVALID",
      "SUBMISSION_CLEANUP_ACL_PREEXISTING_GRANT_INVALID",
      "SUBMISSION_CLEANUP_ACL_TEMPORARY_MEMBERSHIP_INVALID",
      "SUBMISSION_CLEANUP_ACL_MEMBERSHIP_CHANGED",
      "SUBMISSION_CLEANUP_ACL_POSTCONDITION_INVALID",
      "SUBMISSION_CLEANUP_ACL_UNEXPECTED_DIRECT_GRANT",
      "SUBMISSION_CLEANUP_ACL_EFFECTIVE_EXECUTE_INVALID",
      "SUBMISSION_CLEANUP_ACL_SERVICE_GRANT_SET_INVALID",
      "SUBMISSION_CLEANUP_ACL_DEFAULT_PRIVILEGES_INVALID",
      "SUBMISSION_CLEANUP_ACL_PUBLIC_APPLICATION_ROUTINE",
      "SUBMISSION_CLEANUP_ACL_UNRELATED_ROUTINE_CHANGED",
      "SUBMISSION_CLEANUP_ACL_TABLE_PRIVILEGE_CHANGED",
      "SUBMISSION_CLEANUP_ACL_FINAL_DEFINITION_INVALID",
      "SUBMISSION_CLEANUP_ACL_FINAL_EXECUTION_INVALID",
    ]) {
      expect(migration).toContain(failureMarker);
    }

    expect(migration).not.toMatch(
      /REVOKE\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+ALL\s+(?:FUNCTIONS|PROCEDURES|ROUTINES)\s+IN\s+SCHEMA\s+public\b/iu,
    );
    expect(migration).not.toMatch(
      /(?:REVOKE|GRANT)\s+EXECUTE\s+ON\s+FUNCTION\s+public\.cleanup_expired_submission_intakes\(integer\)/iu,
    );
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
