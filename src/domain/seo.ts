export const INDEXABLE_TRUST_PATHS = [
  "/methodology",
  "/safety",
  "/licensing",
  "/privacy",
  "/corrections",
  "/notice",
  "/independence",
] as const;

export const NON_INDEXABLE_FORM_PATHS = [
  "/request-part",
  "/confirm-fit",
  "/submit-design",
] as const;

const SCHEMA_CONTEXT = "https://schema.org";
const SEARCH_QUERY_INPUT = "required name=search_term_string";
const SEARCH_TEMPLATE_TOKEN = "{search_term_string}";
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/u;
const NON_ASCII = /[^\u0020-\u007e]/u;
const CANONICAL_SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const MODEL_PATH = new RegExp(`^/brands/${CANONICAL_SLUG}/${CANONICAL_SLUG}$`, "u");
const PART_PATH = new RegExp(`^/parts/${CANONICAL_SLUG}$`, "u");
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u;

export type SiteOriginFailure =
  | "missing"
  | "malformed"
  | "unsafe_protocol"
  | "insecure_origin"
  | "credentials"
  | "not_an_origin";

export type SiteOriginResult =
  | Readonly<{ valid: true; origin: string }>
  | Readonly<{ valid: false; reason: SiteOriginFailure }>;

export interface SeoRuntimeInput {
  readonly demoMode: string | undefined;
  readonly siteUrl: string | undefined;
  /** Development and test servers are never crawler-eligible. */
  readonly nodeEnvironment?: string | undefined;
  /** Explicit false means the required production notice channel is absent or invalid. */
  readonly noticeChannelConfigured?: boolean | undefined;
  /** Vercel's broad environment (`production`, `preview`, or `development`). */
  readonly deploymentEnvironment?: string | undefined;
  /** A provider custom target such as `staging`; it may only be production when set. */
  readonly deploymentTarget?: string | undefined;
}

export type SeoRuntimeReason =
  | "indexing_enabled"
  | "demo_locked"
  | "deployment_locked"
  | "launch_prerequisite_locked"
  | "invalid_origin";

export interface SeoRuntimeDecision {
  readonly indexingAllowed: boolean;
  readonly origin: string | null;
  readonly reason: SeoRuntimeReason;
}

export type SeoRouteKind =
  | "home"
  | "trust"
  | "model"
  | "part"
  | "search"
  | "form"
  | "contribution_privacy"
  | "thin_design"
  | "admin"
  | "api"
  | "preview"
  | "unknown"
  | "invalid";

export type CatalogueRecordState =
  | "published"
  | "candidate"
  | "disputed"
  | "rejected"
  | "unavailable"
  | "archived";

export interface CatalogueSeoFacts {
  readonly entityType: "model" | "part";
  readonly recordState: CatalogueRecordState;
  readonly publishedExactModel: boolean;
  readonly lowRiskSafetyApproved: boolean;
  readonly qualifyingLiveDesigns: number;
  readonly visible: Readonly<{
    creator: boolean;
    source: boolean;
    licence: boolean;
    evidence: boolean;
    lastCheckedAt: boolean;
    provenance: boolean;
  }>;
  readonly uniqueRepairInformation: boolean;
}

export type SeoPageReason =
  | SeoRuntimeReason
  | "indexable"
  | "parameterized"
  | "invalid_path"
  | "excluded_route"
  | "private_route"
  | "missing_catalogue_facts"
  | "entity_kind_mismatch"
  | "unpublished_record"
  | "candidate_record"
  | "disputed_record"
  | "rejected_record"
  | "unavailable_record"
  | "archived_record"
  | "safety_ineligible"
  | "empty_catalogue_page"
  | "missing_visible_facts"
  | "thin_content";

export interface SeoPageDecision {
  readonly canonicalUrl: string | null;
  readonly follow: boolean;
  readonly index: boolean;
  readonly reason: SeoPageReason;
  readonly routeKind: SeoRouteKind;
  readonly sitemapEligible: boolean;
}

