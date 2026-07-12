import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { StaffIdentity } from "@/domain/authorization";
import {
  evaluateIndependentReview,
  evaluatePublicationTransition,
  evaluateSubmissionTransition,
  validateArchiveRedirect,
} from "@/domain/editorial-workflow";
import { evaluateFitmentEvidence } from "@/domain/fitment";
import { evaluatePublishability } from "@/domain/publishability";
import { CURRENT_FITMENT_RULESET, CURRENT_SAFETY_RULESET } from "@/domain/rulesets";
import { looseIdentifierKey, slugify, strictIdentifierKey } from "@/domain/normalization";
import type { FitmentEvidence as DomainFitmentEvidence, PublishabilityDecision } from "@/domain/types";
import type {
  ArchiveFitmentInput,
  CatalogTargetDraftInput,
  ModerateEvidenceInput,
  PrepareCreatorCaseInput,
  PublishCaseInput,
  ReviewCreatorCaseInput,
} from "@/lib/admin-schemas";
import { designSubmissionSchema, storedHttpUrlSchema } from "@/lib/submission-schemas";
import { writeAuditEvent } from "./audit";
import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

export class EditorialWorkflowError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(code);
  }
}

export interface EditorialQueueItem {
  id: string;
  kind: string;
  status: string;
  createdAt: Date;
  matchedEntityType: string | null;
  matchedEntityId: string | null;
  payload: Record<string, unknown>;
  demandCount: number;
  intakes: Array<{
    id: string;
    acceptedAt: Date;
    payload: Record<string, unknown>;
  }>;
}

export async function listEditorialQueue(database: Database): Promise<{
  submissions: EditorialQueueItem[];
  targets: Array<{
    productComponentId: string;
    modelPublicId: string;
    modelName: string;
    modelSlug: string;
    brandName: string;
    componentName: string;
    oemPartNumber: string | null;
  }>;
  collisions: Array<{ id: string; type: string; key: string; conflictingKeys: string[]; createdAt: Date }>;
  catalog: {
    brands: Array<{ id: string; name: string }>;
    categories: Array<{ id: string; name: string }>;
    components: Array<{ id: string; name: string; categoryId: string }>;
    sources: Array<{ id: string; title: string; url: string }>;
  };
}> {
  const [submissionRows, intakeRows, demandRows, targets, collisions, brandRows, categoryRows, componentRows, sourceRows] = await Promise.all([
    database
      .select({
        id: schema.submissions.id,
        kind: schema.submissions.kind,
        status: schema.submissions.status,
        createdAt: schema.submissions.createdAt,
        matchedEntityType: schema.submissions.matchedEntityType,
        matchedEntityId: schema.submissions.matchedEntityId,
        payload: schema.submissions.payload,
        contentFingerprint: schema.submissions.contentFingerprint,
      })
      .from(schema.submissions)
      .where(inArray(schema.submissions.status, ["pending", "in_review", "accepted", "rejected"]))
      .orderBy(desc(schema.submissions.createdAt)),
    database
      .select({
        acceptedAt: schema.submissionIdempotencyBindings.acceptedAt,
        id: schema.submissionIdempotencyBindings.id,
        payload: schema.submissionIdempotencyBindings.payload,
        submissionId: schema.submissionIdempotencyBindings.submissionId,
      })
      .from(schema.submissionIdempotencyBindings)
      .where(gt(schema.submissionIdempotencyBindings.retentionExpiresAt, sql`CURRENT_TIMESTAMP`))
      .orderBy(asc(schema.submissionIdempotencyBindings.acceptedAt), asc(schema.submissionIdempotencyBindings.id)),
    database
      .select({
        contentFingerprint: schema.submissions.contentFingerprint,
        demandCount: sql<number>`count(DISTINCT ${schema.submissions.contributorKey})::int`,
      })
      .from(schema.submissions)
      .where(and(
        eq(schema.submissions.kind, "missing_part"),
        inArray(schema.submissions.status, ["pending", "in_review"]),
        sql`${schema.submissions.contentFingerprint} IS NOT NULL`,
      ))
      .groupBy(schema.submissions.contentFingerprint),
    database
      .select({
        productComponentId: schema.productComponents.id,
        modelPublicId: schema.productModels.publicId,
        modelName: schema.productModels.modelName,
        modelSlug: schema.productModels.slug,
        brandName: schema.brands.name,
        componentName: schema.components.name,
        oemPartNumber: schema.oemParts.partNumberDisplay,
      })
      .from(schema.productComponents)
      .innerJoin(schema.productModels, eq(schema.productComponents.productModelId, schema.productModels.id))
      .innerJoin(schema.brands, eq(schema.productModels.brandId, schema.brands.id))
      .innerJoin(schema.components, eq(schema.productComponents.componentId, schema.components.id))
      .leftJoin(schema.oemParts, eq(schema.productComponents.oemPartId, schema.oemParts.id))
      .orderBy(schema.brands.name, schema.productModels.modelName, schema.components.name),
    database
      .select({
        id: schema.importCollisions.id,
        type: schema.importCollisions.collisionType,
        key: schema.importCollisions.collisionKey,
        conflictingKeys: schema.importCollisions.conflictingKeys,
        createdAt: schema.importCollisions.createdAt,
      })
      .from(schema.importCollisions)
      .where(eq(schema.importCollisions.status, "open"))
      .orderBy(desc(schema.importCollisions.createdAt)),
    database.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands).orderBy(schema.brands.name),
    database.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories).orderBy(schema.categories.name),
    database.select({ id: schema.components.id, name: schema.components.name, categoryId: schema.components.categoryId }).from(schema.components).orderBy(schema.components.name),
    database.select({ id: schema.sources.id, title: schema.sources.title, url: schema.sources.canonicalUrl }).from(schema.sources).orderBy(desc(schema.sources.createdAt)),
  ]);

  const demandByFingerprint = new Map(
    demandRows.map((row) => [row.contentFingerprint, row.demandCount]),
  );
  const intakesBySubmission = new Map<string, typeof intakeRows>();
  for (const intake of intakeRows) {
    const existing = intakesBySubmission.get(intake.submissionId) ?? [];
    existing.push(intake);
    intakesBySubmission.set(intake.submissionId, existing);
  }

  return {
    submissions: submissionRows.map(({ contentFingerprint, ...row }) => {
      const intakes = (intakesBySubmission.get(row.id) ?? []).map((intake) => ({
        acceptedAt: intake.acceptedAt,
        id: intake.id,
        payload: redactPrivatePayload(intake.payload),
      }));
      return {
        ...row,
        demandCount: contentFingerprint && (row.status === "pending" || row.status === "in_review")
        ? (demandByFingerprint.get(contentFingerprint) ?? 1)
        : 1,
        intakes,
        payload: intakes[0]?.payload ?? redactPrivatePayload(row.payload),
      };
    }),
    targets,
    collisions,
    catalog: { brands: brandRows, categories: categoryRows, components: componentRows, sources: sourceRows },
  };
}

