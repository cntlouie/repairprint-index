import "server-only";

import type {
  CatalogEvidence,
  CatalogFitment,
  CatalogInvalidationContext,
  CatalogModel,
  CatalogModelIdentifier,
  CatalogPart,
  CatalogPartLookup,
  CatalogPartSummary,
  CatalogPrintRecipe,
  PublicCitation,
  UnavailableCatalogPart,
} from "@/lib/catalog-types";
import { resolveRedirectChain } from "@/domain/catalogue";
import { databaseClient } from "./client";

type DatabaseTimestamp = Date | string;

interface ModelRow {
  id: string;
  publicId: string;
  brandName: string;
  brandSlug: string;
  modelName: string;
  modelSlug: string;
  categoryName: string;
  categorySlug: string;
  marketCodes: string[];
  labelLocation: string | null;
  publishedAt: DatabaseTimestamp;
  updatedAt: DatabaseTimestamp;
  identifiers: CatalogModelIdentifier[];
}

interface PartSummaryRow {
  id: string;
  publicId: string;
  slug: string;
  componentName: string;
  designTitle: string;
  revision: string;
  creator: string;
  platform: string;
  licenseCode: string;
  fitmentStatus: CatalogPartSummary["fitmentStatus"];
  evidenceCount: number;
  sourceLastCheckedAt: DatabaseTimestamp;
  material: string | null;
  updatedAt: DatabaseTimestamp;
}

interface AnchorRow {
  fitmentId: string;
  designId: string;
  componentId: string;
  canonicalSlug: string;
}

interface FitmentRow {
  fitment_id: string;
  fitment_public_id: string;
  fitment_slug: string;
  canonical_slug: string;
  fitment_status: CatalogFitment["status"];
  fitment_published_at: DatabaseTimestamp;
  fitment_updated_at: DatabaseTimestamp;
  material_updated_at: DatabaseTimestamp;
  design_id: string;
  design_public_id: string;
  design_title: string;
  revision_id: string;
  source_revision: string;
  license_code: string;
  license_version: string | null;
  license_url: string | null;
  license_evidence_url: string | null;
  attribution_text: string;
  file_formats: string[];
  rights_checked_at: DatabaseTimestamp;
  creator_name: string;
  creator_platform: string;
  creator_profile_url: string | null;
  source_platform: string;
  source_url: string;
  source_publisher: string | null;
  source_title: string;
  source_retrieved_at: DatabaseTimestamp;
  source_last_checked_at: DatabaseTimestamp;
  serial_from: string | null;
  serial_to: string | null;
  model_id: string;
  model_public_id: string;
  model_name: string;
  model_slug: string;
  brand_name: string;
  brand_slug: string;
  component_name: string;
  component_slug: string;
  component_common_names: string[];
  component_alias_citation: PublicCitation | null;
  oem_public_id: string | null;
  oem_part_number: string | null;
  oem_part_name: string | null;
  oem_citations: PublicCitation[];
  safety_class: "low";
  safety_signals: string[];
  failure_consequence: string;
  safety_rationale: string;
  safety_ruleset_version: string;
  safety_reviewed_at: DatabaseTimestamp;
  evidence: CatalogEvidence[];
  print_recipe: CatalogPrintRecipe | null;
}

interface UnavailableRow {
  fitment_public_id: string;
  fitment_slug: string;
  fitment_updated_at: DatabaseTimestamp;
  design_title: string;
  creator_name: string;
  source_title: string;
  source_last_checked_at: DatabaseTimestamp;
  component_name: string;
  model_name: string;
  brand_name: string;
  unavailable_reason: UnavailableCatalogPart["reason"];
}

export async function listPublishedModelsFromDatabase(limit = 24): Promise<CatalogModel[]> {
  const rows = await modelRows(undefined, undefined, limit);
  return rows.map(toModel);
}

export async function getPublishedModelFromDatabase(
  brandSlug: string,
  modelSlug: string,
): Promise<CatalogModel | null> {
  const [row] = await publishedModelRows(brandSlug, modelSlug);
  return row ? toModel(row) : null;
}

export async function listPublishedPartsForModelFromDatabase(
  modelId: string,
): Promise<CatalogPartSummary[]> {
  const rows = await partSummaryRows(modelId, 100);
  return rows.map(toPartSummary);
}

export async function listRecentPublishedPartsFromDatabase(limit = 12): Promise<CatalogPartSummary[]> {
  const rows = await partSummaryRows(undefined, 250);
  return uniqueBy(rows.map(toPartSummary), (part) => part.slug).slice(0, Math.max(1, Math.min(limit, 250)));
}