export interface SeoPageInput {
  readonly runtime: SeoRuntimeDecision;
  readonly path: string;
  readonly hasQueryParameters?: boolean;
  readonly catalogue?: CatalogueSeoFacts;
}

export type SeoRequestBoundaryDecision = Readonly<{
  follow: boolean;
  reason: SeoPageReason;
  routeKind: SeoRouteKind;
}>;

export interface BreadcrumbItem {
  readonly name: string;
  readonly url: string;
}

export type SupportedStructuredData = Readonly<Record<string, unknown>>;

export class UnsupportedStructuredDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedStructuredDataError";
  }
}

/**
 * Accept a configured site origin, not a general URL. HTTP is permitted only
 * for loopback development and the production-HTTP integration fixture.
 */
export function parseSiteOrigin(value: string | undefined): SiteOriginResult {
  if (value === undefined || value.length === 0) return { valid: false, reason: "missing" };
  if (
    value !== value.trim()
    || value.length > 2048
    || CONTROL_OR_SPACE.test(value)
    || NON_ASCII.test(value)
    || value.includes("\\")
    || !/^https?:\/\//u.test(value)
    || !value.isWellFormed()
  ) return { valid: false, reason: "malformed" };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: "unsafe_protocol" };
  }
  if (parsed.username || parsed.password) return { valid: false, reason: "credentials" };
  if (
    !parsed.hostname
    || parsed.hostname.endsWith(".")
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin === "null"
  ) return { valid: false, reason: "not_an_origin" };
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    return { valid: false, reason: "insecure_origin" };
  }

  return { valid: true, origin: parsed.origin };
}

export function evaluateSeoRuntime(input: SeoRuntimeInput): SeoRuntimeDecision {
  const origin = parseSiteOrigin(input.siteUrl);
  if (input.demoMode !== "false") {
    return { indexingAllowed: false, origin: origin.valid ? origin.origin : null, reason: "demo_locked" };
  }
  if (input.nodeEnvironment !== "production") {
    return { indexingAllowed: false, origin: origin.valid ? origin.origin : null, reason: "deployment_locked" };
  }
  if (
    (input.deploymentEnvironment !== undefined && input.deploymentEnvironment !== "production")
    || input.deploymentTarget !== "production"
  ) {
    return { indexingAllowed: false, origin: origin.valid ? origin.origin : null, reason: "deployment_locked" };
  }
  if (input.noticeChannelConfigured !== true) {
    return { indexingAllowed: false, origin: origin.valid ? origin.origin : null, reason: "launch_prerequisite_locked" };
  }
  if (!origin.valid) return { indexingAllowed: false, origin: null, reason: "invalid_origin" };
  return { indexingAllowed: true, origin: origin.origin, reason: "indexing_enabled" };
}

export function classifySeoPath(path: string): SeoRouteKind {
  if (!strictPath(path)) return "invalid";
  if (path === "/") return "home";
  if ((INDEXABLE_TRUST_PATHS as readonly string[]).includes(path)) return "trust";
  if (MODEL_PATH.test(path)) return "model";
  if (PART_PATH.test(path)) return "part";
  // A route-shaped catalogue path that misses the canonical slug grammar is
  // malformed, not an innocuous unknown route.
  if (path === "/brands" || path.startsWith("/brands/") || path === "/parts" || path.startsWith("/parts/")) {
    return "invalid";
  }
  if (path === "/search") return "search";
  if ((NON_INDEXABLE_FORM_PATHS as readonly string[]).includes(path)) return "form";
  if (path === "/contribution-privacy") return "contribution_privacy";
  if (path === "/designs" || path.startsWith("/designs/")) return "thin_design";
  if (path === "/admin" || path.startsWith("/admin/")) return "admin";
  if (path === "/api" || path.startsWith("/api/")) return "api";
  if (path === "/preview" || path.startsWith("/preview/")) return "preview";
  return "unknown";
}