export async function getSubmissionEvidenceLink(
  database: Database,
  submissionId: string,
  intakeId?: string,
): Promise<Readonly<{ evidenceUrl: string; intakeId: string; submissionId: string }>> {
  const [submission] = await database
    .select({
      intakeId: schema.submissionIdempotencyBindings.id,
      kind: schema.submissions.kind,
      payload: schema.submissionIdempotencyBindings.payload,
    })
    .from(schema.submissionIdempotencyBindings)
    .innerJoin(schema.submissions, eq(schema.submissions.id, schema.submissionIdempotencyBindings.submissionId))
    .where(and(
      eq(schema.submissions.id, submissionId),
      intakeId ? eq(schema.submissionIdempotencyBindings.id, intakeId) : undefined,
      gt(schema.submissionIdempotencyBindings.retentionExpiresAt, sql`CURRENT_TIMESTAMP`),
    ))
    .orderBy(asc(schema.submissionIdempotencyBindings.acceptedAt))
    .limit(1);
  if (!submission || submission.kind !== "fit_confirmation") {
    throw new EditorialWorkflowError("SUBMISSION_EVIDENCE_NOT_FOUND");
  }
  const evidenceUrl = storedHttpUrlSchema.safeParse(submission.payload.evidenceUrl);
  if (!evidenceUrl.success) throw new EditorialWorkflowError("SUBMISSION_EVIDENCE_NOT_FOUND");
  return Object.freeze({ evidenceUrl: evidenceUrl.data, intakeId: submission.intakeId, submissionId });
}

