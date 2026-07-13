export {};

async function main(): Promise<void> {
  if (!process.env.DATABASE_TEST_URL && !process.env.CI) {
    console.log("Database check skipped locally: set DATABASE_TEST_URL to the guarded repairprint_test database.");
    return;
  }

  await import("./check-database");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
