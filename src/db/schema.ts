import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const publicationStatusEnum = pgEnum("publication_status", [
  "draft",
  "in_review",
  "published",
  "needs_review",
  "archived",
]);
export const moderationStatusEnum = pgEnum("moderation_status", ["pending", "accepted", "rejected"]);
export const safetyClassEnum = pgEnum("safety_class", ["low", "caution", "blocked"]);
export const fitmentStatusEnum = pgEnum("fitment_status", [
  "verified_fit",
  "community_confirmed",
  "creator_listed",
  "candidate_match",
  "disputed",
  "rejected",
]);
export const fitOutcomeEnum = pgEnum("fit_outcome", [
  "fits_without_modification",
  "fits_after_modification",
  "does_not_fit",
  "print_failed",
  "unsure",
]);
export const evidenceKindEnum = pgEnum("evidence_kind", [
  "trusted_physical_test",
  "community_report",
  "creator_claim",
  "oem_mapping",
  "dimensional_match",
  "editorial_note",
]);
export const sourcePolicyEnum = pgEnum("source_policy", [
  "api",
  "creator_submission",
  "written_permission",
  "link_only",
  "blocked",
]);
export const submissionKindEnum = pgEnum("submission_kind", [
  "missing_part",
  "fit_confirmation",
  "design_submission",
  "rights_or_safety_notice",
]);
export const submissionStatusEnum = pgEnum("submission_status", [
  "pending",
  "in_review",
  "accepted",
  "rejected",
  "resolved",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    publicationStatus: publicationStatusEnum("publication_status").notNull().default("draft"),
    ...timestamps,
  },
  (table) => [uniqueIndex("brands_slug_uq").on(table.slug), uniqueIndex("brands_name_key_uq").on(table.normalizedName)],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("categories_slug_uq").on(table.slug)],
);

export const productModels = pgTable(
  "product_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    brandId: uuid("brand_id").notNull().references(() => brands.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "restrict" }),
    modelName: text("model_name").notNull(),
    slug: text("slug").notNull(),
    familyName: text("family_name"),
    marketCodes: jsonb("market_codes").$type<string[]>().notNull(),
    productionStart: date("production_start"),
    productionEnd: date("production_end"),
    labelLocation: text("label_location"),
    summary: text("summary"),
    publicationStatus: publicationStatusEnum("publication_status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_models_public_id_uq").on(table.publicId),
    uniqueIndex("product_models_brand_slug_uq").on(table.brandId, table.slug),
    index("product_models_publication_idx").on(table.publicationStatus),
  ],
);

export const productIdentifiers = pgTable(
  "product_identifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productModelId: uuid("product_model_id").notNull().references(() => productModels.id, { onDelete: "cascade" }),
    displayValue: text("display_value").notNull(),
    strictKey: text("strict_key").notNull(),
    looseKey: text("loose_key").notNull(),
    identifierType: text("identifier_type").notNull(),
    marketCode: text("market_code"),
    sourceCitationId: uuid("source_citation_id"),
    ...timestamps,
  },
  (table) => [
    index("product_identifiers_strict_idx").on(table.strictKey),
    index("product_identifiers_loose_idx").on(table.looseKey),
    uniqueIndex("product_identifiers_model_display_uq").on(table.productModelId, table.displayValue),
  ],
);

export const components = pgTable(
  "components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "restrict" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    commonNames: jsonb("common_names").$type<string[]>().notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("components_category_slug_uq").on(table.categoryId, table.slug)],
);

export const oemParts = pgTable(
  "oem_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    brandId: uuid("brand_id").notNull().references(() => brands.id, { onDelete: "restrict" }),
    componentId: uuid("component_id").notNull().references(() => components.id, { onDelete: "restrict" }),
    partNumberDisplay: text("part_number_display").notNull(),
    strictPartKey: text("strict_part_key").notNull(),
    loosePartKey: text("loose_part_key").notNull(),
    name: text("name").notNull(),
    publicationStatus: publicationStatusEnum("publication_status").notNull().default("draft"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("oem_parts_public_id_uq").on(table.publicId),
    uniqueIndex("oem_parts_brand_strict_uq").on(table.brandId, table.strictPartKey),
    index("oem_parts_loose_idx").on(table.loosePartKey),
  ],
);