export async function createCatalogTargetDraft(
  database: Database,
  actor: StaffIdentity,
  input: CatalogTargetDraftInput,
): Promise<{ productModelId: string; componentId: string; oemPartId: string | null; productComponentId: string }> {
  return database.transaction(async (transaction) => {
    const [brand] = await transaction.select({ id: schema.brands.id }).from(schema.brands).where(eq(schema.brands.id, input.brandId)).limit(1);
    const [category] = await transaction.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.id, input.categoryId)).limit(1);
    const [source] = await transaction.select({ id: schema.sources.id }).from(schema.sources).where(eq(schema.sources.id, input.sourceId)).limit(1);
    if (!brand || !category || !source) throw new EditorialWorkflowError("CATALOG_REFERENCE_NOT_FOUND");

    const strictKey = strictIdentifierKey(input.identifierDisplay);
    const looseKey = looseIdentifierKey(input.identifierDisplay);
    const modelCollisions = await transaction
      .select({ id: schema.productModels.id })
      .from(schema.productIdentifiers)
      .innerJoin(schema.productModels, eq(schema.productIdentifiers.productModelId, schema.productModels.id))
      .where(and(eq(schema.productModels.brandId, input.brandId), or(eq(schema.productIdentifiers.strictKey, strictKey), eq(schema.productIdentifiers.looseKey, looseKey))));
    if (modelCollisions.length) throw new EditorialWorkflowError("MODEL_AMBIGUOUS");

    const [model] = await transaction
      .insert(schema.productModels)
      .values({
        publicId: input.modelPublicId,
        brandId: input.brandId,
        categoryId: input.categoryId,
        modelName: input.modelName,
        slug: input.modelSlug,
        marketCodes: input.marketCodes,
        publicationStatus: "draft",
      })
      .returning({ id: schema.productModels.id });
    if (!model) throw new EditorialWorkflowError("MODEL_WRITE_FAILED");

    const [identifier] = await transaction
      .insert(schema.productIdentifiers)
      .values({
        productModelId: model.id,
        displayValue: input.identifierDisplay,
        strictKey,
        looseKey,
        identifierType: input.identifierType,
      })
      .returning({ id: schema.productIdentifiers.id });
    if (!identifier) throw new EditorialWorkflowError("IDENTIFIER_WRITE_FAILED");

    let componentId: string;
    if (input.component.mode === "existing") {
      const [component] = await transaction
        .select({ id: schema.components.id, categoryId: schema.components.categoryId })
        .from(schema.components)
        .where(eq(schema.components.id, input.component.id))
        .limit(1);
      if (!component || component.categoryId !== input.categoryId) throw new EditorialWorkflowError("COMPONENT_CATEGORY_MISMATCH");
      componentId = component.id;
    } else {
      const [component] = await transaction
        .insert(schema.components)
        .values({ categoryId: input.categoryId, name: input.component.name, slug: input.component.slug, commonNames: input.component.commonNames })
        .returning({ id: schema.components.id });
      if (!component) throw new EditorialWorkflowError("COMPONENT_WRITE_FAILED");
      componentId = component.id;
    }

    let oemPartId: string | null = null;
    if (input.oem.mode === "new") {
      const oemStrict = strictIdentifierKey(input.oem.partNumberDisplay);
      const oemLoose = looseIdentifierKey(input.oem.partNumberDisplay);
      const oemCollisions = await transaction
        .select({ id: schema.oemParts.id })
        .from(schema.oemParts)
        .where(and(eq(schema.oemParts.brandId, input.brandId), or(eq(schema.oemParts.strictPartKey, oemStrict), eq(schema.oemParts.loosePartKey, oemLoose))));
      if (oemCollisions.length) throw new EditorialWorkflowError("PART_NUMBER_AMBIGUOUS");
      const [oem] = await transaction
        .insert(schema.oemParts)
        .values({
          publicId: input.oem.publicId,
          brandId: input.brandId,
          componentId,
          partNumberDisplay: input.oem.partNumberDisplay,
          strictPartKey: oemStrict,
          loosePartKey: oemLoose,
          name: input.oem.name,
          publicationStatus: "draft",
        })
        .returning({ id: schema.oemParts.id });
      if (!oem) throw new EditorialWorkflowError("OEM_WRITE_FAILED");
      oemPartId = oem.id;
    }

    const [productComponent] = await transaction
      .insert(schema.productComponents)
      .values({ productModelId: model.id, componentId, oemPartId, mappingStatus: "pending" })
      .returning({ id: schema.productComponents.id });
    if (!productComponent) throw new EditorialWorkflowError("PRODUCT_COMPONENT_WRITE_FAILED");

    await transaction.insert(schema.sourceCitations).values([
      {
        sourceId: input.sourceId,
        entityType: "product_model",
        entityId: model.id,
        fieldPath: "model_name",
        claimValue: input.modelName,
        locator: input.sourceLocator,
        extractionMethod: "editorial",
        reviewStatus: "pending" as const,
      },
      {
        sourceId: input.sourceId,
        entityType: "product_identifier",
        entityId: identifier.id,
        fieldPath: "display_value",
        claimValue: input.identifierDisplay,
        locator: input.sourceLocator,
        extractionMethod: "editorial",
        reviewStatus: "pending" as const,
      },
      {
        sourceId: input.sourceId,
        entityType: "product_component",
        entityId: productComponent.id,
        fieldPath: "mapping",
        claimValue: { productModelId: model.id, componentId, oemPartId },
        locator: input.sourceLocator,
        extractionMethod: "editorial",
        reviewStatus: "pending" as const,
      },
    ]);

    await writeAuditEvent(
      {
        actorId: actor.id,
        action: "catalog.target.prepare",
        entityType: "product_component",
        entityId: productComponent.id,
        before: null,
        after: { productModelId: model.id, identifierId: identifier.id, componentId, oemPartId, mappingStatus: "pending", publicationStatus: "draft" },
        reason: input.reason,
        requestId: input.requestId,
      },
      transaction,
    );
    return { productModelId: model.id, componentId, oemPartId, productComponentId: productComponent.id };
  });
}

