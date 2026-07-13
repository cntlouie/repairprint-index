import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANALYTICS_MAINTENANCE_ROLE,
  ANALYTICS_SERVICE_ROLE,
  assessAnalyticsRoleMemberships,
  type AnalyticsRoleMembership,
} from "@/domain/analytics-role-membership";

const service: AnalyticsRoleMembership = {
  grantedRole: ANALYTICS_SERVICE_ROLE,
  memberRole: "postgres",
  grantorRole: "supabase_admin",
  adminOption: true,
  inheritOption: false,
  setOption: false,
};
const maintenance: AnalyticsRoleMembership = { ...service, grantedRole: ANALYTICS_MAINTENANCE_ROLE };

describe("analytics database role membership boundary", () => {
  it("allows local PostgreSQL with no provider memberships", () => {
    expect(assessAnalyticsRoleMemberships([])).toEqual({ valid: true, violations: [] });
  });

  it("allows only the complete PostgreSQL 17 Supabase administration pair", () => {
    expect(assessAnalyticsRoleMemberships([service, maintenance])).toEqual({ valid: true, violations: [] });
  });

  it.each([
    ["reversed", { ...service, grantedRole: "postgres", memberRole: ANALYTICS_SERVICE_ROLE }],
    ["public role", { ...service, memberRole: "anon" }],
    ["wrong grantor", { ...service, grantorRole: "postgres" }],
    ["unsafe set", { ...service, setOption: true }],
    ["unsafe inherit", { ...service, inheritOption: true }],
  ])("rejects %s membership", (_label, row) => {
    expect(assessAnalyticsRoleMemberships([row, maintenance]).valid).toBe(false);
  });

  it("rejects incomplete, duplicate, and extra memberships", () => {
    expect(assessAnalyticsRoleMemberships([service]).valid).toBe(false);
    expect(assessAnalyticsRoleMemberships([service, service, maintenance]).valid).toBe(false);
    expect(assessAnalyticsRoleMemberships([service, maintenance, { ...service, memberRole: "service_role" }]).valid).toBe(false);
  });

  it("keeps migration 0012 execute-only, private, and provider-compatible", () => {
    const migration = readFileSync(
      path.join(process.cwd(), "drizzle", "0012_eager_earthquake.sql"),
      "utf8",
    );
    expect(migration).toMatch(/CREATE ROLE repairprint_analytics_service\s+LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;/u);
    expect(migration).toMatch(/CREATE ROLE repairprint_analytics_maintenance\s+NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;/u);
    expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog/u);
    expect(migration).toMatch(/REVOKE ALL PRIVILEGES ON TABLE public\.private_analytics_daily_aggregates\s+FROM PUBLIC, repairprint_analytics_service, repairprint_analytics_maintenance;/u);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.record_private_analytics_event\(text, jsonb\)\s+FROM PUBLIC, repairprint_analytics_service, repairprint_analytics_maintenance;/u);
    expect(migration).not.toMatch(/REVOKE\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+ALL\s+(?:TABLES|SEQUENCES|FUNCTIONS|PROCEDURES|ROUTINES)\s+IN\s+SCHEMA\s+public\s+FROM\s+repairprint_analytics_(?:service|maintenance)/iu);
    expect(migration).toContain("dependency.deptype IN ('o', 'a', 'i', 'r')");
    expect(migration).toContain("ANALYTICS_PREEXISTING_ROLE_DEPENDENCY");
    expect(migration).toContain("set_config('createrole_self_grant', '', true)");
    expect(migration).toContain("repairprint.wp11_analytics_membership_baseline");
    expect(migration).toContain("repairprint.wp11_analytics_temporary_membership");
    expect(migration).toMatch(/member_role\.rolname = current_user\s+AND membership\.grantor = 10\s+AND grantor_role\.rolsuper/u);
    expect(migration).toContain(") IS NOT TRUE");
    expect(migration).toContain("ANALYTICS_AUTOMATIC_MEMBERSHIP_PAIR_INCOMPLETE");
    const membershipBaseline = migration.match(
      /INTO membership_baseline([\s\S]*?)PERFORM set_config\('repairprint\.wp11_analytics_membership_baseline'/u,
    )?.[1];
    expect(membershipBaseline).toMatch(/WHERE granted_role\.rolname IN \([^)]+\)\s+OR member_role\.rolname IN \([^)]+\);/u);
    expect(migration).not.toContain("repairprint.wp11_analytics_creator_memberships");
    expect(migration).not.toContain("ANALYTICS_CREATOR_MEMBERSHIP_PAIR_INCOMPLETE");
    expect(migration).not.toContain(
      "GRANT repairprint_analytics_maintenance TO %I WITH ADMIN TRUE, INHERIT FALSE, SET TRUE GRANTED BY %I",
    );
    expect(migration).toContain(
      "GRANT repairprint_analytics_maintenance TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY %I",
    );
    expect(migration).toContain(
      "REVOKE repairprint_analytics_maintenance FROM %I GRANTED BY %I",
    );
    expect(migration).not.toContain(
      "REVOKE repairprint_analytics_service, repairprint_analytics_maintenance FROM %I GRANTED BY %I",
    );
    expect(migration).toContain("ANALYTICS_PROVIDER_MEMBERSHIP_CHANGED");
    expect(migration).toMatch(/ALTER FUNCTION public\.record_private_analytics_event\(text, jsonb\)\s+OWNER TO repairprint_analytics_maintenance;[\s\S]*?SET ROLE repairprint_analytics_maintenance;[\s\S]*?GRANT EXECUTE ON FUNCTION public\.record_private_analytics_event\(text, jsonb\)\s+TO repairprint_analytics_service\s+GRANTED BY CURRENT_USER;[\s\S]*?RESET ROLE;/u);
    expect(migration).toContain("acl.grantor = maintenance_oid");
    expect(migration).toContain("ANALYTICS_RECORDER_SERVICE_GRANT_INVALID");
    expect(migration).toContain("dependency.refclassid = 'pg_catalog.pg_extension'::regclass");
    expect(migration).toContain("dependency.objsubid = 0");
    expect(migration).toContain("dependency.refobjsubid = 0");
    expect(migration).toContain("procedure.prokind IN ('f', 'p', 'a', 'w')");
    expect(migration).toContain("procedure.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)");
    expect(migration).toContain("ANALYTICS_UNEXPECTED_SERVICE_ROUTINE_EXECUTE: %");
    expect(migration).toContain("ANALYTICS_NON_CALLABLE_ROUTINE_BASELINE_INVALID");
    expect(migration).toContain("ANALYTICS_MAINTENANCE_EFFECTIVE_RELATION_PRIVILEGE_INVALID");
    expect(migration).toContain("namespace.nspname !~ '^pg_toast_temp_[0-9]+$'");
    expect(migration).toContain("ANALYTICS_PUBLIC_RECORDER_EXECUTE");
    expect(migration).toContain("ANALYTICS_ANONYMOUS_AGGREGATE_ACCESS");
    expect(migration).toMatch(/IF EXISTS \(SELECT 1 FROM public\.private_analytics_daily_aggregates\) THEN\s+RAISE EXCEPTION 'ANALYTICS_AGGREGATE_NOT_EMPTY';/u);
    expect(migration).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*private_analytics_daily_aggregates[^;]*TO repairprint_analytics_service/iu);
    expect(migration).not.toMatch(/ALTER\s+ROLE\s+repairprint_analytics_(?:service|maintenance)/iu);
  });

  it("pins only the approved pg_trgm PUBLIC-execute baseline outside the application routine boundary", () => {
    const migration = readFileSync(
      path.join(process.cwd(), "drizzle", "0012_eager_earthquake.sql"),
      "utf8",
    );
    expect(migration.startsWith("SET LOCAL search_path = pg_catalog;\n")).toBe(true);
    expect(migration).toContain(
      "fb1fec29b971acc669e9ebdfeb3b7f55cf2c6b5710f2ce99cbac020e70bdffac",
    );
    expect(migration).toContain(
      "9815bdde7ae8e74337c527c90b34d23d02ffb508ddc58c1f1a8323b430dcfc94",
    );
    for (const structuralFingerprint of [
      "c0275d3247965414d0ab1902027ee33214f8f11fcd4def7cea0df155fd94efbf",
      "f40dba0bec070313337e408557cc44ad59f4bafedc94121327bba8a6dc000164",
    ]) {
      expect(migration.match(new RegExp(structuralFingerprint, "gu"))).toHaveLength(2);
    }
    expect(migration.match(
      /owner_role\.rolname NOT IN \('repairprint', 'supabase_admin'\)/gu,
    )).toHaveLength(2);
    const ownerFingerprintPairs = [...migration.matchAll(
      /extension_owner = '(repairprint|supabase_admin)'\s+AND manifest_fingerprint = '([0-9a-f]{64})'/gu,
    )].map((match) => `${match[1]}:${match[2]}`);
    expect(ownerFingerprintPairs).toEqual([
      "repairprint:c0275d3247965414d0ab1902027ee33214f8f11fcd4def7cea0df155fd94efbf",
      "supabase_admin:f40dba0bec070313337e408557cc44ad59f4bafedc94121327bba8a6dc000164",
      "repairprint:c0275d3247965414d0ab1902027ee33214f8f11fcd4def7cea0df155fd94efbf",
      "supabase_admin:f40dba0bec070313337e408557cc44ad59f4bafedc94121327bba8a6dc000164",
    ]);
    expect(migration).not.toContain("manifest_fingerprint NOT IN");
    expect(migration.match(/SET LOCAL search_path = pg_catalog;/gu)).toHaveLength(2);
    expect(migration.match(/routine_count <> 31/gu)).toHaveLength(2);
    expect(migration.match(/'owner', '<extension_owner>'/gu)).toHaveLength(2);
    expect(migration.match(/WHEN acl\.grantor = extension_state\.extowner THEN '<extension_owner>'/gu)).toHaveLength(4);
    expect(migration.match(/WHEN acl\.grantee = extension_state\.extowner THEN '<extension_owner>'/gu)).toHaveLength(4);
    expect(migration.match(/sha256\(convert_to\(pg_get_functiondef\(procedure\.oid\), 'UTF8'\)\)/gu)).toHaveLength(2);
    expect(migration.match(/'aclDefaulted', procedure\.proacl IS NULL/gu)).toHaveLength(2);
    expect((migration.match(/dependency\.objsubid = 0/gu) ?? []).length).toBeGreaterThanOrEqual(8);
    expect((migration.match(/dependency\.refobjsubid = 0/gu) ?? []).length).toBeGreaterThanOrEqual(8);
    expect((migration.match(/dependency\.deptype = 'e'/gu) ?? []).length).toBeGreaterThanOrEqual(8);
    expect((migration.match(/COLLATE "C"/gu) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(migration).toContain("repairprint.wp11_pg_trgm_manifest_fingerprint");
    expect(migration).toContain("ANALYTICS_PG_TRGM_DIRECT_ANALYTICS_GRANT");
    expect(migration).toContain("ANALYTICS_PG_TRGM_DIRECT_ANALYTICS_GRANT_POSTCONDITION");
    expect(migration.match(
      /AND extension\.extname = 'pg_trgm'\s+\)\s+AND has_function_privilege\((?:service|maintenance)_oid, procedure\.oid, 'EXECUTE'\)/gu,
    )).toHaveLength(2);
    expect(migration).not.toMatch(
      /AND NOT EXISTS \(\s+SELECT 1\s+FROM pg_depend AS dependency\s+WHERE[\s\S]*?dependency\.deptype = 'e'\s+\)\s+AND has_function_privilege\((?:service|maintenance)_oid/u,
    );
  });

  it("keeps the analytics tuple constraint two-valued, explicitly typed, and sanitized", () => {
    const migration = readFileSync(
      path.join(process.cwd(), "drizzle", "0012_eager_earthquake.sql"),
      "utf8",
    );
    const constraint = migration.match(
      /CONSTRAINT "private_analytics_dimensions_ck" CHECK \(([\s\S]*?)\r?\n    \)\r?\n\);/u,
    )?.[1];
    expect(constraint).toBeDefined();
    expect(constraint).toMatch(/\) IS TRUE\s*$/u);
    for (const property of [
      "normalizedCategory",
      "entityType",
      "matchClass",
      "tokenClass",
      "publicId",
      "confidenceTier",
      "safetyClass",
      "sourcePlatform",
      "outcome",
      "categoryMatch",
    ]) {
      expect(constraint).toContain(`jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'${property}') = 'string'`);
    }
    expect(constraint).not.toContain("::integer");
    expect(migration).toMatch(/EXCEPTION\s+WHEN check_violation THEN\s+RAISE EXCEPTION 'ANALYTICS_EVENT_INVALID' USING ERRCODE = '22023';/u);
  });
});
