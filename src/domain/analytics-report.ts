export const PRIVATE_ANALYTICS_REPORT_EVENTS = Object.freeze([
  "zero_result",
  "search_resolved",
  "variant_disambiguation_shown",
  "missing_part_submitted",
] as const);

export type PrivateAnalyticsReportOptions = Readonly<{
  days: number;
  minimumCellCount: number;
}>;

export type PrivateAnalyticsReportAccess = Readonly<{
  canRead: boolean;
  currentUser: string;
  ownsAggregateTable: boolean;
  privileged: boolean;
}>;

const FORBIDDEN_REPORT_ROLES = new Set([
  "anon",
  "authenticated",
  "repairprint_analytics_service",
  "repairprint_analytics_maintenance",
]);

export function parsePrivateAnalyticsReportOptions(
  arguments_: readonly string[],
): PrivateAnalyticsReportOptions {
  const supported = new Set(["--days", "--minimum-cell-count"]);
  for (const argument of arguments_) {
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (!supported.has(name)) throw new Error(`Unsupported analytics report argument: ${name}.`);
  }

  return Object.freeze({
    days: boundedIntegerArgument(arguments_, "--days", 30, 1, 366),
    minimumCellCount: boundedIntegerArgument(arguments_, "--minimum-cell-count", 5, 5, 100),
  });
}

export function canRunPrivateAnalyticsReport(access: PrivateAnalyticsReportAccess): boolean {
  return access.canRead
    && access.currentUser.length > 0
    && !FORBIDDEN_REPORT_ROLES.has(access.currentUser)
    && !access.ownsAggregateTable
    && !access.privileged;
}

function boundedIntegerArgument(
  arguments_: readonly string[],
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const supplied = arguments_.filter((argument) => argument.startsWith(`${name}=`));
  if (supplied.length > 1) throw new Error(`${name} may be supplied only once.`);
  if (supplied.length === 0) return defaultValue;
  const value = Number(supplied[0]!.slice(name.length + 1));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
