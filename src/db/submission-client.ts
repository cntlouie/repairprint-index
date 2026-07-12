import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const REQUIRED_SUBMISSION_DATABASE_ROLE = "repairprint_submission_service";
type SubmissionDatabase = PostgresJsDatabase<typeof schema>;
type SubmissionDatabaseClient = ReturnType<typeof postgres>;

let submissionDatabaseClient: SubmissionDatabaseClient | undefined;
let submissionDb: SubmissionDatabase | undefined;
let roleAssertion: Promise<void> | undefined;

export async function getSubmissionDatabase(): Promise<SubmissionDatabase> {
  const { client, database } = initializeSubmissionDatabase();
  roleAssertion ??= assertDedicatedSubmissionRole(client);
  await roleAssertion;
  return database;
}

export async function closeSubmissionDatabase(): Promise<void> {
  const client = submissionDatabaseClient;
  submissionDatabaseClient = undefined;
  submissionDb = undefined;
  roleAssertion = undefined;
  if (client) await client.end();
}

function initializeSubmissionDatabase(): Readonly<{
  client: SubmissionDatabaseClient;
  database: SubmissionDatabase;
}> {
  if (submissionDatabaseClient && submissionDb) {
    return { client: submissionDatabaseClient, database: submissionDb };
  }
  const submissionDatabaseUrl = process.env.SUBMISSION_DATABASE_URL;
  if (!submissionDatabaseUrl) {
    throw new Error("SUBMISSION_DATABASE_URL_REQUIRED");
  }
  submissionDatabaseClient = postgres(submissionDatabaseUrl, { prepare: false, max: 4 });
  submissionDb = drizzle(submissionDatabaseClient, { schema });
  return { client: submissionDatabaseClient, database: submissionDb };
}

async function assertDedicatedSubmissionRole(client: SubmissionDatabaseClient): Promise<void> {
  const [identity] = await client<Array<{ currentUser: string }>>`
    SELECT current_user AS "currentUser"
  `;
  if (identity?.currentUser !== REQUIRED_SUBMISSION_DATABASE_ROLE) {
    throw new Error("SUBMISSION_DATABASE_ROLE_INVALID");
  }
}
