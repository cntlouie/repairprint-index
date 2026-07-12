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
  publishedAt: Date;
  updatedAt: Date;
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
  fitmentStatus: CatalogPartSummary["fitmentStatus"];
  material: string | null;
  updatedAt: Date;
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
  fitment_published_at: Date;
  fitment_updated_at: Date;
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
  rights_checked_at: Date;
  creator_name: string;
  creator_platform: string;
  creator_profile_url: string | null;
  source_platform: string;
  source_url: string;
  source_publisher: string | null;
  source_title: string;
  source_retrieved_at: Date;
  source_last_checked_at: Date;
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
  oem_public_id: string | null;
  oem_part_number: string | null;
  oem_part_name: string | null;
  safety_class: "low";
  safety_signals: string[];
  failure_consequence: string;
  safety_rationale: string;
  safety_ruleset_version: string;
  safety_reviewed_at: Date;
  evidence: CatalogEvidence[];
  print_recipe: CatalogPrintRecipe | null;
}

interface UnavailableRow {
  fitment_public_id: string;
  fitment_slug: string;
  fitment_updated_at: Date;
  design_title: string;
  creator_name: string;
  source_title: string;
  source_last_checked_at: Date;
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
  const [row] = await modelRows(brandSlug, modelSlug, 1);
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
  return location ? { kind: "redirect", location } : { kind: "not_found" };
}

