import "server-only";

import postgres from "postgres";

import { ANALYTICS_SERVICE_ROLE } from "@/domain/analytics-role-membership";

type AnalyticsDatabaseClient = ReturnType<typeof postgres>;

let analyticsDatabaseClient: AnalyticsDatabaseClient | undefined;
let roleAssertion: Promise<void> | undefined;

export async function getAnalyticsDatabaseClient(): Promise<AnalyticsDatabaseClient> {
  const client = initializeAnalyticsDatabaseClient();
  roleAssertion ??= assertDedicatedAnalyticsRole(client);
  await roleAssertion;
  return client;
}

export async function closeAnalyticsDatabase(): Promise<void> {
  const client = analyticsDatabaseClient;
  analyticsDatabaseClient = undefined;
  roleAssertion = undefined;
  if (client) await client.end();
}

function initializeAnalyticsDatabaseClient(): AnalyticsDatabaseClient {
  if (analyticsDatabaseClient) return analyticsDatabaseClient;
  const databaseUrl = process.env.ANALYTICS_DATABASE_URL;
  if (!databaseUrl) throw new Error("ANALYTICS_DATABASE_URL_REQUIRED");
  analyticsDatabaseClient = postgres(databaseUrl, { prepare: false, max: 2 });
  return analyticsDatabaseClient;
}

async function assertDedicatedAnalyticsRole(client: AnalyticsDatabaseClient): Promise<void> {
  const [identity] = await client<Array<{ currentUser: string }>>`
    SELECT current_user AS "currentUser"
  `;
  if (identity?.currentUser !== ANALYTICS_SERVICE_ROLE) {
    throw new Error("ANALYTICS_DATABASE_ROLE_INVALID");
  }
}