export async function getPublishedPartFromDatabase(slug: string): Promise<CatalogPartLookup> {
  const [anchor] = await databaseClient<AnchorRow[]>`
    SELECT
      fitment_id AS "fitmentId",
      design_id AS "designId",
      component_id AS "componentId",
      canonical_slug AS "canonicalSlug"
    FROM public_catalogue_fitments
    WHERE fitment_slug = ${slug} OR canonical_slug = ${slug}
    ORDER BY CASE WHEN canonical_slug = ${slug} THEN 0 ELSE 1 END, fitment_public_id
    LIMIT 1
  `;

  if (anchor) {
    if (slug !== anchor.canonicalSlug) {
      return { kind: "redirect", location: `/parts/${anchor.canonicalSlug}` };
    }
    const rows = await fitmentRows(anchor.designId, anchor.componentId);
    if (rows.length === 0) return { kind: "not_found" };
    return { kind: "published", part: toPart(anchor.canonicalSlug, rows) };
  }

  const [unavailable] = await databaseClient<UnavailableRow[]>`
    SELECT *
    FROM public_catalogue_unavailable_sources
    WHERE fitment_slug = ${slug}
    LIMIT 1
  `;
  if (unavailable) return { kind: "unavailable", part: toUnavailablePart(unavailable) };

  const redirects = await databaseClient<Array<{ oldPath: string; replacementPath: string }>>`
    SELECT old_path AS "oldPath", replacement_path AS "replacementPath"
    FROM slug_history
    ORDER BY created_at, id
  `;
  const location = resolveRedirectChain(redirects, `/parts/${slug}`);
  if (!location) return { kind: "not_found" };

  // Slug-history text is untrusted even after syntactic normalization. Resolve
  // the destination back through a publication-safe view and return the path
  // derived from that public entity, never the stored replacement verbatim.
  const destinationSlug = location.slice("/parts/".length);
  const initialPath = `/parts/${slug}`;
  const [eligibleDestination] = await databaseClient<Array<{ canonicalSlug: string }>>`
    WITH history_source AS (
      SELECT entity_id
      FROM slug_history
      WHERE old_path = ${initialPath} AND entity_type = 'fitment'
      LIMIT 1
    ), source_group AS (
      SELECT revision.design_id, product_component.component_id
      FROM history_source
      INNER JOIN fitments AS source_fitment ON source_fitment.id = history_source.entity_id
      INNER JOIN design_revisions AS revision ON revision.id = source_fitment.design_revision_id
      INNER JOIN product_components AS product_component ON product_component.id = source_fitment.product_component_id
    )
    SELECT destination.canonical_slug AS "canonicalSlug"
    FROM source_group
    INNER JOIN public_catalogue_fitments AS destination
      ON destination.design_id = source_group.design_id
      AND destination.component_id = source_group.component_id
    WHERE destination.fitment_slug = ${destinationSlug} OR destination.canonical_slug = ${destinationSlug}
    ORDER BY CASE WHEN destination.canonical_slug = ${destinationSlug} THEN 0 ELSE 1 END, destination.fitment_public_id
    LIMIT 1
  `;
  if (eligibleDestination) {
    return { kind: "redirect", location: `/parts/${eligibleDestination.canonicalSlug}` };
  }

  const [safeTombstone] = await databaseClient<Array<{ fitmentSlug: string }>>`
    WITH history_source AS (
      SELECT entity_id
      FROM slug_history
      WHERE old_path = ${initialPath} AND entity_type = 'fitment'
      LIMIT 1
    ), source_group AS (
      SELECT revision.design_id, product_component.component_id
      FROM history_source
      INNER JOIN fitments AS source_fitment ON source_fitment.id = history_source.entity_id
      INNER JOIN design_revisions AS revision ON revision.id = source_fitment.design_revision_id
      INNER JOIN product_components AS product_component ON product_component.id = source_fitment.product_component_id
    )
    SELECT tombstone.fitment_slug AS "fitmentSlug"
    FROM source_group
    INNER JOIN public_catalogue_unavailable_sources AS tombstone ON tombstone.fitment_slug = ${destinationSlug}
    INNER JOIN fitments AS destination_fitment ON destination_fitment.id = tombstone.fitment_id
    INNER JOIN design_revisions AS destination_revision ON destination_revision.id = destination_fitment.design_revision_id
      AND destination_revision.design_id = source_group.design_id
    INNER JOIN product_components AS destination_component ON destination_component.id = destination_fitment.product_component_id
      AND destination_component.component_id = source_group.component_id
    LIMIT 1
  `;
  return safeTombstone
    ? { kind: "redirect", location: `/parts/${safeTombstone.fitmentSlug}` }
    : { kind: "not_found" };
}

export async function getPublishedFitmentAnalyticsFactsFromDatabase(
  fitmentSlug: string,
): Promise<Readonly<{ publicId: string }> | null> {
  const [row] = await databaseClient<Array<{ publicId: string }>>`
    SELECT fitment_public_id AS "publicId"
    FROM public_catalogue_fitments
    WHERE fitment_slug = ${fitmentSlug}
    ORDER BY fitment_public_id
    LIMIT 1
  `;
  return row ?? null;
}

export async function resolvePublishedCategoryForAnalyticsFromDatabase(
  suppliedCategory: string,
): Promise<string | null> {
  const normalized = suppliedCategory.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
  if (!normalized) return null;
  const rows = await databaseClient<Array<{ categorySlug: string }>>`
    SELECT DISTINCT category_slug AS "categorySlug"
    FROM public_catalogue_fitments
    WHERE lower(trim(category_name)) = ${normalized}
      OR category_slug = ${normalized}
    ORDER BY category_slug
    LIMIT 2
  `;
  return rows.length === 1 ? rows[0]!.categorySlug : null;
}

