import { analyticsEventSchema, type AnalyticsEvent } from "@/domain/analytics";

type Environment = Readonly<Record<string, string | undefined>>;

export type AnalyticsConfiguration = Readonly<{
  enabled: boolean;
  reason: "enabled" | "demo_locked" | "disabled" | "invalid_mode" | "database_url_missing";
}>;

export type AnalyticsRecordResult = "recorded" | "disabled" | "dropped";

export interface AnalyticsRecorderDependencies {
  readonly environment: Environment;
  readonly persist: (event: AnalyticsEvent) => Promise<void>;
  readonly reportFailure: (entry: Readonly<{ code: string; eventName?: AnalyticsEvent["name"] }>) => void;
}

const defaultDependencies: AnalyticsRecorderDependencies = {
  environment: process.env,
  persist: async (event) => {
    const { recordPrivateAnalyticsEvent } = await import("@/db/analytics");
    await recordPrivateAnalyticsEvent(event);
  },
  reportFailure: (entry) => console.error(entry),
};

export function resolveAnalyticsConfiguration(environment: Environment): AnalyticsConfiguration {
  if (environment.DEMO_MODE !== "false") return { enabled: false, reason: "demo_locked" };
  if (environment.ANALYTICS_MODE === undefined || environment.ANALYTICS_MODE === "disabled") {
    return { enabled: false, reason: "disabled" };
  }
  if (environment.ANALYTICS_MODE !== "aggregate_database") {
    return { enabled: false, reason: "invalid_mode" };
  }
  const databaseUrl = environment.ANALYTICS_DATABASE_URL;
  if (!databaseUrl || databaseUrl !== databaseUrl.trim()) {
    return { enabled: false, reason: "database_url_missing" };
  }
  return { enabled: true, reason: "enabled" };
}

/**
 * Analytics is deliberately best effort. Invalid events and persistence failures
 * are reduced to stable codes; no properties or underlying errors enter logs.
 */
export async function bestEffortRecordAnalyticsEvent(
  candidate: unknown,
  dependencies: AnalyticsRecorderDependencies = defaultDependencies,
): Promise<AnalyticsRecordResult> {
  const parsed = analyticsEventSchema.safeParse(candidate);
  if (!parsed.success) {
    dependencies.reportFailure({ code: "ANALYTICS_EVENT_REJECTED" });
    return "dropped";
  }

  const configuration = resolveAnalyticsConfiguration(dependencies.environment);
  if (!configuration.enabled) return "disabled";

  try {
    await dependencies.persist(parsed.data);
    return "recorded";
  } catch {
    dependencies.reportFailure({ code: "ANALYTICS_EVENT_DROPPED", eventName: parsed.data.name });
    return "dropped";
  }
}