export const oemPartSupersessions = pgTable(
  "oem_part_supersessions",
  {
    fromPartId: uuid("from_part_id").notNull().references(() => oemParts.id, { onDelete: "cascade" }),
    toPartId: uuid("to_part_id").notNull().references(() => oemParts.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull().default("superseded_by"),
    sourceCitationId: uuid("source_citation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.fromPartId, table.toPartId] })],
);

export const productComponents = pgTable(
  "product_components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productModelId: uuid("product_model_id").notNull().references(() => productModels.id, { onDelete: "cascade" }),
    componentId: uuid("component_id").notNull().references(() => components.id, { onDelete: "restrict" }),
    oemPartId: uuid("oem_part_id").references(() => oemParts.id, { onDelete: "set null" }),
    serialFrom: text("serial_from"),
    serialTo: text("serial_to"),
    mappingStatus: moderationStatusEnum("mapping_status").notNull().default("pending"),
    sourceCitationId: uuid("source_citation_id"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_components_logical_uq").on(table.productModelId, table.componentId, table.oemPartId),
    index("product_components_model_idx").on(table.productModelId),
  ],
);

export const creators = pgTable(
  "creators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    platform: text("platform").notNull(),
    externalProfileUrl: text("external_profile_url"),
    ...timestamps,
  },
  (table) => [uniqueIndex("creators_platform_name_uq").on(table.platform, table.displayName)],
);

export const sourcePlatformPolicies = pgTable("source_platform_policies", {
  platform: text("platform").primaryKey(),
  policy: sourcePolicyEnum("policy").notNull(),
  termsUrl: text("terms_url").notNull(),
  termsCheckedAt: timestamp("terms_checked_at", { withTimezone: true }).notNull(),
  permissionScope: text("permission_scope"),
  allowedFields: jsonb("allowed_fields").$type<string[]>().notNull(),
  imageReuseAllowed: boolean("image_reuse_allowed").notNull().default(false),
  fileRehostingAllowed: boolean("file_rehosting_allowed").notNull().default(false),
  automationAllowed: boolean("automation_allowed").notNull().default(false),
  commercialUseAllowed: boolean("commercial_use_allowed"),
  adapterEnabled: boolean("adapter_enabled").notNull().default(false),
  ...timestamps,
});

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceType: text("source_type").notNull(),
    platform: text("platform"),
    canonicalUrl: text("canonical_url").notNull(),
    publisher: text("publisher"),
    title: text("title").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull(),
    contentChecksum: text("content_checksum"),
    rightsNotes: text("rights_notes"),
    status: text("status").notNull().default("live"),
    ...timestamps,
  },
  (table) => [uniqueIndex("sources_url_uq").on(table.canonicalUrl), index("sources_status_idx").on(table.status)],
);

export const sourceCitations = pgTable(
  "source_citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    fieldPath: text("field_path").notNull(),
    claimValue: jsonb("claim_value").notNull(),
    locator: text("locator"),
    supportingExcerpt: text("supporting_excerpt"),
    extractionMethod: text("extraction_method").notNull(),
    reviewStatus: moderationStatusEnum("review_status").notNull().default("pending"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("source_citations_entity_idx").on(table.entityType, table.entityId)],
);

export const designs = pgTable(
  "designs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    slug: text("slug").notNull(),
    creatorId: uuid("creator_id").notNull().references(() => creators.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    summary: text("summary"),
    publicationStatus: publicationStatusEnum("publication_status").notNull().default("draft"),
    availabilityStatus: text("availability_status").notNull().default("available"),
    ...timestamps,
  },
  (table) => [uniqueIndex("designs_public_id_uq").on(table.publicId), uniqueIndex("designs_slug_uq").on(table.slug)],
);

export const designRevisions = pgTable(
  "design_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    designId: uuid("design_id").notNull().references(() => designs.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
    sourceRevision: text("source_revision").notNull(),
    sourceExternalId: text("source_external_id"),
    sourceHash: text("source_hash"),
    licenseCode: text("license_code").notNull(),
    licenseVersion: text("license_version"),
    licenseUrl: text("license_url"),
    licenseEvidenceUrl: text("license_evidence_url"),
    attributionText: text("attribution_text").notNull(),
    fileFormats: jsonb("file_formats").$type<string[]>().notNull(),
    sourcePublishedAt: timestamp("source_published_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    rightsCheckedAt: timestamp("rights_checked_at", { withTimezone: true }).notNull(),
    rightsCheckedBy: uuid("rights_checked_by"),
    ...timestamps,
  },
  (table) => [uniqueIndex("design_revisions_design_source_revision_uq").on(table.designId, table.sourceRevision)],
);