export async function getCatalogInvalidationContextFromDatabase(
  fitmentId: string,
): Promise<CatalogInvalidationContext> {
  const rows = await databaseClient<Array<{ partSlug: string; canonicalSlug: string | null; brandSlug: string; modelSlug: string }>>`
    WITH target AS (
      SELECT revision.design_id, product_component.component_id
      FROM fitments AS fitment
      INNER JOIN design_revisions AS revision ON revision.id = fitment.design_revision_id
      INNER JOIN product_components AS product_component ON product_component.id = fitment.product_component_id
      WHERE fitment.id = ${fitmentId}
    )
    SELECT DISTINCT
      grouped_fitment.slug AS "partSlug",
      canonical.canonical_slug AS "canonicalSlug",
      brand.slug AS "brandSlug",
      model.slug AS "modelSlug"
    FROM target
    INNER JOIN design_revisions AS revision ON revision.design_id = target.design_id
    INNER JOIN fitments AS grouped_fitment ON grouped_fitment.design_revision_id = revision.id
    INNER JOIN product_components AS product_component
      ON product_component.id = grouped_fitment.product_component_id
      AND product_component.component_id = target.component_id
    INNER JOIN product_models AS model ON model.id = product_component.product_model_id
    INNER JOIN brands AS brand ON brand.id = model.brand_id
    LEFT JOIN LATERAL (
      SELECT eligible.canonical_slug
      FROM public_catalogue_fitments AS eligible
      WHERE eligible.design_id = target.design_id
        AND eligible.component_id = target.component_id
      ORDER BY eligible.fitment_published_at, eligible.fitment_public_id
      LIMIT 1
    ) AS canonical ON true
    ORDER BY brand.slug, model.slug, grouped_fitment.slug
  `;

  return {
    modelPaths: uniqueBy(rows.map(({ brandSlug, modelSlug }) => ({ brandSlug, modelSlug })), ({ brandSlug, modelSlug }) => `${brandSlug}/${modelSlug}`),
    partSlugs: [...new Set(rows.flatMap((row) => [row.partSlug, row.canonicalSlug].filter((slug): slug is string => slug !== null)))],
  };
}

async function modelRows(
  brandSlug: string | undefined,
  modelSlug: string | undefined,
  limit: number,
): Promise<ModelRow[]> {
  return databaseClient<ModelRow[]>`
    SELECT DISTINCT ON (catalogue.model_id)
      catalogue.model_id AS id,
      catalogue.model_public_id AS "publicId",
      catalogue.brand_name AS "brandName",
      catalogue.brand_slug AS "brandSlug",
      catalogue.model_name AS "modelName",
      catalogue.model_slug AS "modelSlug",
      catalogue.category_name AS "categoryName",
      catalogue.category_slug AS "categorySlug",
      catalogue.market_codes AS "marketCodes",
      catalogue.label_location AS "labelLocation",
      catalogue.model_published_at AS "publishedAt",
      GREATEST(
        catalogue.model_published_at,
        identifier.material_at,
        model_claims.material_at
      ) AS "updatedAt",
      COALESCE(identifier.identifiers, '[]'::jsonb) AS identifiers
    FROM public_catalogue_fitments AS catalogue
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'displayValue', identifier.display_value,
          'identifierType', identifier.identifier_type,
          'marketCode', NULL,
          'citation', jsonb_build_object(
            'sourceTitle', source.title,
            'sourceUrl', source.canonical_url,
            'sourceAvailable', true,
            'locator', citation.locator,
            'retrievedAt', source.retrieved_at,
            'lastCheckedAt', source.last_checked_at
          )
        ) ORDER BY identifier.display_value
      ) AS identifiers,
      MAX(GREATEST(
        citation.reviewed_at,
        source.retrieved_at,
        source.last_checked_at
      )) AS material_at
      FROM product_identifiers AS identifier
      INNER JOIN source_citations AS citation
        ON citation.entity_type = 'product_identifier'
        AND citation.entity_id = identifier.id
        AND citation.field_path = 'display_value'
        AND citation.review_status = 'accepted'
        AND citation.reviewed_by IS NOT NULL
        AND citation.reviewed_at IS NOT NULL
        AND (identifier.source_citation_id IS NULL OR citation.id = identifier.source_citation_id)
      INNER JOIN sources AS source
        ON source.id = citation.source_id
        AND source.status = 'live'
        AND source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS policy
        ON policy.platform = source.platform
        AND policy.policy <> 'blocked'
        AND policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE identifier.product_model_id = catalogue.model_id
    ) AS identifier ON true
    LEFT JOIN LATERAL (
      SELECT MAX(GREATEST(
        citation.reviewed_at,
        source.retrieved_at,
        source.last_checked_at
      )) AS material_at
      FROM source_citations AS citation
      INNER JOIN sources AS source
        ON source.id = citation.source_id
        AND source.status = 'live'
        AND source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS policy
        ON policy.platform = source.platform
        AND policy.policy <> 'blocked'
        AND policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE citation.entity_type = 'product_model'
        AND citation.entity_id = catalogue.model_id
        AND citation.field_path IN ('model_name', 'market_codes', 'label_location')
        AND citation.review_status = 'accepted'
        AND citation.reviewed_by IS NOT NULL
        AND citation.reviewed_at IS NOT NULL
    ) AS model_claims ON true
    WHERE (${brandSlug ?? null}::text IS NULL OR catalogue.brand_slug = ${brandSlug ?? null})
      AND (${modelSlug ?? null}::text IS NULL OR catalogue.model_slug = ${modelSlug ?? null})
    ORDER BY catalogue.model_id, catalogue.brand_name, catalogue.model_name
    LIMIT ${Math.max(1, Math.min(limit, 100))}
  `;
}

