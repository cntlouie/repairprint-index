import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for database migrations.");

  // Managed transaction and session poolers require prepared statements off.
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });

  try {
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
    console.log("Database migrations applied successfully.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
