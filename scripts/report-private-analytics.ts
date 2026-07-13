import postgres from "postgres";
import {
  canRunPrivateAnalyticsReport,
  parsePrivateAnalyticsReportOptions,
  PRIVATE_ANALYTICS_REPORT_EVENTS,
} from "../src/domain/analytics-report";

async function main(): Promise<void> {
  const { days, minimumCellCount } = parsePrivateAnalyticsReportOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the private analytics report.");

  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [access] = await sql<{
      canRead: boolean;
      currentUser: string;
      ownsAggregateTable: boolean;
      privileged: boolean;
    }[]>`
      SELECT
        current_user AS "currentUser",
        has_table_privilege(
          current_user,
          'public.private_analytics_daily_aggregates',
          'SELECT'
        ) AS "canRead",
        role.rolsuper
          OR role.rolcreatedb
          OR role.rolcreaterole
          OR role.rolreplication
          OR role.rolbypassrls AS privileged,
        table_class.relowner = role.oid AS "ownsAggregateTable"
      FROM pg_catalog.pg_roles AS role
      CROSS JOIN pg_catalog.pg_class AS table_class
      WHERE role.rolname = current_user
        AND table_class.oid = 'public.private_analytics_daily_aggregates'::regclass
    `;
    if (!access || !canRunPrivateAnalyticsReport(access)) {
      throw new Error("ANALYTICS_REPORT_ROLE_FORBIDDEN");
    }

    const rows = await sql<{
      dimensions: Record<string, boolean | number | string>;
      eventCount: number;
      eventName: string;
    }[]>`
      SELECT
        event_name AS "eventName",
        dimensions,
        sum(event_count)::int AS "eventCount"
      FROM public.private_analytics_daily_aggregates
      WHERE event_day >= (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - (${days}::int - 1)
        AND event_name IN (
        ${PRIVATE_ANALYTICS_REPORT_EVENTS[0]},
        ${PRIVATE_ANALYTICS_REPORT_EVENTS[1]},
        ${PRIVATE_ANALYTICS_REPORT_EVENTS[2]},
        ${PRIVATE_ANALYTICS_REPORT_EVENTS[3]}
        )
      GROUP BY event_name, dimensions
      HAVING sum(event_count) >= ${minimumCellCount}
      ORDER BY sum(event_count) DESC, event_name, dimensions
      LIMIT 200
    `;

    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      privacy: {
        dailyRowsExposed: false,
        minimumCellCount,
        rawEventsAvailable: false,
      },
      reportingWindowDays: days,
      rows,
    }, null, 2));
  } finally {
    await sql.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Private analytics report failed.");
  process.exitCode = 1;
});
