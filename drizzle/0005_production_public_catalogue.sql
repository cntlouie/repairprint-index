CREATE VIEW "public"."public_catalogue_fitments" WITH (security_barrier = true) AS
SELECT
  fitment.id AS "fitment_id",
  fitment.public_id AS "fitment_public_id",
  fitment.slug AS "fitment_slug",
  canonical.canonical_slug AS "canonical_slug",
  fitment.confidence_level AS "fitment_status",
  fitment.published_at AS "fitment_published_at",
  fitment.updated_at AS "fitment_updated_at",
  design.id AS "design_id",
  design.public_id AS "design_public_id",
  design.slug AS "design_slug",
  design.title AS "design_title",
  revision.id AS "revision_id",
  revision.source_revision AS "source_revision",
  revision.license_code AS "license_code",
  revision.license_version AS "license_version",
  revision.license_url AS "license_url",
  revision.license_evidence_url AS "license_evidence_url",
  revision.attribution_text AS "attribution_text",
  revision.file_formats AS "file_formats",
  revision.rights_checked_at AS "rights_checked_at",
  creator.id AS "creator_id",
  creator.display_name AS "creator_name",
  creator.platform AS "creator_platform",
  creator.external_profile_url AS "creator_profile_url",
  source.id AS "source_id",
  source.platform AS "source_platform",
  source.canonical_url AS "source_url",
  source.publisher AS "source_publisher",
  source.title AS "source_title",
  source.retrieved_at AS "source_retrieved_at",
  source.last_checked_at AS "source_last_checked_at",
  product_component.id AS "product_component_id",
  product_component.serial_from AS "serial_from",
  product_component.serial_to AS "serial_to",
  model.id AS "model_id",
  model.public_id AS "model_public_id",
  model.model_name AS "model_name",
  model.slug AS "model_slug",
  model.market_codes AS "market_codes",
  model.label_location AS "label_location",
  model.published_at AS "model_published_at",
  model.updated_at AS "model_updated_at",
  brand.id AS "brand_id",
  brand.name AS "brand_name",
  brand.slug AS "brand_slug",
  category.id AS "category_id",
  category.name AS "category_name",
  category.slug AS "category_slug",
  component.id AS "component_id",
  component.name AS "component_name",
  component.slug AS "component_slug",
  component.common_names AS "component_common_names",
  oem.id AS "oem_part_id",
  oem.public_id AS "oem_public_id",
  oem.part_number_display AS "oem_part_number",
  oem.name AS "oem_part_name",
  safety.safety_class AS "safety_class",
  safety.signals AS "safety_signals",
  safety.failure_consequence AS "failure_consequence",
  safety.rationale AS "safety_rationale",
  safety.ruleset_version AS "safety_ruleset_version",
  safety.reviewed_at AS "safety_reviewed_at"
FROM "public"."fitments" AS fitment
INNER JOIN "public"."design_revisions" AS revision ON revision.id = fitment.design_revision_id
INNER JOIN "public"."designs" AS design ON design.id = revision.design_id
INNER JOIN "public"."creators" AS creator ON creator.id = design.creator_id
INNER JOIN "public"."sources" AS source ON source.id = revision.source_id
INNER JOIN "public"."source_platform_policies" AS policy ON policy.platform = source.platform
INNER JOIN "public"."product_components" AS product_component ON product_component.id = fitment.product_component_id
INNER JOIN "public"."product_models" AS model ON model.id = product_component.product_model_id
INNER JOIN "public"."brands" AS brand ON brand.id = model.brand_id
INNER JOIN "public"."categories" AS category ON category.id = model.category_id
INNER JOIN "public"."components" AS component ON component.id = product_component.component_id
LEFT JOIN "public"."oem_parts" AS oem ON oem.id = product_component.oem_part_id
INNER JOIN "public"."safety_reviews" AS safety ON safety.product_component_id = product_component.id
  AND safety.ruleset_version = 'safety-v1'
