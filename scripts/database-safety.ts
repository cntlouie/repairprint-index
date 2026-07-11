const localHosts = new Set(["localhost", "127.0.0.1"]);

export function assertSafeTestDatabaseUrl(value: string, allowCiServiceHost: boolean): URL {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.slice(1);
  const allowedHost = localHosts.has(parsed.hostname) || (allowCiServiceHost && parsed.hostname === "postgres");

  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("Refusing destructive database check: DATABASE_TEST_URL must use PostgreSQL.");
  }

  if (!allowedHost || databaseName !== "repairprint_test") {
    throw new Error(
      "Refusing destructive database check: use database repairprint_test on localhost, 127.0.0.1, or the CI postgres service.",
    );
  }

  return parsed;
}
