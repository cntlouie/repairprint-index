CREATE TYPE "public"."submission_email_status" AS ENUM('pending', 'processing', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "submission_email_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intake_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"follow_up_key" text NOT NULL,
	"qualifying_event" text NOT NULL,
	"template_key" text NOT NULL,
	"status" "submission_email_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_email_follow_ups_attempt_count_ck" CHECK ("submission_email_follow_ups"."attempt_count" >= 0),
	CONSTRAINT "submission_email_follow_ups_lease_ck" CHECK (("submission_email_follow_ups"."status" = 'processing') = ("submission_email_follow_ups"."lease_token" IS NOT NULL AND "submission_email_follow_ups"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "submission_email_follow_ups_sent_ck" CHECK (("submission_email_follow_ups"."status" = 'sent') = ("submission_email_follow_ups"."sent_at" IS NOT NULL)),
	CONSTRAINT "submission_email_follow_ups_event_ck" CHECK ("submission_email_follow_ups"."qualifying_event" IN ('matching_publication', 'moderator_question')),
	CONSTRAINT "submission_email_follow_ups_event_template_ck" CHECK (("submission_email_follow_ups"."qualifying_event" = 'matching_publication' AND "submission_email_follow_ups"."template_key" = 'missing-part-match-alert')
        OR ("submission_email_follow_ups"."qualifying_event" = 'moderator_question' AND "submission_email_follow_ups"."template_key" = 'moderator-follow-up'))
);
--> statement-breakpoint
CREATE TABLE "submission_hmac_key_pin" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"hmac_version" text NOT NULL,
	"key_commitment" text NOT NULL,
	"provisioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_hmac_key_pin_hmac_version_unique" UNIQUE("hmac_version"),
	CONSTRAINT "submission_hmac_key_pin_singleton_ck" CHECK ("submission_hmac_key_pin"."singleton"),
	CONSTRAINT "submission_hmac_key_pin_commitment_ck" CHECK ("submission_hmac_key_pin"."key_commitment" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "submission_idempotency_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "submission_kind" NOT NULL,
	"idempotency_actor_key" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"intake_version" integer DEFAULT 1 NOT NULL,
	"hmac_version" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"payload" jsonb NOT NULL,
	"privacy_consent" boolean NOT NULL,
	"contribution_consent" boolean NOT NULL,
	"email_follow_up_consent" boolean NOT NULL,
	"contributor_terms_version" text NOT NULL,
	"privacy_notice_version" text NOT NULL,
	"contact_consent_version" text NOT NULL,
	"retention_policy_version" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"challenge_provider" text NOT NULL,
	"challenge_verified_at" timestamp with time zone NOT NULL,
	"contact_present" boolean NOT NULL,
	"contact_digest" text,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"contact_retention_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_idempotency_bindings_intake_version_ck" CHECK ("submission_idempotency_bindings"."intake_version" = 1),
	CONSTRAINT "submission_idempotency_bindings_hashes_ck" CHECK (
      "submission_idempotency_bindings"."idempotency_actor_key" ~ '^[0-9a-f]{64}$'
      AND "submission_idempotency_bindings"."idempotency_key_hash" ~ '^[0-9a-f]{64}$'
      AND "submission_idempotency_bindings"."request_fingerprint" ~ '^[0-9a-f]{64}$'
      AND ("submission_idempotency_bindings"."contact_digest" IS NULL OR "submission_idempotency_bindings"."contact_digest" ~ '^[0-9a-f]{64}$')
    ),
	CONSTRAINT "submission_idempotency_bindings_required_consent_ck" CHECK ("submission_idempotency_bindings"."privacy_consent" AND "submission_idempotency_bindings"."contribution_consent"
        AND (NOT "submission_idempotency_bindings"."contact_present" OR "submission_idempotency_bindings"."email_follow_up_consent")),
	CONSTRAINT "submission_idempotency_bindings_challenge_ck" CHECK ("submission_idempotency_bindings"."challenge_provider" = 'turnstile'),
	CONSTRAINT "submission_idempotency_bindings_retention_ck" CHECK (
      "submission_idempotency_bindings"."retention_expires_at" > "submission_idempotency_bindings"."accepted_at"
      AND (
        ("submission_idempotency_bindings"."contact_present" = false AND "submission_idempotency_bindings"."contact_digest" IS NULL AND "submission_idempotency_bindings"."contact_retention_expires_at" IS NULL)
        OR
        ("submission_idempotency_bindings"."contact_present" = true AND "submission_idempotency_bindings"."contact_digest" IS NOT NULL
          AND "submission_idempotency_bindings"."contact_retention_expires_at" > "submission_idempotency_bindings"."accepted_at"
          AND "submission_idempotency_bindings"."contact_retention_expires_at" <= "submission_idempotency_bindings"."retention_expires_at")
      )
    )
);
--> statement-breakpoint
CREATE TABLE "submission_intake_contacts" (
	"intake_id" uuid PRIMARY KEY NOT NULL,
	"contact_present" boolean DEFAULT true NOT NULL,
	"contact_digest" text NOT NULL,
	"contact_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_intake_contacts_present_ck" CHECK ("submission_intake_contacts"."contact_present"),
	CONSTRAINT "submission_intake_contacts_digest_ck" CHECK ("submission_intake_contacts"."contact_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "submission_intake_contacts_email_length_ck" CHECK (char_length("submission_intake_contacts"."contact_email") BETWEEN 3 AND 320)
);
--> statement-breakpoint
CREATE TABLE "submission_rate_limit_buckets" (
	"scope" text NOT NULL,
	"subject_hash" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"window_seconds" integer NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_rate_limit_buckets_scope_subject_hash_window_started_at_window_seconds_pk" PRIMARY KEY("scope","subject_hash","window_started_at","window_seconds"),
	CONSTRAINT "submission_rate_limit_buckets_window_ck" CHECK ("submission_rate_limit_buckets"."window_seconds" > 0),
	CONSTRAINT "submission_rate_limit_buckets_count_ck" CHECK ("submission_rate_limit_buckets"."request_count" >= 1),
	CONSTRAINT "submission_rate_limit_buckets_expiry_ck" CHECK ("submission_rate_limit_buckets"."expires_at" > "submission_rate_limit_buckets"."window_started_at")
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "receipt_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "intake_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "hmac_version" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contributor_key" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "content_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "submission_email_follow_ups_key_uq" ON "submission_email_follow_ups" USING btree ("follow_up_key");--> statement-breakpoint
CREATE INDEX "submission_email_follow_ups_worker_idx" ON "submission_email_follow_ups" USING btree ("status","available_at","lease_expires_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_idempotency_bindings_scope_uq" ON "submission_idempotency_bindings" USING btree ("kind","idempotency_actor_key","idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_idempotency_bindings_id_submission_uq" ON "submission_idempotency_bindings" USING btree ("id","submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_idempotency_bindings_contact_contract_uq" ON "submission_idempotency_bindings" USING btree ("id","contact_present","contact_digest");--> statement-breakpoint
CREATE INDEX "submission_idempotency_bindings_submission_idx" ON "submission_idempotency_bindings" USING btree ("submission_id","accepted_at","id");--> statement-breakpoint
CREATE INDEX "submission_idempotency_bindings_retention_idx" ON "submission_idempotency_bindings" USING btree ("retention_expires_at","id");--> statement-breakpoint
CREATE INDEX "submission_idempotency_bindings_contact_retention_idx" ON "submission_idempotency_bindings" USING btree ("contact_retention_expires_at","id") WHERE "submission_idempotency_bindings"."contact_retention_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "submission_rate_limit_buckets_expiry_idx" ON "submission_rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_receipt_id_uq" ON "submissions" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_intake_contract_uq" ON "submissions" USING btree ("id","kind","intake_version","hmac_version","receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_active_contributor_content_uq" ON "submissions" USING btree ("kind","hmac_version","contributor_key","content_fingerprint") WHERE "submissions"."status" IN ('pending', 'in_review') AND "submissions"."contributor_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "submissions_content_fingerprint_idx" ON "submissions" USING btree ("kind","hmac_version","content_fingerprint","created_at");--> statement-breakpoint
ALTER TABLE "submission_email_follow_ups" ADD CONSTRAINT "submission_email_follow_ups_intake_fk" FOREIGN KEY ("intake_id","submission_id") REFERENCES "public"."submission_idempotency_bindings"("id","submission_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_idempotency_bindings" ADD CONSTRAINT "submission_idempotency_bindings_submission_contract_fk" FOREIGN KEY ("submission_id","kind","intake_version","hmac_version","receipt_id") REFERENCES "public"."submissions"("id","kind","intake_version","hmac_version","receipt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_intake_contacts" ADD CONSTRAINT "submission_intake_contacts_binding_fk" FOREIGN KEY ("intake_id","contact_present","contact_digest") REFERENCES "public"."submission_idempotency_bindings"("id","contact_present","contact_digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_intake_version_ck" CHECK ("submissions"."intake_version" IN (0, 1));--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_intake_contract_ck" CHECK ((
        "submissions"."intake_version" = 0
        AND "submissions"."hmac_version" IS NULL
        AND "submissions"."contributor_key" IS NULL
        AND "submissions"."content_fingerprint" IS NULL
      ) OR (
        "submissions"."intake_version" = 1
        AND "submissions"."hmac_version" IS NOT NULL
        AND "submissions"."contributor_key" IS NOT NULL
        AND "submissions"."content_fingerprint" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_hmac_version_ck" CHECK ("submissions"."hmac_version" IS NULL OR char_length("submissions"."hmac_version") BETWEEN 1 AND 64);--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_contributor_key_ck" CHECK ("submissions"."contributor_key" IS NULL OR "submissions"."contributor_key" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_content_fingerprint_ck" CHECK ("submissions"."content_fingerprint" IS NULL OR "submissions"."content_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reject_submission_intake_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'submission intake is immutable' USING ERRCODE = '55000';
  END IF;
  IF current_user <> 'repairprint_submission_maintenance' THEN
    RAISE EXCEPTION 'submission intake deletion is maintenance-only' USING ERRCODE = '42501';
  END IF;
  IF OLD.retention_expires_at > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'live submission intake cannot be deleted' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER submission_intakes_immutable_row_trg
BEFORE UPDATE OR DELETE ON public.submission_idempotency_bindings
FOR EACH ROW EXECUTE FUNCTION public.reject_submission_intake_mutation();--> statement-breakpoint
CREATE TRIGGER submission_intakes_immutable_truncate_trg
BEFORE TRUNCATE ON public.submission_idempotency_bindings
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_submission_intake_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reject_submission_contact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  contact_deadline timestamptz;
  intake_deadline timestamptz;
BEGIN
  IF TG_OP IN ('UPDATE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'submission intake contact is immutable' USING ERRCODE = '55000';
  END IF;
  IF current_user <> 'repairprint_submission_maintenance' THEN
    RAISE EXCEPTION 'submission intake contact deletion is maintenance-only' USING ERRCODE = '42501';
  END IF;
  SELECT intake.contact_retention_expires_at, intake.retention_expires_at
    INTO contact_deadline, intake_deadline
  FROM public.submission_idempotency_bindings AS intake
  WHERE intake.id = OLD.intake_id;
  IF NOT FOUND OR (
    contact_deadline > pg_catalog.clock_timestamp()
    AND intake_deadline > pg_catalog.clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'live submission intake contact cannot be deleted' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER submission_intake_contacts_immutable_row_trg
BEFORE UPDATE OR DELETE ON public.submission_intake_contacts
FOR EACH ROW EXECUTE FUNCTION public.reject_submission_contact_mutation();--> statement-breakpoint
CREATE TRIGGER submission_intake_contacts_immutable_truncate_trg
BEFORE TRUNCATE ON public.submission_intake_contacts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_submission_contact_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reject_live_submission_parent_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'submission parents cannot be truncated' USING ERRCODE = '55000';
  END IF;
  IF OLD.intake_version = 1 AND (
    current_user <> 'repairprint_submission_maintenance'
    OR EXISTS (
      SELECT 1 FROM public.submission_idempotency_bindings AS intake
      WHERE intake.submission_id = OLD.id
    )
  ) THEN
    RAISE EXCEPTION 'live submission parent cannot be deleted' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER submissions_parent_delete_trg
BEFORE DELETE ON public.submissions
FOR EACH ROW EXECUTE FUNCTION public.reject_live_submission_parent_delete();--> statement-breakpoint
CREATE TRIGGER submissions_parent_truncate_trg
BEFORE TRUNCATE ON public.submissions
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_live_submission_parent_delete();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.assert_submission_parent_has_intake()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'repairprint_submission_service' AND NEW.intake_version <> 1 THEN
    RAISE EXCEPTION 'submission service may create only version-one parents' USING ERRCODE = '23514';
  END IF;
  IF NEW.intake_version = 1 AND NOT EXISTS (
    SELECT 1 FROM public.submission_hmac_key_pin AS pin
    WHERE pin.singleton = true
      AND pin.hmac_version = NEW.hmac_version
  ) THEN
    RAISE EXCEPTION 'version-one submission must match the pinned HMAC version' USING ERRCODE = '23514';
  END IF;
  IF NEW.intake_version = 1 AND NOT EXISTS (
    SELECT 1 FROM public.submission_idempotency_bindings AS intake
    WHERE intake.submission_id = NEW.id
      AND intake.kind = NEW.kind
      AND intake.receipt_id = NEW.receipt_id
      AND intake.hmac_version = NEW.hmac_version
  ) THEN
    RAISE EXCEPTION 'version-one submission requires an immutable intake' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER submissions_require_intake_trg
AFTER INSERT OR UPDATE ON public.submissions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_submission_parent_has_intake();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.assert_submission_intake_has_contact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.contact_present AND NOT EXISTS (
    SELECT 1 FROM public.submission_intake_contacts AS contact
    WHERE contact.intake_id = NEW.id
      AND contact.contact_digest = NEW.contact_digest
  ) THEN
    RAISE EXCEPTION 'contact-present intake requires its private contact row' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER submission_intakes_require_contact_trg
AFTER INSERT ON public.submission_idempotency_bindings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_submission_intake_has_contact();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.assert_submission_parent_after_intake_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.submissions AS parent WHERE parent.id = OLD.submission_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.submission_idempotency_bindings AS intake
      WHERE intake.submission_id = OLD.submission_id
    ) THEN
    RAISE EXCEPTION 'semantic submission cannot outlive its final intake' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER submission_intakes_preserve_parent_graph_trg
AFTER DELETE ON public.submission_idempotency_bindings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_submission_parent_after_intake_delete();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_submission_follow_up_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.qualifying_event NOT IN ('matching_publication', 'moderator_question')
    OR NEW.follow_up_key !~ (
      '^intake:' || NEW.intake_id::text || ':' || NEW.qualifying_event
      || ':[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) THEN
    RAISE EXCEPTION 'submission follow-up requires a typed server event UUID' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.submission_idempotency_bindings AS intake
    INNER JOIN public.submissions AS parent
      ON parent.id = intake.submission_id
      AND parent.kind = intake.kind
      AND parent.receipt_id = intake.receipt_id
      AND parent.hmac_version = intake.hmac_version
    INNER JOIN public.submission_intake_contacts AS contact
      ON contact.intake_id = intake.id
      AND contact.contact_digest = intake.contact_digest
    WHERE intake.id = NEW.intake_id
      AND intake.submission_id = NEW.submission_id
      AND intake.email_follow_up_consent = true
      AND intake.contact_consent_version = 'wp08-email-follow-up-v1'
      AND intake.contact_retention_expires_at > pg_catalog.clock_timestamp()
      AND intake.retention_expires_at > pg_catalog.clock_timestamp()
      AND parent.status IN ('pending', 'in_review')
      AND (
        NEW.qualifying_event = 'moderator_question'
        OR (NEW.qualifying_event = 'matching_publication' AND parent.kind = 'missing_part')
      )
  ) THEN
    RAISE EXCEPTION 'submission follow-up requires one exact eligible intake' USING ERRCODE = '23514';
  END IF;
  NEW.available_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER submission_follow_ups_eligibility_trg
BEFORE INSERT ON public.submission_email_follow_ups
FOR EACH ROW EXECUTE FUNCTION public.enforce_submission_follow_up_eligibility();--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_submission_service') THEN
    CREATE ROLE repairprint_submission_service
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE repairprint_submission_service
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_submission_maintenance') THEN
    CREATE ROLE repairprint_submission_maintenance
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE repairprint_submission_maintenance
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE (
      granted_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
      OR member_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
    ) AND NOT (
      granted_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
      AND member_role.rolname = 'postgres'
      AND grantor_role.rolname = 'supabase_admin'
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
    )
  ) THEN
    RAISE EXCEPTION 'submission roles retain an unsafe role membership';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE granted_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
      AND member_role.rolname = 'postgres'
      AND grantor_role.rolname = 'supabase_admin'
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
  ) NOT IN (0, 2) THEN
    RAISE EXCEPTION 'submission roles retain an incomplete provider administration membership pair';
  END IF;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.cleanup_expired_submission_intakes(p_batch_limit integer)
RETURNS TABLE (
  deleted_contacts bigint,
  deleted_follow_ups bigint,
  deleted_intakes bigint,
  deleted_submissions bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_ids uuid[] := ARRAY[]::uuid[];
  parent_ids uuid[] := ARRAY[]::uuid[];
  cleanup_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_batch_limit IS NULL OR p_batch_limit < 1 OR p_batch_limit > 1000 THEN
    RAISE EXCEPTION 'invalid cleanup batch limit' USING ERRCODE = '22023';
  END IF;

  SELECT
    COALESCE(pg_catalog.array_agg(locked.id), ARRAY[]::uuid[]),
    COALESCE(pg_catalog.array_agg(locked.submission_id), ARRAY[]::uuid[])
  INTO candidate_ids, parent_ids
  FROM (
    SELECT intake.id, intake.submission_id
    FROM public.submission_idempotency_bindings AS intake
    INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
    LEFT JOIN public.submission_intake_contacts AS contact ON contact.intake_id = intake.id
    WHERE intake.retention_expires_at <= cleanup_now
      OR (contact.intake_id IS NOT NULL AND intake.contact_retention_expires_at <= cleanup_now)
    ORDER BY LEAST(
      intake.retention_expires_at,
      COALESCE(intake.contact_retention_expires_at, intake.retention_expires_at)
    ), intake.id
    LIMIT p_batch_limit
    FOR UPDATE OF parent, intake SKIP LOCKED
  ) AS locked;

  DELETE FROM public.submission_email_follow_ups AS follow_up
  WHERE follow_up.intake_id = ANY(candidate_ids);
  GET DIAGNOSTICS deleted_follow_ups = ROW_COUNT;

  DELETE FROM public.submission_intake_contacts AS contact
  USING public.submission_idempotency_bindings AS intake
  WHERE contact.intake_id = intake.id
    AND intake.id = ANY(candidate_ids)
    AND (
      intake.retention_expires_at <= cleanup_now
      OR intake.contact_retention_expires_at <= cleanup_now
    );
  GET DIAGNOSTICS deleted_contacts = ROW_COUNT;

  DELETE FROM public.submission_idempotency_bindings AS intake
  WHERE intake.id = ANY(candidate_ids)
    AND intake.retention_expires_at <= cleanup_now;
  GET DIAGNOSTICS deleted_intakes = ROW_COUNT;

  DELETE FROM public.submissions AS parent
  WHERE parent.id = ANY(parent_ids)
    AND parent.intake_version = 1
    AND NOT EXISTS (
      SELECT 1 FROM public.submission_idempotency_bindings AS intake
      WHERE intake.submission_id = parent.id
    );
  GET DIAGNOSTICS deleted_submissions = ROW_COUNT;

  RETURN NEXT;
END;
$$;--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE public.submissions FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.submission_idempotency_bindings FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.submission_intake_contacts FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.submission_email_follow_ups FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.submission_rate_limit_buckets FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.submission_hmac_key_pin FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.cleanup_expired_submission_intakes(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_submission_intake_mutation() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_submission_contact_mutation() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_live_submission_parent_delete() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_submission_parent_has_intake() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_submission_intake_has_contact() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_submission_parent_after_intake_delete() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_submission_follow_up_eligibility() FROM PUBLIC;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.submissions, public.submission_idempotency_bindings,
      public.submission_intake_contacts, public.submission_email_follow_ups,
      public.submission_rate_limit_buckets, public.submission_hmac_key_pin FROM anon;
    REVOKE ALL ON FUNCTION public.cleanup_expired_submission_intakes(integer) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.submissions, public.submission_idempotency_bindings,
      public.submission_intake_contacts, public.submission_email_follow_ups,
      public.submission_rate_limit_buckets, public.submission_hmac_key_pin FROM authenticated;
    REVOKE ALL ON FUNCTION public.cleanup_expired_submission_intakes(integer) FROM authenticated;
  END IF;

  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM repairprint_submission_service;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM repairprint_submission_service;
  REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM repairprint_submission_service;
  GRANT USAGE ON SCHEMA public TO repairprint_submission_service;
  GRANT SELECT ON TABLE public.submissions, public.submission_idempotency_bindings,
    public.submission_intake_contacts, public.submission_email_follow_ups,
    public.submission_rate_limit_buckets, public.submission_hmac_key_pin
    TO repairprint_submission_service;
  GRANT INSERT (kind, payload, intake_version, hmac_version, contributor_key, content_fingerprint)
    ON TABLE public.submissions TO repairprint_submission_service;
  GRANT INSERT (
    kind, idempotency_actor_key, idempotency_key_hash, submission_id, receipt_id,
    intake_version, hmac_version, request_fingerprint, payload, privacy_consent,
    contribution_consent, email_follow_up_consent, contributor_terms_version,
    privacy_notice_version, contact_consent_version, retention_policy_version,
    accepted_at, challenge_provider, challenge_verified_at, contact_present,
    contact_digest, retention_expires_at, contact_retention_expires_at
  ) ON TABLE public.submission_idempotency_bindings TO repairprint_submission_service;
  GRANT INSERT (intake_id, contact_present, contact_digest, contact_email)
    ON TABLE public.submission_intake_contacts TO repairprint_submission_service;
  GRANT INSERT (intake_id, submission_id, follow_up_key, qualifying_event, template_key, available_at)
    ON TABLE public.submission_email_follow_ups TO repairprint_submission_service;
  GRANT INSERT (scope, subject_hash, window_started_at, window_seconds, expires_at)
    ON TABLE public.submission_rate_limit_buckets TO repairprint_submission_service;
  GRANT UPDATE (request_count, updated_at)
    ON TABLE public.submission_rate_limit_buckets TO repairprint_submission_service;
  GRANT DELETE ON TABLE public.submission_rate_limit_buckets TO repairprint_submission_service;
  GRANT EXECUTE ON FUNCTION public.cleanup_expired_submission_intakes(integer)
    TO repairprint_submission_service;

  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM repairprint_submission_maintenance;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM repairprint_submission_maintenance;
  REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM repairprint_submission_maintenance;
  GRANT USAGE ON SCHEMA public TO repairprint_submission_maintenance;
  GRANT SELECT, DELETE ON TABLE public.submissions, public.submission_idempotency_bindings,
    public.submission_intake_contacts, public.submission_email_follow_ups
    TO repairprint_submission_maintenance;
  GRANT UPDATE (updated_at) ON TABLE public.submissions TO repairprint_submission_maintenance;
  GRANT UPDATE (request_fingerprint) ON TABLE public.submission_idempotency_bindings
    TO repairprint_submission_maintenance;
  GRANT EXECUTE ON FUNCTION public.reject_submission_intake_mutation(),
    public.reject_submission_contact_mutation(), public.reject_live_submission_parent_delete(),
    public.assert_submission_parent_has_intake(), public.assert_submission_intake_has_contact(),
    public.assert_submission_parent_after_intake_delete(), public.enforce_submission_follow_up_eligibility()
    TO repairprint_submission_maintenance;
END
$$;--> statement-breakpoint

GRANT CREATE ON SCHEMA public TO repairprint_submission_maintenance;--> statement-breakpoint
ALTER FUNCTION public.cleanup_expired_submission_intakes(integer) OWNER TO repairprint_submission_maintenance;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM repairprint_submission_maintenance;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.cleanup_expired_submission_intakes(integer) TO repairprint_submission_service;
