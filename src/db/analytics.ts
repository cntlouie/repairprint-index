import "server-only";

import { getAnalyticsDatabaseClient } from "@/db/analytics-client";
import { analyticsDimensions, type AnalyticsEvent } from "@/domain/analytics";

export async function recordPrivateAnalyticsEvent(event: AnalyticsEvent): Promise<void> {
  const sql = await getAnalyticsDatabaseClient();
  const dimensions = analyticsDimensions(event);
  await sql`
    SELECT public.record_private_analytics_event(
      ${event.name},
      ${JSON.stringify(dimensions)}::text::jsonb
    )
  `;
}
