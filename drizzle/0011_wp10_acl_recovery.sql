DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_source_service')
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_source_maintenance')
  THEN RAISE EXCEPTION 'WP10_ACL_ROLES_MISSING'; END IF;

  PERFORM set_config('repairprint.wp10_acl_temporary_membership', 'false', true);
  IF NOT pg_has_role(current_user, 'repairprint_source_maintenance', 'SET') THEN
    EXECUTE format(
      'GRANT repairprint_source_maintenance TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY %I',
      current_user,
      current_user
    );
    PERFORM set_config('repairprint.wp10_acl_temporary_membership', 'true', true);
  END IF;
END
$$;
--> statement-breakpoint
SET ROLE repairprint_source_maintenance;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  public.upsert_private_source_candidate(text, text, public.source_candidate_origin, text, jsonb, text, uuid, timestamptz, uuid, text, text, text, text),
  public.transition_source_candidate_version(uuid, public.source_ingestion_stage, public.source_ingestion_stage, uuid, text, text),
  public.claim_source_link_check_jobs(text, integer, integer),
  public.complete_source_link_check(uuid, uuid, uuid, integer, text, text, integer, text, integer, timestamptz, text, text)
  FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION
      public.upsert_private_source_candidate(text, text, public.source_candidate_origin, text, jsonb, text, uuid, timestamptz, uuid, text, text, text, text),
      public.transition_source_candidate_version(uuid, public.source_ingestion_stage, public.source_ingestion_stage, uuid, text, text),
      public.claim_source_link_check_jobs(text, integer, integer),
      public.complete_source_link_check(uuid, uuid, uuid, integer, text, text, integer, text, integer, timestamptz, text, text)
      FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION
      public.upsert_private_source_candidate(text, text, public.source_candidate_origin, text, jsonb, text, uuid, timestamptz, uuid, text, text, text, text),
      public.transition_source_candidate_version(uuid, public.source_ingestion_stage, public.source_ingestion_stage, uuid, text, text),
      public.claim_source_link_check_jobs(text, integer, integer),
      public.complete_source_link_check(uuid, uuid, uuid, integer, text, text, integer, text, integer, timestamptz, text, text)
      FROM authenticated;
  END IF;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.upsert_private_source_candidate(text, text, public.source_candidate_origin, text, jsonb, text, uuid, timestamptz, uuid, text, text, text, text),
  public.transition_source_candidate_version(uuid, public.source_ingestion_stage, public.source_ingestion_stage, uuid, text, text),
  public.claim_source_link_check_jobs(text, integer, integer),
  public.complete_source_link_check(uuid, uuid, uuid, integer, text, text, integer, text, integer, timestamptz, text, text)
  TO repairprint_source_service;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('repairprint.wp10_acl_temporary_membership', true) = 'true' THEN
    EXECUTE format(
      'REVOKE repairprint_source_maintenance FROM %I GRANTED BY %I',
      current_user,
      current_user
    );
  END IF;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  expected_names constant text[] := ARRAY[
    'upsert_private_source_candidate',
    'transition_source_candidate_version',
    'claim_source_link_check_jobs',
    'complete_source_link_check'
  ];
  expected_signatures constant text[] := ARRAY[
    'public.upsert_private_source_candidate(text,text,public.source_candidate_origin,text,jsonb,text,uuid,timestamptz,uuid,text,text,text,text)',
    'public.transition_source_candidate_version(uuid,public.source_ingestion_stage,public.source_ingestion_stage,uuid,text,text)',
    'public.claim_source_link_check_jobs(text,integer,integer)',
    'public.complete_source_link_check(uuid,uuid,uuid,integer,text,text,integer,text,integer,timestamptz,text,text)'
  ];
  expected_oids oid[] := ARRAY[]::oid[];
  function_oid regprocedure;
  function_signature text;
  service_oid oid;
  maintenance_oid oid;
