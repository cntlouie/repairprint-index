CREATE TABLE "private_analytics_daily_aggregates" (
	"event_day" date NOT NULL,
	"event_name" text NOT NULL,
	"dimensions" jsonb NOT NULL,
	"event_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "private_analytics_daily_aggregates_event_day_event_name_dimensions_pk" PRIMARY KEY("event_day","event_name","dimensions"),
	CONSTRAINT "private_analytics_event_count_ck" CHECK ("private_analytics_daily_aggregates"."event_count" >= 1),
	CONSTRAINT "private_analytics_event_name_ck" CHECK ("private_analytics_daily_aggregates"."event_name" IN (
      'search_submitted', 'search_resolved', 'variant_disambiguation_shown', 'variant_selected',
      'zero_result', 'part_viewed', 'original_source_clicked', 'fit_report_started',
      'fit_report_submitted', 'missing_part_submitted', 'design_submitted'
    )),
	CONSTRAINT "private_analytics_dimensions_ck" CHECK (
      jsonb_typeof("private_analytics_daily_aggregates"."dimensions") = 'object'
      AND CASE "private_analytics_daily_aggregates"."event_name"
        WHEN 'search_submitted' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['normalizedCategory', 'queryLength', 'identifierLike']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['normalizedCategory', 'queryLength', 'identifierLike'] = '{}'::jsonb
          AND "private_analytics_daily_aggregates"."dimensions"->>'normalizedCategory' IN ('identifier', 'component', 'mixed', 'other')
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'identifierLike') = 'boolean'
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'queryLength') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'queryLength' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'queryLength')::integer BETWEEN 2 AND 160
            ELSE false
          END
        WHEN 'search_resolved' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['entityType', 'matchClass', 'rank', 'ambiguityCount']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['entityType', 'matchClass', 'rank', 'ambiguityCount'] = '{}'::jsonb
          AND "private_analytics_daily_aggregates"."dimensions"->>'entityType' IN ('model', 'part')
          AND "private_analytics_daily_aggregates"."dimensions"->>'matchClass' IN (
            'strict_identifier', 'loose_identifier', 'model_component', 'text', 'trigram'
          )
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'rank') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'rank' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'rank')::integer BETWEEN 1 AND 50
            ELSE false
          END
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'ambiguityCount') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'ambiguityCount' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'ambiguityCount')::integer BETWEEN 0 AND 50
            ELSE false
          END
        WHEN 'variant_disambiguation_shown' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['candidateCount']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['candidateCount'] = '{}'::jsonb
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'candidateCount') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'candidateCount' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'candidateCount')::integer BETWEEN 2 AND 50
            ELSE false
          END
        WHEN 'variant_selected' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['selectedRank']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['selectedRank'] = '{}'::jsonb
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'selectedRank') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'selectedRank' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'selectedRank')::integer BETWEEN 1 AND 50
            ELSE false
          END
        WHEN 'zero_result' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['tokenClass']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['tokenClass', 'brand', 'category'] = '{}'::jsonb
          AND "private_analytics_daily_aggregates"."dimensions"->>'tokenClass' IN ('numeric', 'alphanumeric', 'words', 'mixed')
          AND (NOT ("private_analytics_daily_aggregates"."dimensions" ? 'brand') OR (
            jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'brand') = 'string'
            AND "private_analytics_daily_aggregates"."dimensions"->>'brand' ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
            AND char_length("private_analytics_daily_aggregates"."dimensions"->>'brand') BETWEEN 1 AND 80
          ))
          AND (NOT ("private_analytics_daily_aggregates"."dimensions" ? 'category') OR (
            jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'category') = 'string'
            AND "private_analytics_daily_aggregates"."dimensions"->>'category' ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
            AND char_length("private_analytics_daily_aggregates"."dimensions"->>'category') BETWEEN 1 AND 80
          ))
        WHEN 'part_viewed' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['publicId', 'confidenceTier', 'safetyClass']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['publicId', 'confidenceTier', 'safetyClass'] = '{}'::jsonb
          AND "private_analytics_daily_aggregates"."dimensions"->>'publicId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'publicId') BETWEEN 1 AND 120
          AND "private_analytics_daily_aggregates"."dimensions"->>'confidenceTier' IN ('verified_fit', 'community_confirmed', 'creator_listed')
          AND "private_analytics_daily_aggregates"."dimensions"->>'safetyClass' = 'low'
        WHEN 'original_source_clicked' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['publicId', 'sourcePlatform', 'confidenceTier']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['publicId', 'sourcePlatform', 'confidenceTier'] = '{}'::jsonb
          AND "private_analytics_daily_aggregates"."dimensions"->>'publicId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'publicId') BETWEEN 1 AND 120
          AND "private_analytics_daily_aggregates"."dimensions"->>'sourcePlatform' ~ '^[a-z0-9][a-z0-9._-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'sourcePlatform') BETWEEN 1 AND 80
          AND "private_analytics_daily_aggregates"."dimensions"->>'confidenceTier' IN ('verified_fit', 'community_confirmed', 'creator_listed')
        WHEN 'fit_report_started' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['publicId']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['publicId'] = '{}'::jsonb
          AND "private_analytics_daily_aggregates"."dimensions"->>'publicId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'publicId') BETWEEN 1 AND 120
        WHEN 'fit_report_submitted' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['publicId', 'outcome']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['publicId', 'outcome'] = '{}'::jsonb
          AND "private_analytics_daily_aggregates"."dimensions"->>'publicId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'publicId') BETWEEN 1 AND 120
          AND "private_analytics_daily_aggregates"."dimensions"->>'outcome' IN (
            'fits_without_modification', 'fits_after_modification', 'does_not_fit', 'print_failed', 'unsure'
          )
        WHEN 'missing_part_submitted' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['categoryMatch']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['categoryMatch', 'category'] = '{}'::jsonb
          AND (
            ("private_analytics_daily_aggregates"."dimensions"->>'categoryMatch' = 'unmatched' AND NOT ("private_analytics_daily_aggregates"."dimensions" ? 'category'))
            OR (
              "private_analytics_daily_aggregates"."dimensions"->>'categoryMatch' = 'matched'
              AND "private_analytics_daily_aggregates"."dimensions" ? 'category'
              AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'category') = 'string'
              AND "private_analytics_daily_aggregates"."dimensions"->>'category' ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
              AND char_length("private_analytics_daily_aggregates"."dimensions"->>'category') BETWEEN 1 AND 80
            )
          )
        WHEN 'design_submitted' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['sourcePlatform']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['sourcePlatform'] = '{}'::jsonb
          AND "private_analytics_daily_aggregates"."dimensions"->>'sourcePlatform' IN ('thingiverse', 'printables', 'makerworld', 'other')
        ELSE false
      END
    )
);
--> statement-breakpoint
CREATE INDEX "private_analytics_event_day_idx" ON "private_analytics_daily_aggregates" USING btree ("event_name","event_day");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.record_private_analytics_event(
  p_event_name text,
  p_dimensions jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  aggregate_day date := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_event_name IS NULL
    OR p_dimensions IS NULL
    OR pg_catalog.jsonb_typeof(p_dimensions) <> 'object'
    OR (
      p_event_name IN (
        'part_viewed',
        'original_source_clicked',
        'fit_report_started',
        'fit_report_submitted'
      )
      AND pg_catalog.jsonb_typeof(p_dimensions->'publicId') <> 'string'
    )
    OR (
      p_event_name = 'original_source_clicked'
      AND pg_catalog.jsonb_typeof(p_dimensions->'sourcePlatform') <> 'string'
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_EVENT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF p_event_name = 'part_viewed' AND NOT EXISTS (
    SELECT 1
    FROM public.public_catalogue_fitments AS catalogue
    WHERE catalogue.fitment_public_id = p_dimensions->>'publicId'
      AND catalogue.fitment_status::text = p_dimensions->>'confidenceTier'
      AND catalogue.safety_class::text = p_dimensions->>'safetyClass'
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PUBLIC_CONTEXT_INVALID' USING ERRCODE = '22023';
  ELSIF p_event_name = 'original_source_clicked' AND NOT EXISTS (
    SELECT 1
    FROM public.public_catalogue_fitments AS catalogue
    WHERE catalogue.fitment_public_id = p_dimensions->>'publicId'
      AND catalogue.source_platform = p_dimensions->>'sourcePlatform'
      AND catalogue.fitment_status::text = p_dimensions->>'confidenceTier'
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PUBLIC_CONTEXT_INVALID' USING ERRCODE = '22023';
  ELSIF p_event_name IN ('fit_report_started', 'fit_report_submitted') AND NOT EXISTS (
    SELECT 1
    FROM public.public_catalogue_fitments AS catalogue
    WHERE catalogue.fitment_public_id = p_dimensions->>'publicId'
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PUBLIC_CONTEXT_INVALID' USING ERRCODE = '22023';
  ELSIF p_event_name = 'zero_result'
    AND p_dimensions ? 'brand'
    AND NOT EXISTS (
      SELECT 1
      FROM public.public_catalogue_fitments AS catalogue
      WHERE catalogue.brand_slug = p_dimensions->>'brand'
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_PUBLIC_CONTEXT_INVALID' USING ERRCODE = '22023';
  ELSIF p_event_name = 'zero_result'
    AND p_dimensions ? 'category'
    AND NOT EXISTS (
      SELECT 1
      FROM public.public_catalogue_fitments AS catalogue
      WHERE catalogue.category_slug = p_dimensions->>'category'
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_PUBLIC_CONTEXT_INVALID' USING ERRCODE = '22023';
  ELSIF p_event_name = 'missing_part_submitted'
    AND p_dimensions->>'categoryMatch' = 'matched'
    AND NOT EXISTS (
      SELECT 1
      FROM public.public_catalogue_fitments AS catalogue
      WHERE catalogue.category_slug = p_dimensions->>'category'
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_PUBLIC_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.private_analytics_daily_aggregates (
    event_day,
    event_name,
    dimensions,
    event_count
  ) VALUES (
    aggregate_day,
    p_event_name,
    p_dimensions,
    1
  )
  ON CONFLICT (event_day, event_name, dimensions) DO UPDATE
  SET event_count = public.private_analytics_daily_aggregates.event_count + 1;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_analytics_service') THEN
    CREATE ROLE repairprint_analytics_service
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_analytics_maintenance') THEN
    CREATE ROLE repairprint_analytics_maintenance
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles AS role
    WHERE (role.rolname = 'repairprint_analytics_service' AND (
        NOT role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
        OR role.rolinherit OR role.rolreplication OR role.rolbypassrls
      ))
      OR (role.rolname = 'repairprint_analytics_maintenance' AND (
        role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
        OR role.rolinherit OR role.rolreplication OR role.rolbypassrls
      ))
  ) THEN
    RAISE EXCEPTION 'analytics roles retain unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE (
      granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      OR member_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
    ) AND NOT (
      granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      AND member_role.rolname = 'postgres'
      AND grantor_role.rolname = 'supabase_admin'
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
    )
  ) THEN
    RAISE EXCEPTION 'analytics roles retain unsafe membership';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      AND member_role.rolname = 'postgres'
      AND grantor_role.rolname = 'supabase_admin'
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
  ) NOT IN (0, 2) THEN
    RAISE EXCEPTION 'analytics provider administration membership pair is incomplete';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.private_analytics_daily_aggregates FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.private_analytics_daily_aggregates FROM anon;
    REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.private_analytics_daily_aggregates FROM authenticated;
    REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb) FROM authenticated;
  END IF;

  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM repairprint_analytics_service;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM repairprint_analytics_service;
  REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM repairprint_analytics_service;
  GRANT USAGE ON SCHEMA public TO repairprint_analytics_service;

  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM repairprint_analytics_maintenance;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM repairprint_analytics_maintenance;
  REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM repairprint_analytics_maintenance;
  GRANT USAGE ON SCHEMA public TO repairprint_analytics_maintenance;
  GRANT SELECT, INSERT, UPDATE ON TABLE public.private_analytics_daily_aggregates
    TO repairprint_analytics_maintenance;
  GRANT SELECT ON TABLE public.public_catalogue_fitments TO repairprint_analytics_maintenance;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO repairprint_analytics_maintenance;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'repairprint_analytics_maintenance', 'SET') THEN
    EXECUTE format(
      'GRANT repairprint_analytics_maintenance TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
      current_user
    );
  END IF;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.record_private_analytics_event(text, jsonb)
  OWNER TO repairprint_analytics_maintenance;
--> statement-breakpoint
SET ROLE repairprint_analytics_maintenance;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb) FROM authenticated;
  END IF;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_private_analytics_event(text, jsonb)
  TO repairprint_analytics_service;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format(
    'REVOKE repairprint_analytics_maintenance FROM %I GRANTED BY %I',
    current_user,
    current_user
  );
END
$$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM repairprint_analytics_maintenance;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT has_function_privilege(
    'repairprint_analytics_service',
    'public.record_private_analytics_event(text,jsonb)',
    'EXECUTE'
  ) OR has_table_privilege(
    'repairprint_analytics_service',
    'public.private_analytics_daily_aggregates',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN
    RAISE EXCEPTION 'analytics service privilege boundary is unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles AS role
    WHERE (role.rolname = 'repairprint_analytics_service' AND (
        NOT role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
        OR role.rolinherit OR role.rolreplication OR role.rolbypassrls
      ))
      OR (role.rolname = 'repairprint_analytics_maintenance' AND (
        role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
        OR role.rolinherit OR role.rolreplication OR role.rolbypassrls
      ))
  ) OR EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE (
      granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      OR member_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
    ) AND NOT (
      granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      AND member_role.rolname = 'postgres'
      AND grantor_role.rolname = 'supabase_admin'
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
    )
  ) OR (
    SELECT count(*)
    FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      AND member_role.rolname = 'postgres'
      AND grantor_role.rolname = 'supabase_admin'
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
  ) NOT IN (0, 2) THEN
    RAISE EXCEPTION 'analytics role boundary is unsafe after ownership transfer';
  END IF;
END
$$;