export const fitments = pgTable(
  "fitments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    slug: text("slug").notNull(),
    designRevisionId: uuid("design_revision_id").notNull().references(() => designRevisions.id, { onDelete: "restrict" }),
    productComponentId: uuid("product_component_id").notNull().references(() => productComponents.id, { onDelete: "restrict" }),
    confidenceLevel: fitmentStatusEnum("confidence_level").notNull().default("candidate_match"),
    confidenceScore: integer("confidence_score").notNull().default(0),
    confidenceVersion: text("confidence_version").notNull().default("fitment-v1"),
    publicationStatus: publicationStatusEnum("publication_status").notNull().default("draft"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    lastComputedAt: timestamp("last_computed_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("fitments_public_id_uq").on(table.publicId),
    uniqueIndex("fitments_slug_uq").on(table.slug),
    uniqueIndex("fitments_revision_component_uq").on(table.designRevisionId, table.productComponentId),
    index("fitments_publication_confidence_idx").on(table.publicationStatus, table.confidenceLevel),
  ],
);

export const fitmentEvidence = pgTable(
  "fitment_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fitmentId: uuid("fitment_id").notNull().references(() => fitments.id, { onDelete: "cascade" }),
    evidenceKind: evidenceKindEnum("evidence_kind").notNull(),
    outcome: fitOutcomeEnum("outcome"),
    sourceCitationId: uuid("source_citation_id").references(() => sourceCitations.id, { onDelete: "set null" }),
    actorIndependenceKey: text("actor_independence_key"),
    exactModel: boolean("exact_model").notNull().default(false),
    exactDesignRevision: boolean("exact_design_revision").notNull().default(false),
    hasModelLabelPhoto: boolean("has_model_label_photo").notNull().default(false),
    hasInstalledPhoto: boolean("has_installed_photo").notNull().default(false),
    measurements: jsonb("measurements"),
    modificationNotes: text("modification_notes"),
    summary: text("summary").notNull(),
    observedAt: date("observed_at").notNull(),
    moderationStatus: moderationStatusEnum("moderation_status").notNull().default("pending"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("fitment_evidence_fitment_status_idx").on(table.fitmentId, table.moderationStatus)],
);

export const safetyReviews = pgTable(
  "safety_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productComponentId: uuid("product_component_id").notNull().references(() => productComponents.id, { onDelete: "cascade" }),
    safetyClass: safetyClassEnum("safety_class").notNull(),
    signals: jsonb("signals").$type<string[]>().notNull(),
    failureConsequence: text("failure_consequence").notNull(),
    rationale: text("rationale").notNull(),
    rulesetVersion: text("ruleset_version").notNull().default("safety-v1"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("safety_reviews_component_ruleset_uq").on(table.productComponentId, table.rulesetVersion)],
);

export const printRecipes = pgTable(
  "print_recipes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fitmentId: uuid("fitment_id").notNull().references(() => fitments.id, { onDelete: "cascade" }),
    material: text("material").notNull(),
    nozzleMm: real("nozzle_mm"),
    layerHeightMm: real("layer_height_mm"),
    wallCount: integer("wall_count"),
    infillPercent: integer("infill_percent"),
    supports: text("supports"),
    orientation: text("orientation"),
    hardware: jsonb("hardware"),
    estimatedMinutes: integer("estimated_minutes"),
    provenance: text("provenance").notNull(),
    sourceCitationId: uuid("source_citation_id").references(() => sourceCitations.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [uniqueIndex("print_recipes_fitment_uq").on(table.fitmentId)],
);

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: submissionKindEnum("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: submissionStatusEnum("status").notNull().default("pending"),
    matchedEntityType: text("matched_entity_type"),
    matchedEntityId: uuid("matched_entity_id"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("submissions_queue_idx").on(table.status, table.kind, table.createdAt)],
);

export const sourceLinkChecks = pgTable(
  "source_link_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    httpStatus: integer("http_status"),
    outcome: text("outcome").notNull(),
    finalUrl: text("final_url"),
    responseMs: integer("response_ms"),
    errorCode: text("error_code"),
  },
  (table) => [index("source_link_checks_source_checked_idx").on(table.sourceId, table.checkedAt)],
);

export const slugHistory = pgTable(
  "slug_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    oldPath: text("old_path").notNull(),
    replacementPath: text("replacement_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("slug_history_old_path_uq").on(table.oldPath)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_log_entity_idx").on(table.entityType, table.entityId, table.createdAt)],
);