export async function prepareCreatorSubmission(
  database: Database,
  submissionId: string,
  actor: StaffIdentity,
  input: PrepareCreatorCaseInput,
): Promise<{ submissionId: string; designId: string; fitmentId: string }> {
  return database.transaction(async (transaction) => {
    const [submission] = await transaction
      .select()
      .from(schema.submissions)
      .where(eq(schema.submissions.id, submissionId))
      .limit(1);
    if (!submission || submission.kind !== "design_submission") throw new EditorialWorkflowError("SUBMISSION_NOT_FOUND");
    if (submission.status === "in_review" && submission.matchedEntityType === "design" && submission.matchedEntityId) {
      const [existingFitment] = await transaction
        .select({ id: schema.fitments.id })
        .from(schema.fitments)
        .innerJoin(schema.designRevisions, eq(schema.fitments.designRevisionId, schema.designRevisions.id))
        .where(eq(schema.designRevisions.designId, submission.matchedEntityId))
        .limit(1);
      if (!existingFitment) throw new EditorialWorkflowError("PREPARED_CASE_INCOMPLETE");
      return { submissionId, designId: submission.matchedEntityId, fitmentId: existingFitment.id };
    }
    assertDecision(evaluateSubmissionTransition(submission.status, "in_review", actor.role));
    const [representativeIntake] = await transaction
      .select({ payload: schema.submissionIdempotencyBindings.payload })
      .from(schema.submissionIdempotencyBindings)
      .where(and(
        eq(schema.submissionIdempotencyBindings.submissionId, submissionId),
        gt(schema.submissionIdempotencyBindings.retentionExpiresAt, sql`CURRENT_TIMESTAMP`),
      ))
      .orderBy(asc(schema.submissionIdempotencyBindings.acceptedAt), asc(schema.submissionIdempotencyBindings.id))
      .limit(1)
      .for("update");
    if (submission.intakeVersion === 1 && !representativeIntake) {
      throw new EditorialWorkflowError("SUBMISSION_INTAKE_NOT_FOUND");
    }
    const payload = designSubmissionSchema.parse(
      submission.intakeVersion === 1 ? representativeIntake?.payload : submission.payload,
    );

    const [target] = await transaction
      .select({
        productComponentId: schema.productComponents.id,
        productModelId: schema.productModels.id,
        modelName: schema.productModels.modelName,
        modelSlug: schema.productModels.slug,
        brandId: schema.brands.id,
        brandName: schema.brands.name,
        componentName: schema.components.name,
      })
      .from(schema.productComponents)
      .innerJoin(schema.productModels, eq(schema.productComponents.productModelId, schema.productModels.id))
      .innerJoin(schema.brands, eq(schema.productModels.brandId, schema.brands.id))
      .innerJoin(schema.components, eq(schema.productComponents.componentId, schema.components.id))
      .where(eq(schema.productComponents.id, input.productComponentId))
      .limit(1);
    if (!target) throw new EditorialWorkflowError("EXACT_TARGET_NOT_FOUND");

    const identifiers = await transaction
      .select({ display: schema.productIdentifiers.displayValue })
      .from(schema.productIdentifiers)
      .where(eq(schema.productIdentifiers.productModelId, target.productModelId));
    if (!identifiers.some((identifier) => strictIdentifierKey(identifier.display) === strictIdentifierKey(payload.modelNumber))) {
      throw new EditorialWorkflowError("EXACT_TARGET_MISMATCH");
    }
    if (slugify(target.brandName) !== slugify(payload.brand)) throw new EditorialWorkflowError("EXACT_TARGET_MISMATCH");

    const [policy] = await transaction
      .select({ platform: schema.sourcePlatformPolicies.platform })
      .from(schema.sourcePlatformPolicies)
      .where(eq(schema.sourcePlatformPolicies.platform, input.sourcePlatform))
      .limit(1);
    if (!policy) throw new EditorialWorkflowError("SOURCE_POLICY_MISSING");

    const [duplicateSource] = await transaction
      .select({ id: schema.sources.id })
      .from(schema.sources)
      .where(eq(schema.sources.canonicalUrl, payload.sourceUrl))
      .limit(1);
    if (duplicateSource) throw new EditorialWorkflowError("DUPLICATE_EXTERNAL_ITEM");

    let [creator] = await transaction
      .select({ id: schema.creators.id })
      .from(schema.creators)
      .where(and(eq(schema.creators.platform, input.creatorPlatform), eq(schema.creators.displayName, payload.creatorName)))
      .limit(1);
    if (!creator) {
      [creator] = await transaction
        .insert(schema.creators)
        .values({ displayName: payload.creatorName, platform: input.creatorPlatform })
        .returning({ id: schema.creators.id });
    }
    if (!creator) throw new EditorialWorkflowError("CREATOR_WRITE_FAILED");

    const now = new Date();
    const suffix = submissionId.replace(/-/g, "").slice(0, 12);
    const [source] = await transaction
      .insert(schema.sources)
      .values({
        sourceType: "creator_submission",
        platform: input.sourcePlatform,
        canonicalUrl: payload.sourceUrl,
        publisher: payload.creatorName,
        title: input.sourceTitle,
        retrievedAt: now,
        lastCheckedAt: now,
        rightsNotes: "Creator-submitted landing page; publication still requires reviewer rights approval.",
      })
      .returning({ id: schema.sources.id });
    if (!source) throw new EditorialWorkflowError("SOURCE_WRITE_FAILED");

    const designSlug = slugify(`${target.brandName}-${target.modelName}-${target.componentName}-${suffix}`);
    const [design] = await transaction
      .insert(schema.designs)
      .values({
        publicId: `dsn_${suffix}`,
        slug: designSlug,
        creatorId: creator.id,
        title: input.designTitle,
        summary: payload.notes || "Creator-submitted candidate awaiting editorial review.",
        publicationStatus: "draft",
      })
      .returning({ id: schema.designs.id });
    if (!design) throw new EditorialWorkflowError("DESIGN_WRITE_FAILED");

    const [revision] = await transaction
      .insert(schema.designRevisions)
      .values({
        designId: design.id,
        sourceId: source.id,
        sourceRevision: input.sourceRevision,
        sourceExternalId: input.sourceExternalId,
        licenseCode: input.licenseCode,
        licenseVersion: input.licenseVersion || null,
        licenseUrl: input.licenseUrl || null,
        licenseEvidenceUrl: input.licenseEvidenceUrl || null,
        attributionText: input.attributionText,
        fileFormats: input.fileFormats,
        rightsCheckedAt: now,
      })
      .returning({ id: schema.designRevisions.id });
    if (!revision) throw new EditorialWorkflowError("REVISION_WRITE_FAILED");

    const [citation] = await transaction
      .insert(schema.sourceCitations)
      .values({
        sourceId: source.id,
        entityType: "design_revision",
        entityId: revision.id,
        fieldPath: "claimed_compatibility",
        claimValue: { brand: payload.brand, model: payload.modelNumber, component: payload.componentName },
        locator: "Creator submission",
        supportingExcerpt: payload.notes || null,
        extractionMethod: "creator_submission",
        reviewStatus: "pending",
      })
      .returning({ id: schema.sourceCitations.id });
    if (!citation) throw new EditorialWorkflowError("CITATION_WRITE_FAILED");

    const [fitment] = await transaction
      .insert(schema.fitments)
      .values({
        publicId: `fit_${suffix}`,
        slug: designSlug,
        designRevisionId: revision.id,
        productComponentId: target.productComponentId,
        confidenceLevel: "candidate_match",
        confidenceScore: 10,
        confidenceVersion: CURRENT_FITMENT_RULESET,
        publicationStatus: "draft",
        lastComputedAt: now,
      })
      .returning({ id: schema.fitments.id });
    if (!fitment) throw new EditorialWorkflowError("FITMENT_WRITE_FAILED");

    await transaction.insert(schema.fitmentEvidence).values({
      fitmentId: fitment.id,
      evidenceKind: "creator_claim",
      outcome: "fits_without_modification",
      sourceCitationId: citation.id,
      actorIndependenceKey: `creator:${creator.id}`,
      exactModel: true,
      exactDesignRevision: true,
      summary: input.evidenceSummary,
      observedAt: input.observedAt,
      moderationStatus: "pending",
    });

    await transaction
      .update(schema.submissions)
      .set({ status: "in_review", matchedEntityType: "design", matchedEntityId: design.id, reviewedAt: now })
      .where(eq(schema.submissions.id, submissionId));

    await writeAuditEvent(
      {
        actorId: actor.id,
        action: "editorial.case.prepare",
        entityType: "submission",
        entityId: submissionId,
        before: { status: submission.status, matchedEntityId: submission.matchedEntityId },
        after: { status: "in_review", designId: design.id, fitmentId: fitment.id, exactTargetConfirmed: true },
        reason: input.reason,
        requestId: input.requestId,
      },
      transaction,
    );
    return { submissionId, designId: design.id, fitmentId: fitment.id };
  });
}