async function publishedModelRows(brandSlug: string, modelSlug: string): Promise<ModelRow[]> {
  return databaseClient<ModelRow[]>`
    WITH accepted_public_claims AS MATERIALIZED (
      SELECT
        citation.id,
        citation.entity_type,
        citation.entity_id,
        citation.field_path,
        citation.source_id,
        citation.locator,
        citation.reviewed_at AS citation_reviewed_at,
        source.title AS source_title,
        source.canonical_url AS source_url,
        source.retrieved_at AS source_retrieved_at,
        source.last_checked_at AS source_last_checked_at
      FROM source_citations AS citation
      INNER JOIN sources AS source
        ON source.id = citation.source_id
        AND source.status = 'live'
        AND source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS policy
        ON policy.platform = source.platform
        AND policy.policy <> 'blocked'
        AND policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE citation.review_status = 'accepted'
        AND citation.reviewed_by IS NOT NULL
        AND citation.reviewed_at IS NOT NULL
    )
    SELECT
      model.id,
      model.public_id AS "publicId",
      brand.name AS "brandName",
      brand.slug AS "brandSlug",
      model.model_name AS "modelName",
      model.slug AS "modelSlug",
      category.name AS "categoryName",
      category.slug AS "categorySlug",
      CASE WHEN EXISTS (
        SELECT 1 FROM accepted_public_claims AS claim
        WHERE claim.entity_type = 'product_model'
          AND claim.entity_id = model.id
          AND claim.field_path = 'market_codes'
      ) THEN model.market_codes ELSE '[]'::jsonb END AS "marketCodes",
      CASE WHEN EXISTS (
        SELECT 1 FROM accepted_public_claims AS claim
        WHERE claim.entity_type = 'product_model'
          AND claim.entity_id = model.id
          AND claim.field_path = 'label_location'
      ) THEN model.label_location ELSE NULL END AS "labelLocation",
      model.published_at AS "publishedAt",
      GREATEST(
        model.published_at,
        identifier.material_at,
        model_claims.material_at
      ) AS "updatedAt",
      identifier.identifiers
    FROM product_models AS model
    INNER JOIN brands AS brand
      ON brand.id = model.brand_id
      AND brand.publication_status = 'published'
    INNER JOIN categories AS category ON category.id = model.category_id
    INNER JOIN LATERAL (
      SELECT
        jsonb_agg(jsonb_build_object(
          'displayValue', identifier.display_value,
          'identifierType', identifier.identifier_type,
          'marketCode', NULL,
          'citation', jsonb_build_object(
            'sourceTitle', claim.source_title,
            'sourceUrl', claim.source_url,
            'sourceAvailable', true,
            'locator', claim.locator,
            'retrievedAt', claim.source_retrieved_at,
            'lastCheckedAt', claim.source_last_checked_at
          )
        ) ORDER BY identifier.display_value) AS identifiers,
        MAX(GREATEST(
          claim.citation_reviewed_at,
          claim.source_retrieved_at,
          claim.source_last_checked_at
        )) AS material_at
      FROM product_identifiers AS identifier
      INNER JOIN accepted_public_claims AS claim
        ON claim.entity_type = 'product_identifier'
        AND claim.entity_id = identifier.id
        AND claim.field_path = 'display_value'
        AND (identifier.source_citation_id IS NULL OR claim.id = identifier.source_citation_id)
      WHERE identifier.product_model_id = model.id
        AND identifier.identifier_type IN ('model_number', 'label')
    ) AS identifier ON identifier.identifiers IS NOT NULL
    INNER JOIN LATERAL (
      SELECT MAX(GREATEST(
        claim.citation_reviewed_at,
        claim.source_retrieved_at,
        claim.source_last_checked_at
      )) AS material_at
      FROM accepted_public_claims AS claim
      WHERE claim.entity_type = 'product_model'
        AND claim.entity_id = model.id
        AND claim.field_path IN ('model_name', 'market_codes', 'label_location')
    ) AS model_claims ON model_claims.material_at IS NOT NULL
    WHERE brand.slug = ${brandSlug}
      AND model.slug = ${modelSlug}
      AND model.publication_status = 'published'
      AND model.published_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM accepted_public_claims AS claim
        WHERE claim.entity_type = 'product_model'
          AND claim.entity_id = model.id
          AND claim.field_path = 'model_name'
      )
    LIMIT 1
  `;
}

