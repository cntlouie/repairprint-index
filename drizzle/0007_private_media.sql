CREATE TYPE "public"."private_media_derivative_kind" AS ENUM('sanitized_master', 'thumbnail', 'redacted');--> statement-breakpoint
CREATE TYPE "public"."private_media_moderation_status" AS ENUM('pending', 'redaction_required', 'approved_private', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."private_media_purpose" AS ENUM('model_label', 'installed_fit', 'broken_part_context');--> statement-breakpoint
CREATE TYPE "public"."private_media_session_status" AS ENUM('issued', 'uploaded', 'processing', 'processed', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "private_media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"checksum_sha256" text NOT NULL,
	"detected_mime_type" text NOT NULL,
	"source_bytes" integer NOT NULL,
	"source_width" integer NOT NULL,
	"source_height" integer NOT NULL,
	"moderation_status" "private_media_moderation_status" DEFAULT 'pending' NOT NULL,
	"moderation_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"retention_deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_media_assets_checksum_ck" CHECK ("private_media_assets"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "private_media_assets_mime_ck" CHECK ("private_media_assets"."detected_mime_type" IN ('image/jpeg','image/png','image/webp','image/avif')),
	CONSTRAINT "private_media_assets_dimensions_ck" CHECK ("private_media_assets"."source_bytes" BETWEEN 1 AND 10485760 AND "private_media_assets"."source_width" BETWEEN 1 AND 12000 AND "private_media_assets"."source_height" BETWEEN 1 AND 12000 AND "private_media_assets"."source_width"::bigint * "private_media_assets"."source_height"::bigint <= 40000000)
);
--> statement-breakpoint
CREATE TABLE "private_media_consents" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"intake_id" uuid NOT NULL,
	"owns_or_has_permission" boolean NOT NULL,
	"private_storage_consent" boolean NOT NULL,
	"derivative_processing_consent" boolean NOT NULL,
	"public_display_consent" boolean DEFAULT false NOT NULL,
	"terms_version" text NOT NULL,
	"privacy_version" text NOT NULL,
	"retention_version" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"retention_deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_media_consents_required_ck" CHECK ("private_media_consents"."owns_or_has_permission" AND "private_media_consents"."private_storage_consent" AND "private_media_consents"."derivative_processing_consent"),
	CONSTRAINT "private_media_consents_retention_ck" CHECK ("private_media_consents"."retention_deadline" > "private_media_consents"."accepted_at")
);
--> statement-breakpoint
CREATE TABLE "private_media_derivatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "private_media_derivative_kind" NOT NULL,
	"object_path" text NOT NULL,
	"checksum_sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_media_derivatives_path_ck" CHECK ("private_media_derivatives"."object_path" ~ '^private/[0-9a-f]{2}/[A-Za-z0-9_-]{22,128}/(master|thumbnail|redacted)-[0-9a-f]{64}\.webp$'),
	CONSTRAINT "private_media_derivatives_checksum_ck" CHECK ("private_media_derivatives"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "private_media_derivatives_mime_ck" CHECK ("private_media_derivatives"."mime_type" = 'image/webp')
);
--> statement-breakpoint
CREATE TABLE "private_media_redactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rectangles" jsonb NOT NULL,
	"rectangles_hash" text NOT NULL,
	"derivative_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_media_redactions_version_ck" CHECK ("private_media_redactions"."version" >= 1),
	CONSTRAINT "private_media_redactions_hash_ck" CHECK ("private_media_redactions"."rectangles_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "private_media_redactions_reason_ck" CHECK (char_length(btrim("private_media_redactions"."reason")) BETWEEN 8 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "private_media_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"intake_id" uuid NOT NULL,
	"kind" "submission_kind" NOT NULL,
	"purpose" "private_media_purpose" NOT NULL,
	"quarantine_object_path" text NOT NULL,
	"claimed_mime_type" text NOT NULL,
	"claimed_extension" text NOT NULL,
	"claimed_bytes" integer NOT NULL,
	"status" "private_media_session_status" DEFAULT 'issued' NOT NULL,
	"capability_nonce_hash" text NOT NULL,
	"capability_expires_at" timestamp with time zone NOT NULL,
	"finalize_capability_expires_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone,
	"processing_lease_token" uuid,
	"processing_lease_expires_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"terminal_error_code" text,
	"cleanup_lease_token" uuid,
	"cleanup_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_media_upload_sessions_public_id_ck" CHECK ("private_media_upload_sessions"."public_id" ~ '^media_[A-Za-z0-9_-]{22,120}$'),
	CONSTRAINT "private_media_upload_sessions_path_ck" CHECK ("private_media_upload_sessions"."quarantine_object_path" ~ '^quarantine/[0-9a-f]{2}/[A-Za-z0-9_-]{22,128}$'),
	CONSTRAINT "private_media_upload_sessions_mime_ck" CHECK ("private_media_upload_sessions"."claimed_mime_type" IN ('image/jpeg','image/png','image/webp','image/avif')),
	CONSTRAINT "private_media_upload_sessions_extension_ck" CHECK ("private_media_upload_sessions"."claimed_extension" IN ('jpg','jpeg','png','webp','avif')),
	CONSTRAINT "private_media_upload_sessions_bytes_ck" CHECK ("private_media_upload_sessions"."claimed_bytes" BETWEEN 1 AND 10485760),
	CONSTRAINT "private_media_upload_sessions_nonce_ck" CHECK ("private_media_upload_sessions"."capability_nonce_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "private_media_upload_sessions_lease_ck" CHECK (
      ("private_media_upload_sessions"."status" = 'processing') = ("private_media_upload_sessions"."processing_lease_token" IS NOT NULL AND "private_media_upload_sessions"."processing_lease_expires_at" IS NOT NULL)
    ),
	CONSTRAINT "private_media_upload_sessions_cleanup_lease_ck" CHECK (
      ("private_media_upload_sessions"."cleanup_lease_token" IS NULL) = ("private_media_upload_sessions"."cleanup_lease_expires_at" IS NULL)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_upload_sessions_id_intake_uq" ON "private_media_upload_sessions" USING btree ("id","intake_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_idempotency_bindings_id_kind_uq" ON "submission_idempotency_bindings" USING btree ("id","kind");--> statement-breakpoint
ALTER TABLE "private_media_assets" ADD CONSTRAINT "private_media_assets_reviewed_by_staff_profiles_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_media_assets" ADD CONSTRAINT "private_media_assets_session_fk" FOREIGN KEY ("session_id","intake_id") REFERENCES "public"."private_media_upload_sessions"("id","intake_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_media_consents" ADD CONSTRAINT "private_media_consents_session_fk" FOREIGN KEY ("session_id","intake_id") REFERENCES "public"."private_media_upload_sessions"("id","intake_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_media_derivatives" ADD CONSTRAINT "private_media_derivatives_asset_id_private_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."private_media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_media_redactions" ADD CONSTRAINT "private_media_redactions_asset_id_private_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."private_media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_media_redactions" ADD CONSTRAINT "private_media_redactions_derivative_id_private_media_derivatives_id_fk" FOREIGN KEY ("derivative_id") REFERENCES "public"."private_media_derivatives"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_media_redactions" ADD CONSTRAINT "private_media_redactions_staff_id_staff_profiles_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_media_upload_sessions" ADD CONSTRAINT "private_media_upload_sessions_intake_fk" FOREIGN KEY ("intake_id","kind") REFERENCES "public"."submission_idempotency_bindings"("id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_assets_session_uq" ON "private_media_assets" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_assets_intake_checksum_uq" ON "private_media_assets" USING btree ("intake_id","checksum_sha256");--> statement-breakpoint
CREATE INDEX "private_media_assets_retention_idx" ON "private_media_assets" USING btree ("retention_deadline","id");--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_derivatives_asset_kind_uq" ON "private_media_derivatives" USING btree ("asset_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_derivatives_object_path_uq" ON "private_media_derivatives" USING btree ("object_path");--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_redactions_asset_version_uq" ON "private_media_redactions" USING btree ("asset_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_upload_sessions_public_id_uq" ON "private_media_upload_sessions" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_upload_sessions_intake_purpose_uq" ON "private_media_upload_sessions" USING btree ("intake_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_upload_sessions_quarantine_path_uq" ON "private_media_upload_sessions" USING btree ("quarantine_object_path");--> statement-breakpoint
CREATE INDEX "private_media_upload_sessions_cleanup_idx" ON "private_media_upload_sessions" USING btree ("status","capability_expires_at","finalize_capability_expires_at","id");--> statement-breakpoint
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.reject_private_media_consent_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'repairprint_submission_maintenance' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'private media consent records are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER private_media_consents_immutable
BEFORE UPDATE OR DELETE ON public.private_media_consents
FOR EACH ROW EXECUTE FUNCTION public.reject_private_media_consent_mutation();
--> statement-breakpoint
CREATE TRIGGER private_media_consents_no_truncate
BEFORE TRUNCATE ON public.private_media_consents
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_private_media_consent_mutation();
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.private_media_upload_sessions, public.private_media_consents,
  public.private_media_assets, public.private_media_derivatives, public.private_media_redactions FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_private_media_consent_mutation() FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.private_media_upload_sessions, public.private_media_consents,
      public.private_media_assets, public.private_media_derivatives, public.private_media_redactions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.private_media_upload_sessions, public.private_media_consents,
      public.private_media_assets, public.private_media_derivatives, public.private_media_redactions FROM authenticated;
  END IF;

  GRANT SELECT ON TABLE public.private_media_upload_sessions, public.private_media_consents,
    public.private_media_assets, public.private_media_derivatives TO repairprint_submission_service;
  GRANT INSERT (public_id, intake_id, kind, purpose, quarantine_object_path, claimed_mime_type,
    claimed_extension, claimed_bytes, capability_nonce_hash, capability_expires_at)
    ON TABLE public.private_media_upload_sessions TO repairprint_submission_service;
  GRANT UPDATE (status, capability_nonce_hash, capability_expires_at, finalize_capability_expires_at, uploaded_at,
    processing_lease_token, processing_lease_expires_at, finalized_at, terminal_error_code, updated_at)
    ON TABLE public.private_media_upload_sessions TO repairprint_submission_service;
  GRANT INSERT (session_id, intake_id, owns_or_has_permission, private_storage_consent,
    derivative_processing_consent, public_display_consent, terms_version, privacy_version,
    retention_version, accepted_at, retention_deadline)
    ON TABLE public.private_media_consents TO repairprint_submission_service;
  GRANT INSERT (session_id, intake_id, checksum_sha256, detected_mime_type, source_bytes,
    source_width, source_height, retention_deadline)
    ON TABLE public.private_media_assets TO repairprint_submission_service;
  GRANT INSERT (asset_id, kind, object_path, checksum_sha256, mime_type, bytes, width, height)
    ON TABLE public.private_media_derivatives TO repairprint_submission_service;

  GRANT SELECT, DELETE ON TABLE public.private_media_upload_sessions, public.private_media_consents,
    public.private_media_assets, public.private_media_derivatives, public.private_media_redactions
    TO repairprint_submission_maintenance;
  GRANT UPDATE (status, terminal_error_code, processing_lease_token, processing_lease_expires_at,
    finalized_at, cleanup_lease_token, cleanup_lease_expires_at, updated_at)
    ON TABLE public.private_media_upload_sessions TO repairprint_submission_maintenance;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'repairprint_submission_maintenance', 'SET') THEN
    EXECUTE format('GRANT repairprint_submission_maintenance TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE', current_user);
  END IF;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO repairprint_submission_maintenance;
--> statement-breakpoint
SET ROLE repairprint_submission_maintenance;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.claim_expired_private_media(p_batch_limit integer, p_lease_token uuid)
RETURNS TABLE (session_id uuid, quarantine_object_path text, private_object_paths text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_batch_limit IS NULL OR p_batch_limit < 1 OR p_batch_limit > 1000 OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'invalid private media cleanup claim' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT session.id
    FROM public.private_media_upload_sessions AS session
    INNER JOIN public.private_media_consents AS consent ON consent.session_id = session.id
    WHERE ((session.status = 'issued' AND (session.capability_expires_at <= pg_catalog.clock_timestamp()
          OR consent.retention_deadline <= pg_catalog.clock_timestamp()))
      OR (session.status = 'uploaded' AND session.finalize_capability_expires_at <= pg_catalog.clock_timestamp())
      OR (session.status IN ('processing','processed','rejected','expired')
        AND consent.retention_deadline <= pg_catalog.clock_timestamp()))
      AND (session.status <> 'processing' OR session.processing_lease_expires_at <= pg_catalog.clock_timestamp())
      AND (session.cleanup_lease_expires_at IS NULL OR session.cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
    ORDER BY LEAST(consent.retention_deadline,
      CASE WHEN session.status = 'issued' THEN session.capability_expires_at
        ELSE COALESCE(session.finalize_capability_expires_at, session.capability_expires_at) END), session.id
    LIMIT p_batch_limit FOR UPDATE OF session SKIP LOCKED
  ), claimed AS (
    UPDATE public.private_media_upload_sessions AS session
    SET cleanup_lease_token = p_lease_token,
      cleanup_lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes',
      updated_at = pg_catalog.clock_timestamp()
    FROM candidates WHERE session.id = candidates.id
    RETURNING session.id, session.quarantine_object_path
  )
  SELECT claimed.id, claimed.quarantine_object_path,
    COALESCE(pg_catalog.array_agg(derivative.object_path) FILTER (WHERE derivative.object_path IS NOT NULL), ARRAY[]::text[])
  FROM claimed
  LEFT JOIN public.private_media_assets AS asset ON asset.session_id = claimed.id
  LEFT JOIN public.private_media_derivatives AS derivative ON derivative.asset_id = asset.id
  GROUP BY claimed.id, claimed.quarantine_object_path;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.complete_private_media_cleanup(p_lease_token uuid, p_session_ids uuid[])
RETURNS TABLE (deleted_sessions bigint, deleted_assets bigint, deleted_derivatives bigint, deleted_redactions bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE asset_ids uuid[] := ARRAY[]::uuid[]; eligible_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_lease_token IS NULL OR p_session_ids IS NULL OR pg_catalog.cardinality(p_session_ids) < 1
    OR pg_catalog.cardinality(p_session_ids) > 1000
    OR pg_catalog.cardinality(p_session_ids) <> (SELECT count(DISTINCT requested.id) FROM pg_catalog.unnest(p_session_ids) AS requested(id)) THEN
    RAISE EXCEPTION 'invalid private media cleanup completion' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(locked.id ORDER BY locked.id), ARRAY[]::uuid[]) INTO eligible_ids
  FROM (
    SELECT session.id
    FROM public.private_media_upload_sessions AS session
    INNER JOIN public.private_media_consents AS consent ON consent.session_id = session.id
    WHERE session.id = ANY(p_session_ids) AND session.cleanup_lease_token = p_lease_token
      AND session.cleanup_lease_expires_at > pg_catalog.clock_timestamp()
      AND ((session.status = 'issued' AND (session.capability_expires_at <= pg_catalog.clock_timestamp()
            OR consent.retention_deadline <= pg_catalog.clock_timestamp()))
        OR (session.status = 'uploaded' AND session.finalize_capability_expires_at <= pg_catalog.clock_timestamp())
        OR (session.status IN ('processing','processed','rejected','expired')
          AND consent.retention_deadline <= pg_catalog.clock_timestamp()))
      AND (session.status <> 'processing' OR session.processing_lease_expires_at <= pg_catalog.clock_timestamp())
    FOR UPDATE OF session
  ) AS locked;
  IF pg_catalog.cardinality(eligible_ids) <> pg_catalog.cardinality(p_session_ids) THEN
    RAISE EXCEPTION 'private media cleanup lease or eligibility changed' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(locked.id), ARRAY[]::uuid[]) INTO asset_ids
  FROM (
    SELECT asset.id FROM public.private_media_assets AS asset
    INNER JOIN public.private_media_upload_sessions AS session ON session.id = asset.session_id
    WHERE session.id = ANY(eligible_ids)
    FOR UPDATE OF session
  ) AS locked;
  DELETE FROM public.private_media_redactions WHERE asset_id = ANY(asset_ids);
  GET DIAGNOSTICS deleted_redactions = ROW_COUNT;
  DELETE FROM public.private_media_derivatives WHERE asset_id = ANY(asset_ids);
  GET DIAGNOSTICS deleted_derivatives = ROW_COUNT;
  DELETE FROM public.private_media_assets WHERE id = ANY(asset_ids);
  GET DIAGNOSTICS deleted_assets = ROW_COUNT;
  DELETE FROM public.private_media_consents AS consent USING public.private_media_upload_sessions AS session
    WHERE consent.session_id = session.id AND session.id = ANY(eligible_ids);
  DELETE FROM public.private_media_upload_sessions AS session
    WHERE session.id = ANY(eligible_ids);
  GET DIAGNOSTICS deleted_sessions = ROW_COUNT;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.cleanup_expired_submission_intakes(p_batch_limit integer)
RETURNS TABLE (deleted_contacts bigint, deleted_follow_ups bigint, deleted_intakes bigint, deleted_submissions bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE candidate_ids uuid[] := ARRAY[]::uuid[]; parent_ids uuid[] := ARRAY[]::uuid[]; cleanup_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_batch_limit IS NULL OR p_batch_limit < 1 OR p_batch_limit > 1000 THEN
    RAISE EXCEPTION 'invalid cleanup batch limit' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(locked.id), ARRAY[]::uuid[]), COALESCE(pg_catalog.array_agg(locked.submission_id), ARRAY[]::uuid[])
  INTO candidate_ids, parent_ids FROM (
    SELECT intake.id, intake.submission_id FROM public.submission_idempotency_bindings AS intake
    INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
    LEFT JOIN public.submission_intake_contacts AS contact ON contact.intake_id = intake.id
    WHERE (intake.retention_expires_at <= cleanup_now OR (contact.intake_id IS NOT NULL AND intake.contact_retention_expires_at <= cleanup_now))
      AND NOT EXISTS (SELECT 1 FROM public.private_media_upload_sessions AS media WHERE media.intake_id = intake.id)
    ORDER BY LEAST(intake.retention_expires_at, COALESCE(intake.contact_retention_expires_at, intake.retention_expires_at)), intake.id
    LIMIT p_batch_limit FOR UPDATE OF parent, intake SKIP LOCKED
  ) AS locked;
  DELETE FROM public.submission_email_follow_ups WHERE intake_id = ANY(candidate_ids); GET DIAGNOSTICS deleted_follow_ups = ROW_COUNT;
  DELETE FROM public.submission_intake_contacts AS contact USING public.submission_idempotency_bindings AS intake
    WHERE contact.intake_id = intake.id AND intake.id = ANY(candidate_ids)
      AND (intake.retention_expires_at <= cleanup_now OR intake.contact_retention_expires_at <= cleanup_now);
  GET DIAGNOSTICS deleted_contacts = ROW_COUNT;
  DELETE FROM public.submission_idempotency_bindings WHERE id = ANY(candidate_ids) AND retention_expires_at <= cleanup_now;
  GET DIAGNOSTICS deleted_intakes = ROW_COUNT;
  DELETE FROM public.submissions AS parent WHERE parent.id = ANY(parent_ids) AND parent.intake_version = 1
    AND NOT EXISTS (SELECT 1 FROM public.submission_idempotency_bindings AS intake WHERE intake.submission_id = parent.id);
  GET DIAGNOSTICS deleted_submissions = ROW_COUNT;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.claim_private_media_quarantine_cleanup(p_batch_limit integer, p_lease_token uuid)
RETURNS TABLE (session_id uuid, quarantine_object_path text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_batch_limit IS NULL OR p_batch_limit < 1 OR p_batch_limit > 1000 OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'invalid quarantine cleanup claim' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT session.id FROM public.private_media_upload_sessions AS session
    WHERE ((session.status IN ('processed','rejected')
          AND session.terminal_error_code LIKE 'MEDIA_QUARANTINE_DELETE_PENDING%')
        OR (session.status = 'processing'
          AND session.processing_lease_expires_at <= pg_catalog.clock_timestamp()))
      AND (session.cleanup_lease_expires_at IS NULL OR session.cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
    ORDER BY COALESCE(session.processing_lease_expires_at, session.finalized_at, session.updated_at), session.id
    LIMIT p_batch_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE public.private_media_upload_sessions AS session
  SET cleanup_lease_token = p_lease_token,
    cleanup_lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes',
    updated_at = pg_catalog.clock_timestamp()
  FROM candidates WHERE session.id = candidates.id
  RETURNING session.id, session.quarantine_object_path;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.complete_private_media_quarantine_cleanup(p_lease_token uuid, p_session_ids uuid[])
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE completed bigint; eligible_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_lease_token IS NULL OR p_session_ids IS NULL OR pg_catalog.cardinality(p_session_ids) < 1
    OR pg_catalog.cardinality(p_session_ids) > 1000
    OR pg_catalog.cardinality(p_session_ids) <> (SELECT count(DISTINCT requested.id) FROM pg_catalog.unnest(p_session_ids) AS requested(id)) THEN
    RAISE EXCEPTION 'invalid quarantine cleanup completion' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(locked.id ORDER BY locked.id), ARRAY[]::uuid[]) INTO eligible_ids
  FROM (
    SELECT session.id
    FROM public.private_media_upload_sessions AS session
    WHERE session.id = ANY(p_session_ids)
      AND session.cleanup_lease_token = p_lease_token
      AND session.cleanup_lease_expires_at > pg_catalog.clock_timestamp()
      AND ((session.status IN ('processed','rejected')
            AND session.terminal_error_code LIKE 'MEDIA_QUARANTINE_DELETE_PENDING%')
        OR (session.status = 'processing'
            AND session.processing_lease_expires_at <= pg_catalog.clock_timestamp()))
    FOR UPDATE
  ) AS locked;
  IF pg_catalog.cardinality(eligible_ids) <> pg_catalog.cardinality(p_session_ids) THEN
    RAISE EXCEPTION 'quarantine cleanup lease or eligibility changed' USING ERRCODE = '55000';
  END IF;
  UPDATE public.private_media_upload_sessions
  SET status = CASE WHEN status = 'processing' THEN 'rejected'::public.private_media_session_status ELSE status END,
    terminal_error_code = CASE
      WHEN status = 'processing' THEN 'MEDIA_PROCESSING_LEASE_EXPIRED'
      WHEN status = 'rejected' THEN NULLIF(pg_catalog.split_part(terminal_error_code, '|', 2), '')
      ELSE NULL
    END,
    processing_lease_token = NULL, processing_lease_expires_at = NULL,
    finalized_at = CASE WHEN status = 'processing' THEN pg_catalog.clock_timestamp() ELSE finalized_at END,
    cleanup_lease_token = NULL, cleanup_lease_expires_at = NULL, updated_at = pg_catalog.clock_timestamp()
  WHERE id = ANY(eligible_ids);
  GET DIAGNOSTICS completed = ROW_COUNT;
  RETURN completed;
END;
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM repairprint_submission_maintenance;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('REVOKE repairprint_submission_maintenance FROM %I GRANTED BY %I', current_user, current_user);
  IF EXISTS (
    SELECT 1 FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE (granted_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
      OR member_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance'))
      AND NOT (granted_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
        AND member_role.rolname = 'postgres' AND grantor_role.rolname = 'supabase_admin'
        AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option)
  ) THEN RAISE EXCEPTION 'private media migration found an unsafe submission role membership'; END IF;
  IF (
    SELECT count(*) FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE granted_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
      AND member_role.rolname = 'postgres' AND grantor_role.rolname = 'supabase_admin'
      AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option
  ) NOT IN (0, 2) THEN RAISE EXCEPTION 'private media migration found an incomplete provider membership pair'; END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_expired_private_media(integer, uuid),
  public.complete_private_media_cleanup(uuid, uuid[]),
  public.claim_private_media_quarantine_cleanup(integer, uuid),
  public.complete_private_media_quarantine_cleanup(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_expired_private_media(integer, uuid),
  public.complete_private_media_cleanup(uuid, uuid[]),
  public.claim_private_media_quarantine_cleanup(integer, uuid),
  public.complete_private_media_quarantine_cleanup(uuid, uuid[]) TO repairprint_submission_service;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.claim_expired_private_media(integer, uuid), public.complete_private_media_cleanup(uuid, uuid[]),
      public.claim_private_media_quarantine_cleanup(integer, uuid), public.complete_private_media_quarantine_cleanup(uuid, uuid[]) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.claim_expired_private_media(integer, uuid), public.complete_private_media_cleanup(uuid, uuid[]),
      public.claim_private_media_quarantine_cleanup(integer, uuid), public.complete_private_media_quarantine_cleanup(uuid, uuid[]) FROM authenticated;
  END IF;
END
$$;
