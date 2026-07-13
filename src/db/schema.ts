import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
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
export const submissionEmailStatusEnum = pgEnum("submission_email_status", [
  "pending",
  "processing",
  "sent",
  "failed",
  "cancelled",
]);
export const privateMediaPurposeEnum = pgEnum("private_media_purpose", [
  "model_label",
  "installed_fit",
  "broken_part_context",
]);
export const privateMediaSessionStatusEnum = pgEnum("private_media_session_status", [
  "issued",
  "uploaded",
  "processing",
  "processed",
  "rejected",
  "expired",
]);
export const privateMediaModerationStatusEnum = pgEnum("private_media_moderation_status", [
  "pending",
  "redaction_required",
  "approved_private",
  "rejected",
  "expired",
]);
export const privateMediaDerivativeKindEnum = pgEnum("private_media_derivative_kind", [
  "sanitized_master",
  "thumbnail",
  "redacted",
]);
export const staffRoleEnum = pgEnum("staff_role", ["editor", "reviewer", "admin"]);
export const staffStatusEnum = pgEnum("staff_status", ["invited", "active", "disabled"]);
export const importRunStatusEnum = pgEnum("import_run_status", ["committed", "failed"]);
export const importRowStatusEnum = pgEnum("import_row_status", ["candidate", "ambiguous", "rejected", "unchanged"]);
export const importCollisionTypeEnum = pgEnum("import_collision_type", [
  "duplicate_external_item",
  "model_ambiguous",
  "part_number_ambiguous",
  "supersession_cycle",
]);
export const importCollisionStatusEnum = pgEnum("import_collision_status", ["open", "resolved"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const staffProfiles = pgTable(
  "staff_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authUserId: uuid("auth_user_id").notNull(),
    email: text("email").notNull(),
    role: staffRoleEnum("role").notNull(),
    status: staffStatusEnum("status").notNull().default("invited"),
    mfaRequired: boolean("mfa_required").notNull().default(false),
    invitedById: uuid("invited_by_id").references((): AnyPgColumn => staffProfiles.id, {
      onDelete: "restrict",
    }),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("staff_profiles_auth_user_uq").on(table.authUserId),
    uniqueIndex("staff_profiles_email_uq").on(table.email),
    check(
      "staff_profiles_privileged_mfa_ck",
      sql`${table.role} = 'editor' OR ${table.mfaRequired} = true`,
    ),
  ],
);

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
    receiptId: uuid("receipt_id").notNull().defaultRandom(),
    kind: submissionKindEnum("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: submissionStatusEnum("status").notNull().default("pending"),
    intakeVersion: integer("intake_version").notNull().default(0),
    hmacVersion: text("hmac_version"),
    contributorKey: text("contributor_key"),
    contentFingerprint: text("content_fingerprint"),
    matchedEntityType: text("matched_entity_type"),
    matchedEntityId: uuid("matched_entity_id"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("submissions_queue_idx").on(table.status, table.kind, table.createdAt),
    uniqueIndex("submissions_receipt_id_uq").on(table.receiptId),
    uniqueIndex("submissions_intake_contract_uq")
      .on(table.id, table.kind, table.intakeVersion, table.hmacVersion, table.receiptId),
    uniqueIndex("submissions_active_contributor_content_uq")
      .on(table.kind, table.hmacVersion, table.contributorKey, table.contentFingerprint)
      .where(sql`${table.status} IN ('pending', 'in_review') AND ${table.contributorKey} IS NOT NULL`),
    index("submissions_content_fingerprint_idx")
      .on(table.kind, table.hmacVersion, table.contentFingerprint, table.createdAt),
    check("submissions_intake_version_ck", sql`${table.intakeVersion} IN (0, 1)`),
    check(
      "submissions_intake_contract_ck",
      sql`(
        ${table.intakeVersion} = 0
        AND ${table.hmacVersion} IS NULL
        AND ${table.contributorKey} IS NULL
        AND ${table.contentFingerprint} IS NULL
      ) OR (
        ${table.intakeVersion} = 1
        AND ${table.hmacVersion} IS NOT NULL
        AND ${table.contributorKey} IS NOT NULL
        AND ${table.contentFingerprint} IS NOT NULL
      )`,
    ),
    check("submissions_hmac_version_ck", sql`${table.hmacVersion} IS NULL OR char_length(${table.hmacVersion}) BETWEEN 1 AND 64`),
    check("submissions_contributor_key_ck", sql`${table.contributorKey} IS NULL OR ${table.contributorKey} ~ '^[0-9a-f]{64}$'`),
    check("submissions_content_fingerprint_ck", sql`${table.contentFingerprint} IS NULL OR ${table.contentFingerprint} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const submissionIdempotencyBindings = pgTable(
  "submission_idempotency_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: submissionKindEnum("kind").notNull(),
    idempotencyActorKey: text("idempotency_actor_key").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    submissionId: uuid("submission_id").notNull(),
    receiptId: uuid("receipt_id").notNull(),
    intakeVersion: integer("intake_version").notNull().default(1),
    hmacVersion: text("hmac_version").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    privacyConsent: boolean("privacy_consent").notNull(),
    contributionConsent: boolean("contribution_consent").notNull(),
    emailFollowUpConsent: boolean("email_follow_up_consent").notNull(),
    contributorTermsVersion: text("contributor_terms_version").notNull(),
    privacyNoticeVersion: text("privacy_notice_version").notNull(),
    contactConsentVersion: text("contact_consent_version").notNull(),
    retentionPolicyVersion: text("retention_policy_version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    challengeProvider: text("challenge_provider").notNull(),
    challengeVerifiedAt: timestamp("challenge_verified_at", { withTimezone: true }).notNull(),
    contactPresent: boolean("contact_present").notNull(),
    contactDigest: text("contact_digest"),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
    contactRetentionExpiresAt: timestamp("contact_retention_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("submission_idempotency_bindings_scope_uq")
      .on(table.kind, table.idempotencyActorKey, table.idempotencyKeyHash),
    uniqueIndex("submission_idempotency_bindings_id_submission_uq").on(table.id, table.submissionId),
    uniqueIndex("submission_idempotency_bindings_id_kind_uq").on(table.id, table.kind),
    uniqueIndex("submission_idempotency_bindings_contact_contract_uq")
      .on(table.id, table.contactPresent, table.contactDigest),
    index("submission_idempotency_bindings_submission_idx").on(table.submissionId, table.acceptedAt, table.id),
    index("submission_idempotency_bindings_retention_idx").on(table.retentionExpiresAt, table.id),
    index("submission_idempotency_bindings_contact_retention_idx")
      .on(table.contactRetentionExpiresAt, table.id)
      .where(sql`${table.contactRetentionExpiresAt} IS NOT NULL`),
    foreignKey({
      columns: [table.submissionId, table.kind, table.intakeVersion, table.hmacVersion, table.receiptId],
      foreignColumns: [
        submissions.id,
        submissions.kind,
        submissions.intakeVersion,
        submissions.hmacVersion,
        submissions.receiptId,
      ],
      name: "submission_idempotency_bindings_submission_contract_fk",
    }).onDelete("restrict"),
    check("submission_idempotency_bindings_intake_version_ck", sql`${table.intakeVersion} = 1`),
    check("submission_idempotency_bindings_hashes_ck", sql`
      ${table.idempotencyActorKey} ~ '^[0-9a-f]{64}$'
      AND ${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'
      AND ${table.requestFingerprint} ~ '^[0-9a-f]{64}$'
      AND (${table.contactDigest} IS NULL OR ${table.contactDigest} ~ '^[0-9a-f]{64}$')
    `),
    check(
      "submission_idempotency_bindings_required_consent_ck",
      sql`${table.privacyConsent} AND ${table.contributionConsent}
        AND (NOT ${table.contactPresent} OR ${table.emailFollowUpConsent})`,
    ),
    check("submission_idempotency_bindings_challenge_ck", sql`${table.challengeProvider} = 'turnstile'`),
    check("submission_idempotency_bindings_retention_ck", sql`
      ${table.retentionExpiresAt} > ${table.acceptedAt}
      AND (
        (${table.contactPresent} = false AND ${table.contactDigest} IS NULL AND ${table.contactRetentionExpiresAt} IS NULL)
        OR
        (${table.contactPresent} = true AND ${table.contactDigest} IS NOT NULL
          AND ${table.contactRetentionExpiresAt} > ${table.acceptedAt}
          AND ${table.contactRetentionExpiresAt} <= ${table.retentionExpiresAt})
      )
    `),
  ],
);

export const submissionIntakeContacts = pgTable(
  "submission_intake_contacts",
  {
    intakeId: uuid("intake_id").primaryKey(),
    contactPresent: boolean("contact_present").notNull().default(true),
    contactDigest: text("contact_digest").notNull(),
    contactEmail: text("contact_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.intakeId, table.contactPresent, table.contactDigest],
      foreignColumns: [
        submissionIdempotencyBindings.id,
        submissionIdempotencyBindings.contactPresent,
        submissionIdempotencyBindings.contactDigest,
      ],
      name: "submission_intake_contacts_binding_fk",
    }).onDelete("cascade"),
    check("submission_intake_contacts_present_ck", sql`${table.contactPresent}`),
    check("submission_intake_contacts_digest_ck", sql`${table.contactDigest} ~ '^[0-9a-f]{64}$'`),
    check("submission_intake_contacts_email_length_ck", sql`char_length(${table.contactEmail}) BETWEEN 3 AND 320`),
  ],
);

export const submissionHmacKeyPin = pgTable(
  "submission_hmac_key_pin",
  {
    singleton: boolean("singleton").primaryKey().notNull().default(true),
    hmacVersion: text("hmac_version").notNull().unique(),
    keyCommitment: text("key_commitment").notNull(),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("submission_hmac_key_pin_singleton_ck", sql`${table.singleton}`),
    check("submission_hmac_key_pin_commitment_ck", sql`${table.keyCommitment} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const submissionRateLimitBuckets = pgTable(
  "submission_rate_limit_buckets",
  {
    scope: text("scope").notNull(),
    subjectHash: text("subject_hash").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    requestCount: integer("request_count").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.subjectHash, table.windowStartedAt, table.windowSeconds] }),
    index("submission_rate_limit_buckets_expiry_idx").on(table.expiresAt),
    check("submission_rate_limit_buckets_window_ck", sql`${table.windowSeconds} > 0`),
    check("submission_rate_limit_buckets_count_ck", sql`${table.requestCount} >= 1`),
    check("submission_rate_limit_buckets_expiry_ck", sql`${table.expiresAt} > ${table.windowStartedAt}`),
  ],
);

export const submissionEmailFollowUps = pgTable(
  "submission_email_follow_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intakeId: uuid("intake_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    followUpKey: text("follow_up_key").notNull(),
    qualifyingEvent: text("qualifying_event").notNull(),
    templateKey: text("template_key").notNull(),
    status: submissionEmailStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    providerMessageId: text("provider_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("submission_email_follow_ups_key_uq").on(table.followUpKey),
    index("submission_email_follow_ups_worker_idx").on(table.status, table.availableAt, table.leaseExpiresAt, table.createdAt),
    foreignKey({
      columns: [table.intakeId, table.submissionId],
      foreignColumns: [submissionIdempotencyBindings.id, submissionIdempotencyBindings.submissionId],
      name: "submission_email_follow_ups_intake_fk",
    }).onDelete("restrict"),
    check("submission_email_follow_ups_attempt_count_ck", sql`${table.attemptCount} >= 0`),
    check(
      "submission_email_follow_ups_lease_ck",
      sql`(${table.status} = 'processing') = (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "submission_email_follow_ups_sent_ck",
      sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`,
    ),
    check(
      "submission_email_follow_ups_event_ck",
      sql`${table.qualifyingEvent} IN ('matching_publication', 'moderator_question')`,
    ),
    check(
      "submission_email_follow_ups_event_template_ck",
      sql`(${table.qualifyingEvent} = 'matching_publication' AND ${table.templateKey} = 'missing-part-match-alert')
        OR (${table.qualifyingEvent} = 'moderator_question' AND ${table.templateKey} = 'moderator-follow-up')`,
    ),
  ],
);

export const privateMediaUploadSessions = pgTable(
  "private_media_upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    intakeId: uuid("intake_id").notNull(),
    kind: submissionKindEnum("kind").notNull(),
    purpose: privateMediaPurposeEnum("purpose").notNull(),
    quarantineObjectPath: text("quarantine_object_path").notNull(),
    claimedMimeType: text("claimed_mime_type").notNull(),
    claimedExtension: text("claimed_extension").notNull(),
    claimedBytes: integer("claimed_bytes").notNull(),
    status: privateMediaSessionStatusEnum("status").notNull().default("issued"),
    capabilityNonceHash: text("capability_nonce_hash").notNull(),
    capabilityExpiresAt: timestamp("capability_expires_at", { withTimezone: true }).notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    processingLeaseToken: uuid("processing_lease_token"),
    processingLeaseExpiresAt: timestamp("processing_lease_expires_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    terminalErrorCode: text("terminal_error_code"),
    cleanupLeaseToken: uuid("cleanup_lease_token"),
    cleanupLeaseExpiresAt: timestamp("cleanup_lease_expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("private_media_upload_sessions_public_id_uq").on(table.publicId),
    uniqueIndex("private_media_upload_sessions_intake_purpose_uq").on(table.intakeId, table.purpose),
    uniqueIndex("private_media_upload_sessions_id_intake_uq").on(table.id, table.intakeId),
    uniqueIndex("private_media_upload_sessions_quarantine_path_uq").on(table.quarantineObjectPath),
    index("private_media_upload_sessions_cleanup_idx").on(table.status, table.capabilityExpiresAt, table.id),
    foreignKey({
      columns: [table.intakeId, table.kind],
      foreignColumns: [submissionIdempotencyBindings.id, submissionIdempotencyBindings.kind],
      name: "private_media_upload_sessions_intake_fk",
    }).onDelete("restrict"),
    check("private_media_upload_sessions_public_id_ck", sql`${table.publicId} ~ '^media_[A-Za-z0-9_-]{22,120}$'`),
    check("private_media_upload_sessions_path_ck", sql`${table.quarantineObjectPath} ~ '^quarantine/[0-9a-f]{2}/[A-Za-z0-9_-]{22,128}$'`),
    check("private_media_upload_sessions_mime_ck", sql`${table.claimedMimeType} IN ('image/jpeg','image/png','image/webp','image/avif')`),
    check("private_media_upload_sessions_extension_ck", sql`${table.claimedExtension} IN ('jpg','jpeg','png','webp','avif')`),
    check("private_media_upload_sessions_bytes_ck", sql`${table.claimedBytes} BETWEEN 1 AND 10485760`),
    check("private_media_upload_sessions_nonce_ck", sql`${table.capabilityNonceHash} ~ '^[0-9a-f]{64}$'`),
    check("private_media_upload_sessions_lease_ck", sql`
      (${table.status} = 'processing') = (${table.processingLeaseToken} IS NOT NULL AND ${table.processingLeaseExpiresAt} IS NOT NULL)
    `),
    check("private_media_upload_sessions_cleanup_lease_ck", sql`
      (${table.cleanupLeaseToken} IS NULL) = (${table.cleanupLeaseExpiresAt} IS NULL)
    `),
  ],
);

export const privateMediaConsents = pgTable(
  "private_media_consents",
  {
    sessionId: uuid("session_id").primaryKey(),
    intakeId: uuid("intake_id").notNull(),
    ownsOrHasPermission: boolean("owns_or_has_permission").notNull(),
    privateStorageConsent: boolean("private_storage_consent").notNull(),
    derivativeProcessingConsent: boolean("derivative_processing_consent").notNull(),
    publicDisplayConsent: boolean("public_display_consent").notNull().default(false),
    termsVersion: text("terms_version").notNull(),
    privacyVersion: text("privacy_version").notNull(),
    retentionVersion: text("retention_version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    retentionDeadline: timestamp("retention_deadline", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.sessionId, table.intakeId],
      foreignColumns: [privateMediaUploadSessions.id, privateMediaUploadSessions.intakeId],
      name: "private_media_consents_session_fk",
    }).onDelete("restrict"),
    check("private_media_consents_required_ck", sql`${table.ownsOrHasPermission} AND ${table.privateStorageConsent} AND ${table.derivativeProcessingConsent}`),
    check("private_media_consents_retention_ck", sql`${table.retentionDeadline} > ${table.acceptedAt}`),
  ],
);

export const privateMediaAssets = pgTable(
  "private_media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    intakeId: uuid("intake_id").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    detectedMimeType: text("detected_mime_type").notNull(),
    sourceBytes: integer("source_bytes").notNull(),
    sourceWidth: integer("source_width").notNull(),
    sourceHeight: integer("source_height").notNull(),
    moderationStatus: privateMediaModerationStatusEnum("moderation_status").notNull().default("pending"),
    moderationReason: text("moderation_reason"),
    reviewedBy: uuid("reviewed_by").references(() => staffProfiles.id, { onDelete: "restrict" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    retentionDeadline: timestamp("retention_deadline", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("private_media_assets_session_uq").on(table.sessionId),
    uniqueIndex("private_media_assets_intake_checksum_uq").on(table.intakeId, table.checksumSha256),
    index("private_media_assets_retention_idx").on(table.retentionDeadline, table.id),
    foreignKey({
      columns: [table.sessionId, table.intakeId],
      foreignColumns: [privateMediaUploadSessions.id, privateMediaUploadSessions.intakeId],
      name: "private_media_assets_session_fk",
    }).onDelete("restrict"),
    check("private_media_assets_checksum_ck", sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    check("private_media_assets_mime_ck", sql`${table.detectedMimeType} IN ('image/jpeg','image/png','image/webp','image/avif')`),
    check("private_media_assets_dimensions_ck", sql`${table.sourceBytes} BETWEEN 1 AND 10485760 AND ${table.sourceWidth} BETWEEN 1 AND 12000 AND ${table.sourceHeight} BETWEEN 1 AND 12000 AND ${table.sourceWidth}::bigint * ${table.sourceHeight}::bigint <= 40000000`),
  ],
);

export const privateMediaDerivatives = pgTable(
  "private_media_derivatives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => privateMediaAssets.id, { onDelete: "restrict" }),
    kind: privateMediaDerivativeKindEnum("kind").notNull(),
    objectPath: text("object_path").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("private_media_derivatives_asset_kind_uq").on(table.assetId, table.kind),
    uniqueIndex("private_media_derivatives_object_path_uq").on(table.objectPath),
    check("private_media_derivatives_path_ck", sql`${table.objectPath} ~ '^private/[0-9a-f]{2}/[A-Za-z0-9_-]{22,128}/(master|thumbnail|redacted)-[0-9a-f]{64}\\.webp$'`),
    check("private_media_derivatives_checksum_ck", sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    check("private_media_derivatives_mime_ck", sql`${table.mimeType} = 'image/webp'`),
  ],
);

export const privateMediaRedactions = pgTable(
  "private_media_redactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => privateMediaAssets.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    rectangles: jsonb("rectangles").$type<Array<{ x: number; y: number; width: number; height: number }>>().notNull(),
    rectanglesHash: text("rectangles_hash").notNull(),
    derivativeId: uuid("derivative_id").notNull().references(() => privateMediaDerivatives.id, { onDelete: "restrict" }),
    staffId: uuid("staff_id").notNull().references(() => staffProfiles.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("private_media_redactions_asset_version_uq").on(table.assetId, table.version),
    check("private_media_redactions_version_ck", sql`${table.version} >= 1`),
    check("private_media_redactions_hash_ck", sql`${table.rectanglesHash} ~ '^[0-9a-f]{64}$'`),
    check("private_media_redactions_reason_ck", sql`char_length(btrim(${table.reason})) BETWEEN 8 AND 1000`),
  ],
);

export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    actorId: uuid("actor_id").notNull().references(() => staffProfiles.id, { onDelete: "restrict" }),
    inputChecksum: text("input_checksum").notNull(),
    manifestChecksum: text("manifest_checksum"),
    status: importRunStatusEnum("status").notNull(),
    report: jsonb("report").$type<Record<string, unknown>>().notNull(),
    reason: text("reason").notNull(),
    requestId: text("request_id").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("import_runs_public_id_uq").on(table.publicId),
    uniqueIndex("import_runs_input_checksum_uq").on(table.inputChecksum),
    index("import_runs_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importRunId: uuid("import_run_id").notNull().references(() => importRuns.id, { onDelete: "restrict" }),
    fileName: text("file_name").notNull(),
    rowNumber: integer("row_number").notNull(),
    recordType: text("record_type").notNull(),
    externalKey: text("external_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, string>>().notNull(),
    status: importRowStatusEnum("status").notNull(),
    errorCodes: jsonb("error_codes").$type<string[]>().notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("import_rows_run_file_row_uq").on(table.importRunId, table.fileName, table.rowNumber),
    uniqueIndex("import_rows_idempotency_uq").on(table.idempotencyKey),
    index("import_rows_queue_idx").on(table.status, table.recordType, table.createdAt),
  ],
);

export const importCollisions = pgTable(
  "import_collisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importRunId: uuid("import_run_id").notNull().references(() => importRuns.id, { onDelete: "restrict" }),
    importRowId: uuid("import_row_id").notNull().references(() => importRows.id, { onDelete: "restrict" }),
    collisionType: importCollisionTypeEnum("collision_type").notNull(),
    collisionKey: text("collision_key").notNull(),
    conflictingKeys: jsonb("conflicting_keys").$type<string[]>().notNull(),
    status: importCollisionStatusEnum("status").notNull().default("open"),
    resolutionReason: text("resolution_reason"),
    resolvedBy: uuid("resolved_by").references(() => staffProfiles.id, { onDelete: "restrict" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("import_collisions_row_type_key_uq").on(table.importRowId, table.collisionType, table.collisionKey),
    index("import_collisions_queue_idx").on(table.status, table.collisionType, table.createdAt),
  ],
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
    actorId: uuid("actor_id").notNull().references(() => staffProfiles.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_log_entity_idx").on(table.entityType, table.entityId, table.createdAt)],
);