export async function reviewCreatorSubmission(
  database: Database,
  submissionId: string,
  actor: StaffIdentity,
  input: ReviewCreatorCaseInput,
): Promise<{ submissionId: string; fitmentId: string | null; status: "accepted" | "rejected" }> {
  return database.transaction(async (transaction) => {
    const [submission] = await transaction.select().from(schema.submissions).where(eq(schema.submissions.id, submissionId)).limit(1);
    if (!submission || submission.status !== "in_review" || submission.matchedEntityType !== "design" || !submission.matchedEntityId) {
      throw new EditorialWorkflowError("CASE_NOT_READY_FOR_REVIEW");
    }
    const [prepared] = await transaction
      .select({ actorId: schema.auditLog.actorId })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityType, "submission"), eq(schema.auditLog.entityId, submissionId), eq(schema.auditLog.action, "editorial.case.prepare")))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(1);
    if (!prepared) throw new EditorialWorkflowError("PREPARATION_AUDIT_MISSING");
    assertDecision(evaluateIndependentReview(prepared.actorId, actor.id));

    const targetStatus = input.decision === "accept" ? "accepted" : "rejected";
    assertDecision(evaluateSubmissionTransition(submission.status, targetStatus, actor.role));

    const [fitment] = await transaction
      .select({ id: schema.fitments.id, productComponentId: schema.fitments.productComponentId })
      .from(schema.fitments)
      .innerJoin(schema.designRevisions, eq(schema.fitments.designRevisionId, schema.designRevisions.id))
      .where(eq(schema.designRevisions.designId, submission.matchedEntityId))
      .limit(1);

    const now = new Date();
    if (input.decision === "reject") {
      await transaction.update(schema.submissions).set({ status: "rejected", reviewedBy: actor.id, reviewedAt: now }).where(eq(schema.submissions.id, submissionId));
      await writeAuditEvent(
        {
          actorId: actor.id,
          action: "editorial.case.reject",
          entityType: "submission",
          entityId: submissionId,
          before: { status: submission.status },
          after: { status: "rejected", preparedRecordsRetainedAsDraft: true, fitmentId: fitment?.id ?? null },
          reason: input.reason,
          requestId: input.requestId,
        },
        transaction,
      );
      return { submissionId, fitmentId: fitment?.id ?? null, status: "rejected" };
    }
    if (!fitment) throw new EditorialWorkflowError("FITMENT_NOT_FOUND");

    const evidenceRows = await transaction.select().from(schema.fitmentEvidence).where(eq(schema.fitmentEvidence.fitmentId, fitment.id));
    if (evidenceRows.length === 0) throw new EditorialWorkflowError("EVIDENCE_NOT_FOUND");
    await transaction
      .update(schema.fitmentEvidence)
      .set({ moderationStatus: "accepted", reviewedBy: actor.id, reviewedAt: now, updatedAt: now })
      .where(eq(schema.fitmentEvidence.fitmentId, fitment.id));
    const [revision] = await transaction
      .select({ id: schema.designRevisions.id })
      .from(schema.designRevisions)
      .innerJoin(schema.fitments, eq(schema.fitments.designRevisionId, schema.designRevisions.id))
      .where(eq(schema.fitments.id, fitment.id))
      .limit(1);
    if (!revision) throw new EditorialWorkflowError("REVISION_NOT_FOUND");
    await transaction
      .update(schema.sourceCitations)
      .set({ reviewStatus: "accepted", reviewedBy: actor.id, reviewedAt: now, updatedAt: now })
      .where(and(eq(schema.sourceCitations.entityType, "design_revision"), eq(schema.sourceCitations.entityId, revision.id)));
    await transaction.update(schema.designRevisions).set({ rightsCheckedBy: actor.id, rightsCheckedAt: now, updatedAt: now }).where(eq(schema.designRevisions.id, revision.id));

    const [existingSafety] = await transaction
      .select({ id: schema.safetyReviews.id })
      .from(schema.safetyReviews)
      .where(and(eq(schema.safetyReviews.productComponentId, fitment.productComponentId), eq(schema.safetyReviews.rulesetVersion, CURRENT_SAFETY_RULESET)))
      .limit(1);
    if (existingSafety) {
      await transaction
        .update(schema.safetyReviews)
        .set({
          safetyClass: input.safetyClass,
          signals: input.safetySignals,
          failureConsequence: input.safetyClass === "low" ? "Inconvenience only" : "Requires specialist review",
          rationale: input.safetyRationale,
          reviewedBy: actor.id,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.safetyReviews.id, existingSafety.id));
    } else {
      await transaction.insert(schema.safetyReviews).values({
        productComponentId: fitment.productComponentId,
        safetyClass: input.safetyClass,
        signals: input.safetySignals,
        failureConsequence: input.safetyClass === "low" ? "Inconvenience only" : "Requires specialist review",
        rationale: input.safetyRationale,
        rulesetVersion: CURRENT_SAFETY_RULESET,
        reviewedBy: actor.id,
        reviewedAt: now,
      });
    }

    const decision = evaluateFitmentEvidence(evidenceRows.map((row) => toDomainEvidence({ ...row, moderationStatus: "accepted" })));
    await transaction
      .update(schema.fitments)
      .set({
        confidenceLevel: decision.status,
        confidenceScore: decision.score,
        confidenceVersion: decision.rulesetVersion,
        publicationStatus: "in_review",
        reviewedBy: actor.id,
        reviewedAt: now,
        lastComputedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.fitments.id, fitment.id));
    await transaction.update(schema.designs).set({ publicationStatus: "in_review", updatedAt: now }).where(eq(schema.designs.id, submission.matchedEntityId));
    await transaction.update(schema.submissions).set({ status: "accepted", reviewedBy: actor.id, reviewedAt: now }).where(eq(schema.submissions.id, submissionId));

    await writeAuditEvent(
      {
        actorId: actor.id,
        action: "editorial.case.accept",
        entityType: "submission",
        entityId: submissionId,
        before: { status: submission.status, evidence: "pending", fitment: "candidate_match" },
        after: { status: "accepted", evidence: "accepted", fitment: decision.status, safetyClass: input.safetyClass, rightsReviewed: true },
        reason: input.reason,
        requestId: input.requestId,
      },
      transaction,
    );
    return { submissionId, fitmentId: fitment.id, status: "accepted" };
  });
}