BEGIN
  SELECT oid INTO service_oid FROM pg_roles WHERE rolname = 'repairprint_source_service';
  SELECT oid INTO maintenance_oid FROM pg_roles WHERE rolname = 'repairprint_source_maintenance';
  IF service_oid IS NULL OR maintenance_oid IS NULL THEN
    RAISE EXCEPTION 'WP10_ACL_ROLES_MISSING_AFTER_REPAIR';
  END IF;

  FOREACH function_signature IN ARRAY expected_signatures LOOP
    function_oid := to_regprocedure(function_signature);
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'WP10_ACL_FUNCTION_MISSING: %', function_signature;
    END IF;
    expected_oids := array_append(expected_oids, function_oid::oid);

    IF EXISTS (
      SELECT 1 FROM pg_proc AS procedure
      WHERE procedure.oid = function_oid::oid
        AND (procedure.proowner <> maintenance_oid OR NOT procedure.prosecdef
          OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[])
    ) THEN RAISE EXCEPTION 'WP10_ACL_FUNCTION_DEFINITION_INVALID: %', function_signature; END IF;

    IF NOT has_function_privilege('repairprint_source_service', function_oid::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'WP10_ACL_SERVICE_EXECUTE_MISSING: %', function_signature;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
      WHERE procedure.oid = function_oid::oid AND acl.grantee = service_oid
        AND acl.grantor = maintenance_oid AND acl.privilege_type = 'EXECUTE'
    ) THEN RAISE EXCEPTION 'WP10_ACL_SERVICE_GRANT_NOT_OWNER_BOUND: %', function_signature; END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) AS acl
      WHERE procedure.oid = function_oid::oid AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    ) THEN RAISE EXCEPTION 'WP10_ACL_PUBLIC_EXECUTE_REMAINS: %', function_signature; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
      AND has_function_privilege('anon', function_oid::oid, 'EXECUTE')
    THEN RAISE EXCEPTION 'WP10_ACL_ANON_EXECUTE_REMAINS: %', function_signature; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
      AND has_function_privilege('authenticated', function_oid::oid, 'EXECUTE')
    THEN RAISE EXCEPTION 'WP10_ACL_AUTHENTICATED_EXECUTE_REMAINS: %', function_signature; END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public' AND procedure.proname = ANY(expected_names)) <> 4
    OR EXISTS (
      SELECT 1 FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public' AND procedure.proname = ANY(expected_names)
      GROUP BY procedure.proname HAVING count(*) <> 1
    )
  THEN RAISE EXCEPTION 'WP10_ACL_UNEXPECTED_FUNCTION_OVERLOAD'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc AS procedure
    INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
    WHERE namespace.nspname = 'public' AND acl.grantee = service_oid
      AND acl.privilege_type = 'EXECUTE' AND NOT (procedure.oid = ANY(expected_oids))
  ) THEN RAISE EXCEPTION 'WP10_ACL_UNRELATED_SERVICE_FUNCTION_GRANT'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege('repairprint_source_service', relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) THEN RAISE EXCEPTION 'WP10_ACL_SERVICE_TABLE_PRIVILEGE'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class AS sequence
    INNER JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
    CROSS JOIN LATERAL aclexplode(sequence.relacl) AS acl
    WHERE namespace.nspname = 'public' AND sequence.relkind = 'S'
      AND acl.grantee = service_oid
  ) THEN RAISE EXCEPTION 'WP10_ACL_SERVICE_SEQUENCE_PRIVILEGE'; END IF;
  IF has_schema_privilege('repairprint_source_service', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'WP10_ACL_SERVICE_SCHEMA_CREATE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles AS role
    WHERE (role.rolname = 'repairprint_source_service' AND (
      NOT role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole OR role.rolinherit
      OR role.rolreplication OR role.rolbypassrls))
      OR (role.rolname = 'repairprint_source_maintenance' AND (
        role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole OR role.rolinherit
        OR role.rolreplication OR role.rolbypassrls))
  ) THEN RAISE EXCEPTION 'WP10_ACL_ROLE_ATTRIBUTES_INVALID'; END IF;

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
  THEN RAISE EXCEPTION 'WP10_ACL_ROLE_MEMBERSHIPS_INVALID'; END IF;
END
$$;