INNER JOIN LATERAL (
  SELECT grouped_fitment.slug AS canonical_slug
  FROM "public"."fitments" AS grouped_fitment
  INNER JOIN "public"."design_revisions" AS grouped_revision
    ON grouped_revision.id = grouped_fitment.design_revision_id
  INNER JOIN "public"."product_components" AS grouped_component
    ON grouped_component.id = grouped_fitment.product_component_id
  WHERE grouped_revision.design_id = design.id
    AND grouped_component.component_id = component.id
    AND grouped_fitment.published_at IS NOT NULL
  ORDER BY grouped_fitment.published_at, grouped_fitment.public_id
  LIMIT 1
) AS canonical ON true
WHERE fitment.publication_status = 'published'
  AND fitment.confidence_level IN ('verified_fit', 'community_confirmed', 'creator_listed')
  AND fitment.confidence_version = 'fitment-v1'
  AND fitment.published_at IS NOT NULL
  AND fitment.reviewed_by IS NOT NULL
  AND fitment.reviewed_at IS NOT NULL
  AND design.publication_status = 'published'
  AND design.availability_status = 'available'
  AND source.status = 'live'
  AND source.source_type <> 'demo'
  AND policy.policy <> 'blocked'
  AND policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
  AND btrim(creator.display_name) <> ''
  AND btrim(revision.source_revision) <> ''
  AND btrim(revision.license_code) <> ''
  AND btrim(revision.attribution_text) <> ''
  AND product_component.mapping_status = 'accepted'
  AND model.publication_status = 'published'
  AND model.published_at IS NOT NULL
  AND brand.publication_status = 'published'
  AND (oem.id IS NULL OR oem.publication_status = 'published')
  AND safety.safety_class = 'low'
  AND safety.reviewed_by IS NOT NULL
  AND safety.reviewed_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "public"."source_citations" AS citation
    WHERE citation.entity_type = 'design_revision'
      AND citation.entity_id = revision.id
      AND citation.review_status = 'accepted'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "public"."source_citations" AS citation
    WHERE citation.entity_type = 'design_revision'
      AND citation.entity_id = revision.id
      AND citation.review_status <> 'accepted'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "public"."submissions" AS notice
    WHERE notice.kind = 'rights_or_safety_notice'
      AND notice.status IN ('pending', 'in_review')
      AND notice.matched_entity_id IN (design.id, fitment.id)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "public"."fitment_evidence" AS evidence
    WHERE evidence.fitment_id = fitment.id
      AND evidence.moderation_status = 'accepted'
      AND evidence.exact_model = true
      AND evidence.exact_design_revision = true
      AND evidence.outcome = 'does_not_fit'
  )
  AND (
    (
      fitment.confidence_level = 'verified_fit'
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.evidence_kind = 'trusted_physical_test'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome = 'fits_without_modification'
      )
    )
    OR (
      fitment.confidence_level = 'community_confirmed'
      AND 2 <= (
        SELECT count(DISTINCT evidence.actor_independence_key)
        FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.evidence_kind = 'community_report'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome IN ('fits_without_modification', 'fits_after_modification')
          AND evidence.actor_independence_key IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.evidence_kind = 'community_report'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome IN ('fits_without_modification', 'fits_after_modification')
          AND evidence.has_installed_photo = true
      )
    )
    OR (
      fitment.confidence_level = 'creator_listed'
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.evidence_kind = 'creator_claim'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
      )
    )
  );--> statement-breakpoint

CREATE VIEW "public"."public_catalogue_unavailable_sources" WITH (security_barrier = true) AS
SELECT
  fitment.id AS "fitment_id",
  fitment.public_id AS "fitment_public_id",
  fitment.slug AS "fitment_slug",
  fitment.updated_at AS "fitment_updated_at",
  design.public_id AS "design_public_id",
  design.title AS "design_title",
  creator.display_name AS "creator_name",
  source.title AS "source_title",
  source.last_checked_at AS "source_last_checked_at",
  component.name AS "component_name",
  component.slug AS "component_slug",
  model.public_id AS "model_public_id",
  model.model_name AS "model_name",
  model.slug AS "model_slug",
  brand.name AS "brand_name",
  brand.slug AS "brand_slug",
  CASE
    WHEN source.status <> 'live' THEN 'source_removed'
    ELSE 'design_unavailable'
  END AS "unavailable_reason"
