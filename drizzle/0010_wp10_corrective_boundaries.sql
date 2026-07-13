CREATE TABLE "source_candidate_acquisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"adapter_run_id" uuid,
	"policy_review_id" uuid NOT NULL,
	"origin" "source_candidate_origin" NOT NULL,
	"adapter_version" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"requested_by" uuid NOT NULL,
	"request_id" text NOT NULL,
	"acquisition_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_candidate_acquisitions_fingerprint_ck" CHECK ("source_candidate_acquisitions"."acquisition_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "source_link_checks" ADD COLUMN "content_checksum" text;--> statement-breakpoint
ALTER TABLE "source_platform_policies" ADD COLUMN "terms_checksum" text;--> statement-breakpoint
DO $$
DECLARE
  unresolved_platforms text;
BEGIN
  SELECT string_agg(invalid_policy.platform, ', ' ORDER BY invalid_policy.platform)
  INTO unresolved_platforms
  FROM (
    SELECT policy.platform
    FROM public.source_platform_policies AS policy
    LEFT JOIN public.source_policy_reviews AS review
      ON review.platform = policy.platform
      AND 'review:' || review.policy_version = policy.permission_scope
    GROUP BY policy.platform
    HAVING count(review.id) <> 1
      OR count(*) FILTER (WHERE review.terms_checksum ~ '^[0-9a-f]{64}$') <> 1
  ) AS invalid_policy;

  IF unresolved_platforms IS NOT NULL THEN
    RAISE EXCEPTION 'SOURCE_POLICY_TERMS_CHECKSUM_BACKFILL_FAILED'
      USING ERRCODE = '23514', DETAIL = 'One or more policies do not resolve to exactly one valid current review.';
  END IF;

  UPDATE public.source_platform_policies AS policy
  SET terms_checksum = review.terms_checksum
  FROM public.source_policy_reviews AS review
  WHERE review.platform = policy.platform
    AND 'review:' || review.policy_version = policy.permission_scope;

  IF EXISTS (SELECT 1 FROM public.source_platform_policies WHERE terms_checksum IS NULL) THEN
    RAISE EXCEPTION 'SOURCE_POLICY_TERMS_CHECKSUM_BACKFILL_FAILED'
      USING ERRCODE = '23514', DETAIL = 'The current policy checksum backfill was incomplete.';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "source_platform_policies" ALTER COLUMN "terms_checksum" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_platform_policies" ADD CONSTRAINT "source_platform_policies_terms_checksum_ck"
  CHECK ("terms_checksum" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "source_candidate_acquisitions" ADD CONSTRAINT "source_candidate_acquisitions_candidate_id_source_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."source_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_candidate_acquisitions" ADD CONSTRAINT "source_candidate_acquisitions_version_id_source_candidate_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."source_candidate_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_candidate_acquisitions" ADD CONSTRAINT "source_candidate_acquisitions_adapter_run_id_source_adapter_runs_id_fk" FOREIGN KEY ("adapter_run_id") REFERENCES "public"."source_adapter_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_candidate_acquisitions" ADD CONSTRAINT "source_candidate_acquisitions_policy_review_id_source_policy_reviews_id_fk" FOREIGN KEY ("policy_review_id") REFERENCES "public"."source_policy_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_candidate_acquisitions" ADD CONSTRAINT "source_candidate_acquisitions_requested_by_staff_profiles_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_candidate_acquisitions_fingerprint_uq" ON "source_candidate_acquisitions" USING btree ("acquisition_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "source_candidate_acquisitions_run_uq" ON "source_candidate_acquisitions" USING btree ("adapter_run_id");--> statement-breakpoint
CREATE INDEX "source_candidate_acquisitions_version_idx" ON "source_candidate_acquisitions" USING btree ("version_id","created_at");--> statement-breakpoint
ALTER TABLE "source_link_checks" ADD CONSTRAINT "source_link_checks_checksum_ck" CHECK ("source_link_checks"."content_checksum" IS NULL OR "source_link_checks"."content_checksum" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
CREATE TRIGGER source_candidate_acquisitions_immutable
BEFORE UPDATE OR DELETE ON public.source_candidate_acquisitions
FOR EACH ROW EXECUTE FUNCTION public.reject_source_evidence_mutation();
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO repairprint_source_maintenance;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'repairprint_source_maintenance', 'SET') THEN
    EXECUTE format(
      'GRANT repairprint_source_maintenance TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
      current_user
    );
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.record_source_policy_review(
  p_platform text,
  p_policy_version text,
  p_terms_url text,
  p_terms_checksum text,
  p_terms_checked_at timestamptz,
  p_expires_at timestamptz,
  p_decision public.source_policy,
  p_allowed_fields jsonb,
  p_automation_allowed boolean,
  p_commercial_use_allowed boolean,
  p_adapter_enabled boolean,
  p_evidence jsonb,
  p_actor_id uuid,
  p_reason text,
  p_request_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor public.staff_profiles%ROWTYPE;
  existing_review public.source_policy_reviews%ROWTYPE;
  before_policy jsonb;
  review_id uuid;
  review_now timestamptz := pg_catalog.clock_timestamp();
  safe_fields constant jsonb := '["external_id","landing_page_url","title","creator","creator_name","license","license_state","source_revision","claimed_compatibility","model","component","print_settings"]'::jsonb;
BEGIN
  SELECT * INTO actor FROM public.staff_profiles
  WHERE id = p_actor_id AND status = 'active' AND role IN ('reviewer', 'admin');
  IF actor.id IS NULL THEN RAISE EXCEPTION 'SOURCE_POLICY_REVIEWER_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF p_platform IS NULL OR btrim(p_platform) = ''
    OR p_policy_version IS NULL OR btrim(p_policy_version) = ''
    OR p_terms_url !~ '^https://'
    OR p_terms_checksum !~ '^[0-9a-f]{64}$'
    OR p_terms_checked_at > review_now
    OR p_expires_at <> p_terms_checked_at + interval '366 days'
    OR jsonb_typeof(p_allowed_fields) <> 'array' OR jsonb_array_length(p_allowed_fields) = 0
    OR NOT p_allowed_fields <@ safe_fields
    OR jsonb_array_length(p_allowed_fields) <> (
      SELECT count(DISTINCT value)::integer FROM jsonb_array_elements_text(p_allowed_fields)
    )
    OR jsonb_typeof(p_evidence) <> 'object'
    OR p_reason IS NULL OR char_length(btrim(p_reason)) < 8
    OR p_request_id IS NULL OR btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'SOURCE_POLICY_REVIEW_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_adapter_enabled AND (
    NOT p_automation_allowed OR p_commercial_use_allowed IS DISTINCT FROM true
    OR p_decision NOT IN ('api', 'written_permission')
  ) THEN RAISE EXCEPTION 'SOURCE_POLICY_AUTOMATION_INVALID' USING ERRCODE = '22023'; END IF;
  IF p_decision = 'blocked' AND (p_adapter_enabled OR p_automation_allowed) THEN
    RAISE EXCEPTION 'SOURCE_POLICY_BLOCKED_CONFIGURATION_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT to_jsonb(policy) INTO before_policy
  FROM public.source_platform_policies AS policy WHERE policy.platform = p_platform FOR UPDATE;
  SELECT * INTO existing_review FROM public.source_policy_reviews
  WHERE platform = p_platform AND policy_version = p_policy_version;
  IF existing_review.id IS NOT NULL THEN
    IF existing_review.terms_url <> p_terms_url
      OR existing_review.terms_checksum IS DISTINCT FROM p_terms_checksum
      OR existing_review.terms_checked_at <> p_terms_checked_at
      OR existing_review.expires_at <> p_expires_at
      OR existing_review.decision <> p_decision
      OR existing_review.allowed_fields <> p_allowed_fields
      OR existing_review.automation_allowed <> p_automation_allowed
      OR existing_review.commercial_use_allowed IS DISTINCT FROM p_commercial_use_allowed
      OR existing_review.adapter_enabled <> p_adapter_enabled
      OR existing_review.evidence <> p_evidence
      OR existing_review.reviewed_by <> p_actor_id THEN
      RAISE EXCEPTION 'SOURCE_POLICY_VERSION_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN existing_review.id;
  END IF;

  INSERT INTO public.source_platform_policies (
    platform, policy, terms_url, terms_checksum, terms_checked_at, permission_scope, allowed_fields,
    image_reuse_allowed, file_rehosting_allowed, automation_allowed,
    commercial_use_allowed, adapter_enabled, created_at, updated_at
  ) VALUES (
    p_platform, p_decision, p_terms_url, p_terms_checksum, p_terms_checked_at,
    'review:' || p_policy_version, p_allowed_fields,
    false, false, p_automation_allowed, p_commercial_use_allowed, p_adapter_enabled, review_now, review_now
  ) ON CONFLICT (platform) DO UPDATE SET
    policy = EXCLUDED.policy, terms_url = EXCLUDED.terms_url, terms_checksum = EXCLUDED.terms_checksum,
    terms_checked_at = EXCLUDED.terms_checked_at, permission_scope = EXCLUDED.permission_scope,
    allowed_fields = EXCLUDED.allowed_fields, image_reuse_allowed = false, file_rehosting_allowed = false,
    automation_allowed = EXCLUDED.automation_allowed,
    commercial_use_allowed = EXCLUDED.commercial_use_allowed,
    adapter_enabled = EXCLUDED.adapter_enabled, updated_at = review_now;

  INSERT INTO public.source_policy_reviews (
    platform, policy_version, terms_url, terms_checksum, terms_checked_at, expires_at,
    decision, allowed_fields, automation_allowed, commercial_use_allowed, adapter_enabled,
    evidence, reviewed_by, reviewed_at
  ) VALUES (
    p_platform, p_policy_version, p_terms_url, p_terms_checksum, p_terms_checked_at, p_expires_at,
    p_decision, p_allowed_fields, p_automation_allowed, p_commercial_use_allowed, p_adapter_enabled,
    p_evidence, p_actor_id, review_now
  ) RETURNING id INTO review_id;

  INSERT INTO public.audit_log (actor_id, action, entity_type, entity_id, before, after, reason, request_id)
  VALUES (
    p_actor_id, 'source_policy.review', 'source_policy_review', review_id, before_policy,
    jsonb_build_object('platform', p_platform, 'policyVersion', p_policy_version, 'decision', p_decision,
      'termsChecksum', p_terms_checksum, 'automationAllowed', p_automation_allowed,
      'commercialUseAllowed', p_commercial_use_allowed, 'adapterEnabled', p_adapter_enabled,
      'allowedFields', p_allowed_fields),
    p_reason, p_request_id
  );
  RETURN review_id;
END;
$$;
--> statement-breakpoint
SET ROLE repairprint_source_maintenance;
--> statement-breakpoint
DROP FUNCTION public.upsert_private_source_candidate(text, text, public.source_candidate_origin, text, jsonb, text, uuid, timestamptz, uuid, text, text, text);
--> statement-breakpoint
CREATE FUNCTION public.upsert_private_source_candidate(
  p_platform text,
  p_external_id text,
  p_origin public.source_candidate_origin,
  p_content_checksum text,
  p_allowed_payload jsonb,
  p_adapter_version text,
  p_policy_review_id uuid,
  p_retrieved_at timestamptz,
  p_actor_id uuid,
  p_request_id text,
  p_run_public_id text DEFAULT NULL,
  p_run_fingerprint text DEFAULT NULL,
  p_acquisition_fingerprint text DEFAULT NULL
)
RETURNS TABLE (run_id uuid, candidate_id uuid, version_id uuid, run_created boolean, candidate_created boolean, version_created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  policy_review public.source_policy_reviews%ROWTYPE;
  current_policy public.source_platform_policies%ROWTYPE;
  current_review_id uuid;
  actor public.staff_profiles%ROWTYPE;
  inserted_id uuid;
  candidate_uuid uuid;
  existing_version public.source_candidate_versions%ROWTYPE;
  existing_run public.source_adapter_runs%ROWTYPE;
  existing_acquisition public.source_candidate_acquisitions%ROWTYPE;
  safe_fields constant jsonb := '["external_id","landing_page_url","title","creator","creator_name","license","license_state","source_revision","claimed_compatibility","model","component","print_settings"]'::jsonb;
BEGIN
  IF p_platform IS NULL OR btrim(p_platform) = '' OR p_external_id IS NULL OR btrim(p_external_id) = '' THEN
    RAISE EXCEPTION 'SOURCE_CANDIDATE_IDENTITY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (p_content_checksum ~ '^[0-9a-f]{64}$') IS NOT TRUE
    OR (p_acquisition_fingerprint ~ '^[0-9a-f]{64}$') IS NOT TRUE
    OR jsonb_typeof(p_allowed_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SOURCE_CANDIDATE_PAYLOAD_INVALID' USING
      ERRCODE = '22023',
      DETAIL = format(
        'checksum_valid=%s acquisition_valid=%s payload_type=%s',
        COALESCE((p_content_checksum ~ '^[0-9a-f]{64}$')::text, 'false'),
        COALESCE((p_acquisition_fingerprint ~ '^[0-9a-f]{64}$')::text, 'false'),
        COALESCE(jsonb_typeof(p_allowed_payload), 'null')
      );
  END IF;
  IF p_request_id IS NULL OR btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'SOURCE_REQUEST_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_allowed_payload) AS payload_field(field_name)
    WHERE NOT (safe_fields ? payload_field.field_name)
  ) OR jsonb_path_exists(p_allowed_payload, '$.* ? (@.type() == "object")')
    OR jsonb_path_exists(p_allowed_payload, '$.*[*] ? (@.type() == "object" || @.type() == "array")') THEN
    RAISE EXCEPTION 'SOURCE_POLICY_FIELD_FORBIDDEN' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO actor FROM public.staff_profiles WHERE id = p_actor_id AND status = 'active';
  IF actor.id IS NULL THEN RAISE EXCEPTION 'SOURCE_ACTOR_UNAUTHORIZED' USING ERRCODE = '42501'; END IF;

  SELECT * INTO current_policy FROM public.source_platform_policies
  WHERE platform = p_platform FOR SHARE;
  SELECT * INTO policy_review FROM public.source_policy_reviews WHERE id = p_policy_review_id;
  SELECT review.id INTO current_review_id
  FROM public.source_policy_reviews AS review
  WHERE review.platform = p_platform
    AND 'review:' || review.policy_version = current_policy.permission_scope;
  IF policy_review.id IS NULL OR current_policy.platform IS NULL
    OR policy_review.platform <> p_platform OR current_review_id IS DISTINCT FROM p_policy_review_id THEN
    RAISE EXCEPTION 'SOURCE_POLICY_REVIEW_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF current_policy.policy = 'blocked' OR policy_review.decision = 'blocked' THEN
    RAISE EXCEPTION 'SOURCE_POLICY_BLOCKED' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.clock_timestamp() > policy_review.expires_at
    OR pg_catalog.clock_timestamp() > policy_review.terms_checked_at + interval '366 days'
    OR pg_catalog.clock_timestamp() > current_policy.terms_checked_at + interval '366 days' THEN
    RAISE EXCEPTION 'SOURCE_POLICY_STALE' USING ERRCODE = '42501';
  END IF;
  IF current_policy.permission_scope <> 'review:' || policy_review.policy_version
    OR current_policy.policy <> policy_review.decision
    OR current_policy.terms_url <> policy_review.terms_url
    OR current_policy.terms_checksum IS DISTINCT FROM policy_review.terms_checksum
    OR current_policy.terms_checked_at <> policy_review.terms_checked_at
    OR current_policy.allowed_fields <> policy_review.allowed_fields
    OR current_policy.automation_allowed <> policy_review.automation_allowed
    OR current_policy.adapter_enabled <> policy_review.adapter_enabled
    OR current_policy.commercial_use_allowed IS DISTINCT FROM policy_review.commercial_use_allowed
    OR current_policy.image_reuse_allowed OR current_policy.file_rehosting_allowed
    OR NOT policy_review.allowed_fields <@ safe_fields THEN
    RAISE EXCEPTION 'SOURCE_POLICY_SNAPSHOT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_allowed_payload) AS payload_field(field_name)
    WHERE NOT (policy_review.allowed_fields ? payload_field.field_name)
  ) THEN RAISE EXCEPTION 'SOURCE_FIELD_NOT_ALLOWED' USING ERRCODE = '42501'; END IF;
  IF p_origin = 'adapter' AND (
    NOT policy_review.automation_allowed OR NOT policy_review.adapter_enabled
    OR policy_review.commercial_use_allowed IS DISTINCT FROM true
    OR policy_review.decision NOT IN ('api', 'written_permission')
  ) THEN RAISE EXCEPTION 'SOURCE_AUTOMATION_FORBIDDEN' USING ERRCODE = '42501'; END IF;

  run_id := NULL;
  run_created := false;
  IF p_origin = 'adapter' THEN
    IF p_run_public_id IS NULL OR p_run_fingerprint !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'SOURCE_RUN_IDENTITY_INVALID' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.source_adapter_runs (
      public_id, platform, adapter_version, policy_review_id, input_fingerprint,
      status, requested_by, request_id
    ) VALUES (
      p_run_public_id, p_platform, p_adapter_version, p_policy_review_id, p_run_fingerprint,
      'running', p_actor_id, p_request_id
    ) ON CONFLICT (input_fingerprint) DO NOTHING RETURNING id INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
      run_id := inserted_id;
      run_created := true;
    ELSE
      SELECT * INTO existing_run FROM public.source_adapter_runs WHERE input_fingerprint = p_run_fingerprint;
      IF existing_run.id IS NULL OR existing_run.platform <> p_platform
        OR existing_run.adapter_version <> p_adapter_version
        OR existing_run.policy_review_id <> p_policy_review_id
        OR existing_run.public_id <> p_run_public_id THEN
        RAISE EXCEPTION 'SOURCE_RUN_IDENTITY_CONFLICT' USING ERRCODE = '23505';
      END IF;
      run_id := existing_run.id;
    END IF;
  ELSIF p_run_public_id IS NOT NULL OR p_run_fingerprint IS NOT NULL THEN
    RAISE EXCEPTION 'SOURCE_RUN_IDENTITY_INVALID' USING ERRCODE = '22023';
  END IF;

  inserted_id := NULL;
  INSERT INTO public.source_candidates (platform, external_id, origin, created_by)
  VALUES (p_platform, p_external_id, p_origin, p_actor_id)
  ON CONFLICT (platform, external_id) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN
    candidate_uuid := inserted_id;
    candidate_created := true;
  ELSE
    SELECT source_candidate.id INTO candidate_uuid FROM public.source_candidates AS source_candidate
    WHERE platform = p_platform AND external_id = p_external_id;
    candidate_created := false;
  END IF;
  candidate_id := candidate_uuid;

  inserted_id := NULL;
  INSERT INTO public.source_candidate_versions (
    candidate_id, adapter_run_id, policy_review_id, adapter_version, content_checksum,
    allowed_payload, stage, retrieved_at
  ) VALUES (
    candidate_uuid, run_id, p_policy_review_id, p_adapter_version, p_content_checksum,
    p_allowed_payload, 'discovered', p_retrieved_at
  ) ON CONFLICT DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN
    version_id := inserted_id;
    version_created := true;
  ELSE
    SELECT * INTO existing_version FROM public.source_candidate_versions AS source_version
    WHERE source_version.candidate_id = candidate_uuid
      AND source_version.content_checksum = p_content_checksum;
    IF existing_version.id IS NULL OR existing_version.allowed_payload <> p_allowed_payload THEN
      RAISE EXCEPTION 'SOURCE_CANDIDATE_PAYLOAD_CONFLICT' USING ERRCODE = '23505';
    END IF;
    version_id := existing_version.id;
    version_created := false;
  END IF;

  inserted_id := NULL;
  INSERT INTO public.source_candidate_acquisitions (
    candidate_id, version_id, adapter_run_id, policy_review_id, origin, adapter_version,
    retrieved_at, requested_by, request_id, acquisition_fingerprint
  ) VALUES (
    candidate_uuid, version_id, run_id, p_policy_review_id, p_origin, p_adapter_version,
    p_retrieved_at, p_actor_id, p_request_id, p_acquisition_fingerprint
  ) ON CONFLICT (acquisition_fingerprint) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    SELECT * INTO existing_acquisition FROM public.source_candidate_acquisitions
    WHERE acquisition_fingerprint = p_acquisition_fingerprint;
    IF existing_acquisition.id IS NULL
      OR existing_acquisition.candidate_id <> candidate_uuid
      OR existing_acquisition.version_id <> version_id
      OR existing_acquisition.adapter_run_id IS DISTINCT FROM run_id
      OR existing_acquisition.policy_review_id <> p_policy_review_id
      OR existing_acquisition.origin <> p_origin
      OR existing_acquisition.adapter_version <> p_adapter_version THEN
      RAISE EXCEPTION 'SOURCE_ACQUISITION_IDENTITY_CONFLICT' USING ERRCODE = '23505';
    END IF;
  END IF;

  IF run_id IS NOT NULL THEN
    UPDATE public.source_adapter_runs
    SET status = 'completed', completed_at = COALESCE(completed_at, pg_catalog.clock_timestamp())
    WHERE id = run_id AND status = 'running';
  END IF;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.complete_source_link_check(uuid, uuid, uuid, integer, text, text, integer, text, integer, timestamptz, text)
  RENAME TO complete_source_link_check_core;
--> statement-breakpoint
DROP FUNCTION public.complete_source_link_check_core(uuid, uuid, uuid, integer, text, text, integer, text, integer, timestamptz, text);
--> statement-breakpoint
CREATE FUNCTION public.complete_source_link_check(
  p_job_id uuid, p_lease_token uuid, p_actor_id uuid, p_http_status integer,
  p_outcome text, p_final_url text, p_response_ms integer, p_error_code text,
  p_redirect_hops integer, p_retry_after_at timestamptz, p_content_checksum text,
  p_request_id text
)
RETURNS TABLE (check_id uuid, affected_fitment_ids uuid[], publication_changed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  job public.source_link_check_jobs%ROWTYPE;
  source_record public.sources%ROWTYPE;
  actor public.staff_profiles%ROWTYPE;
  changed_fitment_count integer := 0;
  changed_design_count integer := 0;
  removal_reason text := NULL;
  completion_now timestamptz := pg_catalog.clock_timestamp();
  bounded_retry_after timestamptz := NULL;
BEGIN
  affected_fitment_ids := ARRAY[]::uuid[];
  publication_changed := false;
  IF p_outcome NOT IN ('healthy', 'redirected', 'removed', 'restricted', 'transient_rate_limited', 'transient_server_error', 'transient_network_error')
    OR p_redirect_hops NOT BETWEEN 0 AND 5
    OR (p_response_ms IS NOT NULL AND p_response_ms < 0)
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[A-Z0-9_]{3,80}$')
    OR (p_content_checksum IS NOT NULL AND p_content_checksum !~ '^[0-9a-f]{64}$')
    OR p_request_id IS NULL OR btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'SOURCE_LINK_RESULT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT (
    (p_outcome = 'healthy' AND p_http_status BETWEEN 200 AND 299 AND p_redirect_hops = 0)
    OR (p_outcome = 'redirected' AND p_http_status BETWEEN 200 AND 299 AND p_redirect_hops > 0 AND p_final_url IS NOT NULL)
    OR (p_outcome = 'removed' AND p_http_status IN (404, 410))
    OR (p_outcome = 'restricted' AND p_http_status IN (401, 403, 451))
    OR (p_outcome = 'transient_rate_limited' AND p_http_status = 429)
    OR (p_outcome = 'transient_server_error' AND p_http_status BETWEEN 500 AND 599)
    OR (p_outcome = 'transient_network_error' AND (
      p_http_status IS NULL OR (p_http_status BETWEEN 100 AND 499
        AND p_http_status NOT IN (401, 403, 404, 410, 429, 451))))
  ) THEN RAISE EXCEPTION 'SOURCE_LINK_RESULT_MISMATCH' USING ERRCODE = '22023'; END IF;
  IF p_outcome = 'transient_rate_limited' THEN
    bounded_retry_after := LEAST(
      GREATEST(COALESCE(p_retry_after_at, completion_now + interval '1 hour'), completion_now + interval '1 minute'),
      completion_now + interval '24 hours'
    );
  END IF;
  SELECT * INTO actor FROM public.staff_profiles WHERE id = p_actor_id AND status = 'active';
  IF actor.id IS NULL THEN RAISE EXCEPTION 'SOURCE_ACTOR_UNAUTHORIZED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO job FROM public.source_link_check_jobs WHERE id = p_job_id FOR UPDATE;
  IF job.id IS NULL OR job.status <> 'leased' OR job.lease_token <> p_lease_token
    OR job.lease_expires_at <= completion_now THEN
    RAISE EXCEPTION 'SOURCE_LINK_LEASE_LOST' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO source_record FROM public.sources WHERE id = job.source_id FOR UPDATE;
  IF source_record.id IS NULL THEN RAISE EXCEPTION 'SOURCE_LINK_SOURCE_MISSING' USING ERRCODE = '40001'; END IF;

  INSERT INTO public.source_link_checks (
    job_id, source_id, checked_at, http_status, outcome, final_url, response_ms,
    error_code, redirect_hops, retry_after_at, content_checksum, checked_by
  ) VALUES (
    job.id, job.source_id, completion_now, p_http_status, p_outcome, p_final_url, p_response_ms,
    p_error_code, p_redirect_hops, bounded_retry_after, p_content_checksum, p_actor_id
  ) RETURNING id INTO check_id;

  IF p_outcome = 'removed' AND p_http_status IN (404, 410) THEN removal_reason := 'removed'; END IF;
  IF p_outcome = 'restricted' AND p_http_status IN (401, 403, 451) THEN removal_reason := 'restricted'; END IF;
  IF p_outcome = 'redirected'
    AND regexp_replace(COALESCE(p_final_url, ''), '/$', '')
      IS DISTINCT FROM regexp_replace(source_record.canonical_url, '/$', '') THEN
    removal_reason := 'material_redirect';
  END IF;
  IF p_outcome IN ('healthy', 'redirected') AND source_record.content_checksum IS NOT NULL
    AND p_content_checksum IS DISTINCT FROM source_record.content_checksum THEN
    removal_reason := 'content_changed';
  END IF;

  IF removal_reason IS NOT NULL THEN
    WITH citation_fitments AS (
      SELECT fitment.id FROM public.fitments AS fitment
      INNER JOIN public.design_revisions AS revision ON revision.id = fitment.design_revision_id
      WHERE revision.source_id = source_record.id
      UNION
      SELECT fitment.id FROM public.source_citations AS citation
      INNER JOIN public.design_revisions AS revision ON citation.entity_type = 'design_revision' AND revision.id = citation.entity_id
      INNER JOIN public.fitments AS fitment ON fitment.design_revision_id = revision.id WHERE citation.source_id = source_record.id
      UNION
      SELECT evidence.fitment_id FROM public.source_citations AS citation
      INNER JOIN public.fitment_evidence AS evidence ON citation.entity_type = 'fitment_evidence' AND evidence.id = citation.entity_id
      WHERE citation.source_id = source_record.id
      UNION
      SELECT recipe.fitment_id FROM public.source_citations AS citation
      INNER JOIN public.print_recipes AS recipe ON citation.entity_type = 'print_recipe' AND recipe.id = citation.entity_id
      WHERE citation.source_id = source_record.id
      UNION
      SELECT fitment.id FROM public.source_citations AS citation
      INNER JOIN public.product_components AS product_component ON citation.entity_type = 'product_component' AND product_component.id = citation.entity_id
      INNER JOIN public.fitments AS fitment ON fitment.product_component_id = product_component.id WHERE citation.source_id = source_record.id
      UNION
      SELECT fitment.id FROM public.source_citations AS citation
      INNER JOIN public.product_models AS model ON citation.entity_type = 'product_model' AND model.id = citation.entity_id
      INNER JOIN public.product_components AS product_component ON product_component.product_model_id = model.id
      INNER JOIN public.fitments AS fitment ON fitment.product_component_id = product_component.id WHERE citation.source_id = source_record.id
      UNION
      SELECT fitment.id FROM public.source_citations AS citation
      INNER JOIN public.product_identifiers AS identifier ON citation.entity_type = 'product_identifier' AND identifier.id = citation.entity_id
      INNER JOIN public.product_components AS product_component ON product_component.product_model_id = identifier.product_model_id
      INNER JOIN public.fitments AS fitment ON fitment.product_component_id = product_component.id WHERE citation.source_id = source_record.id
      UNION
      SELECT fitment.id FROM public.source_citations AS citation
      INNER JOIN public.components AS component ON citation.entity_type = 'component' AND component.id = citation.entity_id
      INNER JOIN public.product_components AS product_component ON product_component.component_id = component.id
      INNER JOIN public.fitments AS fitment ON fitment.product_component_id = product_component.id WHERE citation.source_id = source_record.id
      UNION
      SELECT fitment.id FROM public.source_citations AS citation
      INNER JOIN public.oem_parts AS oem ON citation.entity_type = 'oem_part' AND oem.id = citation.entity_id
      INNER JOIN public.product_components AS product_component ON product_component.oem_part_id = oem.id
      INNER JOIN public.fitments AS fitment ON fitment.product_component_id = product_component.id WHERE citation.source_id = source_record.id
    )
    SELECT COALESCE(array_agg(DISTINCT id), ARRAY[]::uuid[]) INTO affected_fitment_ids FROM citation_fitments;
    UPDATE public.sources SET status = removal_reason,
      content_checksum = CASE WHEN p_outcome IN ('healthy', 'redirected')
        THEN p_content_checksum ELSE content_checksum END,
      last_checked_at = completion_now, updated_at = completion_now
    WHERE id = source_record.id;
    UPDATE public.fitments SET publication_status = 'needs_review', updated_at = completion_now
    WHERE id = ANY(affected_fitment_ids) AND publication_status = 'published';
    GET DIAGNOSTICS changed_fitment_count = ROW_COUNT;
    UPDATE public.designs AS design SET publication_status = 'needs_review', updated_at = completion_now
    WHERE design.publication_status = 'published' AND EXISTS (
      SELECT 1 FROM public.design_revisions AS revision
      INNER JOIN public.fitments AS fitment ON fitment.design_revision_id = revision.id
      WHERE revision.design_id = design.id AND fitment.id = ANY(affected_fitment_ids)
    );
    GET DIAGNOSTICS changed_design_count = ROW_COUNT;
    IF source_record.status IS DISTINCT FROM removal_reason OR changed_fitment_count > 0 OR changed_design_count > 0 THEN
      publication_changed := true;
      INSERT INTO public.audit_log (actor_id, action, entity_type, entity_id, before, after, reason, request_id)
      VALUES (
        p_actor_id, 'source.link_health.needs_review', 'source', source_record.id,
        jsonb_build_object('status', source_record.status, 'contentChecksum', source_record.content_checksum),
        jsonb_build_object('status', removal_reason, 'contentChecksum', p_content_checksum,
          'fitmentIds', to_jsonb(affected_fitment_ids), 'linkCheckId', check_id),
        'Machine link-health result requires human source review.', p_request_id
      );
      PERFORM public.refresh_source_public_search();
    END IF;
  ELSE
    UPDATE public.sources SET
      content_checksum = CASE WHEN p_outcome IN ('healthy', 'redirected')
        THEN p_content_checksum ELSE content_checksum END,
      last_checked_at = completion_now, updated_at = completion_now WHERE id = source_record.id;
  END IF;

  UPDATE public.source_link_check_jobs
  SET status = 'pending', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
      next_check_at = CASE
        WHEN p_outcome = 'transient_rate_limited' THEN bounded_retry_after
        WHEN p_outcome IN ('transient_server_error', 'transient_network_error') THEN completion_now + interval '15 minutes'
        WHEN removal_reason IS NOT NULL THEN completion_now + interval '7 days'
        ELSE completion_now + interval '1 day'
      END,
      updated_at = completion_now
  WHERE id = job.id;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('REVOKE repairprint_source_maintenance FROM %I GRANTED BY %I', current_user, current_user);
END
$$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM repairprint_source_maintenance;
--> statement-breakpoint
ALTER ROLE repairprint_source_service LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE repairprint_source_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
REVOKE ALL ON TABLE public.source_candidate_acquisitions FROM PUBLIC, repairprint_source_service;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.source_candidate_acquisitions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.source_candidate_acquisitions FROM authenticated;
  END IF;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.source_adapter_runs, public.source_candidates,
  public.source_candidate_versions, public.source_link_check_jobs, public.source_link_checks,
  public.sources, public.designs, public.fitments, public.audit_log TO repairprint_source_maintenance;
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE public.source_platform_policies TO repairprint_source_maintenance;
--> statement-breakpoint
GRANT SELECT ON TABLE public.source_policy_reviews, public.staff_profiles,
  public.source_citations, public.design_revisions, public.fitment_evidence, public.print_recipes,
  public.product_components, public.product_models, public.product_identifiers, public.components,
  public.oem_parts TO repairprint_source_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.source_candidate_acquisitions TO repairprint_source_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.upsert_private_source_candidate(text, text, public.source_candidate_origin, text, jsonb, text, uuid, timestamptz, uuid, text, text, text, text),
  public.complete_source_link_check(uuid, uuid, uuid, integer, text, text, integer, text, integer, timestamptz, text, text)
  TO repairprint_source_service;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  public.upsert_private_source_candidate(text, text, public.source_candidate_origin, text, jsonb, text, uuid, timestamptz, uuid, text, text, text, text),
  public.complete_source_link_check(uuid, uuid, uuid, integer, text, text, integer, text, integer, timestamptz, text, text)
  FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles AS role
    WHERE (role.rolname = 'repairprint_source_service' AND (
      NOT role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole OR role.rolinherit
      OR role.rolreplication OR role.rolbypassrls))
      OR (role.rolname = 'repairprint_source_maintenance' AND (
        role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole OR role.rolinherit
        OR role.rolreplication OR role.rolbypassrls))
  ) THEN RAISE EXCEPTION 'source worker roles retain unsafe attributes'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE (granted_role.rolname IN ('repairprint_source_service', 'repairprint_source_maintenance')
      OR member_role.rolname IN ('repairprint_source_service', 'repairprint_source_maintenance'))
      AND NOT (granted_role.rolname IN ('repairprint_source_service', 'repairprint_source_maintenance')
        AND member_role.rolname = 'postgres' AND grantor_role.rolname = 'supabase_admin'
        AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option)
  ) OR (SELECT count(*) FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      WHERE granted_role.rolname IN ('repairprint_source_service', 'repairprint_source_maintenance')
         OR member_role.rolname IN ('repairprint_source_service', 'repairprint_source_maintenance')) NOT IN (0, 2)
  THEN RAISE EXCEPTION 'unsafe source role membership after corrective boundary'; END IF;
END
$$;
