CREATE TYPE "public"."import_collision_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."import_collision_type" AS ENUM('duplicate_external_item', 'model_ambiguous', 'part_number_ambiguous', 'supersession_cycle');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('candidate', 'ambiguous', 'rejected', 'unchanged');--> statement-breakpoint
CREATE TYPE "public"."import_run_status" AS ENUM('committed', 'failed');--> statement-breakpoint
CREATE TABLE "import_collisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_run_id" uuid NOT NULL,
	"import_row_id" uuid NOT NULL,
	"collision_type" "import_collision_type" NOT NULL,
	"collision_key" text NOT NULL,
	"conflicting_keys" jsonb NOT NULL,
	"status" "import_collision_status" DEFAULT 'open' NOT NULL,
	"resolution_reason" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_run_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"row_number" integer NOT NULL,
	"record_type" text NOT NULL,
	"external_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "import_row_status" NOT NULL,
	"error_codes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"input_checksum" text NOT NULL,
	"manifest_checksum" text,
	"status" "import_run_status" NOT NULL,
	"report" jsonb NOT NULL,
	"reason" text NOT NULL,
	"request_id" text NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_collisions" ADD CONSTRAINT "import_collisions_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_collisions" ADD CONSTRAINT "import_collisions_import_row_id_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_collisions" ADD CONSTRAINT "import_collisions_resolved_by_staff_profiles_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_actor_id_staff_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_collisions_row_type_key_uq" ON "import_collisions" USING btree ("import_row_id","collision_type","collision_key");--> statement-breakpoint
CREATE INDEX "import_collisions_queue_idx" ON "import_collisions" USING btree ("status","collision_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_run_file_row_uq" ON "import_rows" USING btree ("import_run_id","file_name","row_number");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_idempotency_uq" ON "import_rows" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "import_rows_queue_idx" ON "import_rows" USING btree ("status","record_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_runs_public_id_uq" ON "import_runs" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_runs_input_checksum_uq" ON "import_runs" USING btree ("input_checksum");--> statement-breakpoint
CREATE INDEX "import_runs_status_created_idx" ON "import_runs" USING btree ("status","created_at");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "public"."import_runs", "public"."import_rows", "public"."import_collisions" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "public"."import_runs", "public"."import_rows", "public"."import_collisions" FROM authenticated;
  END IF;
END
$$;
