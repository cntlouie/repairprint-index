import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  findProviderIncompatibleAnalyticsSchemaRevocations,
  findProviderIncompatibleSourceRoleAlterations,
} from "../src/domain/migration-role-safety";

describe("managed-provider source-role migration safety", () => {
  it("rejects provider-restricted source-role attribute changes", () => {
    for (const attribute of [
      "LOGIN", "NOLOGIN", "SUPERUSER", "NOSUPERUSER", "CREATEDB", "NOCREATEDB",
      "CREATEROLE", "NOCREATEROLE", "INHERIT", "NOINHERIT", "REPLICATION",
      "NOREPLICATION", "BYPASSRLS", "NOBYPASSRLS",
    ]) {
      const violations = findProviderIncompatibleSourceRoleAlterations(
        `ALTER ROLE repairprint_source_service ${attribute};`,
      );
      expect(violations, attribute).toEqual([{
        role: "repairprint_source_service",
        statement: `ALTER ROLE repairprint_source_service ${attribute};`,
      }]);
    }
  });

  it("allows exact role creation, unrelated roles and non-attribute configuration", () => {
    expect(findProviderIncompatibleSourceRoleAlterations(`
      CREATE ROLE repairprint_source_service LOGIN NOSUPERUSER;
      ALTER ROLE unrelated_service NOSUPERUSER;
      ALTER ROLE repairprint_source_service SET statement_timeout = '5s';
    `)).toEqual([]);
  });

  it("keeps every reviewed migration free of provider-incompatible WP-10 ALTER ROLE statements", () => {
    const directory = path.join(process.cwd(), "drizzle");
    const violations = readdirSync(directory)
      .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
      .flatMap((file) => findProviderIncompatibleSourceRoleAlterations(
        readFileSync(path.join(directory, file), "utf8"),
      ).map((violation) => ({ file, ...violation })));
    expect(violations).toEqual([]);
  });
});

describe("managed-provider analytics-role migration safety", () => {
  it("rejects all-privilege and privilege-specific schema-wide revocations for either analytics role", () => {
    for (const [objectKind, privilege] of [
      ["FUNCTIONS", "EXECUTE"],
      ["PROCEDURES", "EXECUTE"],
      ["ROUTINES", "EXECUTE"],
      ["SEQUENCES", "USAGE"],
      ["TABLES", "SELECT"],
    ] as const) {
      for (const role of [
        "repairprint_analytics_service",
        "repairprint_analytics_maintenance",
      ] as const) {
        for (const privilegeClause of ["ALL PRIVILEGES", privilege]) {
          const statement = `REVOKE ${privilegeClause} ON ALL ${objectKind} IN SCHEMA public FROM ${role};`;
          expect(
            findProviderIncompatibleAnalyticsSchemaRevocations(statement),
            `${objectKind}:${privilegeClause}:${role}`,
          ).toEqual([{
            objectKind,
            role,
            statement,
          }]);
        }
      }
    }
  });

  it("detects quoted and privilege-specific schema-wide revocations", () => {
    expect(findProviderIncompatibleAnalyticsSchemaRevocations(`
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "public"
      FROM unrelated_role, "repairprint_analytics_service" RESTRICT;
    `)).toEqual([{
      objectKind: "FUNCTIONS",
      role: "repairprint_analytics_service",
      statement: "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA \"public\" FROM unrelated_role, \"repairprint_analytics_service\" RESTRICT;",
    }]);
  });

  it("allows exact-object revocations, other schemas, and unchanged legacy role revocations", () => {
    expect(findProviderIncompatibleAnalyticsSchemaRevocations(`
      REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb)
        FROM repairprint_analytics_service;
      REVOKE ALL PRIVILEGES ON TABLE public.private_analytics_daily_aggregates
        FROM repairprint_analytics_maintenance;
      REVOKE USAGE ON SEQUENCE public.private_analytics_fixture_id_seq
        FROM repairprint_analytics_service;
      REVOKE EXECUTE ON PROCEDURE public.refresh_private_analytics()
        FROM repairprint_analytics_maintenance;
      REVOKE EXECUTE ON ROUTINE public.refresh_private_analytics()
        FROM repairprint_analytics_maintenance;
      REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA private
        FROM repairprint_analytics_service;
      REVOKE ALL PRIVILEGES ON ALL PROCEDURES IN SCHEMA private
        FROM repairprint_analytics_maintenance;
      REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA private
        FROM repairprint_analytics_service;
      REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
        FROM repairprint_source_service;
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
        FROM repairprint_submission_maintenance;
    `)).toEqual([]);
  });

  it("keeps every reviewed migration free of schema-wide analytics-role revocations", () => {
    const directory = path.join(process.cwd(), "drizzle");
    const violations = readdirSync(directory)
      .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
      .flatMap((file) => findProviderIncompatibleAnalyticsSchemaRevocations(
        readFileSync(path.join(directory, file), "utf8"),
      ).map((violation) => ({ file, ...violation })));
    expect(violations).toEqual([]);
  });
});