async function partSummaryRows(modelId: string | undefined, limit: number): Promise<PartSummaryRow[]> {
  return databaseClient<PartSummaryRow[]>`
    SELECT
      catalogue.fitment_id AS id,
      catalogue.fitment_public_id AS "publicId",
      catalogue.canonical_slug AS slug,
      catalogue.component_name AS "componentName",
      catalogue.design_title AS "designTitle",
      catalogue.source_revision AS revision,
      catalogue.creator_name AS creator,
      catalogue.source_platform AS platform,
      catalogue.license_code AS "licenseCode",
      catalogue.fitment_status AS "fitmentStatus",
      evidence.count AS "evidenceCount",
      catalogue.source_last_checked_at AS "sourceLastCheckedAt",
      recipe.material,
      GREATEST(
        catalogue.model_published_at,
        catalogue.fitment_published_at,
        catalogue.source_retrieved_at,
        catalogue.source_last_checked_at,
        catalogue.rights_checked_at,
        catalogue.safety_reviewed_at,
        claims.material_at,
        evidence.material_at,
        recipe.material_at
      ) AS "updatedAt"
    FROM public_catalogue_fitments AS catalogue
    LEFT JOIN LATERAL (
      SELECT MAX(GREATEST(
        citation.reviewed_at,
        claim_source.retrieved_at,
        claim_source.last_checked_at
      )) AS material_at
      FROM source_citations AS citation
      INNER JOIN sources AS claim_source
        ON claim_source.id = citation.source_id
        AND claim_source.status = 'live'
        AND claim_source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS claim_policy
        ON claim_policy.platform = claim_source.platform
        AND claim_policy.policy <> 'blocked'
        AND claim_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE citation.review_status = 'accepted'
        AND citation.reviewed_by IS NOT NULL
        AND citation.reviewed_at IS NOT NULL
        AND (
          (citation.entity_type = 'product_model' AND citation.entity_id = catalogue.model_id AND citation.field_path = 'model_name')
          OR (citation.entity_type = 'product_component' AND citation.entity_id = catalogue.product_component_id AND citation.field_path = 'mapping')
          OR (citation.entity_type = 'design_revision' AND citation.entity_id = catalogue.revision_id AND citation.field_path = 'claimed_compatibility')
          OR (citation.entity_type = 'component' AND citation.entity_id = catalogue.component_id AND citation.field_path = 'common_names')
          OR (
            catalogue.oem_part_id IS NOT NULL
            AND citation.entity_type = 'oem_part'
            AND citation.entity_id = catalogue.oem_part_id
            AND citation.field_path IN ('record', 'part_number_display', 'name')
          )
        )
    ) AS claims ON true
    LEFT JOIN LATERAL (
      SELECT
        print_recipe.material,
        GREATEST(
          recipe_citation.reviewed_at,
          recipe_source.retrieved_at,
          recipe_source.last_checked_at
        ) AS material_at
      FROM print_recipes AS print_recipe
      INNER JOIN source_citations AS recipe_citation
        ON recipe_citation.id = print_recipe.source_citation_id
        AND recipe_citation.entity_type = 'print_recipe'
        AND recipe_citation.entity_id = print_recipe.id
        AND recipe_citation.field_path = 'settings'
        AND recipe_citation.review_status = 'accepted'
        AND recipe_citation.reviewed_by IS NOT NULL
        AND recipe_citation.reviewed_at IS NOT NULL
      INNER JOIN sources AS recipe_source
        ON recipe_source.id = recipe_citation.source_id
        AND recipe_source.status = 'live'
        AND recipe_source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS recipe_policy
        ON recipe_policy.platform = recipe_source.platform
        AND recipe_policy.policy <> 'blocked'
        AND recipe_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE print_recipe.fitment_id = catalogue.fitment_id
      LIMIT 1
    ) AS recipe ON true
    INNER JOIN LATERAL (
      SELECT
        count(*)::int AS count,
        MAX(GREATEST(
          fitment_evidence.reviewed_at,
          evidence_citation.reviewed_at,
          evidence_source.retrieved_at,
          evidence_source.last_checked_at
        )) AS material_at
      FROM fitment_evidence
      INNER JOIN source_citations AS evidence_citation
        ON evidence_citation.id = fitment_evidence.source_citation_id
        AND evidence_citation.review_status = 'accepted'
        AND evidence_citation.reviewed_by IS NOT NULL
        AND evidence_citation.reviewed_at IS NOT NULL
        AND (
          (
            evidence_citation.entity_type = 'fitment_evidence'
            AND evidence_citation.entity_id = fitment_evidence.id
            AND evidence_citation.field_path = 'observation'
          )
          OR (
            fitment_evidence.evidence_kind = 'creator_claim'
            AND evidence_citation.entity_type = 'design_revision'
            AND evidence_citation.entity_id = catalogue.revision_id
            AND evidence_citation.field_path = 'claimed_compatibility'
            AND evidence_citation.source_id = catalogue.source_id
          )
        )
      INNER JOIN sources AS evidence_source
        ON evidence_source.id = evidence_citation.source_id
        AND evidence_source.status = 'live'
        AND evidence_source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS evidence_policy
        ON evidence_policy.platform = evidence_source.platform
        AND evidence_policy.policy <> 'blocked'
        AND evidence_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE fitment_evidence.fitment_id = catalogue.fitment_id
        AND fitment_evidence.moderation_status = 'accepted'
        AND fitment_evidence.reviewed_by IS NOT NULL
        AND fitment_evidence.reviewed_at IS NOT NULL
    ) AS evidence ON evidence.count > 0
    WHERE (${modelId ?? null}::uuid IS NULL OR catalogue.model_id = ${modelId ?? null})
    ORDER BY
      CASE catalogue.fitment_status
        WHEN 'verified_fit' THEN 0
        WHEN 'community_confirmed' THEN 1
        ELSE 2
      END,
      "updatedAt" DESC,
      catalogue.fitment_public_id
    LIMIT ${Math.max(1, Math.min(limit, 250))}
  `;
}

