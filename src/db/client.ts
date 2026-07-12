import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for database operations.");

// Serverless instances share the provider transaction pool. Keep one client
// connection per instance; postgres.js queues concurrent application queries.
const sql = postgres(databaseUrl, { prepare: false, max: 1 });
export const db = drizzle(sql, { schema });

export async function closeDatabase(): Promise<void> {
  await sql.end();
}