export function buildCanonicalUrl(origin: string, path: string): string | null {
  const parsedOrigin = parseSiteOrigin(origin);
  const routeKind = classifySeoPath(path);
  if (!parsedOrigin.valid || !canonicalRouteKind(routeKind)) return null;
  return path === "/" ? `${parsedOrigin.origin}/` : `${parsedOrigin.origin}${path}`;
}

export function evaluateSeoPage(input: SeoPageInput): SeoPageDecision {
  const boundary = evaluateSeoRequestBoundary(input.runtime, input.path, Boolean(input.hasQueryParameters));
  if (boundary) return noIndexDecision(boundary.routeKind, boundary.follow, boundary.reason);
  const routeKind = classifySeoPath(input.path);
  const origin = input.runtime.origin;
  if (!origin) return noIndexDecision(routeKind, false, input.runtime.reason);

  if (routeKind === "model" || routeKind === "part") {
    const factsReason = catalogueFailureReason(routeKind, input.catalogue);
    if (factsReason) return noIndexDecision(routeKind, true, factsReason);
  }

  const canonicalUrl = buildCanonicalUrl(origin, input.path);
  if (!canonicalUrl) return noIndexDecision(routeKind, false, "invalid_path");
  return {
    canonicalUrl,
    follow: true,
    index: true,
    reason: "indexable",
    routeKind,
    sitemapEligible: true,
  };
}

/**
 * Request-level exclusions that can be decided before catalogue facts load.
 * Metadata and the proxy both consume this result so query/private behavior
 * cannot diverge. A null result means the page must finish its content policy.
 */
export function evaluateSeoRequestBoundary(
  runtime: SeoRuntimeDecision,
  path: string,
  hasQueryParameters: boolean,
): SeoRequestBoundaryDecision | null {
  const routeKind = classifySeoPath(path);
  if (!runtime.indexingAllowed || !runtime.origin) {
    return { follow: false, reason: runtime.reason, routeKind };
  }
  if (routeKind === "invalid") return { follow: false, reason: "invalid_path", routeKind };
  if (["admin", "api", "preview", "unknown"].includes(routeKind)) {
    return { follow: false, reason: "private_route", routeKind };
  }
  if (hasQueryParameters) return { follow: true, reason: "parameterized", routeKind };
  if (["search", "form", "contribution_privacy", "thin_design"].includes(routeKind)) {
    return { follow: true, reason: "excluded_route", routeKind };
  }
  return null;
}

export function normalizeBreadcrumbItems(items: readonly BreadcrumbItem[]): readonly BreadcrumbItem[] {
  if (items.length === 0 || items.length > 10) {
    throw new UnsupportedStructuredDataError("Breadcrumbs require between one and ten visible items.");
  }

  let expectedOrigin: string | undefined;
  const normalized = items.map((item, index) => {
    const name = strictVisibleText(item.name, `Breadcrumb ${index + 1} name`, 200);
    const url = parseCanonicalPageUrl(item.url);
    if (!url) throw new UnsupportedStructuredDataError(`Breadcrumb ${index + 1} has a non-canonical URL.`);
    const origin = new URL(url).origin;
    if (expectedOrigin === undefined) expectedOrigin = origin;
    else if (expectedOrigin !== origin) {
      throw new UnsupportedStructuredDataError("Every breadcrumb URL must use the same canonical origin.");
    }
    return Object.freeze({ name, url });
  });

  return Object.freeze(normalized);
}

export function buildWebSiteStructuredData(input: Readonly<{
  name: string;
  origin: string;
  description?: string;
}>): SupportedStructuredData {
  const parsedOrigin = parseSiteOrigin(input.origin);
  if (!parsedOrigin.valid) throw new UnsupportedStructuredDataError("WebSite JSON-LD requires a canonical origin.");
  const document: SupportedStructuredData = {
    "@context": SCHEMA_CONTEXT,
    "@type": "WebSite",
    name: strictVisibleText(input.name, "WebSite name", 200),
    url: `${parsedOrigin.origin}/`,
    ...(input.description === undefined
      ? {}
      : { description: strictVisibleText(input.description, "WebSite description", 1_000) }),
    potentialAction: {
      "@type": "SearchAction",
      target: `${parsedOrigin.origin}/search?q=${SEARCH_TEMPLATE_TOKEN}`,
      "query-input": SEARCH_QUERY_INPUT,
    },
  };
  assertSupportedStructuredData(document);
  return document;
}

