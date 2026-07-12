CREATE TYPE "public"."submission_email_status" AS ENUM('awaiting_event', 'pending', 'processing', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "submission_email_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"follow_up_key" text NOT NULL,
	"template_key" text NOT NULL,
	"status" "submission_email_status" DEFAULT 'awaiting_event' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone,
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
	CONSTRAINT "submission_email_follow_ups_availability_ck" CHECK (("submission_email_follow_ups"."status" = 'awaiting_event' AND "submission_email_follow_ups"."available_at" IS NULL)
        OR ("submission_email_follow_ups"."status" IN ('pending', 'processing', 'sent', 'failed') AND "submission_email_follow_ups"."available_at" IS NOT NULL)
        OR "submission_email_follow_ups"."status" = 'cancelled')
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
ALTER TABLE "submissions" ADD COLUMN "intake_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
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
ALTER TABLE "submission_email_follow_ups" ADD CONSTRAINT "submission_email_follow_ups_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "submission_email_follow_ups_key_uq" ON "submission_email_follow_ups" USING btree ("follow_up_key");--> statement-breakpoint
CREATE INDEX "submission_email_follow_ups_worker_idx" ON "submission_email_follow_ups" USING btree ("status","available_at","lease_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "submission_rate_limit_buckets_expiry_idx" ON "submission_rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_idempotency_key_hash_uq" ON "submissions" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_active_contributor_content_uq" ON "submissions" USING btree ("kind","contributor_key","content_fingerprint") WHERE "submissions"."status" IN ('pending', 'in_review') AND "submissions"."contributor_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "submissions_content_fingerprint_idx" ON "submissions" USING btree ("kind","content_fingerprint","created_at");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_intake_version_ck" CHECK ("submissions"."intake_version" IN (0, 1));--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_intake_contract_ck" CHECK ((
        "submissions"."intake_version" = 0
        AND "submissions"."idempotency_key_hash" IS NULL
        AND "submissions"."request_fingerprint" IS NULL
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
      ) OR (
        "submissions"."intake_version" = 1
        AND "submissions"."idempotency_key_hash" IS NOT NULL
        AND "submissions"."request_fingerprint" IS NOT NULL
        AND "submissions"."contributor_key" IS NOT NULL
        AND "submissions"."content_fingerprint" IS NOT NULL
        AND "submissions"."contributor_terms_version" IS NOT NULL
        AND "submissions"."privacy_notice_version" IS NOT NULL
        AND "submissions"."consented_at" IS NOT NULL
        AND "submissions"."challenge_provider" = 'turnstile'
        AND "submissions"."challenge_verified_at" IS NOT NULL
        AND (
          ("submissions"."contact_email" IS NULL AND "submissions"."contact_consent_version" IS NULL AND "submissions"."contact_consented_at" IS NULL)
          OR
          ("submissions"."contact_email" IS NOT NULL AND "submissions"."contact_consent_version" IS NOT NULL AND "submissions"."contact_consented_at" IS NOT NULL)
        )
      ));--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_contact_email_length_ck" CHECK ("submissions"."contact_email" IS NULL OR char_length("submissions"."contact_email") <= 320);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "submission_email_follow_ups" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "submission_rate_limit_buckets" FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE "submission_email_follow_ups" FROM anon;
    REVOKE ALL PRIVILEGES ON TABLE "submission_rate_limit_buckets" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE "submission_email_follow_ups" FROM authenticated;
    REVOKE ALL PRIVILEGES ON TABLE "submission_rate_limit_buckets" FROM authenticated;
  END IF;
END
$$;