FROM "public"."fitments" AS fitment
INNER JOIN "public"."design_revisions" AS revision ON revision.id = fitment.design_revision_id
INNER JOIN "public"."designs" AS design ON design.id = revision.design_id
INNER JOIN "public"."creators" AS creator ON creator.id = design.creator_id
INNER JOIN "public"."sources" AS source ON source.id = revision.source_id
INNER JOIN "public"."source_platform_policies" AS policy ON policy.platform = source.platform
INNER JOIN "public"."product_components" AS product_component ON product_component.id = fitment.product_component_id
INNER JOIN "public"."product_models" AS model ON model.id = product_component.product_model_id
INNER JOIN "public"."brands" AS brand ON brand.id = model.brand_id
INNER JOIN "public"."components" AS component ON component.id = product_component.component_id
LEFT JOIN "public"."oem_parts" AS oem ON oem.id = product_component.oem_part_id
INNER JOIN "public"."safety_reviews" AS safety ON safety.product_component_id = product_component.id
  AND safety.ruleset_version = 'safety-v1'
WHERE fitment.publication_status = 'published'
  AND fitment.confidence_level IN ('verified_fit', 'community_confirmed', 'creator_listed')
  AND fitment.confidence_version = 'fitment-v1'
  AND fitment.published_at IS NOT NULL
  AND fitment.reviewed_by IS NOT NULL
  AND fitment.reviewed_at IS NOT NULL
  AND design.publication_status = 'published'
  AND (design.availability_status <> 'available' OR source.status <> 'live')
  AND source.source_type <> 'demo'
  AND policy.policy <> 'blocked'
  AND policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
  AND btrim(creator.display_name) <> ''
  AND btrim(revision.source_revision) <> ''
  AND btrim(revision.license_code) <> ''
  AND btrim(revision.attribution_text) <> ''
  AND product_component.mapping_status = 'accepted'
  AND model.publication_status = 'published'
  AND model.published_at IS NOT NULL
  AND brand.publication_status = 'published'
  AND (oem.id IS NULL OR oem.publication_status = 'published')
  AND safety.safety_class = 'low'
  AND safety.reviewed_by IS NOT NULL
  AND safety.reviewed_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "public"."source_citations" AS citation
    WHERE citation.entity_type = 'design_revision'
      AND citation.entity_id = revision.id
      AND citation.review_status = 'accepted'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "public"."source_citations" AS citation
    WHERE citation.entity_type = 'design_revision'
      AND citation.entity_id = revision.id
      AND citation.review_status <> 'accepted'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "public"."submissions" AS notice
    WHERE notice.kind = 'rights_or_safety_notice'
      AND notice.status IN ('pending', 'in_review')
      AND notice.matched_entity_id IN (design.id, fitment.id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM "public"."fitment_evidence" AS evidence
    WHERE evidence.fitment_id = fitment.id
      AND evidence.moderation_status = 'accepted'
      AND evidence.exact_model = true
      AND evidence.exact_design_revision = true
      AND evidence.outcome = 'does_not_fit'
  )
  AND (
    (
      fitment.confidence_level = 'verified_fit'
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.evidence_kind = 'trusted_physical_test'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome = 'fits_without_modification'
      )
    )
    OR (
      fitment.confidence_level = 'community_confirmed'
      AND 2 <= (
        SELECT count(DISTINCT evidence.actor_independence_key)
        FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.evidence_kind = 'community_report'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome IN ('fits_without_modification', 'fits_after_modification')
          AND evidence.actor_independence_key IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.evidence_kind = 'community_report'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome IN ('fits_without_modification', 'fits_after_modification')
          AND evidence.has_installed_photo = true
      )
    )
    OR (
      fitment.confidence_level = 'creator_listed'
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.evidence_kind = 'creator_claim'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
      )
    )
  );--> statement-breakpoint

DROP MATERIALIZED VIEW "public"."public_search_documents";--> statement-breakpoint