export async function getCatalogInvalidationContextFromDatabase(
  fitmentId: string,
): Promise<CatalogInvalidationContext> {
  const rows = await databaseClient<Array<{ partSlug: string; canonicalSlug: string; brandSlug: string; modelSlug: string }>>`
    WITH target AS (
      SELECT revision.design_id, product_component.component_id
      FROM fitments AS fitment
      INNER JOIN design_revisions AS revision ON revision.id = fitment.design_revision_id
      INNER JOIN product_components AS product_component ON product_component.id = fitment.product_component_id
      WHERE fitment.id = ${fitmentId}
    )
    SELECT DISTINCT
      grouped_fitment.slug AS "partSlug",
      canonical.slug AS "canonicalSlug",
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
    INNER JOIN LATERAL (
      SELECT canonical_fitment.slug
      FROM fitments AS canonical_fitment
      INNER JOIN design_revisions AS canonical_revision ON canonical_revision.id = canonical_fitment.design_revision_id
      INNER JOIN product_components AS canonical_component ON canonical_component.id = canonical_fitment.product_component_id
      WHERE canonical_revision.design_id = target.design_id
        AND canonical_component.component_id = target.component_id
        AND canonical_fitment.published_at IS NOT NULL
      ORDER BY canonical_fitment.published_at, canonical_fitment.public_id
      LIMIT 1
    ) AS canonical ON true
    ORDER BY brand.slug, model.slug, grouped_fitment.slug
  `;

  return {
    modelPaths: uniqueBy(rows.map(({ brandSlug, modelSlug }) => ({ brandSlug, modelSlug })), ({ brandSlug, modelSlug }) => `${brandSlug}/${modelSlug}`),
    partSlugs: [...new Set(rows.flatMap((row) => [row.partSlug, row.canonicalSlug]))],
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
      catalogue.model_updated_at AS "updatedAt",
      COALESCE(identifier.identifiers, '[]'::jsonb) AS identifiers
    FROM public_catalogue_fitments AS catalogue
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'displayValue', identifier.display_value,
          'identifierType', identifier.identifier_type,
          'marketCode', identifier.market_code,
          'citation', CASE WHEN citation.id IS NULL OR source.source_type = 'demo' THEN NULL ELSE jsonb_build_object(
            'sourceTitle', source.title,
            'sourceUrl', CASE WHEN source.status = 'live' THEN source.canonical_url ELSE NULL END,
            'sourceAvailable', source.status = 'live',
            'locator', citation.locator,
            'retrievedAt', source.retrieved_at,
            'lastCheckedAt', source.last_checked_at
          ) END
        ) ORDER BY identifier.display_value
      ) AS identifiers
      FROM product_identifiers AS identifier
      LEFT JOIN source_citations AS citation
        ON citation.entity_type = 'product_identifier'
        AND citation.entity_id = identifier.id
        AND citation.review_status = 'accepted'
      LEFT JOIN sources AS source ON source.id = citation.source_id
      WHERE identifier.product_model_id = catalogue.model_id
    ) AS identifier ON true
    WHERE (${brandSlug ?? null}::text IS NULL OR catalogue.brand_slug = ${brandSlug ?? null})
      AND (${modelSlug ?? null}::text IS NULL OR catalogue.model_slug = ${modelSlug ?? null})
    ORDER BY catalogue.model_id, catalogue.brand_name, catalogue.model_name
    LIMIT ${Math.max(1, Math.min(limit, 100))}
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
      catalogue.fitment_status AS "fitmentStatus",
      recipe.material,
      catalogue.fitment_updated_at AS "updatedAt"
    FROM public_catalogue_fitments AS catalogue
    LEFT JOIN print_recipes AS recipe ON recipe.fitment_id = catalogue.fitment_id
    WHERE (${modelId ?? null}::uuid IS NULL OR catalogue.model_id = ${modelId ?? null})
    ORDER BY
      CASE catalogue.fitment_status
        WHEN 'verified_fit' THEN 0
        WHEN 'community_confirmed' THEN 1
        ELSE 2
      END,
      catalogue.fitment_updated_at DESC,
      catalogue.fitment_public_id
    LIMIT ${Math.max(1, Math.min(limit, 250))}
  `;
}

async function fitmentRows(designId: string, componentId: string): Promise<FitmentRow[]> {
  return databaseClient<FitmentRow[]>`
    SELECT
      catalogue.*,
      COALESCE(evidence.items, '[]'::jsonb) AS evidence,
      recipe.item AS print_recipe
    FROM public_catalogue_fitments AS catalogue
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
          'citation', CASE WHEN citation.id IS NULL OR evidence_source.source_type = 'demo' THEN NULL ELSE jsonb_build_object(
            'sourceTitle', evidence_source.title,
            'sourceUrl', CASE WHEN evidence_source.status = 'live' THEN evidence_source.canonical_url ELSE NULL END,
            'sourceAvailable', evidence_source.status = 'live',
            'locator', citation.locator,
            'retrievedAt', evidence_source.retrieved_at,
            'lastCheckedAt', evidence_source.last_checked_at
          ) END
        ) ORDER BY fitment_evidence.observed_at DESC, fitment_evidence.id
      ) AS items
      FROM fitment_evidence
      LEFT JOIN source_citations AS citation
        ON citation.id = fitment_evidence.source_citation_id
        AND citation.review_status = 'accepted'
      LEFT JOIN sources AS evidence_source ON evidence_source.id = citation.source_id
      WHERE fitment_evidence.fitment_id = catalogue.fitment_id
        AND fitment_evidence.moderation_status = 'accepted'
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
        'citation', CASE WHEN recipe_citation.id IS NULL OR recipe_source.source_type = 'demo' THEN NULL ELSE jsonb_build_object(
          'sourceTitle', recipe_source.title,
          'sourceUrl', CASE WHEN recipe_source.status = 'live' THEN recipe_source.canonical_url ELSE NULL END,
          'sourceAvailable', recipe_source.status = 'live',
          'locator', recipe_citation.locator,
          'retrievedAt', recipe_source.retrieved_at,
          'lastCheckedAt', recipe_source.last_checked_at
        ) END
      ) AS item
      FROM print_recipes AS print_recipe
      LEFT JOIN source_citations AS recipe_citation
        ON recipe_citation.id = print_recipe.source_citation_id
        AND recipe_citation.review_status = 'accepted'
      LEFT JOIN sources AS recipe_source ON recipe_source.id = recipe_citation.source_id
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
    updatedAt: iso(row.updatedAt),
  };
}

function toPart(canonicalSlug: string, rows: FitmentRow[]): CatalogPart {
  const anchor = rows.find((row) => row.fitment_slug === canonicalSlug) ?? rows[0]!;
  const oemParts = uniqueBy(
    rows.flatMap((row) => row.oem_public_id && row.oem_part_number && row.oem_part_name
      ? [{ publicId: row.oem_public_id, partNumber: row.oem_part_number, name: row.oem_part_name }]
      : []),
    (part) => part.publicId,
  );

  return {
    canonicalSlug,
    name: anchor.component_name,
    componentSlug: anchor.component_slug,
    commonNames: anchor.component_common_names,
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
    updatedAt: iso(new Date(Math.max(...rows.map((row) => row.fitment_updated_at.getTime())))),
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
    updatedAt: iso(row.fitment_updated_at),
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

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
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
