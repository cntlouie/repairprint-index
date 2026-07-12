CREATE VIEW "public"."public_catalogue_fitments" WITH (security_barrier = true) AS
WITH accepted_public_claims AS MATERIALIZED (
  SELECT
    citation.id,
    citation.entity_type,
    citation.entity_id,
    citation.field_path,
    citation.source_id
  FROM "public"."source_citations" AS citation
  INNER JOIN "public"."sources" AS citation_source ON citation_source.id = citation.source_id
  INNER JOIN "public"."source_platform_policies" AS citation_policy ON citation_policy.platform = citation_source.platform
  WHERE citation.review_status = 'accepted'
    AND citation.reviewed_by IS NOT NULL
    AND citation.reviewed_at IS NOT NULL
    AND citation_source.status = 'live'
    AND citation_source.source_type <> 'demo'
    AND citation_policy.policy <> 'blocked'
    AND citation_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
),
eligible_catalogue AS (
SELECT
  fitment.id AS "fitment_id",
  fitment.public_id AS "fitment_public_id",
  fitment.slug AS "fitment_slug",
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
  NULL::text AS "creator_profile_url",
  source.id AS "source_id",
  source.platform AS "source_platform",
  source.canonical_url AS "source_url",
  source.publisher AS "source_publisher",
  source.title AS "source_title",
  source.retrieved_at AS "source_retrieved_at",
  source.last_checked_at AS "source_last_checked_at",
  product_component.id AS "product_component_id",
  CASE WHEN EXISTS (
    SELECT 1 FROM accepted_public_claims AS claim
    WHERE claim.entity_type = 'product_component'
      AND claim.entity_id = product_component.id
      AND claim.field_path = 'serial_range'
  ) THEN product_component.serial_from ELSE NULL END AS "serial_from",
  CASE WHEN EXISTS (
    SELECT 1 FROM accepted_public_claims AS claim
    WHERE claim.entity_type = 'product_component'
      AND claim.entity_id = product_component.id
      AND claim.field_path = 'serial_range'
  ) THEN product_component.serial_to ELSE NULL END AS "serial_to",
  model.id AS "model_id",
  model.public_id AS "model_public_id",
  model.model_name AS "model_name",
  model.slug AS "model_slug",
  CASE WHEN EXISTS (
    SELECT 1 FROM accepted_public_claims AS claim
    WHERE claim.entity_type = 'product_model'
      AND claim.entity_id = model.id
      AND claim.field_path = 'market_codes'
  ) THEN model.market_codes ELSE '[]'::jsonb END AS "market_codes",
  CASE WHEN EXISTS (
    SELECT 1 FROM accepted_public_claims AS claim
    WHERE claim.entity_type = 'product_model'
      AND claim.entity_id = model.id
      AND claim.field_path = 'label_location'
  ) THEN model.label_location ELSE NULL END AS "label_location",
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
  CASE WHEN EXISTS (
    SELECT 1 FROM accepted_public_claims AS claim
    WHERE claim.entity_type = 'component'
      AND claim.entity_id = component.id
      AND claim.field_path = 'common_names'
  ) THEN component.common_names ELSE '[]'::jsonb END AS "component_common_names",
  public_oem.id AS "oem_part_id",
  public_oem.public_id AS "oem_public_id",
  public_oem.part_number_display AS "oem_part_number",
  public_oem.name AS "oem_part_name",
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
LEFT JOIN LATERAL (
  SELECT oem.id, oem.public_id, oem.part_number_display, oem.name
  WHERE oem.id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM accepted_public_claims AS claim
        WHERE claim.entity_type = 'oem_part'
          AND claim.entity_id = oem.id
          AND claim.field_path = 'record'
      )
      OR (
        EXISTS (
          SELECT 1 FROM accepted_public_claims AS claim
          WHERE claim.entity_type = 'oem_part'
            AND claim.entity_id = oem.id
            AND claim.field_path = 'part_number_display'
        )
        AND EXISTS (
          SELECT 1 FROM accepted_public_claims AS claim
          WHERE claim.entity_type = 'oem_part'
            AND claim.entity_id = oem.id
            AND claim.field_path = 'name'
        )
      )
    )
) AS public_oem ON true
INNER JOIN "public"."safety_reviews" AS safety ON safety.product_component_id = product_component.id
  AND safety.ruleset_version = 'safety-v1'
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
  AND revision.rights_checked_by IS NOT NULL
  AND product_component.mapping_status = 'accepted'
  AND EXISTS (
    SELECT 1 FROM accepted_public_claims AS claim
    WHERE claim.entity_type = 'product_component'
      AND claim.entity_id = product_component.id
      AND claim.field_path = 'mapping'
      AND (product_component.source_citation_id IS NULL OR claim.id = product_component.source_citation_id)
  )
  AND model.publication_status = 'published'
  AND model.published_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM accepted_public_claims AS claim
    WHERE claim.entity_type = 'product_model'
      AND claim.entity_id = model.id
      AND claim.field_path = 'model_name'
  )
  AND EXISTS (
    SELECT 1
    FROM "public"."product_identifiers" AS primary_identifier
    INNER JOIN accepted_public_claims AS claim
      ON claim.entity_type = 'product_identifier'
      AND claim.entity_id = primary_identifier.id
      AND claim.field_path = 'display_value'
    WHERE primary_identifier.product_model_id = model.id
      AND primary_identifier.identifier_type IN ('model_number', 'label')
      AND (primary_identifier.source_citation_id IS NULL OR claim.id = primary_identifier.source_citation_id)
  )
  AND brand.publication_status = 'published'
  AND (oem.id IS NULL OR oem.publication_status = 'published')
  AND safety.safety_class = 'low'
  AND safety.reviewed_by IS NOT NULL
  AND safety.reviewed_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM accepted_public_claims AS citation
    WHERE citation.entity_type = 'design_revision'
      AND citation.entity_id = revision.id
      AND citation.field_path = 'claimed_compatibility'
      AND citation.source_id = revision.source_id
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
          AND evidence.reviewed_by IS NOT NULL
          AND evidence.reviewed_at IS NOT NULL
          AND evidence.evidence_kind = 'trusted_physical_test'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome = 'fits_without_modification'
          AND EXISTS (
            SELECT 1 FROM accepted_public_claims AS claim
            WHERE claim.id = evidence.source_citation_id
              AND claim.entity_type = 'fitment_evidence'
              AND claim.entity_id = evidence.id
              AND claim.field_path = 'observation'
          )
      )
    )
    OR (
      fitment.confidence_level = 'community_confirmed'
      AND 2 <= (
        SELECT count(DISTINCT evidence.actor_independence_key)
        FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.reviewed_by IS NOT NULL
          AND evidence.reviewed_at IS NOT NULL
          AND evidence.evidence_kind = 'community_report'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome IN ('fits_without_modification', 'fits_after_modification')
          AND evidence.actor_independence_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM accepted_public_claims AS claim
            WHERE claim.id = evidence.source_citation_id
              AND claim.entity_type = 'fitment_evidence'
              AND claim.entity_id = evidence.id
              AND claim.field_path = 'observation'
          )
      )
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.reviewed_by IS NOT NULL
          AND evidence.reviewed_at IS NOT NULL
          AND evidence.evidence_kind = 'community_report'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome IN ('fits_without_modification', 'fits_after_modification')
          AND evidence.has_installed_photo = true
          AND EXISTS (
            SELECT 1 FROM accepted_public_claims AS claim
            WHERE claim.id = evidence.source_citation_id
              AND claim.entity_type = 'fitment_evidence'
              AND claim.entity_id = evidence.id
              AND claim.field_path = 'observation'
          )
      )
    )
    OR (
      fitment.confidence_level = 'creator_listed'
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.reviewed_by IS NOT NULL
          AND evidence.reviewed_at IS NOT NULL
          AND evidence.evidence_kind = 'creator_claim'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND EXISTS (
            SELECT 1 FROM accepted_public_claims AS claim
            WHERE claim.id = evidence.source_citation_id
              AND claim.entity_type = 'design_revision'
              AND claim.entity_id = revision.id
              AND claim.field_path = 'claimed_compatibility'
          )
      )
    )
  )
)
SELECT
  eligible_catalogue.*,
  (
    SELECT canonical_candidate.fitment_slug
    FROM eligible_catalogue AS canonical_candidate
    WHERE canonical_candidate.design_id = eligible_catalogue.design_id
      AND canonical_candidate.component_id = eligible_catalogue.component_id
    ORDER BY canonical_candidate.fitment_published_at, canonical_candidate.fitment_public_id
    LIMIT 1
  ) AS "canonical_slug"
