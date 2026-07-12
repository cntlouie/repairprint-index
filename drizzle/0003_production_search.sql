CREATE MATERIALIZED VIEW "public"."public_search_documents" AS
SELECT
  'model'::text AS "entity_type",
  model.id AS "entity_id",
  brand.id AS "brand_id",
  brand.name AS "brand_name",
  brand.slug AS "brand_slug",
  model.model_name AS "model_name",
  model.slug AS "model_slug",
  NULL::text AS "component_name",
  NULL::text AS "component_slug",
  brand.name || ' ' || model.model_name AS "title",
  category.name AS "subtitle",
  '/brands/' || brand.slug || '/' || model.slug AS "href",
  COALESCE(identifier.strict_keys, ARRAY[]::text[]) AS "strict_keys",
  COALESCE(identifier.loose_keys, ARRAY[]::text[]) AS "loose_keys",
  ARRAY[]::text[] AS "component_terms",
  lower(concat_ws(' ', brand.name, model.model_name, model.family_name, identifier.display_values)) AS "search_text"
FROM "public"."product_models" AS model
INNER JOIN "public"."brands" AS brand ON brand.id = model.brand_id
INNER JOIN "public"."categories" AS category ON category.id = model.category_id
LEFT JOIN LATERAL (
  SELECT
    array_agg(DISTINCT product_identifier.strict_key) AS strict_keys,
    array_agg(DISTINCT product_identifier.loose_key) AS loose_keys,
    string_agg(DISTINCT product_identifier.display_value, ' ') AS display_values
  FROM "public"."product_identifiers" AS product_identifier
  WHERE product_identifier.product_model_id = model.id
) AS identifier ON true
WHERE model.publication_status = 'published'
  AND brand.publication_status = 'published'

UNION ALL

SELECT
  'part'::text AS "entity_type",
  fitment.id AS "entity_id",
  brand.id AS "brand_id",
  brand.name AS "brand_name",
  brand.slug AS "brand_slug",
  model.model_name AS "model_name",
  model.slug AS "model_slug",
  component.name AS "component_name",
  component.slug AS "component_slug",
  component.name AS "title",
  concat_ws(' · ', brand.name || ' ' || model.model_name, CASE WHEN oem.id IS NOT NULL THEN 'OEM ' || oem.part_number_display END) AS "subtitle",
  '/parts/' || fitment.slug AS "href",
  CASE WHEN oem.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[oem.strict_part_key] END AS "strict_keys",
  CASE WHEN oem.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[oem.loose_part_key] END AS "loose_keys",
  ARRAY[component.name] || ARRAY(SELECT jsonb_array_elements_text(component.common_names)) AS "component_terms",
  lower(concat_ws(' ', brand.name, model.model_name, model.family_name, identifier.display_values, component.name,
    array_to_string(ARRAY(SELECT jsonb_array_elements_text(component.common_names)), ' '), oem.part_number_display, oem.name, design.title)) AS "search_text"
FROM "public"."fitments" AS fitment
INNER JOIN "public"."design_revisions" AS revision ON revision.id = fitment.design_revision_id
INNER JOIN "public"."designs" AS design ON design.id = revision.design_id
INNER JOIN "public"."product_components" AS product_component ON product_component.id = fitment.product_component_id
INNER JOIN "public"."product_models" AS model ON model.id = product_component.product_model_id
INNER JOIN "public"."brands" AS brand ON brand.id = model.brand_id
INNER JOIN "public"."components" AS component ON component.id = product_component.component_id
LEFT JOIN "public"."oem_parts" AS oem ON oem.id = product_component.oem_part_id
INNER JOIN "public"."safety_reviews" AS safety ON safety.product_component_id = product_component.id
  AND safety.ruleset_version = 'safety-v1'
LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT product_identifier.display_value, ' ') AS display_values
  FROM "public"."product_identifiers" AS product_identifier
  WHERE product_identifier.product_model_id = model.id
) AS identifier ON true
WHERE fitment.publication_status = 'published'
  AND fitment.confidence_level IN ('verified_fit', 'community_confirmed', 'creator_listed')
  AND fitment.confidence_version = 'fitment-v1'
  AND design.publication_status = 'published'
  AND design.availability_status = 'available'
  AND product_component.mapping_status = 'accepted'
  AND model.publication_status = 'published'
  AND brand.publication_status = 'published'
  AND (oem.id IS NULL OR oem.publication_status = 'published')
  AND safety.safety_class = 'low';--> statement-breakpoint

CREATE UNIQUE INDEX "public_search_documents_entity_uq" ON "public"."public_search_documents" ("entity_type", "entity_id");--> statement-breakpoint
CREATE INDEX "public_search_documents_strict_keys_idx" ON "public"."public_search_documents" USING gin ("strict_keys");--> statement-breakpoint
CREATE INDEX "public_search_documents_loose_keys_idx" ON "public"."public_search_documents" USING gin ("loose_keys");--> statement-breakpoint
CREATE INDEX "public_search_documents_text_trgm_idx" ON "public"."public_search_documents" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT ON "public"."public_search_documents" TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON "public"."public_search_documents" TO authenticated;
  END IF;
END;
$$;
