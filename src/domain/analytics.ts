import { z } from "zod";

export const ANALYTICS_EVENT_NAMES = Object.freeze([
  "search_submitted",
  "search_resolved",
  "variant_disambiguation_shown",
  "variant_selected",
  "zero_result",
  "part_viewed",
  "original_source_clicked",
  "fit_report_started",
  "fit_report_submitted",
  "missing_part_submitted",
  "design_submitted",
] as const);

export const BROWSER_ANALYTICS_EVENT_NAMES = Object.freeze([
  "search_submitted",
  "search_resolved",
  "variant_disambiguation_shown",
  "variant_selected",
  "zero_result",
  "part_viewed",
  "original_source_clicked",
  "fit_report_started",
] as const);

const publicIdSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const publicSlugSchema = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const sourcePlatformSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const confidenceTierSchema = z.enum(["verified_fit", "community_confirmed", "creator_listed"]);
const fitOutcomeSchema = z.enum([
  "fits_without_modification",
  "fits_after_modification",
  "does_not_fit",
  "print_failed",
  "unsure",
]);

const searchSubmittedEventSchema = eventSchema("search_submitted", {
  normalizedCategory: z.enum(["identifier", "component", "mixed", "other"]),
  queryLength: z.number().int().min(2).max(160),
  identifierLike: z.boolean(),
});

const searchResolvedEventSchema = eventSchema("search_resolved", {
  entityType: z.enum(["model", "part"]),
  matchClass: z.enum(["strict_identifier", "loose_identifier", "model_component", "text", "trigram"]),
  rank: z.number().int().min(1).max(50),
  ambiguityCount: z.number().int().min(0).max(50),
});

const variantDisambiguationShownEventSchema = eventSchema("variant_disambiguation_shown", {
  candidateCount: z.number().int().min(2).max(50),
});

const variantSelectedEventSchema = eventSchema("variant_selected", {
  selectedRank: z.number().int().min(1).max(50),
});

const zeroResultEventSchema = eventSchema("zero_result", {
  tokenClass: z.enum(["numeric", "alphanumeric", "words", "mixed"]),
  brand: publicSlugSchema.optional(),
  category: publicSlugSchema.optional(),
});

const partViewedEventSchema = eventSchema("part_viewed", {
  publicId: publicIdSchema,
  confidenceTier: confidenceTierSchema,
  safetyClass: z.literal("low"),
});

const originalSourceClickedEventSchema = eventSchema("original_source_clicked", {
  publicId: publicIdSchema,
  sourcePlatform: sourcePlatformSchema,
  confidenceTier: confidenceTierSchema,
});

const fitReportStartedEventSchema = eventSchema("fit_report_started", {
  publicId: publicIdSchema,
});

const fitReportSubmittedEventSchema = eventSchema("fit_report_submitted", {
  publicId: publicIdSchema,
  outcome: fitOutcomeSchema,
});

const missingPartSubmittedEventSchema = z.object({
  name: z.literal("missing_part_submitted"),
  properties: z.discriminatedUnion("categoryMatch", [
    z.object({ categoryMatch: z.literal("matched"), category: publicSlugSchema }).strict(),
    z.object({ categoryMatch: z.literal("unmatched") }).strict(),
  ]),
}).strict();

const designSubmittedEventSchema = eventSchema("design_submitted", {
  sourcePlatform: z.enum(["thingiverse", "printables", "makerworld", "other"]),
});

export const analyticsEventSchema = z.discriminatedUnion("name", [
  searchSubmittedEventSchema,
  searchResolvedEventSchema,
  variantDisambiguationShownEventSchema,
  variantSelectedEventSchema,
  zeroResultEventSchema,
  partViewedEventSchema,
  originalSourceClickedEventSchema,
  fitReportStartedEventSchema,
  fitReportSubmittedEventSchema,
  missingPartSubmittedEventSchema,
  designSubmittedEventSchema,
]);

export const browserAnalyticsEventSchema = z.discriminatedUnion("name", [
  searchSubmittedEventSchema,
  searchResolvedEventSchema,
  variantDisambiguationShownEventSchema,
  variantSelectedEventSchema,
  zeroResultEventSchema,
  partViewedEventSchema,
  originalSourceClickedEventSchema,
  fitReportStartedEventSchema,
]);

export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;
export type BrowserAnalyticsEvent = z.infer<typeof browserAnalyticsEventSchema>;
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];
export type BrowserAnalyticsEventName = BrowserAnalyticsEvent["name"];
export type AnalyticsDimensions = AnalyticsEvent["properties"];

export type SearchAnalyticsClassification = Readonly<{
  identifierLike: boolean;
  normalizedCategory: "identifier" | "component" | "mixed" | "other";
  queryLength: number;
  tokenClass: "numeric" | "alphanumeric" | "words" | "mixed";
}>;

export function classifySearchForAnalytics(rawQuery: string): SearchAnalyticsClassification {
  const normalized = rawQuery.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const queryLength = Math.min(normalized.length, 160);
  const hasLetters = /\p{L}/u.test(normalized);
  const hasDigits = /\p{N}/u.test(normalized);
  const identifierPunctuationOnly = /^[\p{L}\p{N}\s./_+#-]+$/u.test(normalized);
  const compactTokens = normalized.split(/\s+/u).filter(Boolean);
  const joinedIdentifier = compactTokens.join("");
  const identifierLike = hasDigits
    && identifierPunctuationOnly
    && joinedIdentifier.length >= 2
    && (compactTokens.length <= 4 || compactTokens.some((token) => /[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*/u.test(token)));

  const tokenClass = !hasLetters && hasDigits
    ? "numeric"
    : hasLetters && hasDigits && compactTokens.length <= 2
      ? "alphanumeric"
      : hasLetters && !hasDigits
        ? "words"
        : "mixed";

  const normalizedCategory = identifierLike
    ? (compactTokens.length <= 2 ? "identifier" : "mixed")
    : hasLetters && !hasDigits
      ? "component"
      : hasLetters || hasDigits
        ? "mixed"
        : "other";

  return Object.freeze({ identifierLike, normalizedCategory, queryLength, tokenClass });
}

export type DesignSourcePlatformClass = "thingiverse" | "printables" | "makerworld" | "other";

export function classifyDesignSourcePlatform(rawUrl: string): DesignSourcePlatformClass {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLocaleLowerCase("en").replace(/\.$/u, "");
  } catch {
    return "other";
  }

  if (hostnameMatches(hostname, "thingiverse.com")) return "thingiverse";
  if (hostnameMatches(hostname, "printables.com")) return "printables";
  if (hostnameMatches(hostname, "makerworld.com")) return "makerworld";
  return "other";
}

export function analyticsDimensions(event: AnalyticsEvent): Readonly<Record<string, boolean | number | string>> {
  return Object.freeze({ ...event.properties });
}

function eventSchema<Name extends (typeof ANALYTICS_EVENT_NAMES)[number], Shape extends z.ZodRawShape>(name: Name, shape: Shape) {
  return z.object({
    name: z.literal(name),
    properties: z.object(shape).strict(),
  }).strict();
}

function hostnameMatches(hostname: string, expected: string): boolean {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}