export function buildBreadcrumbListStructuredData(
  items: readonly BreadcrumbItem[],
): SupportedStructuredData {
  const normalized = normalizeBreadcrumbItems(items);
  const document: SupportedStructuredData = {
    "@context": SCHEMA_CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: normalized.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
  assertSupportedStructuredData(document);
  return document;
}

export function buildCollectionPageStructuredData(input: Readonly<{
  name: string;
  url: string;
  description?: string;
  dateModified?: string;
  items?: readonly BreadcrumbItem[];
}>): SupportedStructuredData {
  const url = requiredCanonicalPageUrl(input.url, "CollectionPage URL");
  const items = input.items ? normalizeCollectionItems(input.items) : undefined;
  if (items?.some((item) => new URL(item.url).origin !== new URL(url).origin)) {
    throw new UnsupportedStructuredDataError("Collection items must use the page canonical origin.");
  }
  const document: SupportedStructuredData = {
    "@context": SCHEMA_CONTEXT,
    "@type": "CollectionPage",
    name: strictVisibleText(input.name, "CollectionPage name", 300),
    url,
    ...(input.description === undefined
      ? {}
      : { description: strictVisibleText(input.description, "CollectionPage description", 2_000) }),
    ...(input.dateModified === undefined ? {} : { dateModified: strictIsoDate(input.dateModified) }),
    ...(items === undefined
      ? {}
      : {
        mainEntity: {
          "@type": "ItemList",
          numberOfItems: items.length,
          itemListElement: items.map((item, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: item.name,
            item: item.url,
          })),
        },
      }),
  };
  assertSupportedStructuredData(document);
  return document;
}

function normalizeCollectionItems(items: readonly BreadcrumbItem[]): readonly BreadcrumbItem[] {
  if (items.length === 0 || items.length > 250) {
    throw new UnsupportedStructuredDataError("Collection items require between one and 250 visible items.");
  }
  return Object.freeze(items.map((item, index) => Object.freeze({
    name: strictVisibleText(item.name, `Collection item ${index + 1} name`, 200),
    url: requiredCanonicalPageUrl(item.url, `Collection item ${index + 1} URL`),
  })));
}

export function buildCreativeWorkStructuredData(input: Readonly<{
  type?: "CreativeWork" | "3DModel";
  name: string;
  url: string;
  identifier?: string;
  creator?: string;
  licence?: string;
  datePublished?: string;
  dateModified?: string;
  about?: string;
  encodingFormat?: readonly string[];
}>): SupportedStructuredData {
  const type = input.type ?? "CreativeWork";
  if (type !== "3DModel" && input.encodingFormat !== undefined) {
    throw new UnsupportedStructuredDataError("encodingFormat is supported only for a genuine 3DModel.");
  }
  const document: SupportedStructuredData = {
    "@context": SCHEMA_CONTEXT,
    "@type": type,
    name: strictVisibleText(input.name, `${type} name`, 500),
    url: requiredCanonicalPageUrl(input.url, `${type} URL`),
    ...(input.identifier === undefined
      ? {}
      : { identifier: strictVisibleText(input.identifier, `${type} identifier`, 200) }),
    ...(input.creator === undefined
      ? {}
      : { creator: { "@type": "Person", name: strictVisibleText(input.creator, `${type} creator`, 200) } }),
    ...(input.licence === undefined
      ? {}
      : { license: strictVisibleText(input.licence, `${type} licence`, 500) }),
    ...(input.datePublished === undefined ? {} : { datePublished: strictIsoDate(input.datePublished) }),
    ...(input.dateModified === undefined ? {} : { dateModified: strictIsoDate(input.dateModified) }),
    ...(input.about === undefined ? {} : { about: strictVisibleText(input.about, `${type} subject`, 500) }),
    ...(input.encodingFormat === undefined
      ? {}
      : {
        encodingFormat: input.encodingFormat.map((format) => strictVisibleText(format, "3DModel format", 100)),
      }),
  };
  assertSupportedStructuredData(document);
  return document;
}