export async function publishCreatorSubmission(
  database: Database,
  submissionId: string,
  actor: StaffIdentity,
  input: PublishCaseInput,
): Promise<{ fitmentId: string; publication: PublishabilityDecision }> {
  return database.transaction(async (transaction) => {
    const [submission] = await transaction.select().from(schema.submissions).where(eq(schema.submissions.id, submissionId)).limit(1);
    if (!submission || submission.status !== "accepted" || submission.matchedEntityType !== "design" || !submission.matchedEntityId) {
      throw new EditorialWorkflowError("CASE_NOT_READY_TO_PUBLISH");
    }
    const [design] = await transaction.select().from(schema.designs).where(eq(schema.designs.id, submission.matchedEntityId)).limit(1);
    if (!design) throw new EditorialWorkflowError("DESIGN_NOT_FOUND");
    const [revision] = await transaction.select().from(schema.designRevisions).where(eq(schema.designRevisions.designId, design.id)).limit(1);
    if (!revision) throw new EditorialWorkflowError("REVISION_NOT_FOUND");
    const [source] = await transaction.select().from(schema.sources).where(eq(schema.sources.id, revision.sourceId)).limit(1);
    const [creator] = await transaction.select().from(schema.creators).where(eq(schema.creators.id, design.creatorId)).limit(1);
    const [fitment] = await transaction.select().from(schema.fitments).where(eq(schema.fitments.designRevisionId, revision.id)).limit(1);
    if (!source || !creator || !fitment) throw new EditorialWorkflowError("PUBLICATION_GRAPH_INCOMPLETE");
    assertDecision(evaluatePublicationTransition(fitment.publicationStatus, "published", actor.role));

    const [target] = await transaction
      .select({ modelId: schema.productModels.id, brandId: schema.productModels.brandId })
      .from(schema.productComponents)
      .innerJoin(schema.productModels, eq(schema.productComponents.productModelId, schema.productModels.id))
      .where(eq(schema.productComponents.id, fitment.productComponentId))
      .limit(1);
    const [safety] = await transaction
      .select()
      .from(schema.safetyReviews)
      .where(and(eq(schema.safetyReviews.productComponentId, fitment.productComponentId), eq(schema.safetyReviews.rulesetVersion, CURRENT_SAFETY_RULESET)))
      .limit(1);
    const citations = await transaction
      .select({ status: schema.sourceCitations.reviewStatus })
      .from(schema.sourceCitations)
      .where(and(eq(schema.sourceCitations.entityType, "design_revision"), eq(schema.sourceCitations.entityId, revision.id)));
    const [policy] = source.platform
      ? await transaction.select().from(schema.sourcePlatformPolicies).where(eq(schema.sourcePlatformPolicies.platform, source.platform)).limit(1)
      : [];
    const notices = await transaction
      .select({ id: schema.submissions.id })
      .from(schema.submissions)
      .where(and(
        eq(schema.submissions.kind, "rights_or_safety_notice"),
        inArray(schema.submissions.status, ["pending", "in_review"]),
        or(eq(schema.submissions.matchedEntityId, design.id), eq(schema.submissions.matchedEntityId, fitment.id)),
      ));

    const sourcePolicy = !policy || policy.policy === "blocked"
      ? "blocked"
      : Date.now() - policy.termsCheckedAt.getTime() > 366 * 24 * 60 * 60 * 1000
        ? "stale"
        : "current_permitted";
    const publication = evaluatePublishability({
      fitmentStatus: fitment.confidenceLevel,
      safetyClass: safety?.safetyClass ?? "blocked",
      sourcePolicy,
      originalLandingPageAvailable: source.status === "live",
      creatorRecorded: Boolean(creator.displayName.trim()),
      attributionComplete: Boolean(revision.attributionText.trim()),
      licenseRecorded: Boolean(revision.licenseCode.trim()),
      exactTargetRecorded: Boolean(target),
      claimProvenanceComplete: citations.length > 0 && citations.every((citation) => citation.status === "accepted"),
      safetyReviewed: Boolean(safety?.reviewedBy && safety.reviewedAt),
      openRightsOrSafetyNotice: notices.length > 0,
      designRevisionIdentified: Boolean(revision.sourceRevision.trim()),
      designRevisionCurrent: design.availabilityStatus === "available" && source.status === "live",
      fitmentRulesetVersion: fitment.confidenceVersion,
      safetyRulesetVersion: safety?.rulesetVersion ?? "missing",
      sourceRetrievedAt: source.retrievedAt.toISOString(),
      sourceLastCheckedAt: source.lastCheckedAt.toISOString(),
    });
    if (!publication.publish) throw new EditorialWorkflowError("PUBLICATION_BLOCKED", publication);
    if (!target) throw new EditorialWorkflowError("EXACT_TARGET_NOT_FOUND");

    const now = new Date();
    await transaction.update(schema.fitments).set({ publicationStatus: "published", publishedAt: now, reviewedBy: actor.id, reviewedAt: now, updatedAt: now }).where(eq(schema.fitments.id, fitment.id));
    await transaction.update(schema.designs).set({ publicationStatus: "published", updatedAt: now }).where(eq(schema.designs.id, design.id));
    await transaction.update(schema.productModels).set({ publicationStatus: "published", publishedAt: now, updatedAt: now }).where(eq(schema.productModels.id, target.modelId));
    await transaction.update(schema.brands).set({ publicationStatus: "published", updatedAt: now }).where(eq(schema.brands.id, target.brandId));
    await transaction.update(schema.submissions).set({ status: "resolved", resolvedAt: now, reviewedBy: actor.id, reviewedAt: now }).where(eq(schema.submissions.id, submissionId));

    await writeAuditEvent(
      {
        actorId: actor.id,
        action: "publication.fitment.publish",
        entityType: "fitment",
        entityId: fitment.id,
        before: { publicationStatus: fitment.publicationStatus, submissionStatus: submission.status },
        after: { publicationStatus: "published", submissionStatus: "resolved", publication },
        reason: input.reason,
        requestId: input.requestId,
      },
      transaction,
    );
    await transaction.execute(sql`REFRESH MATERIALIZED VIEW public_search_documents`);
    return { fitmentId: fitment.id, publication };
  });
}

