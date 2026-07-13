import "server-only";

import postgres from "postgres";

const REQUIRED_SOURCE_DATABASE_ROLE = "repairprint_source_service";
type SourceDatabaseClient = ReturnType<typeof postgres>;

let sourceDatabaseClient: SourceDatabaseClient | undefined;
let roleAssertion: Promise<void> | undefined;

export async function getSourceDatabaseClient(): Promise<SourceDatabaseClient> {
  const client = initializeSourceDatabaseClient();
  roleAssertion ??= assertDedicatedSourceRole(client);
  await roleAssertion;
  return client;
}

export async function closeSourceDatabase(): Promise<void> {
  const client = sourceDatabaseClient;
  sourceDatabaseClient = undefined;
  roleAssertion = undefined;
  if (client) await client.end();
}

function initializeSourceDatabaseClient(): SourceDatabaseClient {
  if (sourceDatabaseClient) return sourceDatabaseClient;
  const databaseUrl = process.env.SOURCE_DATABASE_URL;
  if (!databaseUrl) throw new Error("SOURCE_DATABASE_URL_REQUIRED");
  sourceDatabaseClient = postgres(databaseUrl, { prepare: false, max: 4 });
  return sourceDatabaseClient;
}

async function assertDedicatedSourceRole(client: SourceDatabaseClient): Promise<void> {
  const [identity] = await client<Array<{ currentUser: string }>>`
    SELECT current_user AS "currentUser"
  `;
  if (identity?.currentUser !== REQUIRED_SOURCE_DATABASE_ROLE) {
    throw new Error("SOURCE_DATABASE_ROLE_INVALID");
  }
}
