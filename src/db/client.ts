import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for database operations.");

// prepare:false works with transaction-pooled managed PostgreSQL providers.
const sql = postgres(databaseUrl, { prepare: false, max: 5 });
export const db = drizzle(sql, { schema });