export async function moderateEvidence(
  database: Database,
  evidenceId: string,
  actor: StaffIdentity,
  input: ModerateEvidenceInput,
): Promise<{ fitmentId: string; confidenceLevel: string; publicationStatus: string }> {
  return database.transaction(async (transaction) => {
    const [evidence] = await transaction.select().from(schema.fitmentEvidence).where(eq(schema.fitmentEvidence.id, evidenceId)).limit(1);
    if (!evidence) throw new EditorialWorkflowError("EVIDENCE_NOT_FOUND");
    const [fitment] = await transaction.select().from(schema.fitments).where(eq(schema.fitments.id, evidence.fitmentId)).limit(1);
    if (!fitment) throw new EditorialWorkflowError("FITMENT_NOT_FOUND");
    const allEvidence = await transaction.select().from(schema.fitmentEvidence).where(eq(schema.fitmentEvidence.fitmentId, fitment.id));
    const decision = evaluateFitmentEvidence(allEvidence.map((row) => toDomainEvidence(row.id === evidenceId ? { ...row, moderationStatus: input.decision } : row)));
    const publicationStatus = fitment.publicationStatus === "published" && (decision.status === "disputed" || decision.status === "rejected")
      ? "needs_review"
      : fitment.publicationStatus;
    const now = new Date();
    await transaction.update(schema.fitmentEvidence).set({ moderationStatus: input.decision, reviewedBy: actor.id, reviewedAt: now, updatedAt: now }).where(eq(schema.fitmentEvidence.id, evidenceId));
    await transaction.update(schema.fitments).set({ confidenceLevel: decision.status, confidenceScore: decision.score, confidenceVersion: decision.rulesetVersion, publicationStatus, reviewedBy: actor.id, reviewedAt: now, lastComputedAt: now, updatedAt: now }).where(eq(schema.fitments.id, fitment.id));
    await writeAuditEvent(
      {
        actorId: actor.id,
        action: "evidence.moderate",
        entityType: "fitment_evidence",
        entityId: evidenceId,
        before: { moderationStatus: evidence.moderationStatus, fitmentStatus: fitment.confidenceLevel, publicationStatus: fitment.publicationStatus },
        after: { moderationStatus: input.decision, fitmentStatus: decision.status, publicationStatus },
        reason: input.reason,
        requestId: input.requestId,
      },
      transaction,
    );
    await transaction.execute(sql`REFRESH MATERIALIZED VIEW public_search_documents`);
    return { fitmentId: fitment.id, confidenceLevel: decision.status, publicationStatus };
  });
}

export async function archiveFitment(
  database: Database,
  fitmentId: string,
  actor: StaffIdentity,
  input: ArchiveFitmentInput,
): Promise<{ fitmentId: string; oldPath: string; replacementPath: string }> {
  return database.transaction(async (transaction) => {
    const [fitment] = await transaction.select().from(schema.fitments).where(eq(schema.fitments.id, fitmentId)).limit(1);
    if (!fitment) throw new EditorialWorkflowError("FITMENT_NOT_FOUND");
    assertDecision(evaluatePublicationTransition(fitment.publicationStatus, "archived", actor.role));
    const oldPath = `/parts/${fitment.slug}`;
    if (!validateArchiveRedirect(oldPath, input.replacementPath)) throw new EditorialWorkflowError("REDIRECT_INVALID");
    const [replacementRedirect] = await transaction
      .select({ id: schema.slugHistory.id })
      .from(schema.slugHistory)
      .where(eq(schema.slugHistory.oldPath, input.replacementPath))
      .limit(1);
    if (replacementRedirect) throw new EditorialWorkflowError("REDIRECT_CHAIN_FORBIDDEN");
    const now = new Date();
    await transaction.update(schema.fitments).set({ publicationStatus: "archived", updatedAt: now }).where(eq(schema.fitments.id, fitmentId));
    await transaction.insert(schema.slugHistory).values({ entityType: "fitment", entityId: fitmentId, oldPath, replacementPath: input.replacementPath }).onConflictDoNothing();
    await writeAuditEvent(
      {
        actorId: actor.id,
        action: "fitment.archive",
        entityType: "fitment",
        entityId: fitmentId,
        before: { publicationStatus: fitment.publicationStatus, path: oldPath },
        after: { publicationStatus: "archived", replacementPath: input.replacementPath },
        reason: input.reason,
        requestId: input.requestId,
      },
      transaction,
    );
    await transaction.execute(sql`REFRESH MATERIALIZED VIEW public_search_documents`);
    return { fitmentId, oldPath, replacementPath: input.replacementPath };
  });
}