export function assertSupportedStructuredData(value: unknown): asserts value is SupportedStructuredData {
  const expectedOrigin = structuredDataOrigin(value);
  validateStructuredNode(value, "$", true, expectedOrigin, new Set<object>());
}

export function serializeJsonLd(value: unknown): string {
  assertSupportedStructuredData(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new UnsupportedStructuredDataError("Structured data must be finite acyclic JSON.");
  }
  return serialized.replace(/[<>&\u2028\u2029]/gu, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  })[character] ?? character);
}

function catalogueFailureReason(
  routeKind: "model" | "part",
  facts: CatalogueSeoFacts | undefined,
): SeoPageReason | null {
  if (!facts) return "missing_catalogue_facts";
  if (facts.entityType !== routeKind) return "entity_kind_mismatch";
  if (facts.recordState !== "published") {
    const recordStateReasons: Readonly<Record<CatalogueRecordState, SeoPageReason>> = {
      published: "unpublished_record",
      candidate: "candidate_record",
      disputed: "disputed_record",
      rejected: "rejected_record",
      unavailable: "unavailable_record",
      archived: "archived_record",
    };
    return recordStateReasons[facts.recordState];
  }
  if (!facts.publishedExactModel) return "unpublished_record";
  if (!facts.lowRiskSafetyApproved) return "safety_ineligible";
  if (!Number.isSafeInteger(facts.qualifyingLiveDesigns) || facts.qualifyingLiveDesigns < 1) {
    return "empty_catalogue_page";
  }
  if (Object.values(facts.visible).some((visible) => !visible)) return "missing_visible_facts";
  if (!facts.uniqueRepairInformation) return "thin_content";
  return null;
}

function noIndexDecision(
  routeKind: SeoRouteKind,
  follow: boolean,
  reason: SeoPageReason,
): SeoPageDecision {
  return { canonicalUrl: null, follow, index: false, reason, routeKind, sitemapEligible: false };
}

function canonicalRouteKind(kind: SeoRouteKind): boolean {
  return kind === "home" || kind === "trust" || kind === "model" || kind === "part";
}

