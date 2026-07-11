CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('trusted_physical_test', 'community_report', 'creator_claim', 'oem_mapping', 'dimensional_match', 'editorial_note');--> statement-breakpoint
CREATE TYPE "public"."fit_outcome" AS ENUM('fits_without_modification', 'fits_after_modification', 'does_not_fit', 'print_failed', 'unsure');--> statement-breakpoint
CREATE TYPE "public"."fitment_status" AS ENUM('verified_fit', 'community_confirmed', 'creator_listed', 'candidate_match', 'disputed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('draft', 'in_review', 'published', 'needs_review', 'archived');--> statement-breakpoint
CREATE TYPE "public"."safety_class" AS ENUM('low', 'caution', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."source_policy" AS ENUM('api', 'creator_submission', 'written_permission', 'link_only', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."submission_kind" AS ENUM('missing_part', 'fit_confirmation', 'design_submission', 'rights_or_safety_notice');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('pending', 'in_review', 'accepted', 'rejected', 'resolved');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"publication_status" "publication_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"common_names" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"platform" text NOT NULL,
	"external_profile_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_revision" text NOT NULL,
	"source_external_id" text,
	"source_hash" text,
	"license_code" text NOT NULL,
	"license_version" text,
	"license_url" text,
	"license_evidence_url" text,
	"attribution_text" text NOT NULL,
	"file_formats" jsonb NOT NULL,
	"source_published_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"rights_checked_at" timestamp with time zone NOT NULL,
	"rights_checked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"slug" text NOT NULL,
	"creator_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"publication_status" "publication_status" DEFAULT 'draft' NOT NULL,
	"availability_status" text DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitment_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fitment_id" uuid NOT NULL,
	"evidence_kind" "evidence_kind" NOT NULL,
	"outcome" "fit_outcome",
	"source_citation_id" uuid,
	"actor_independence_key" text,
	"exact_model" boolean DEFAULT false NOT NULL,
	"exact_design_revision" boolean DEFAULT false NOT NULL,
	"has_model_label_photo" boolean DEFAULT false NOT NULL,
	"has_installed_photo" boolean DEFAULT false NOT NULL,
	"measurements" jsonb,
	"modification_notes" text,
	"summary" text NOT NULL,
	"observed_at" date NOT NULL,
	"moderation_status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"slug" text NOT NULL,
	"design_revision_id" uuid NOT NULL,
	"product_component_id" uuid NOT NULL,
	"confidence_level" "fitment_status" DEFAULT 'candidate_match' NOT NULL,
	"confidence_score" integer DEFAULT 0 NOT NULL,
	"confidence_version" text DEFAULT 'fitment-v1' NOT NULL,
	"publication_status" "publication_status" DEFAULT 'draft' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"last_computed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oem_part_supersessions" (
	"from_part_id" uuid NOT NULL,
	"to_part_id" uuid NOT NULL,
	"relation_type" text DEFAULT 'superseded_by' NOT NULL,
	"source_citation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oem_part_supersessions_from_part_id_to_part_id_pk" PRIMARY KEY("from_part_id","to_part_id")
);
--> statement-breakpoint
CREATE TABLE "oem_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"part_number_display" text NOT NULL,
	"strict_part_key" text NOT NULL,
	"loose_part_key" text NOT NULL,
	"name" text NOT NULL,
	"publication_status" "publication_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fitment_id" uuid NOT NULL,
	"material" text NOT NULL,
	"nozzle_mm" real,
	"layer_height_mm" real,
	"wall_count" integer,
	"infill_percent" integer,
	"supports" text,
	"orientation" text,
	"hardware" jsonb,
	"estimated_minutes" integer,
	"provenance" text NOT NULL,
	"source_citation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_model_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"oem_part_id" uuid,
	"serial_from" text,
	"serial_to" text,
	"mapping_status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"source_citation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_model_id" uuid NOT NULL,
	"display_value" text NOT NULL,
	"strict_key" text NOT NULL,
	"loose_key" text NOT NULL,
	"identifier_type" text NOT NULL,
	"market_code" text,
	"source_citation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"model_name" text NOT NULL,
	"slug" text NOT NULL,
	"family_name" text,
	"market_codes" jsonb NOT NULL,
	"production_start" date,
	"production_end" date,
	"label_location" text,
	"summary" text,
	"publication_status" "publication_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_component_id" uuid NOT NULL,
	"safety_class" "safety_class" NOT NULL,
	"signals" jsonb NOT NULL,
	"failure_consequence" text NOT NULL,
	"rationale" text NOT NULL,
	"ruleset_version" text DEFAULT 'safety-v1' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slug_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"old_path" text NOT NULL,
	"replacement_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"claim_value" jsonb NOT NULL,
	"locator" text,
	"supporting_excerpt" text,
	"extraction_method" text NOT NULL,
	"review_status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_link_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"http_status" integer,
	"outcome" text NOT NULL,
	"final_url" text,
	"response_ms" integer,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "source_platform_policies" (
	"platform" text PRIMARY KEY NOT NULL,
	"policy" "source_policy" NOT NULL,
	"terms_url" text NOT NULL,
	"terms_checked_at" timestamp with time zone NOT NULL,
	"permission_scope" text,
	"allowed_fields" jsonb NOT NULL,
	"image_reuse_allowed" boolean DEFAULT false NOT NULL,
	"file_rehosting_allowed" boolean DEFAULT false NOT NULL,
	"automation_allowed" boolean DEFAULT false NOT NULL,
	"commercial_use_allowed" boolean,
	"adapter_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"platform" text,
	"canonical_url" text NOT NULL,
	"publisher" text,
	"title" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	"content_checksum" text,
	"rights_notes" text,
	"status" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "submission_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "submission_status" DEFAULT 'pending' NOT NULL,
	"matched_entity_type" text,
	"matched_entity_id" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_revisions" ADD CONSTRAINT "design_revisions_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_revisions" ADD CONSTRAINT "design_revisions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitment_evidence" ADD CONSTRAINT "fitment_evidence_fitment_id_fitments_id_fk" FOREIGN KEY ("fitment_id") REFERENCES "public"."fitments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitment_evidence" ADD CONSTRAINT "fitment_evidence_source_citation_id_source_citations_id_fk" FOREIGN KEY ("source_citation_id") REFERENCES "public"."source_citations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitments" ADD CONSTRAINT "fitments_design_revision_id_design_revisions_id_fk" FOREIGN KEY ("design_revision_id") REFERENCES "public"."design_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitments" ADD CONSTRAINT "fitments_product_component_id_product_components_id_fk" FOREIGN KEY ("product_component_id") REFERENCES "public"."product_components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oem_part_supersessions" ADD CONSTRAINT "oem_part_supersessions_from_part_id_oem_parts_id_fk" FOREIGN KEY ("from_part_id") REFERENCES "public"."oem_parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oem_part_supersessions" ADD CONSTRAINT "oem_part_supersessions_to_part_id_oem_parts_id_fk" FOREIGN KEY ("to_part_id") REFERENCES "public"."oem_parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oem_parts" ADD CONSTRAINT "oem_parts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oem_parts" ADD CONSTRAINT "oem_parts_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_recipes" ADD CONSTRAINT "print_recipes_fitment_id_fitments_id_fk" FOREIGN KEY ("fitment_id") REFERENCES "public"."fitments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_recipes" ADD CONSTRAINT "print_recipes_source_citation_id_source_citations_id_fk" FOREIGN KEY ("source_citation_id") REFERENCES "public"."source_citations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_product_model_id_product_models_id_fk" FOREIGN KEY ("product_model_id") REFERENCES "public"."product_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_oem_part_id_oem_parts_id_fk" FOREIGN KEY ("oem_part_id") REFERENCES "public"."oem_parts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_product_model_id_product_models_id_fk" FOREIGN KEY ("product_model_id") REFERENCES "public"."product_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_models" ADD CONSTRAINT "product_models_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_models" ADD CONSTRAINT "product_models_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_reviews" ADD CONSTRAINT "safety_reviews_product_component_id_product_components_id_fk" FOREIGN KEY ("product_component_id") REFERENCES "public"."product_components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_citations" ADD CONSTRAINT "source_citations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_link_checks" ADD CONSTRAINT "source_link_checks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_uq" ON "brands" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_name_key_uq" ON "brands" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_uq" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "components_category_slug_uq" ON "components" USING btree ("category_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "creators_platform_name_uq" ON "creators" USING btree ("platform","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "design_revisions_design_source_revision_uq" ON "design_revisions" USING btree ("design_id","source_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "designs_public_id_uq" ON "designs" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "designs_slug_uq" ON "designs" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "fitment_evidence_fitment_status_idx" ON "fitment_evidence" USING btree ("fitment_id","moderation_status");--> statement-breakpoint
CREATE UNIQUE INDEX "fitments_public_id_uq" ON "fitments" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fitments_slug_uq" ON "fitments" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "fitments_revision_component_uq" ON "fitments" USING btree ("design_revision_id","product_component_id");--> statement-breakpoint
CREATE INDEX "fitments_publication_confidence_idx" ON "fitments" USING btree ("publication_status","confidence_level");--> statement-breakpoint
CREATE UNIQUE INDEX "oem_parts_public_id_uq" ON "oem_parts" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oem_parts_brand_strict_uq" ON "oem_parts" USING btree ("brand_id","strict_part_key");--> statement-breakpoint
CREATE INDEX "oem_parts_loose_idx" ON "oem_parts" USING btree ("loose_part_key");--> statement-breakpoint
CREATE UNIQUE INDEX "print_recipes_fitment_uq" ON "print_recipes" USING btree ("fitment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_components_logical_uq" ON "product_components" USING btree ("product_model_id","component_id","oem_part_id");--> statement-breakpoint
CREATE INDEX "product_components_model_idx" ON "product_components" USING btree ("product_model_id");--> statement-breakpoint
CREATE INDEX "product_identifiers_strict_idx" ON "product_identifiers" USING btree ("strict_key");--> statement-breakpoint
CREATE INDEX "product_identifiers_loose_idx" ON "product_identifiers" USING btree ("loose_key");--> statement-breakpoint
CREATE UNIQUE INDEX "product_identifiers_model_display_uq" ON "product_identifiers" USING btree ("product_model_id","display_value");--> statement-breakpoint
CREATE UNIQUE INDEX "product_models_public_id_uq" ON "product_models" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_models_brand_slug_uq" ON "product_models" USING btree ("brand_id","slug");--> statement-breakpoint
CREATE INDEX "product_models_publication_idx" ON "product_models" USING btree ("publication_status");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_reviews_component_ruleset_uq" ON "safety_reviews" USING btree ("product_component_id","ruleset_version");--> statement-breakpoint
CREATE UNIQUE INDEX "slug_history_old_path_uq" ON "slug_history" USING btree ("old_path");--> statement-breakpoint
CREATE INDEX "source_citations_entity_idx" ON "source_citations" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "source_link_checks_source_checked_idx" ON "source_link_checks" USING btree ("source_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_url_uq" ON "sources" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "sources_status_idx" ON "sources" USING btree ("status");--> statement-breakpoint
CREATE INDEX "submissions_queue_idx" ON "submissions" USING btree ("status","kind","created_at");
--> statement-breakpoint
CREATE INDEX "product_models_name_trgm_idx" ON "product_models" USING gin ("model_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "components_name_trgm_idx" ON "components" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "designs_title_trgm_idx" ON "designs" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_components_no_oem_uq" ON "product_components" ("product_model_id", "component_id") WHERE "oem_part_id" IS NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_parent_id_components_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_source_citation_id_fk" FOREIGN KEY ("source_citation_id") REFERENCES "public"."source_citations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_source_citation_id_fk" FOREIGN KEY ("source_citation_id") REFERENCES "public"."source_citations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oem_part_supersessions" ADD CONSTRAINT "oem_part_supersessions_source_citation_id_fk" FOREIGN KEY ("source_citation_id") REFERENCES "public"."source_citations"("id") ON DELETE set null ON UPDATE no action;