export async function getEditorialCasePreview(database: Database, submissionId: string): Promise<Record<string, unknown>> {
  const [submission] = await database.select().from(schema.submissions).where(eq(schema.submissions.id, submissionId)).limit(1);
  if (!submission) throw new EditorialWorkflowError("SUBMISSION_NOT_FOUND");
  const intakeRows = await database
    .select({
      acceptedAt: schema.submissionIdempotencyBindings.acceptedAt,
      id: schema.submissionIdempotencyBindings.id,
      payload: schema.submissionIdempotencyBindings.payload,
    })
    .from(schema.submissionIdempotencyBindings)
    .where(and(
      eq(schema.submissionIdempotencyBindings.submissionId, submissionId),
      gt(schema.submissionIdempotencyBindings.retentionExpiresAt, sql`CURRENT_TIMESTAMP`),
    ))
    .orderBy(asc(schema.submissionIdempotencyBindings.acceptedAt), asc(schema.submissionIdempotencyBindings.id));
  const intakes = intakeRows.map((intake) => ({ ...intake, payload: redactPrivatePayload(intake.payload) }));
  const submissionPreview = {
    id: submission.id,
    status: submission.status,
    payload: intakes[0]?.payload ?? redactPrivatePayload(submission.payload),
    intakes,
  };
  if (!submission.matchedEntityId) return { submission: submissionPreview };
  const [record] = await database
    .select({
      designId: schema.designs.id,
      designTitle: schema.designs.title,
      designStatus: schema.designs.publicationStatus,
      creator: schema.creators.displayName,
      sourceUrl: schema.sources.canonicalUrl,
      sourceTitle: schema.sources.title,
      sourceStatus: schema.sources.status,
      sourceRevision: schema.designRevisions.sourceRevision,
      licenseCode: schema.designRevisions.licenseCode,
      attributionText: schema.designRevisions.attributionText,
      fitmentId: schema.fitments.id,
      fitmentStatus: schema.fitments.confidenceLevel,
      publicationStatus: schema.fitments.publicationStatus,
      model: schema.productModels.modelName,
      component: schema.components.name,
    })
    .from(schema.designs)
    .innerJoin(schema.creators, eq(schema.designs.creatorId, schema.creators.id))
    .innerJoin(schema.designRevisions, eq(schema.designRevisions.designId, schema.designs.id))
    .innerJoin(schema.sources, eq(schema.designRevisions.sourceId, schema.sources.id))
    .innerJoin(schema.fitments, eq(schema.fitments.designRevisionId, schema.designRevisions.id))
    .innerJoin(schema.productComponents, eq(schema.fitments.productComponentId, schema.productComponents.id))
    .innerJoin(schema.productModels, eq(schema.productComponents.productModelId, schema.productModels.id))
    .innerJoin(schema.components, eq(schema.productComponents.componentId, schema.components.id))
    .where(eq(schema.designs.id, submission.matchedEntityId))
    .limit(1);
  const evidence = record
    ? await database
        .select({
          id: schema.fitmentEvidence.id,
          kind: schema.fitmentEvidence.evidenceKind,
          outcome: schema.fitmentEvidence.outcome,
          summary: schema.fitmentEvidence.summary,
          exactModel: schema.fitmentEvidence.exactModel,
          exactDesignRevision: schema.fitmentEvidence.exactDesignRevision,
          moderationStatus: schema.fitmentEvidence.moderationStatus,
          sourceUrl: schema.sources.canonicalUrl,
        })
        .from(schema.fitmentEvidence)
        .leftJoin(schema.sourceCitations, eq(schema.fitmentEvidence.sourceCitationId, schema.sourceCitations.id))
        .leftJoin(schema.sources, eq(schema.sourceCitations.sourceId, schema.sources.id))
        .where(eq(schema.fitmentEvidence.fitmentId, record.fitmentId))
    : [];
  const safety = record
    ? await database
        .select({ safetyClass: schema.safetyReviews.safetyClass, signals: schema.safetyReviews.signals, rationale: schema.safetyReviews.rationale, rulesetVersion: schema.safetyReviews.rulesetVersion })
        .from(schema.safetyReviews)
        .innerJoin(schema.fitments, eq(schema.safetyReviews.productComponentId, schema.fitments.productComponentId))
        .where(eq(schema.fitments.id, record.fitmentId))
    : [];
  return {
    submission: submissionPreview,
    record,
    evidence,
    safety,
  };
}

function toDomainEvidence(row: typeof schema.fitmentEvidence.$inferSelect): DomainFitmentEvidence {
  return {
    id: row.id,
    kind: row.evidenceKind,
    outcome: row.outcome ?? undefined,
    moderationStatus: row.moderationStatus,
    exactModel: row.exactModel,
    exactDesignRevision: row.exactDesignRevision,
    reporterKey: row.actorIndependenceKey ?? undefined,
    installedPhoto: row.hasInstalledPhoto,
    measurements: Boolean(row.measurements),
    modificationNotes: row.modificationNotes ?? undefined,
    observedAt: row.observedAt,
    summary: row.summary,
  };
}

function redactPrivatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...payload };
  delete safe.email;
  delete safe.website;
  delete safe.evidenceUrl;
  return safe;
}

function assertDecision(decision: { allowed: boolean; code?: string }): asserts decision is { allowed: true } {
  if (!decision.allowed) throw new EditorialWorkflowError(decision.code ?? "TRANSITION_INVALID");
}
