CREATE TYPE "public"."staff_role" AS ENUM('editor', 'reviewer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"status" "staff_status" DEFAULT 'invited' NOT NULL,
	"mfa_required" boolean DEFAULT false NOT NULL,
	"invited_by_id" uuid,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_profiles_privileged_mfa_ck" CHECK ("staff_profiles"."role" = 'editor' OR "staff_profiles"."mfa_required" = true)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "actor_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_invited_by_id_staff_profiles_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."staff_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_profiles_auth_user_uq" ON "staff_profiles" USING btree ("auth_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_profiles_email_uq" ON "staff_profiles" USING btree ("email");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_staff_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reject_audit_log_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_immutable"
BEFORE UPDATE OR DELETE ON "public"."audit_log"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_audit_log_mutation"();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate"
BEFORE TRUNCATE ON "public"."audit_log"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_audit_log_mutation"();--> statement-breakpoint
CREATE VIEW "public"."published_brands" WITH (security_barrier = true) AS
SELECT * FROM "public"."brands" WHERE "publication_status" = 'published';--> statement-breakpoint
CREATE VIEW "public"."published_product_models" WITH (security_barrier = true) AS
SELECT * FROM "public"."product_models" WHERE "publication_status" = 'published';--> statement-breakpoint
CREATE VIEW "public"."published_designs" WITH (security_barrier = true) AS
SELECT * FROM "public"."designs" WHERE "publication_status" = 'published';--> statement-breakpoint
CREATE VIEW "public"."published_fitments" WITH (security_barrier = true) AS
SELECT * FROM "public"."fitments" WHERE "publication_status" = 'published';--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM anon;
		GRANT SELECT ON "public"."published_brands", "public"."published_product_models", "public"."published_designs", "public"."published_fitments" TO anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM authenticated;
		GRANT SELECT ON "public"."published_brands", "public"."published_product_models", "public"."published_designs", "public"."published_fitments" TO authenticated;
	END IF;
END;
$$;
