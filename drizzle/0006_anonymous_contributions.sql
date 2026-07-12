CREATE TYPE "public"."submission_email_status" AS ENUM('pending', 'processing', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "submission_email_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
ALTER TABLE "submissions" ADD COLUMN "contributor_key" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "content_fingerprint" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contributor_terms_version" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "privacy_notice_version" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "challenge_provider" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "challenge_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contact_consent_version" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contact_consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "retention_policy_version" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "retention_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contact_retention_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "submission_idempotency_bindings" (
	"kind" "submission_kind" NOT NULL,
	"idempotency_actor_key" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"intake_version" integer DEFAULT 1 NOT NULL,
	"request_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_idempotency_bindings_pk" PRIMARY KEY("kind","idempotency_actor_key","idempotency_key_hash"),
	CONSTRAINT "submission_idempotency_bindings_intake_version_ck" CHECK ("submission_idempotency_bindings"."intake_version" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_id_kind_intake_uq" ON "submissions" USING btree ("id","kind","intake_version");--> statement-breakpoint
ALTER TABLE "submission_idempotency_bindings" ADD CONSTRAINT "submission_idempotency_bindings_submission_contract_fk" FOREIGN KEY ("submission_id","kind","intake_version") REFERENCES "public"."submissions"("id","kind","intake_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_email_follow_ups" ADD CONSTRAINT "submission_email_follow_ups_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "submission_email_follow_ups_key_uq" ON "submission_email_follow_ups" USING btree ("follow_up_key");--> statement-breakpoint
CREATE INDEX "submission_email_follow_ups_worker_idx" ON "submission_email_follow_ups" USING btree ("status","available_at","lease_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "submission_rate_limit_buckets_expiry_idx" ON "submission_rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "submission_idempotency_bindings_submission_idx" ON "submission_idempotency_bindings" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_receipt_id_uq" ON "submissions" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_active_contributor_content_uq" ON "submissions" USING btree ("kind","contributor_key","content_fingerprint") WHERE "submissions"."status" IN ('pending', 'in_review') AND "submissions"."contributor_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "submissions_content_fingerprint_idx" ON "submissions" USING btree ("kind","content_fingerprint","created_at");--> statement-breakpoint
CREATE INDEX "submissions_retention_idx" ON "submissions" USING btree ("retention_expires_at","id") WHERE "submissions"."retention_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "submissions_contact_retention_idx" ON "submissions" USING btree ("contact_retention_expires_at","id") WHERE "submissions"."contact_retention_expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_intake_version_ck" CHECK ("submissions"."intake_version" IN (0, 1));--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_intake_contract_ck" CHECK ((
        "submissions"."intake_version" = 0
        AND "submissions"."contributor_key" IS NULL
        AND "submissions"."content_fingerprint" IS NULL
        AND "submissions"."contributor_terms_version" IS NULL
        AND "submissions"."privacy_notice_version" IS NULL
        AND "submissions"."consented_at" IS NULL
        AND "submissions"."challenge_provider" IS NULL
        AND "submissions"."challenge_verified_at" IS NULL
        AND "submissions"."contact_email" IS NULL
        AND "submissions"."contact_consent_version" IS NULL
        AND "submissions"."contact_consented_at" IS NULL
        AND "submissions"."retention_policy_version" IS NULL
        AND "submissions"."retention_expires_at" IS NULL
        AND "submissions"."contact_retention_expires_at" IS NULL
      ) OR (
        "submissions"."intake_version" = 1
        AND "submissions"."contributor_key" IS NOT NULL
        AND "submissions"."content_fingerprint" IS NOT NULL
        AND "submissions"."contributor_terms_version" IS NOT NULL
        AND "submissions"."privacy_notice_version" IS NOT NULL
        AND "submissions"."consented_at" IS NOT NULL
        AND "submissions"."challenge_provider" = 'turnstile'
        AND "submissions"."challenge_verified_at" IS NOT NULL
        AND "submissions"."retention_policy_version" IS NOT NULL
        AND "submissions"."retention_expires_at" IS NOT NULL
        AND (
          ("submissions"."contact_email" IS NULL AND "submissions"."contact_consent_version" IS NULL AND "submissions"."contact_consented_at" IS NULL AND "submissions"."contact_retention_expires_at" IS NULL)
          OR
          ("submissions"."contact_email" IS NOT NULL AND "submissions"."contact_consent_version" IS NOT NULL AND "submissions"."contact_consented_at" IS NOT NULL AND "submissions"."contact_retention_expires_at" IS NOT NULL)
        )
      ));--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_contact_email_length_ck" CHECK ("submissions"."contact_email" IS NULL OR char_length("submissions"."contact_email") <= 320);--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_retention_deadline_ck" CHECK ("submissions"."retention_expires_at" IS NULL OR "submissions"."retention_expires_at" > "submissions"."consented_at");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_contact_retention_deadline_ck" CHECK ("submissions"."contact_retention_expires_at" IS NULL OR (
        "submissions"."contact_retention_expires_at" > "submissions"."contact_consented_at"
        AND "submissions"."contact_retention_expires_at" <= "submissions"."retention_expires_at"
      ));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "submission_email_follow_ups" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "submission_idempotency_bindings" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "submission_rate_limit_buckets" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "submissions" FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE "submission_email_follow_ups" FROM anon;
    REVOKE ALL PRIVILEGES ON TABLE "submission_idempotency_bindings" FROM anon;
    REVOKE ALL PRIVILEGES ON TABLE "submission_rate_limit_buckets" FROM anon;
    REVOKE ALL PRIVILEGES ON TABLE "submissions" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE "submission_email_follow_ups" FROM authenticated;
    REVOKE ALL PRIVILEGES ON TABLE "submission_idempotency_bindings" FROM authenticated;
    REVOKE ALL PRIVILEGES ON TABLE "submission_rate_limit_buckets" FROM authenticated;
    REVOKE ALL PRIVILEGES ON TABLE "submissions" FROM authenticated;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_submission_service') THEN
    CREATE ROLE repairprint_submission_service
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE repairprint_submission_service
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM repairprint_submission_service;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "public" FROM repairprint_submission_service;
  REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "public" FROM repairprint_submission_service;
  GRANT USAGE ON SCHEMA "public" TO repairprint_submission_service;
  GRANT SELECT, DELETE ON TABLE
    "submissions",
    "submission_rate_limit_buckets",
    "submission_email_follow_ups"
  TO repairprint_submission_service;
  GRANT SELECT ON TABLE "submission_idempotency_bindings" TO repairprint_submission_service;
  GRANT INSERT (
    "kind", "payload", "intake_version", "contributor_key", "content_fingerprint",
    "contributor_terms_version", "privacy_notice_version",
    "consented_at", "challenge_provider", "challenge_verified_at", "contact_email",
    "contact_consent_version", "contact_consented_at", "retention_policy_version",
    "retention_expires_at", "contact_retention_expires_at"
  ) ON TABLE "submissions" TO repairprint_submission_service;
  GRANT UPDATE (
    "contact_email", "contact_consent_version", "contact_consented_at",
    "contact_retention_expires_at", "contributor_key", "updated_at"
  ) ON TABLE "submissions" TO repairprint_submission_service;
  GRANT INSERT (
    "kind", "idempotency_actor_key", "idempotency_key_hash", "submission_id", "request_fingerprint"
  ) ON TABLE "submission_idempotency_bindings" TO repairprint_submission_service;
  GRANT UPDATE ("request_fingerprint")
    ON TABLE "submission_idempotency_bindings" TO repairprint_submission_service;
  GRANT INSERT (
    "scope", "subject_hash", "window_started_at", "window_seconds", "expires_at"
  ) ON TABLE "submission_rate_limit_buckets" TO repairprint_submission_service;
  GRANT UPDATE ("request_count", "updated_at")
    ON TABLE "submission_rate_limit_buckets" TO repairprint_submission_service;
  GRANT INSERT ("submission_id", "follow_up_key", "qualifying_event", "template_key", "available_at")
    ON TABLE "submission_email_follow_ups" TO repairprint_submission_service;
END
$$;
