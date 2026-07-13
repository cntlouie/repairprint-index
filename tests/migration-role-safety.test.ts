import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findProviderIncompatibleSourceRoleAlterations } from "../src/domain/migration-role-safety";

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