async function fitmentRows(designId: string, componentId: string): Promise<FitmentRow[]> {
  return databaseClient<FitmentRow[]>`
    SELECT
      catalogue.*,
      COALESCE(evidence.items, '[]'::jsonb) AS evidence,
      recipe.item AS print_recipe,
      alias_claim.item AS component_alias_citation,
      COALESCE(oem_claim.items, '[]'::jsonb) AS oem_citations,
      GREATEST(
        catalogue.model_published_at,
        catalogue.fitment_published_at,
        catalogue.source_retrieved_at,
        catalogue.source_last_checked_at,
        catalogue.rights_checked_at,
        catalogue.safety_reviewed_at,
        claims.material_at,
        evidence.material_at,
        recipe.material_at
      ) AS material_updated_at
    FROM public_catalogue_fitments AS catalogue
    LEFT JOIN LATERAL (
      SELECT MAX(GREATEST(
        citation.reviewed_at,
        claim_source.retrieved_at,
        claim_source.last_checked_at
      )) AS material_at
      FROM source_citations AS citation
      INNER JOIN sources AS claim_source
        ON claim_source.id = citation.source_id
        AND claim_source.status = 'live'
        AND claim_source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS claim_policy
        ON claim_policy.platform = claim_source.platform
        AND claim_policy.policy <> 'blocked'
        AND claim_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE citation.review_status = 'accepted'
        AND citation.reviewed_by IS NOT NULL
        AND citation.reviewed_at IS NOT NULL
        AND (
          (citation.entity_type = 'product_model' AND citation.entity_id = catalogue.model_id AND citation.field_path = 'model_name')
          OR (citation.entity_type = 'product_component' AND citation.entity_id = catalogue.product_component_id AND citation.field_path = 'mapping')
          OR (citation.entity_type = 'design_revision' AND citation.entity_id = catalogue.revision_id AND citation.field_path = 'claimed_compatibility')
          OR (citation.entity_type = 'component' AND citation.entity_id = catalogue.component_id AND citation.field_path = 'common_names')
          OR (
            catalogue.oem_part_id IS NOT NULL
            AND citation.entity_type = 'oem_part'
            AND citation.entity_id = catalogue.oem_part_id
            AND citation.field_path IN ('record', 'part_number_display', 'name')
          )
        )
    ) AS claims ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'sourceTitle', claim_source.title,
        'sourceUrl', claim_source.canonical_url,
        'sourceAvailable', true,
        'locator', citation.locator,
        'retrievedAt', claim_source.retrieved_at,
        'lastCheckedAt', claim_source.last_checked_at
      ) AS item
      FROM source_citations AS citation
      INNER JOIN sources AS claim_source
        ON claim_source.id = citation.source_id
        AND claim_source.status = 'live'
        AND claim_source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS claim_policy
        ON claim_policy.platform = claim_source.platform
        AND claim_policy.policy <> 'blocked'
        AND claim_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE citation.entity_type = 'component'
        AND citation.entity_id = catalogue.component_id
        AND citation.field_path = 'common_names'
        AND citation.review_status = 'accepted'
        AND citation.reviewed_by IS NOT NULL
        AND citation.reviewed_at IS NOT NULL
      ORDER BY citation.reviewed_at DESC, citation.id
      LIMIT 1
    ) AS alias_claim ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'sourceTitle', claim_source.title,
        'sourceUrl', claim_source.canonical_url,
        'sourceAvailable', true,
        'locator', citation.locator,
        'retrievedAt', claim_source.retrieved_at,
        'lastCheckedAt', claim_source.last_checked_at
      ) ORDER BY citation.reviewed_at DESC, citation.id) AS items
      FROM source_citations AS citation
      INNER JOIN sources AS claim_source
        ON claim_source.id = citation.source_id
        AND claim_source.status = 'live'
        AND claim_source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS claim_policy
        ON claim_policy.platform = claim_source.platform
        AND claim_policy.policy <> 'blocked'
        AND claim_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE catalogue.oem_part_id IS NOT NULL
        AND citation.entity_type = 'oem_part'
        AND citation.entity_id = catalogue.oem_part_id
        AND citation.field_path IN ('record', 'part_number_display', 'name')
        AND citation.review_status = 'accepted'
        AND citation.reviewed_by IS NOT NULL
        AND citation.reviewed_at IS NOT NULL
    ) AS oem_claim ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', fitment_evidence.id,
          'kind', fitment_evidence.evidence_kind,
          'outcome', fitment_evidence.outcome,
          'exactModel', fitment_evidence.exact_model,
          'exactDesignRevision', fitment_evidence.exact_design_revision,
          'installedPhoto', fitment_evidence.has_installed_photo,
          'measurementsRecorded', fitment_evidence.measurements IS NOT NULL,
          'modificationNotes', fitment_evidence.modification_notes,
          'summary', fitment_evidence.summary,
          'observedAt', fitment_evidence.observed_at,
          'citation', jsonb_build_object(
            'sourceTitle', evidence_source.title,
            'sourceUrl', evidence_source.canonical_url,
            'sourceAvailable', true,
            'locator', citation.locator,
            'retrievedAt', evidence_source.retrieved_at,
            'lastCheckedAt', evidence_source.last_checked_at
          )
        ) ORDER BY fitment_evidence.observed_at DESC, fitment_evidence.id
      ) AS items,
      MAX(GREATEST(
        fitment_evidence.reviewed_at,
        citation.reviewed_at,
        evidence_source.retrieved_at,
        evidence_source.last_checked_at
      )) AS material_at
      FROM fitment_evidence
      INNER JOIN source_citations AS citation
        ON citation.id = fitment_evidence.source_citation_id
        AND citation.review_status = 'accepted'
        AND citation.reviewed_by IS NOT NULL
        AND citation.reviewed_at IS NOT NULL
        AND (
          (
            citation.entity_type = 'fitment_evidence'
            AND citation.entity_id = fitment_evidence.id
            AND citation.field_path = 'observation'
          )
          OR (
            fitment_evidence.evidence_kind = 'creator_claim'
            AND citation.entity_type = 'design_revision'
            AND citation.entity_id = catalogue.revision_id
            AND citation.field_path = 'claimed_compatibility'
            AND citation.source_id = catalogue.source_id
          )
        )
      INNER JOIN sources AS evidence_source
        ON evidence_source.id = citation.source_id
        AND evidence_source.status = 'live'
        AND evidence_source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS evidence_policy
        ON evidence_policy.platform = evidence_source.platform
        AND evidence_policy.policy <> 'blocked'
        AND evidence_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE fitment_evidence.fitment_id = catalogue.fitment_id
        AND fitment_evidence.moderation_status = 'accepted'
        AND fitment_evidence.reviewed_by IS NOT NULL
        AND fitment_evidence.reviewed_at IS NOT NULL
    ) AS evidence ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'material', print_recipe.material,
        'nozzleMm', print_recipe.nozzle_mm,
        'layerHeightMm', print_recipe.layer_height_mm,
        'wallCount', print_recipe.wall_count,
        'infillPercent', print_recipe.infill_percent,
        'supports', print_recipe.supports,
        'orientation', print_recipe.orientation,
        'hardware', print_recipe.hardware,
        'estimatedMinutes', print_recipe.estimated_minutes,
        'provenance', print_recipe.provenance,
        'citation', jsonb_build_object(
          'sourceTitle', recipe_source.title,
          'sourceUrl', recipe_source.canonical_url,
          'sourceAvailable', true,
          'locator', recipe_citation.locator,
          'retrievedAt', recipe_source.retrieved_at,
          'lastCheckedAt', recipe_source.last_checked_at
        )
      ) AS item,
      GREATEST(
        recipe_citation.reviewed_at,
        recipe_source.retrieved_at,
        recipe_source.last_checked_at
      ) AS material_at
      FROM print_recipes AS print_recipe
      INNER JOIN source_citations AS recipe_citation
        ON recipe_citation.id = print_recipe.source_citation_id
        AND recipe_citation.entity_type = 'print_recipe'
        AND recipe_citation.entity_id = print_recipe.id
        AND recipe_citation.field_path = 'settings'
        AND recipe_citation.review_status = 'accepted'
        AND recipe_citation.reviewed_by IS NOT NULL
        AND recipe_citation.reviewed_at IS NOT NULL
      INNER JOIN sources AS recipe_source
        ON recipe_source.id = recipe_citation.source_id
        AND recipe_source.status = 'live'
        AND recipe_source.source_type <> 'demo'
      INNER JOIN source_platform_policies AS recipe_policy
        ON recipe_policy.platform = recipe_source.platform
        AND recipe_policy.policy <> 'blocked'
        AND recipe_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
      WHERE print_recipe.fitment_id = catalogue.fitment_id
      LIMIT 1
    ) AS recipe ON true
    WHERE catalogue.design_id = ${designId}
      AND catalogue.component_id = ${componentId}
    ORDER BY catalogue.source_revision DESC, catalogue.brand_name, catalogue.model_name, catalogue.fitment_public_id
  `;
}

