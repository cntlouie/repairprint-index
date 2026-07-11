import { describe, expect, it } from "vitest";

import { assertSafeTestDatabaseUrl } from "../scripts/database-safety";

describe("destructive database check guard", () => {
  it.each([
    "postgres://repairprint:repairprint@localhost:5432/repairprint_test",
    "postgresql://repairprint:repairprint@127.0.0.1:5432/repairprint_test",
  ])("accepts the isolated local test database: %s", (value) => {
    expect(assertSafeTestDatabaseUrl(value, false).pathname).toBe("/repairprint_test");
  });

  it("accepts the service hostname only in CI", () => {
    const value = "postgres://repairprint:repairprint@postgres:5432/repairprint_test";
    expect(() => assertSafeTestDatabaseUrl(value, false)).toThrow(/Refusing destructive database check/);
    expect(assertSafeTestDatabaseUrl(value, true).hostname).toBe("postgres");
  });

  it.each([
    "postgres://repairprint:repairprint@localhost:5432/repairprint",
    "postgres://repairprint:repairprint@db.example.com:5432/repairprint_test",
    "postgres://repairprint:repairprint@db.example.com:5432/production",
    "https://localhost/repairprint_test",
  ])("rejects an unsafe target: %s", (value) => {
    expect(() => assertSafeTestDatabaseUrl(value, false)).toThrow(/Refusing destructive database check/);
  });
});