function strictPath(path: string): boolean {
  return path.length > 0
    && path.length <= 2048
    && path.startsWith("/")
    && !path.startsWith("//")
    && (path === "/" || !path.endsWith("/"))
    && !CONTROL_OR_SPACE.test(path)
    && !NON_ASCII.test(path)
    && !/[\\%?#]/u.test(path)
    && !path.includes("//")
    && !path.split("/").some((segment) => segment === "." || segment === "..")
    && path.isWellFormed();
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseCanonicalPageUrl(value: string): string | null {
  if (
    value.length === 0
    || value !== value.trim()
    || CONTROL_OR_SPACE.test(value)
    || NON_ASCII.test(value)
    || /[\\%?#]/u.test(value)
    || !value.isWellFormed()
  ) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const origin = parseSiteOrigin(parsed.origin);
  if (!origin.valid || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (!canonicalRouteKind(classifySeoPath(parsed.pathname))) return null;
  const canonical = buildCanonicalUrl(origin.origin, parsed.pathname);
  return canonical === value ? canonical : null;
}

function requiredCanonicalPageUrl(value: string, label: string): string {
  const url = parseCanonicalPageUrl(value);
  if (!url) throw new UnsupportedStructuredDataError(`${label} must be an absolute canonical public URL.`);
  return url;
}

function strictVisibleText(value: string, label: string, maximum: number): string {
  if (
    value.length === 0
    || value.length > maximum
    || value !== value.trim()
    || !value.isWellFormed()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) throw new UnsupportedStructuredDataError(`${label} is empty, malformed, or exceeds ${maximum} characters.`);
  return value;
}

function strictIsoDate(value: string): string {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new UnsupportedStructuredDataError("Structured dates must be valid ISO dates or UTC timestamps.");
  }
  return value;
}

const ALLOWED_PROPERTIES: Readonly<Record<string, ReadonlySet<string>>> = {
  WebSite: new Set(["@context", "@type", "name", "url", "description", "potentialAction"]),
  SearchAction: new Set(["@type", "target", "query-input"]),
  BreadcrumbList: new Set(["@context", "@type", "itemListElement"]),
  ListItem: new Set(["@type", "position", "name", "item"]),
  CollectionPage: new Set(["@context", "@type", "name", "url", "description", "dateModified", "mainEntity"]),
  ItemList: new Set(["@type", "numberOfItems", "itemListElement"]),
  CreativeWork: new Set(["@context", "@type", "name", "url", "identifier", "creator", "license", "datePublished", "dateModified", "about"]),
  "3DModel": new Set(["@context", "@type", "name", "url", "identifier", "creator", "license", "datePublished", "dateModified", "about", "encodingFormat"]),
  Person: new Set(["@type", "name"]),
};

function structuredDataOrigin(value: unknown): string {
  const record = plainRecord(value, "$");
  const type = record["@type"];
  let candidate: unknown;
  if (type === "BreadcrumbList") {
    const elements = record.itemListElement;
    if (Array.isArray(elements)) candidate = plainRecord(elements[0], "$.itemListElement[0]").item;
  } else {
    candidate = record.url;
  }
  if (typeof candidate !== "string") {
    throw new UnsupportedStructuredDataError("Root structured data must expose its canonical origin.");
  }
  const parsed = parseCanonicalPageUrl(candidate);
  if (!parsed) throw new UnsupportedStructuredDataError("Root structured data URL is not canonical.");
  return new URL(parsed).origin;
}

function validateStructuredNode(
  value: unknown,
  path: string,
  root: boolean,
  expectedOrigin: string,
  ancestors: Set<object>,
): void {
  const record = plainRecord(value, path);
  if (ancestors.has(record)) throw new UnsupportedStructuredDataError(`${path} contains a structured-data cycle.`);
  ancestors.add(record);
  try {
    const type = record["@type"];
    if (typeof type !== "string" || !ALLOWED_PROPERTIES[type]) {
      throw new UnsupportedStructuredDataError(`${path} uses unsupported schema type ${String(type)}.`);
    }
    for (const key of Object.keys(record)) {
      if (!ALLOWED_PROPERTIES[type]!.has(key)) {
        throw new UnsupportedStructuredDataError(`${path}.${key} is not an approved structured-data property.`);
      }
    }
    if (root) {
      if (record["@context"] !== SCHEMA_CONTEXT) {
        throw new UnsupportedStructuredDataError(`${path} must use the canonical Schema.org context.`);
      }
    } else if ("@context" in record) {
      throw new UnsupportedStructuredDataError(`${path} must not redefine the structured-data context.`);
    }

    validateRequiredNodeFacts(record, type, path, expectedOrigin, ancestors);
  } finally {
    ancestors.delete(record);
  }
}

function validateRequiredNodeFacts(
  record: Record<string, unknown>,
  type: string,
  path: string,
  expectedOrigin: string,
  ancestors: Set<object>,
): void {
  if (type === "WebSite") {
    validateNameAndCanonicalUrl(record, path, expectedOrigin);
    validateStructuredNode(record.potentialAction, `${path}.potentialAction`, false, expectedOrigin, ancestors);
    if (record.description !== undefined) assertStructuredText(record.description, `${path}.description`);
    return;
  }
  if (type === "SearchAction") {
    if (record["query-input"] !== SEARCH_QUERY_INPUT || typeof record.target !== "string") {
      throw new UnsupportedStructuredDataError(`${path} is not the supported search action contract.`);
    }
    const expectedTargetPrefix = `${expectedOrigin}/search?q=`;
    if (record.target !== `${expectedTargetPrefix}${SEARCH_TEMPLATE_TOKEN}`) {
      throw new UnsupportedStructuredDataError(`${path}.target must use the real canonical search action.`);
    }
    return;
  }
  if (type === "BreadcrumbList" || type === "ItemList") {
    const elements = record.itemListElement;
    if (!Array.isArray(elements) || elements.length === 0 || elements.length > 250) {
      throw new UnsupportedStructuredDataError(`${path}.itemListElement must be a bounded non-empty list.`);
    }
    if (type === "ItemList" && record.numberOfItems !== elements.length) {
      throw new UnsupportedStructuredDataError(`${path}.numberOfItems must match the visible item count.`);
    }
    elements.forEach((element, index) => validateStructuredNode(
      element,
      `${path}.itemListElement[${index}]`,
      false,
      expectedOrigin,
      ancestors,
    ));
    return;
  }
  if (type === "ListItem") {
    if (!Number.isSafeInteger(record.position) || (record.position as number) < 1) {
      throw new UnsupportedStructuredDataError(`${path}.position must be a positive integer.`);
    }
    assertStructuredText(record.name, `${path}.name`);
    assertSameOriginCanonicalUrl(record.item, `${path}.item`, expectedOrigin);
    return;
  }
  if (type === "CollectionPage") {
    validateNameAndCanonicalUrl(record, path, expectedOrigin);
    if (record.description !== undefined) assertStructuredText(record.description, `${path}.description`);
    if (record.dateModified !== undefined) strictIsoDate(String(record.dateModified));
    if (record.mainEntity !== undefined) {
      validateStructuredNode(record.mainEntity, `${path}.mainEntity`, false, expectedOrigin, ancestors);
    }
    return;
  }
  if (type === "CreativeWork" || type === "3DModel") {
    validateNameAndCanonicalUrl(record, path, expectedOrigin);
    for (const key of ["identifier", "license", "about"] as const) {
      if (record[key] !== undefined) assertStructuredText(record[key], `${path}.${key}`);
    }
    for (const key of ["datePublished", "dateModified"] as const) {
      if (record[key] !== undefined) strictIsoDate(String(record[key]));
    }
    if (record.creator !== undefined) {
      validateStructuredNode(record.creator, `${path}.creator`, false, expectedOrigin, ancestors);
    }
    if (record.encodingFormat !== undefined) {
      if (type !== "3DModel" || !Array.isArray(record.encodingFormat) || record.encodingFormat.length === 0) {
        throw new UnsupportedStructuredDataError(`${path}.encodingFormat requires a genuine 3DModel.`);
      }
      record.encodingFormat.forEach((format, index) => assertStructuredText(format, `${path}.encodingFormat[${index}]`));
    }
    return;
  }
  if (type === "Person") {
    assertStructuredText(record.name, `${path}.name`);
  }
}

function validateNameAndCanonicalUrl(
  record: Record<string, unknown>,
  path: string,
  expectedOrigin: string,
): void {
  assertStructuredText(record.name, `${path}.name`);
  assertSameOriginCanonicalUrl(record.url, `${path}.url`, expectedOrigin);
}

function assertStructuredText(value: unknown, path: string): void {
  if (typeof value !== "string") throw new UnsupportedStructuredDataError(`${path} must be visible text.`);
  strictVisibleText(value, path, 10_000);
}

function assertSameOriginCanonicalUrl(value: unknown, path: string, expectedOrigin: string): void {
  if (typeof value !== "string") throw new UnsupportedStructuredDataError(`${path} must be a canonical URL.`);
  const parsed = parseCanonicalPageUrl(value);
  if (!parsed || new URL(parsed).origin !== expectedOrigin) {
    throw new UnsupportedStructuredDataError(`${path} must use the structured page's canonical origin.`);
  }
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UnsupportedStructuredDataError(`${path} must be a plain structured-data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnsupportedStructuredDataError(`${path} must not use a custom object prototype.`);
  }
  return value as Record<string, unknown>;
}