function toModel(row: ModelRow): CatalogModel {
  return {
    ...row,
    identifiers: row.identifiers.map((identifier) => ({
      ...identifier,
      citation: identifier.citation ? normalizeCitation(identifier.citation) : null,
    })),
    publishedAt: iso(row.publishedAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toPartSummary(row: PartSummaryRow): CatalogPartSummary {
  return {
    ...row,
    name: row.componentName,
    safetyClass: "low",
    sourceLastCheckedAt: iso(row.sourceLastCheckedAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toPart(canonicalSlug: string, rows: FitmentRow[]): CatalogPart {
  const anchor = rows.find((row) => row.fitment_slug === canonicalSlug) ?? rows[0]!;
  const oemParts = uniqueBy(
    rows.flatMap((row) => row.oem_public_id && row.oem_part_number && row.oem_part_name && row.oem_citations.length > 0
      ? [{
          publicId: row.oem_public_id,
          partNumber: row.oem_part_number,
          name: row.oem_part_name,
          citations: uniqueBy(row.oem_citations, (citation) => `${citation.sourceUrl ?? ""}:${citation.locator ?? ""}`),
        }]
      : []),
    (part) => part.publicId,
  );
  const commonNameCitation = anchor.component_alias_citation;

  return {
    canonicalSlug,
    name: anchor.component_name,
    componentSlug: anchor.component_slug,
    commonNames: commonNameCitation ? anchor.component_common_names : [],
    commonNameCitation,
    oemParts,
    design: {
      id: anchor.design_id,
      publicId: anchor.design_public_id,
      title: anchor.design_title,
      creator: anchor.creator_name,
      creatorPlatform: anchor.creator_platform,
      creatorProfileUrl: anchor.creator_profile_url,
    },
    fitments: rows.map(toFitment),
    updatedAt: iso(new Date(Math.max(...rows.map((row) => timestampMillis(row.material_updated_at))))),
  };
}

function toFitment(row: FitmentRow): CatalogFitment {
  return {
    id: row.fitment_id,
    publicId: row.fitment_public_id,
    slug: row.fitment_slug,
    status: row.fitment_status,
    model: {
      id: row.model_id,
      publicId: row.model_public_id,
      brandName: row.brand_name,
      brandSlug: row.brand_slug,
      modelName: row.model_name,
      modelSlug: row.model_slug,
      serialFrom: row.serial_from,
      serialTo: row.serial_to,
    },
    revision: {
      id: row.revision_id,
      label: row.source_revision,
      licenseCode: row.license_code,
      licenseVersion: row.license_version,
      licenseUrl: row.license_url,
      licenseEvidenceUrl: row.license_evidence_url,
      attributionText: row.attribution_text,
      fileFormats: row.file_formats,
      rightsCheckedAt: iso(row.rights_checked_at),
    },
    source: {
      title: row.source_title,
      platform: row.source_platform,
      url: row.source_url,
      publisher: row.source_publisher,
      retrievedAt: iso(row.source_retrieved_at),
      lastCheckedAt: iso(row.source_last_checked_at),
      available: true,
    },
    safety: {
      safetyClass: row.safety_class,
      signals: row.safety_signals,
      failureConsequence: row.failure_consequence,
      rationale: row.safety_rationale,
      rulesetVersion: row.safety_ruleset_version,
      reviewedAt: iso(row.safety_reviewed_at),
    },
    evidence: row.evidence.map((item) => ({
      ...item,
      citation: item.citation ? normalizeCitation(item.citation) : null,
    })),
    printRecipe: row.print_recipe ? {
      ...row.print_recipe,
      citation: row.print_recipe.citation ? normalizeCitation(row.print_recipe.citation) : null,
    } : null,
    publishedAt: iso(row.fitment_published_at),
    updatedAt: iso(row.material_updated_at),
  };
}

function toUnavailablePart(row: UnavailableRow): UnavailableCatalogPart {
  return {
    slug: row.fitment_slug,
    publicId: row.fitment_public_id,
    name: row.component_name,
    designTitle: row.design_title,
    creator: row.creator_name,
    modelLabel: `${row.brand_name} ${row.model_name}`,
    sourceTitle: row.source_title,
    sourceLastCheckedAt: iso(row.source_last_checked_at),
    reason: row.unavailable_reason,
    updatedAt: iso(row.fitment_updated_at),
  };
}

function normalizeCitation(citation: PublicCitation): PublicCitation {
  return {
    ...citation,
    retrievedAt: iso(citation.retrievedAt),
    lastCheckedAt: iso(citation.lastCheckedAt),
  };
}

function iso(value: DatabaseTimestamp): string {
  return value instanceof Date ? value.toISOString() : value;
}

function timestampMillis(value: DatabaseTimestamp): number {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(milliseconds)) throw new Error("Public catalogue query returned an invalid timestamp.");
  return milliseconds;
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}