CREATE MATERIALIZED VIEW "public"."public_search_documents" AS
SELECT DISTINCT ON (catalogue.model_id)
  'model'::text AS "entity_type",
  catalogue.model_id AS "entity_id",
  catalogue.brand_id AS "brand_id",
  catalogue.brand_name AS "brand_name",
  catalogue.brand_slug AS "brand_slug",
  catalogue.model_name AS "model_name",
  catalogue.model_slug AS "model_slug",
  NULL::text AS "component_name",
  NULL::text AS "component_slug",
  catalogue.brand_name || ' ' || catalogue.model_name AS "title",
  catalogue.category_name AS "subtitle",
  '/brands/' || catalogue.brand_slug || '/' || catalogue.model_slug AS "href",
  COALESCE(identifier.strict_keys, ARRAY[]::text[]) AS "strict_keys",
  COALESCE(identifier.loose_keys, ARRAY[]::text[]) AS "loose_keys",
  ARRAY[]::text[] AS "component_terms",
  lower(concat_ws(' ', catalogue.brand_name, catalogue.model_name, identifier.display_values)) AS "search_text"
FROM "public"."public_catalogue_fitments" AS catalogue
LEFT JOIN LATERAL (
  SELECT
    array_agg(DISTINCT product_identifier.strict_key) AS strict_keys,
    array_agg(DISTINCT product_identifier.loose_key) AS loose_keys,
    string_agg(DISTINCT product_identifier.display_value, ' ') AS display_values
  FROM "public"."product_identifiers" AS product_identifier
  WHERE product_identifier.product_model_id = catalogue.model_id
) AS identifier ON true

UNION ALL

SELECT
  'part'::text AS "entity_type",
  catalogue.fitment_id AS "entity_id",
  catalogue.brand_id AS "brand_id",
  catalogue.brand_name AS "brand_name",
  catalogue.brand_slug AS "brand_slug",
  catalogue.model_name AS "model_name",
  catalogue.model_slug AS "model_slug",
  catalogue.component_name AS "component_name",
  catalogue.component_slug AS "component_slug",
  catalogue.component_name AS "title",
  concat_ws(' · ', catalogue.brand_name || ' ' || catalogue.model_name, CASE WHEN catalogue.oem_part_id IS NOT NULL THEN 'OEM ' || catalogue.oem_part_number END) AS "subtitle",
  '/parts/' || catalogue.canonical_slug AS "href",
  CASE WHEN catalogue.oem_part_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[(SELECT strict_part_key FROM "public"."oem_parts" WHERE id = catalogue.oem_part_id)] END AS "strict_keys",
  CASE WHEN catalogue.oem_part_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[(SELECT loose_part_key FROM "public"."oem_parts" WHERE id = catalogue.oem_part_id)] END AS "loose_keys",
  ARRAY[catalogue.component_name] || ARRAY(SELECT jsonb_array_elements_text(catalogue.component_common_names)) AS "component_terms",
  lower(concat_ws(' ', catalogue.brand_name, catalogue.model_name, identifier.display_values, catalogue.component_name,
    array_to_string(ARRAY(SELECT jsonb_array_elements_text(catalogue.component_common_names)), ' '), catalogue.oem_part_number, catalogue.oem_part_name, catalogue.design_title)) AS "search_text"
FROM "public"."public_catalogue_fitments" AS catalogue
LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT product_identifier.display_value, ' ') AS display_values
  FROM "public"."product_identifiers" AS product_identifier
  WHERE product_identifier.product_model_id = catalogue.model_id
) AS identifier ON true;--> statement-breakpoint

CREATE UNIQUE INDEX "public_search_documents_entity_uq" ON "public"."public_search_documents" ("entity_type", "entity_id");--> statement-breakpoint
CREATE INDEX "public_search_documents_strict_keys_idx" ON "public"."public_search_documents" USING gin ("strict_keys");--> statement-breakpoint
CREATE INDEX "public_search_documents_loose_keys_idx" ON "public"."public_search_documents" USING gin ("loose_keys");--> statement-breakpoint
CREATE INDEX "public_search_documents_text_trgm_idx" ON "public"."public_search_documents" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT ON "public"."public_catalogue_fitments", "public"."public_catalogue_unavailable_sources", "public"."public_search_documents" TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON "public"."public_catalogue_fitments", "public"."public_catalogue_unavailable_sources", "public"."public_search_documents" TO authenticated;
  END IF;
END;
$$;
