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
    expect(migration).toContain("REVOKE ALL PRIVILEGES ON TABLE public.private_analytics_daily_aggregates FROM PUBLIC");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb) FROM PUBLIC");
    expect(migration).toMatch(/ALTER FUNCTION public\.record_private_analytics_event\(text, jsonb\)\s+OWNER TO repairprint_analytics_maintenance;[\s\S]*?SET ROLE repairprint_analytics_maintenance;[\s\S]*?GRANT EXECUTE ON FUNCTION public\.record_private_analytics_event\(text, jsonb\)\s+TO repairprint_analytics_service;[\s\S]*?RESET ROLE;/u);
    expect(migration).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*private_analytics_daily_aggregates[^;]*TO repairprint_analytics_service/iu);
    expect(migration).not.toMatch(/ALTER\s+ROLE\s+repairprint_analytics_(?:service|maintenance)/iu);
  });
});
