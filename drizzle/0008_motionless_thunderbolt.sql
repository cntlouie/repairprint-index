CREATE TABLE "private_media_pending_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "private_media_derivative_kind" NOT NULL,
	"object_path" text NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"cleanup_lease_token" uuid,
	"cleanup_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_media_pending_objects_path_ck" CHECK ("private_media_pending_objects"."object_path" ~ '^private/[0-9a-f]{2}/[A-Za-z0-9_-]{22,128}/(master|thumbnail|redacted)-[0-9a-f]{64}\.webp$'),
	CONSTRAINT "private_media_pending_objects_lease_ck" CHECK (
      ("private_media_pending_objects"."cleanup_lease_token" IS NULL) = ("private_media_pending_objects"."cleanup_lease_expires_at" IS NULL)
    )
);
--> statement-breakpoint
ALTER TABLE "private_media_pending_objects" ADD CONSTRAINT "private_media_pending_objects_session_id_private_media_upload_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."private_media_upload_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "private_media_pending_objects_path_uq" ON "private_media_pending_objects" USING btree ("object_path");--> statement-breakpoint
CREATE INDEX "private_media_pending_objects_cleanup_idx" ON "private_media_pending_objects" USING btree ("delete_after","cleanup_lease_expires_at","id");
--> statement-breakpoint
REVOKE ALL ON TABLE public.private_media_pending_objects FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON TABLE public.private_media_pending_objects FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON TABLE public.private_media_pending_objects FROM authenticated; END IF;
  GRANT SELECT, DELETE ON TABLE public.private_media_pending_objects TO repairprint_submission_service;
  GRANT INSERT (session_id, kind, object_path, delete_after)
    ON TABLE public.private_media_pending_objects TO repairprint_submission_service;
  GRANT SELECT, DELETE ON TABLE public.private_media_pending_objects TO repairprint_submission_maintenance;
  GRANT UPDATE (cleanup_lease_token, cleanup_lease_expires_at)
    ON TABLE public.private_media_pending_objects TO repairprint_submission_maintenance;
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
CREATE OR REPLACE FUNCTION public.claim_private_media_pending_object_cleanup(p_batch_limit integer, p_lease_token uuid)
RETURNS TABLE (pending_object_id uuid, object_path text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_batch_limit IS NULL OR p_batch_limit < 1 OR p_batch_limit > 1000 OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'invalid pending object cleanup claim' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT pending.id
    FROM public.private_media_pending_objects AS pending
    INNER JOIN public.private_media_upload_sessions AS session ON session.id = pending.session_id
    WHERE pending.delete_after <= pg_catalog.clock_timestamp()
      AND (pending.cleanup_lease_expires_at IS NULL OR pending.cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
      AND (session.status <> 'processing' OR session.processing_lease_expires_at <= pg_catalog.clock_timestamp())
    ORDER BY pending.delete_after, pending.id
    LIMIT p_batch_limit FOR UPDATE OF pending SKIP LOCKED
  )
  UPDATE public.private_media_pending_objects AS pending
  SET cleanup_lease_token = p_lease_token,
    cleanup_lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes'
  FROM candidates WHERE pending.id = candidates.id
  RETURNING pending.id, pending.object_path;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.complete_private_media_pending_object_cleanup(p_lease_token uuid, p_pending_object_ids uuid[])
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE completed bigint; eligible_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_lease_token IS NULL OR p_pending_object_ids IS NULL OR pg_catalog.cardinality(p_pending_object_ids) < 1
    OR pg_catalog.cardinality(p_pending_object_ids) > 1000
    OR pg_catalog.cardinality(p_pending_object_ids) <> (SELECT count(DISTINCT requested.id) FROM pg_catalog.unnest(p_pending_object_ids) AS requested(id)) THEN
    RAISE EXCEPTION 'invalid pending object cleanup completion' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(locked.id ORDER BY locked.id), ARRAY[]::uuid[]) INTO eligible_ids
  FROM (
    SELECT pending.id
    FROM public.private_media_pending_objects AS pending
    INNER JOIN public.private_media_upload_sessions AS session ON session.id = pending.session_id
    WHERE pending.id = ANY(p_pending_object_ids)
      AND pending.cleanup_lease_token = p_lease_token
      AND pending.cleanup_lease_expires_at > pg_catalog.clock_timestamp()
      AND pending.delete_after <= pg_catalog.clock_timestamp()
      AND (session.status <> 'processing' OR session.processing_lease_expires_at <= pg_catalog.clock_timestamp())
    FOR UPDATE OF pending
  ) AS locked;
  IF pg_catalog.cardinality(eligible_ids) <> pg_catalog.cardinality(p_pending_object_ids) THEN
    RAISE EXCEPTION 'pending object cleanup lease or eligibility changed' USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.private_media_pending_objects WHERE id = ANY(eligible_ids);
  GET DIAGNOSTICS completed = ROW_COUNT;
  RETURN completed;
END;
$$;
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
      AND NOT EXISTS (SELECT 1 FROM public.private_media_pending_objects AS pending WHERE pending.session_id = session.id)
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
      AND NOT EXISTS (SELECT 1 FROM public.private_media_pending_objects AS pending WHERE pending.session_id = session.id)
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
  DELETE FROM public.private_media_upload_sessions AS session WHERE session.id = ANY(eligible_ids);
  GET DIAGNOSTICS deleted_sessions = ROW_COUNT;
  RETURN NEXT;
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
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_private_media_pending_object_cleanup(integer, uuid),
  public.complete_private_media_pending_object_cleanup(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_private_media_pending_object_cleanup(integer, uuid),
  public.complete_private_media_pending_object_cleanup(uuid, uuid[]) TO repairprint_submission_service;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.claim_private_media_pending_object_cleanup(integer, uuid),
      public.complete_private_media_pending_object_cleanup(uuid, uuid[]) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.claim_private_media_pending_object_cleanup(integer, uuid),
      public.complete_private_media_pending_object_cleanup(uuid, uuid[]) FROM authenticated;
  END IF;
END
$$;