FROM eligible_catalogue;--> statement-breakpoint

CREATE VIEW "public"."public_catalogue_unavailable_sources" WITH (security_barrier = true) AS
WITH accepted_public_claims AS MATERIALIZED (
  SELECT citation.id, citation.entity_type, citation.entity_id, citation.field_path
  FROM "public"."source_citations" AS citation
  INNER JOIN "public"."sources" AS citation_source ON citation_source.id = citation.source_id
  INNER JOIN "public"."source_platform_policies" AS citation_policy ON citation_policy.platform = citation_source.platform
  WHERE citation.review_status = 'accepted'
    AND citation.reviewed_by IS NOT NULL
    AND citation.reviewed_at IS NOT NULL
    AND citation_source.status = 'live'
    AND citation_source.source_type <> 'demo'
    AND citation_policy.policy <> 'blocked'
    AND citation_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
),
accepted_tombstone_claims AS MATERIALIZED (
  SELECT citation.id, citation.entity_type, citation.entity_id, citation.field_path, citation.source_id
  FROM "public"."source_citations" AS citation
  INNER JOIN "public"."sources" AS citation_source ON citation_source.id = citation.source_id
  INNER JOIN "public"."source_platform_policies" AS citation_policy ON citation_policy.platform = citation_source.platform
  WHERE citation.review_status = 'accepted'
    AND citation.reviewed_by IS NOT NULL
    AND citation.reviewed_at IS NOT NULL
    AND citation_source.source_type <> 'demo'
    AND citation_policy.policy <> 'blocked'
    AND citation_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
)
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
  AND revision.rights_checked_by IS NOT NULL
  AND product_component.mapping_status = 'accepted'
  AND EXISTS (
    SELECT 1 FROM accepted_public_claims AS claim
    WHERE claim.entity_type = 'product_component'
      AND claim.entity_id = product_component.id
      AND claim.field_path = 'mapping'
      AND (product_component.source_citation_id IS NULL OR claim.id = product_component.source_citation_id)
  )
  AND model.publication_status = 'published'
  AND model.published_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM accepted_public_claims AS claim
    WHERE claim.entity_type = 'product_model'
      AND claim.entity_id = model.id
      AND claim.field_path = 'model_name'
  )
  AND EXISTS (
    SELECT 1
    FROM "public"."product_identifiers" AS primary_identifier
    INNER JOIN accepted_public_claims AS claim
      ON claim.entity_type = 'product_identifier'
      AND claim.entity_id = primary_identifier.id
      AND claim.field_path = 'display_value'
    WHERE primary_identifier.product_model_id = model.id
      AND primary_identifier.identifier_type IN ('model_number', 'label')
      AND (primary_identifier.source_citation_id IS NULL OR claim.id = primary_identifier.source_citation_id)
  )
  AND brand.publication_status = 'published'
  AND (oem.id IS NULL OR oem.publication_status = 'published')
  AND safety.safety_class = 'low'
  AND safety.reviewed_by IS NOT NULL
  AND safety.reviewed_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM accepted_tombstone_claims AS citation
    WHERE citation.entity_type = 'design_revision'
      AND citation.entity_id = revision.id
      AND citation.field_path = 'claimed_compatibility'
      AND citation.source_id = revision.source_id
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
          AND evidence.reviewed_by IS NOT NULL
          AND evidence.reviewed_at IS NOT NULL
          AND evidence.evidence_kind = 'trusted_physical_test'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome = 'fits_without_modification'
          AND EXISTS (
            SELECT 1 FROM accepted_tombstone_claims AS claim
            WHERE claim.id = evidence.source_citation_id
              AND claim.entity_type = 'fitment_evidence'
              AND claim.entity_id = evidence.id
              AND claim.field_path = 'observation'
          )
      )
    )
    OR (
      fitment.confidence_level = 'community_confirmed'
      AND 2 <= (
        SELECT count(DISTINCT evidence.actor_independence_key)
        FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.reviewed_by IS NOT NULL
          AND evidence.reviewed_at IS NOT NULL
          AND evidence.evidence_kind = 'community_report'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome IN ('fits_without_modification', 'fits_after_modification')
          AND evidence.actor_independence_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM accepted_tombstone_claims AS claim
            WHERE claim.id = evidence.source_citation_id
              AND claim.entity_type = 'fitment_evidence'
              AND claim.entity_id = evidence.id
              AND claim.field_path = 'observation'
          )
      )
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.reviewed_by IS NOT NULL
          AND evidence.reviewed_at IS NOT NULL
          AND evidence.evidence_kind = 'community_report'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND evidence.outcome IN ('fits_without_modification', 'fits_after_modification')
          AND evidence.has_installed_photo = true
          AND EXISTS (
            SELECT 1 FROM accepted_tombstone_claims AS claim
            WHERE claim.id = evidence.source_citation_id
              AND claim.entity_type = 'fitment_evidence'
              AND claim.entity_id = evidence.id
              AND claim.field_path = 'observation'
          )
      )
    )
    OR (
      fitment.confidence_level = 'creator_listed'
      AND EXISTS (
        SELECT 1 FROM "public"."fitment_evidence" AS evidence
        WHERE evidence.fitment_id = fitment.id
          AND evidence.moderation_status = 'accepted'
          AND evidence.reviewed_by IS NOT NULL
          AND evidence.reviewed_at IS NOT NULL
          AND evidence.evidence_kind = 'creator_claim'
          AND evidence.exact_model = true
          AND evidence.exact_design_revision = true
          AND EXISTS (
            SELECT 1 FROM accepted_tombstone_claims AS claim
            WHERE claim.id = evidence.source_citation_id
              AND claim.entity_type = 'design_revision'
              AND claim.entity_id = revision.id
              AND claim.field_path = 'claimed_compatibility'
          )
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
  INNER JOIN "public"."source_citations" AS identifier_citation
    ON identifier_citation.entity_type = 'product_identifier'
    AND identifier_citation.entity_id = product_identifier.id
    AND identifier_citation.field_path = 'display_value'
    AND identifier_citation.review_status = 'accepted'
    AND identifier_citation.reviewed_by IS NOT NULL
    AND identifier_citation.reviewed_at IS NOT NULL
    AND (product_identifier.source_citation_id IS NULL OR identifier_citation.id = product_identifier.source_citation_id)
  INNER JOIN "public"."sources" AS identifier_source
    ON identifier_source.id = identifier_citation.source_id
    AND identifier_source.status = 'live'
    AND identifier_source.source_type <> 'demo'
  INNER JOIN "public"."source_platform_policies" AS identifier_policy
    ON identifier_policy.platform = identifier_source.platform
    AND identifier_policy.policy <> 'blocked'
    AND identifier_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
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
  INNER JOIN "public"."source_citations" AS identifier_citation
    ON identifier_citation.entity_type = 'product_identifier'
    AND identifier_citation.entity_id = product_identifier.id
    AND identifier_citation.field_path = 'display_value'
    AND identifier_citation.review_status = 'accepted'
    AND identifier_citation.reviewed_by IS NOT NULL
    AND identifier_citation.reviewed_at IS NOT NULL
    AND (product_identifier.source_citation_id IS NULL OR identifier_citation.id = product_identifier.source_citation_id)
  INNER JOIN "public"."sources" AS identifier_source
    ON identifier_source.id = identifier_citation.source_id
    AND identifier_source.status = 'live'
    AND identifier_source.source_type <> 'demo'
  INNER JOIN "public"."source_platform_policies" AS identifier_policy
    ON identifier_policy.platform = identifier_source.platform
    AND identifier_policy.policy <> 'blocked'
    AND identifier_policy.terms_checked_at >= CURRENT_TIMESTAMP - INTERVAL '366 days'
  WHERE product_identifier.product_model_id = catalogue.model_id
) AS identifier ON true;--> statement-breakpoint

CREATE UNIQUE INDEX "public_search_documents_entity_uq" ON "public"."public_search_documents" ("entity_type", "entity_id");--> statement-breakpoint
CREATE INDEX "public_search_documents_strict_keys_idx" ON "public"."public_search_documents" USING gin ("strict_keys");--> statement-breakpoint
CREATE INDEX "public_search_documents_loose_keys_idx" ON "public"."public_search_documents" USING gin ("loose_keys");--> statement-breakpoint
CREATE INDEX "public_search_documents_text_trgm_idx" ON "public"."public_search_documents" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM anon;
    GRANT USAGE ON SCHEMA "public" TO anon;
    GRANT SELECT ON
      "public"."public_catalogue_fitments",
      "public"."public_catalogue_unavailable_sources",
      "public"."public_search_documents"
    TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM authenticated;
    GRANT USAGE ON SCHEMA "public" TO authenticated;
    GRANT SELECT ON
      "public"."public_catalogue_fitments",
      "public"."public_catalogue_unavailable_sources",
      "public"."public_search_documents"
    TO authenticated;
  END IF;
END;
$$;
