SET LOCAL search_path = pg_catalog;
--> statement-breakpoint
-- Approved raw canonical evidence (owner identities are intentionally not normalized):
-- fresh PostgreSQL 17 / pg_trgm 1.6 / 31 routines:
-- fb1fec29b971acc669e9ebdfeb3b7f55cf2c6b5710f2ce99cbac020e70bdffac
-- read-only staging / pg_trgm 1.6 / 31 routines:
-- 9815bdde7ae8e74337c527c90b34d23d02ffb508ddc58c1f1a8323b430dcfc94
DO $$
DECLARE
  extension_count integer;
  extension_owner text;
  routine_count integer;
  manifest_fingerprint text;
BEGIN
  SELECT count(*)::integer
  INTO extension_count
  FROM pg_extension AS extension
  WHERE extension.extname = 'pg_trgm';

  SELECT owner_role.rolname
  INTO extension_owner
  FROM pg_extension AS extension
  INNER JOIN pg_roles AS owner_role ON owner_role.oid = extension.extowner
  WHERE extension.extname = 'pg_trgm';

  IF extension_count <> 1 OR EXISTS (
    SELECT 1
    FROM pg_extension AS extension
    INNER JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    INNER JOIN pg_roles AS owner_role ON owner_role.oid = extension.extowner
    WHERE extension.extname = 'pg_trgm'
      AND (
        extension.extversion <> '1.6'
        OR namespace.nspname <> 'public'
        OR NOT extension.extrelocatable
        OR extension.extconfig IS NOT NULL
        OR extension.extcondition IS NOT NULL
        OR owner_role.rolname NOT IN ('repairprint', 'supabase_admin')
      )
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_EXTENSION_BASELINE_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_depend AS dependency
    INNER JOIN pg_proc AS procedure
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = procedure.oid
    INNER JOIN pg_extension AS extension
      ON dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      AND dependency.refobjid = extension.oid
    WHERE extension.extname = 'pg_trgm'
      AND (
        dependency.objsubid <> 0
        OR dependency.refobjsubid <> 0
        OR dependency.deptype <> 'e'
      )
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_DEPENDENCY_BASELINE_INVALID';
  END IF;

  WITH extension_state AS (
    SELECT extension.oid,
      extension.extowner,
      extension.extname,
      extension.extversion,
      namespace.nspname AS schema_name,
      owner_role.rolname AS owner_name,
      extension.extrelocatable,
      extension.extconfig,
      extension.extcondition
    FROM pg_extension AS extension
    INNER JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    INNER JOIN pg_roles AS owner_role ON owner_role.oid = extension.extowner
    WHERE extension.extname = 'pg_trgm'
  ), routine_manifest AS (
    SELECT format(
        '%I.%I(%s)',
        namespace.nspname,
        procedure.proname,
        pg_get_function_identity_arguments(procedure.oid)
      ) AS signature,
      jsonb_build_object(
        'schema', namespace.nspname,
        'signature', format(
          '%I.%I(%s)',
          namespace.nspname,
          procedure.proname,
          pg_get_function_identity_arguments(procedure.oid)
        ),
        'result', pg_get_function_result(procedure.oid),
        'owner', CASE
          WHEN procedure_owner.rolname = extension_state.owner_name THEN '<extension_owner>'
          ELSE procedure_owner.rolname
        END,
        'language', language.lanname,
        'kind', CASE procedure.prokind
          WHEN 'f' THEN 'function'
          WHEN 'p' THEN 'procedure'
          WHEN 'a' THEN 'aggregate'
          WHEN 'w' THEN 'window'
          ELSE procedure.prokind::text
        END,
        'securityDefiner', procedure.prosecdef,
        'volatility', CASE procedure.provolatile
          WHEN 'i' THEN 'immutable'
          WHEN 's' THEN 'stable'
          WHEN 'v' THEN 'volatile'
          ELSE procedure.provolatile::text
        END,
        'parallel', CASE procedure.proparallel
          WHEN 's' THEN 'safe'
          WHEN 'r' THEN 'restricted'
          WHEN 'u' THEN 'unsafe'
          ELSE procedure.proparallel::text
        END,
        'leakproof', procedure.proleakproof,
        'strict', procedure.proisstrict,
        'returnsSet', procedure.proretset,
        'configuration', COALESCE((
          SELECT jsonb_agg(setting ORDER BY setting COLLATE "C")
          FROM unnest(procedure.proconfig) AS setting
        ), '[]'::jsonb),
        'definitionSha256', encode(
          sha256(convert_to(pg_get_functiondef(procedure.oid), 'UTF8')),
          'hex'
        ),
        'aclDefaulted', procedure.proacl IS NULL,
        'acl', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'grantor', CASE
                WHEN acl.grantor = extension_state.extowner THEN '<extension_owner>'
                ELSE pg_get_userbyid(acl.grantor)
              END,
              'grantee', CASE
                WHEN acl.grantee = 0 THEN 'PUBLIC'
                WHEN acl.grantee = extension_state.extowner THEN '<extension_owner>'
                ELSE pg_get_userbyid(acl.grantee)
              END,
              'privilege', acl.privilege_type,
              'grantable', acl.is_grantable
            ) ORDER BY
              CASE
                WHEN acl.grantee = 0 THEN 'PUBLIC'
                WHEN acl.grantee = extension_state.extowner THEN '<extension_owner>'
                ELSE pg_get_userbyid(acl.grantee)
              END COLLATE "C",
              CASE
                WHEN acl.grantor = extension_state.extowner THEN '<extension_owner>'
                ELSE pg_get_userbyid(acl.grantor)
              END COLLATE "C",
              acl.privilege_type COLLATE "C",
              acl.is_grantable
          )
          FROM aclexplode(
            COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
          ) AS acl
        ), '[]'::jsonb)
      ) AS manifest_entry
    FROM pg_proc AS procedure
    INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    INNER JOIN pg_roles AS procedure_owner ON procedure_owner.oid = procedure.proowner
    INNER JOIN pg_language AS language ON language.oid = procedure.prolang
    INNER JOIN pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = procedure.oid
      AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      AND dependency.refobjsubid = 0
      AND dependency.deptype = 'e'
    INNER JOIN extension_state ON extension_state.oid = dependency.refobjid
  )
  SELECT count(*)::integer,
    encode(sha256(convert_to(jsonb_build_object(
      'extension', (
        SELECT jsonb_build_object(
          'name', extension_state.extname,
          'version', extension_state.extversion,
          'schema', extension_state.schema_name,
          'owner', '<extension_owner>',
          'relocatable', extension_state.extrelocatable,
          'configuration', COALESCE(to_jsonb(extension_state.extconfig::text[]), '[]'::jsonb),
          'conditions', COALESCE(to_jsonb(extension_state.extcondition), '[]'::jsonb)
        )
        FROM extension_state
      ),
      'routines', COALESCE(
        jsonb_agg(
          routine_manifest.manifest_entry ORDER BY routine_manifest.signature COLLATE "C"
        ),
        '[]'::jsonb
      )
    )::text, 'UTF8')), 'hex')
  INTO routine_count, manifest_fingerprint
  FROM routine_manifest;

  IF routine_count <> 31 OR NOT (
    (
      extension_owner = 'repairprint'
      AND manifest_fingerprint = 'c0275d3247965414d0ab1902027ee33214f8f11fcd4def7cea0df155fd94efbf'
    ) OR (
      extension_owner = 'supabase_admin'
      AND manifest_fingerprint = 'f40dba0bec070313337e408557cc44ad59f4bafedc94121327bba8a6dc000164'
    )
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_MANIFEST_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    INNER JOIN pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = procedure.oid
      AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      AND dependency.refobjsubid = 0
      AND dependency.deptype = 'e'
    INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
    WHERE extension.extname = 'pg_trgm'
      AND (procedure.prosecdef OR procedure.proconfig IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_ROUTINE_SECURITY_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    INNER JOIN pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = procedure.oid
      AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      AND dependency.refobjsubid = 0
      AND dependency.deptype = 'e'
    INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
    INNER JOIN pg_roles AS grantee_role ON grantee_role.oid = acl.grantee
    WHERE extension.extname = 'pg_trgm'
      AND grantee_role.rolname IN (
        'repairprint_analytics_service',
        'repairprint_analytics_maintenance'
      )
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_DIRECT_ANALYTICS_GRANT';
  END IF;

  PERFORM set_config(
    'repairprint.wp11_pg_trgm_manifest_fingerprint',
    manifest_fingerprint,
    true
  );
END
$$;
--> statement-breakpoint
-- Repair the six submission-media cleanup ACLs in their owner's context. Earlier
-- migrations attempted these exact-object changes after dropping their temporary
-- owner membership; hosted PostgreSQL therefore warned and left PUBLIC EXECUTE in
-- place. Keep this repair separate from the analytics routine boundary below.
DO $$
DECLARE
  expected_names constant text[] := ARRAY[
    'claim_expired_private_media',
    'complete_private_media_cleanup',
    'claim_private_media_quarantine_cleanup',
    'complete_private_media_quarantine_cleanup',
    'claim_private_media_pending_object_cleanup',
    'complete_private_media_pending_object_cleanup'
  ];
  expected_signatures constant text[] := ARRAY[
    'public.claim_expired_private_media(integer,uuid)',
    'public.complete_private_media_cleanup(uuid,uuid[])',
    'public.claim_private_media_quarantine_cleanup(integer,uuid)',
    'public.complete_private_media_quarantine_cleanup(uuid,uuid[])',
    'public.claim_private_media_pending_object_cleanup(integer,uuid)',
    'public.complete_private_media_pending_object_cleanup(uuid,uuid[])'
  ];
  expected_hashes constant text[] := ARRAY[
    'e808d6497297b83a2ef835f53f418cf3ac1c4f77dbbd5b864c27d067f0faad05',
    '4fec04ddc768c40e03477b2c236a90658bc4b37ccbdd244a98d22c6c6ceba053',
    '1ce25e27485ded40bb340216e16f128e73f779a961243a60f2ae826a1ebbeca0',
    'b8bddc9ad048742f5f49de926c8e08d9c14acc25ce7fca3cb0983a72908c2a1b',
    '443b45a000763e985fae74255f858f0808fbd778f30adb1a6b0c5cef5cda021f',
    '541809a72285659cbfc0120364d4e625c2bc701edd93127e56b91cbcc03b1de4'
  ];
  maintenance_oid oid;
  service_oid oid;
  routine_oid oid;
  routine_oids oid[] := ARRAY[]::oid[];
  signature_index integer;
  membership_baseline text;
  unrelated_routine_fingerprint text;
  table_acl_fingerprint text;
BEGIN
  SELECT oid INTO maintenance_oid
  FROM pg_roles WHERE rolname = 'repairprint_submission_maintenance';
  SELECT oid INTO service_oid
  FROM pg_roles WHERE rolname = 'repairprint_submission_service';
  IF maintenance_oid IS NULL OR service_oid IS NULL THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_ROLE_MISSING';
  END IF;

  IF (SELECT count(*)
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = ANY(expected_names)) <> 6
  THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_OVERLOAD_SET_INVALID';
  END IF;

  FOR signature_index IN 1..array_length(expected_signatures, 1) LOOP
    routine_oid := to_regprocedure(expected_signatures[signature_index])::oid;
    IF routine_oid IS NULL THEN
      RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_ROUTINE_MISSING';
    END IF;
    routine_oids := array_append(routine_oids, routine_oid);

    IF EXISTS (
      SELECT 1
      FROM pg_proc AS procedure
      WHERE procedure.oid = routine_oid
        AND (
          procedure.proowner <> maintenance_oid
          OR procedure.prokind <> 'f'
          OR NOT procedure.prosecdef
          OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
          OR encode(sha256(convert_to(pg_get_functiondef(procedure.oid), 'UTF8')), 'hex')
            <> expected_hashes[signature_index]
        )
    ) THEN
      RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_DEFINITION_INVALID';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
      WHERE procedure.oid = routine_oid
        AND acl.grantor = maintenance_oid
        AND acl.grantee = maintenance_oid
        AND acl.privilege_type = 'EXECUTE'
        AND NOT acl.is_grantable
    ) OR EXISTS (
      SELECT 1
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
      LEFT JOIN pg_roles AS grantee_role ON grantee_role.oid = acl.grantee
      WHERE procedure.oid = routine_oid
        AND (
          acl.grantor <> maintenance_oid
          OR acl.privilege_type <> 'EXECUTE'
          OR acl.is_grantable
          OR (
            acl.grantee NOT IN (0, maintenance_oid, service_oid)
            AND grantee_role.rolname NOT IN ('anon', 'authenticated')
          )
        )
    ) THEN
      RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_PREEXISTING_GRANT_INVALID';
    END IF;
  END LOOP;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_array(
        granted_role.rolname,
        member_role.rolname,
        grantor_role.rolname,
        membership.admin_option,
        membership.inherit_option,
        membership.set_option
      ) ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname
    ),
    '[]'::jsonb
  )::text
  INTO membership_baseline
  FROM pg_auth_members AS membership
  INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
  LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
  WHERE granted_role.rolname IN (
      'repairprint_submission_service', 'repairprint_submission_maintenance'
    )
    OR member_role.rolname IN (
      'repairprint_submission_service', 'repairprint_submission_maintenance'
    );

  WITH routine_state AS (
    SELECT format(
        '%I.%I(%s)', namespace.nspname, procedure.proname,
        pg_get_function_identity_arguments(procedure.oid)
      ) AS signature,
      jsonb_build_object(
        'owner', owner_role.rolname,
        'kind', procedure.prokind,
        'securityDefiner', procedure.prosecdef,
        'configuration', COALESCE(to_jsonb(procedure.proconfig), '[]'::jsonb),
        'definitionSha256', encode(
          sha256(convert_to(pg_get_functiondef(procedure.oid), 'UTF8')), 'hex'
        ),
        'aclDefaulted', procedure.proacl IS NULL,
        'acl', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'grantor', pg_get_userbyid(acl.grantor),
              'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              'privilege', acl.privilege_type,
              'grantable', acl.is_grantable
            ) ORDER BY
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
          )
          FROM aclexplode(procedure.proacl) AS acl
        ), '[]'::jsonb)
      ) AS state
    FROM pg_proc AS procedure
    INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    INNER JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE namespace.nspname = 'public'
      AND procedure.oid <> ALL(routine_oids)
  )
  SELECT encode(sha256(convert_to(COALESCE(
    jsonb_agg(state ORDER BY signature), '[]'::jsonb
  )::text, 'UTF8')), 'hex')
  INTO unrelated_routine_fingerprint
  FROM routine_state;

  WITH relation_state AS (
    SELECT format('%I.%I', namespace.nspname, relation.relname) AS identity,
      jsonb_build_object(
        'kind', relation.relkind,
        'owner', owner_role.rolname,
        'aclDefaulted', relation.relacl IS NULL,
        'acl', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'grantor', pg_get_userbyid(acl.grantor),
              'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              'privilege', acl.privilege_type,
              'grantable', acl.is_grantable
            ) ORDER BY
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
          ) FROM aclexplode(relation.relacl) AS acl
        ), '[]'::jsonb),
        'columnAcl', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'column', attribute.attname,
              'grantor', pg_get_userbyid(acl.grantor),
              'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              'privilege', acl.privilege_type,
              'grantable', acl.is_grantable
            ) ORDER BY attribute.attname,
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
          )
          FROM pg_attribute AS attribute
          CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
          WHERE attribute.attrelid = relation.oid AND NOT attribute.attisdropped
        ), '[]'::jsonb)
      ) AS state
    FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    INNER JOIN pg_roles AS owner_role ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = 'public'
  )
  SELECT encode(sha256(convert_to(COALESCE(
    jsonb_agg(state ORDER BY identity), '[]'::jsonb
  )::text, 'UTF8')), 'hex')
  INTO table_acl_fingerprint
  FROM relation_state;

  PERFORM set_config(
    'repairprint.wp11_submission_membership_baseline', membership_baseline, true
  );
  PERFORM set_config(
    'repairprint.wp11_submission_unrelated_routine_fingerprint',
    unrelated_routine_fingerprint,
    true
  );
  PERFORM set_config(
    'repairprint.wp11_submission_table_acl_fingerprint', table_acl_fingerprint, true
  );
  PERFORM set_config('repairprint.wp11_submission_temporary_membership', 'false', true);

  IF NOT pg_has_role(current_user, 'repairprint_submission_maintenance', 'SET') THEN
    EXECUTE format(
      'GRANT repairprint_submission_maintenance TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY %I',
      current_user,
      current_user
    );
    PERFORM set_config('repairprint.wp11_submission_temporary_membership', 'true', true);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      INNER JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      WHERE granted_role.rolname = 'repairprint_submission_maintenance'
        AND member_role.rolname = current_user
        AND grantor_role.rolname = current_user
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option
    ) THEN
      RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_TEMPORARY_MEMBERSHIP_INVALID';
    END IF;
  END IF;
END
$$;
--> statement-breakpoint
SET ROLE repairprint_submission_maintenance;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  public.claim_expired_private_media(integer, uuid),
  public.complete_private_media_cleanup(uuid, uuid[]),
  public.claim_private_media_quarantine_cleanup(integer, uuid),
  public.complete_private_media_quarantine_cleanup(uuid, uuid[]),
  public.claim_private_media_pending_object_cleanup(integer, uuid),
  public.complete_private_media_pending_object_cleanup(uuid, uuid[])
  FROM PUBLIC
  GRANTED BY CURRENT_USER;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION
      public.claim_expired_private_media(integer, uuid),
      public.complete_private_media_cleanup(uuid, uuid[]),
      public.claim_private_media_quarantine_cleanup(integer, uuid),
      public.complete_private_media_quarantine_cleanup(uuid, uuid[]),
      public.claim_private_media_pending_object_cleanup(integer, uuid),
      public.complete_private_media_pending_object_cleanup(uuid, uuid[])
      FROM anon GRANTED BY CURRENT_USER;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION
      public.claim_expired_private_media(integer, uuid),
      public.complete_private_media_cleanup(uuid, uuid[]),
      public.claim_private_media_quarantine_cleanup(integer, uuid),
      public.complete_private_media_quarantine_cleanup(uuid, uuid[]),
      public.claim_private_media_pending_object_cleanup(integer, uuid),
      public.complete_private_media_pending_object_cleanup(uuid, uuid[])
      FROM authenticated GRANTED BY CURRENT_USER;
  END IF;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.claim_expired_private_media(integer, uuid),
  public.complete_private_media_cleanup(uuid, uuid[]),
  public.claim_private_media_quarantine_cleanup(integer, uuid),
  public.complete_private_media_quarantine_cleanup(uuid, uuid[]),
  public.claim_private_media_pending_object_cleanup(integer, uuid),
  public.complete_private_media_pending_object_cleanup(uuid, uuid[])
  TO repairprint_submission_service
  GRANTED BY CURRENT_USER;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
DO $$
DECLARE
  expected_oids oid[] := ARRAY[
    to_regprocedure('public.claim_expired_private_media(integer,uuid)')::oid,
    to_regprocedure('public.complete_private_media_cleanup(uuid,uuid[])')::oid,
    to_regprocedure('public.claim_private_media_quarantine_cleanup(integer,uuid)')::oid,
    to_regprocedure('public.complete_private_media_quarantine_cleanup(uuid,uuid[])')::oid,
    to_regprocedure('public.claim_private_media_pending_object_cleanup(integer,uuid)')::oid,
    to_regprocedure('public.complete_private_media_pending_object_cleanup(uuid,uuid[])')::oid
  ];
  expected_hashes text[] := ARRAY[
    'e808d6497297b83a2ef835f53f418cf3ac1c4f77dbbd5b864c27d067f0faad05',
    '4fec04ddc768c40e03477b2c236a90658bc4b37ccbdd244a98d22c6c6ceba053',
    '1ce25e27485ded40bb340216e16f128e73f779a961243a60f2ae826a1ebbeca0',
    'b8bddc9ad048742f5f49de926c8e08d9c14acc25ce7fca3cb0983a72908c2a1b',
    '443b45a000763e985fae74255f858f0808fbd778f30adb1a6b0c5cef5cda021f',
    '541809a72285659cbfc0120364d4e625c2bc701edd93127e56b91cbcc03b1de4'
  ];
  approved_cleanup_oids oid[];
  maintenance_oid oid;
  service_oid oid;
  membership_after text;
  unrelated_routine_fingerprint text;
  table_acl_fingerprint text;
BEGIN
  SELECT oid INTO maintenance_oid
  FROM pg_roles WHERE rolname = 'repairprint_submission_maintenance';
  SELECT oid INTO service_oid
  FROM pg_roles WHERE rolname = 'repairprint_submission_service';

  IF current_setting('repairprint.wp11_submission_temporary_membership', true) = 'true' THEN
    EXECUTE format(
      'REVOKE repairprint_submission_maintenance FROM %I GRANTED BY %I',
      current_user,
      current_user
    );
    PERFORM set_config('repairprint.wp11_submission_temporary_membership', 'false', true);
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_array(
        granted_role.rolname,
        member_role.rolname,
        grantor_role.rolname,
        membership.admin_option,
        membership.inherit_option,
        membership.set_option
      ) ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname
    ),
    '[]'::jsonb
  )::text
  INTO membership_after
  FROM pg_auth_members AS membership
  INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
  LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
  WHERE granted_role.rolname IN (
      'repairprint_submission_service', 'repairprint_submission_maintenance'
    )
    OR member_role.rolname IN (
      'repairprint_submission_service', 'repairprint_submission_maintenance'
    );
  IF membership_after IS DISTINCT FROM current_setting(
    'repairprint.wp11_submission_membership_baseline', true
  ) OR current_setting('repairprint.wp11_submission_temporary_membership', true) <> 'false'
  THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_MEMBERSHIP_CHANGED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    WHERE procedure.oid = ANY(expected_oids)
      AND (
        procedure.proowner <> maintenance_oid
        OR NOT procedure.prosecdef
        OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
        OR encode(sha256(convert_to(pg_get_functiondef(procedure.oid), 'UTF8')), 'hex')
          <> expected_hashes[array_position(expected_oids, procedure.oid)]
        OR (SELECT count(*) FROM aclexplode(procedure.proacl)) <> 2
        OR NOT has_function_privilege(maintenance_oid, procedure.oid, 'EXECUTE')
        OR NOT has_function_privilege(service_oid, procedure.oid, 'EXECUTE')
        OR EXISTS (
          SELECT 1 FROM aclexplode(procedure.proacl) AS acl
          WHERE acl.grantor <> maintenance_oid
            OR acl.grantee NOT IN (maintenance_oid, service_oid)
            OR acl.privilege_type <> 'EXECUTE'
            OR acl.is_grantable
        )
        OR (SELECT count(*) FROM aclexplode(procedure.proacl) AS acl
            WHERE acl.grantee = maintenance_oid) <> 1
        OR (SELECT count(*) FROM aclexplode(procedure.proacl) AS acl
            WHERE acl.grantee = service_oid) <> 1
      )
  ) THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_POSTCONDITION_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
    WHERE procedure.oid = ANY(expected_oids)
      AND acl.grantee NOT IN (maintenance_oid, service_oid)
  ) THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_UNEXPECTED_DIRECT_GRANT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles AS role
    CROSS JOIN pg_proc AS procedure
    WHERE procedure.oid = ANY(expected_oids)
      AND role.rolname IN (
        'anon', 'authenticated', 'service_role',
        'repairprint_source_service', 'repairprint_source_maintenance'
      )
      AND has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_EFFECTIVE_EXECUTE_INVALID';
  END IF;

  approved_cleanup_oids := array_append(
    expected_oids,
    to_regprocedure('public.cleanup_expired_submission_intakes(integer)')::oid
  );
  IF (SELECT count(*)
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
      WHERE namespace.nspname = 'public'
        AND acl.grantee = service_oid) <> 7
    OR EXISTS (
      SELECT 1
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
      WHERE namespace.nspname = 'public'
        AND acl.grantee = service_oid
        AND (
          procedure.oid <> ALL(approved_cleanup_oids)
          OR procedure.proowner <> maintenance_oid
          OR acl.grantor <> maintenance_oid
          OR acl.privilege_type <> 'EXECUTE'
          OR acl.is_grantable
        )
    )
  THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_SERVICE_GRANT_SET_INVALID';
  END IF;

  IF (SELECT count(*) FROM pg_default_acl AS default_acl
      WHERE default_acl.defaclrole = maintenance_oid
        AND default_acl.defaclobjtype = 'f') <> 1
    OR EXISTS (
      SELECT 1
      FROM pg_default_acl AS default_acl
      CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS acl
      WHERE default_acl.defaclrole = maintenance_oid
        AND default_acl.defaclobjtype = 'f'
        AND (
          default_acl.defaclnamespace <> 0
          OR acl.grantor <> maintenance_oid
          OR acl.grantee <> maintenance_oid
          OR acl.privilege_type <> 'EXECUTE'
          OR acl.is_grantable
        )
    )
    OR (SELECT count(*)
        FROM pg_default_acl AS default_acl
        CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS acl
        WHERE default_acl.defaclrole = maintenance_oid
          AND default_acl.defaclobjtype = 'f') <> 1
  THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_DEFAULT_PRIVILEGES_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
    ) AS acl
    WHERE namespace.nspname = 'public'
      AND procedure.prokind IN ('f', 'p')
      AND procedure.prorettype NOT IN (
        'pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype
      )
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS dependency
        INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
        WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass
          AND dependency.objid = procedure.oid
          AND dependency.objsubid = 0
          AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
          AND dependency.refobjsubid = 0
          AND dependency.deptype = 'e'
      )
  ) THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_PUBLIC_APPLICATION_ROUTINE';
  END IF;

  WITH routine_state AS (
    SELECT format(
        '%I.%I(%s)', namespace.nspname, procedure.proname,
        pg_get_function_identity_arguments(procedure.oid)
      ) AS signature,
      jsonb_build_object(
        'owner', owner_role.rolname,
        'kind', procedure.prokind,
        'securityDefiner', procedure.prosecdef,
        'configuration', COALESCE(to_jsonb(procedure.proconfig), '[]'::jsonb),
        'definitionSha256', encode(
          sha256(convert_to(pg_get_functiondef(procedure.oid), 'UTF8')), 'hex'
        ),
        'aclDefaulted', procedure.proacl IS NULL,
        'acl', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'grantor', pg_get_userbyid(acl.grantor),
              'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              'privilege', acl.privilege_type,
              'grantable', acl.is_grantable
            ) ORDER BY
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
          ) FROM aclexplode(procedure.proacl) AS acl
        ), '[]'::jsonb)
      ) AS state
    FROM pg_proc AS procedure
    INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    INNER JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE namespace.nspname = 'public'
      AND procedure.oid <> ALL(expected_oids)
  )
  SELECT encode(sha256(convert_to(COALESCE(
    jsonb_agg(state ORDER BY signature), '[]'::jsonb
  )::text, 'UTF8')), 'hex')
  INTO unrelated_routine_fingerprint
  FROM routine_state;
  IF unrelated_routine_fingerprint IS DISTINCT FROM current_setting(
    'repairprint.wp11_submission_unrelated_routine_fingerprint', true
  ) THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_UNRELATED_ROUTINE_CHANGED';
  END IF;

  WITH relation_state AS (
    SELECT format('%I.%I', namespace.nspname, relation.relname) AS identity,
      jsonb_build_object(
        'kind', relation.relkind,
        'owner', owner_role.rolname,
        'aclDefaulted', relation.relacl IS NULL,
        'acl', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'grantor', pg_get_userbyid(acl.grantor),
              'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              'privilege', acl.privilege_type,
              'grantable', acl.is_grantable
            ) ORDER BY
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
          ) FROM aclexplode(relation.relacl) AS acl
        ), '[]'::jsonb),
        'columnAcl', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'column', attribute.attname,
              'grantor', pg_get_userbyid(acl.grantor),
              'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              'privilege', acl.privilege_type,
              'grantable', acl.is_grantable
            ) ORDER BY attribute.attname,
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END,
              pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
          )
          FROM pg_attribute AS attribute
          CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
          WHERE attribute.attrelid = relation.oid AND NOT attribute.attisdropped
        ), '[]'::jsonb)
      ) AS state
    FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    INNER JOIN pg_roles AS owner_role ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = 'public'
  )
  SELECT encode(sha256(convert_to(COALESCE(
    jsonb_agg(state ORDER BY identity), '[]'::jsonb
  )::text, 'UTF8')), 'hex')
  INTO table_acl_fingerprint
  FROM relation_state;
  IF table_acl_fingerprint IS DISTINCT FROM current_setting(
    'repairprint.wp11_submission_table_acl_fingerprint', true
  ) THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_TABLE_PRIVILEGE_CHANGED';
  END IF;
END
$$;
--> statement-breakpoint
SET LOCAL search_path = "$user", public;
--> statement-breakpoint
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
      (
      jsonb_typeof("private_analytics_daily_aggregates"."dimensions") = 'object'
      AND CASE "private_analytics_daily_aggregates"."event_name"
        WHEN 'search_submitted' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['normalizedCategory', 'queryLength', 'identifierLike']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['normalizedCategory', 'queryLength', 'identifierLike'] = '{}'::jsonb
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'normalizedCategory') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'normalizedCategory' IN ('identifier', 'component', 'mixed', 'other')
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'identifierLike') = 'boolean'
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'queryLength') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'queryLength' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'queryLength')::numeric BETWEEN 2 AND 160
            ELSE false
          END
        WHEN 'search_resolved' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['entityType', 'matchClass', 'rank', 'ambiguityCount']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['entityType', 'matchClass', 'rank', 'ambiguityCount'] = '{}'::jsonb
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'entityType') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'entityType' IN ('model', 'part')
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'matchClass') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'matchClass' IN (
            'strict_identifier', 'loose_identifier', 'model_component', 'text', 'trigram'
          )
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'rank') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'rank' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'rank')::numeric BETWEEN 1 AND 50
            ELSE false
          END
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'ambiguityCount') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'ambiguityCount' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'ambiguityCount')::numeric BETWEEN 0 AND 50
            ELSE false
          END
        WHEN 'variant_disambiguation_shown' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['candidateCount']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['candidateCount'] = '{}'::jsonb
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'candidateCount') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'candidateCount' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'candidateCount')::numeric BETWEEN 2 AND 50
            ELSE false
          END
        WHEN 'variant_selected' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['selectedRank']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['selectedRank'] = '{}'::jsonb
          AND CASE
            WHEN jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'selectedRank') = 'number'
              AND "private_analytics_daily_aggregates"."dimensions"->>'selectedRank' ~ '^[0-9]+$'
            THEN ("private_analytics_daily_aggregates"."dimensions"->>'selectedRank')::numeric BETWEEN 1 AND 50
            ELSE false
          END
        WHEN 'zero_result' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['tokenClass']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['tokenClass', 'brand', 'category'] = '{}'::jsonb
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'tokenClass') = 'string'
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
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'publicId') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'publicId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'publicId') BETWEEN 1 AND 120
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'confidenceTier') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'confidenceTier' IN ('verified_fit', 'community_confirmed', 'creator_listed')
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'safetyClass') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'safetyClass' = 'low'
        WHEN 'original_source_clicked' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['publicId', 'sourcePlatform', 'confidenceTier']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['publicId', 'sourcePlatform', 'confidenceTier'] = '{}'::jsonb
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'publicId') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'publicId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'publicId') BETWEEN 1 AND 120
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'sourcePlatform') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'sourcePlatform' ~ '^[a-z0-9][a-z0-9._-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'sourcePlatform') BETWEEN 1 AND 80
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'confidenceTier') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'confidenceTier' IN ('verified_fit', 'community_confirmed', 'creator_listed')
        WHEN 'fit_report_started' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['publicId']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['publicId'] = '{}'::jsonb
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'publicId') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'publicId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'publicId') BETWEEN 1 AND 120
        WHEN 'fit_report_submitted' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['publicId', 'outcome']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['publicId', 'outcome'] = '{}'::jsonb
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'publicId') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'publicId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          AND char_length("private_analytics_daily_aggregates"."dimensions"->>'publicId') BETWEEN 1 AND 120
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'outcome') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'outcome' IN (
            'fits_without_modification', 'fits_after_modification', 'does_not_fit', 'print_failed', 'unsure'
          )
        WHEN 'missing_part_submitted' THEN
          "private_analytics_daily_aggregates"."dimensions" ?& ARRAY['categoryMatch']
          AND "private_analytics_daily_aggregates"."dimensions" - ARRAY['categoryMatch', 'category'] = '{}'::jsonb
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'categoryMatch') = 'string'
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
          AND jsonb_typeof("private_analytics_daily_aggregates"."dimensions"->'sourcePlatform') = 'string'
          AND "private_analytics_daily_aggregates"."dimensions"->>'sourcePlatform' IN ('thingiverse', 'printables', 'makerworld', 'other')
        ELSE false
      END
      ) IS TRUE
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
    OR pg_catalog.jsonb_typeof(p_dimensions) IS DISTINCT FROM 'object'
    OR (
      p_event_name IN (
        'part_viewed',
        'original_source_clicked',
        'fit_report_started',
        'fit_report_submitted'
      )
      AND pg_catalog.jsonb_typeof(p_dimensions->'publicId') IS DISTINCT FROM 'string'
    )
    OR (
      p_event_name = 'original_source_clicked'
      AND pg_catalog.jsonb_typeof(p_dimensions->'sourcePlatform') IS DISTINCT FROM 'string'
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_EVENT_INVALID' USING ERRCODE = '22023';
  END IF;

  BEGIN
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
  EXCEPTION
    WHEN check_violation THEN
      RAISE EXCEPTION 'ANALYTICS_EVENT_INVALID' USING ERRCODE = '22023';
  END;

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

END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  service_preexisting boolean;
  maintenance_preexisting boolean;
  service_oid oid;
  maintenance_oid oid;
  membership_count integer;
  provider_membership_count integer;
  automatic_membership_count integer;
  membership_baseline text;
BEGIN
  PERFORM set_config('createrole_self_grant', '', true);

  SELECT
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_analytics_service'),
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_analytics_maintenance')
  INTO service_preexisting, maintenance_preexisting;

  IF service_preexisting <> maintenance_preexisting THEN
    RAISE EXCEPTION 'ANALYTICS_ROLE_PAIR_PARTIAL';
  END IF;

  IF NOT service_preexisting THEN
    CREATE ROLE repairprint_analytics_service
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT maintenance_preexisting THEN
    CREATE ROLE repairprint_analytics_maintenance
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  SELECT oid INTO service_oid FROM pg_roles WHERE rolname = 'repairprint_analytics_service';
  SELECT oid INTO maintenance_oid FROM pg_roles WHERE rolname = 'repairprint_analytics_maintenance';
  IF service_oid IS NULL OR maintenance_oid IS NULL THEN
    RAISE EXCEPTION 'ANALYTICS_ROLES_MISSING';
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
    RAISE EXCEPTION 'ANALYTICS_ROLE_ATTRIBUTES_UNSAFE';
  END IF;

  IF service_preexisting AND EXISTS (
    SELECT 1
    FROM pg_shdepend AS dependency
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
      AND dependency.refobjid IN (service_oid, maintenance_oid)
      AND dependency.deptype IN ('o', 'a', 'i', 'r')
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PREEXISTING_ROLE_DEPENDENCY';
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
    ) AND (
      granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
      AND (
        (
          member_role.rolname = 'postgres'
          AND grantor_role.rolname = 'supabase_admin'
        )
        OR (
          member_role.rolname = current_user
          AND membership.grantor = 10
          AND grantor_role.rolsuper
        )
      )
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_ROLE_MEMBERSHIP_UNSAFE';
  END IF;

  SELECT count(*)::integer
  INTO membership_count
  FROM pg_auth_members AS membership
  INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
  WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
     OR member_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance');

  SELECT count(*)::integer
  INTO provider_membership_count
  FROM pg_auth_members AS membership
  INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
  INNER JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
  WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
    AND member_role.rolname = 'postgres'
    AND grantor_role.rolname = 'supabase_admin'
    AND membership.admin_option
    AND NOT membership.inherit_option
    AND NOT membership.set_option;

  SELECT count(*)::integer
  INTO automatic_membership_count
  FROM pg_auth_members AS membership
  INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
  INNER JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
  WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
    AND member_role.rolname = current_user
    AND membership.grantor = 10
    AND grantor_role.rolsuper
    AND membership.admin_option
    AND NOT membership.inherit_option
    AND NOT membership.set_option;

  IF provider_membership_count NOT IN (0, 2) OR (
    provider_membership_count = 2 AND (
      SELECT count(DISTINCT granted_role.rolname)
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      INNER JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
        AND member_role.rolname = 'postgres'
        AND grantor_role.rolname = 'supabase_admin'
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND NOT membership.set_option
    ) <> 2
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PROVIDER_MEMBERSHIP_PAIR_INCOMPLETE';
  END IF;

  IF automatic_membership_count NOT IN (0, 2) OR (
    automatic_membership_count = 2 AND (
      SELECT count(DISTINCT granted_role.rolname)
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      INNER JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
        AND member_role.rolname = current_user
        AND membership.grantor = 10
        AND grantor_role.rolsuper
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND NOT membership.set_option
    ) <> 2
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_AUTOMATIC_MEMBERSHIP_PAIR_INCOMPLETE';
  END IF;

  IF membership_count NOT IN (0, 2, 4) THEN
    RAISE EXCEPTION 'ANALYTICS_ROLE_MEMBERSHIP_UNCLASSIFIED';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_array(
        granted_role.rolname,
        member_role.rolname,
        grantor_role.rolname,
        membership.admin_option,
        membership.inherit_option,
        membership.set_option
      ) ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname
    ),
    '[]'::jsonb
  )::text
  INTO membership_baseline
  FROM pg_auth_members AS membership
  INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
  LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
  WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
     OR member_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance');

  PERFORM set_config('repairprint.wp11_analytics_membership_baseline', membership_baseline, true);
  PERFORM set_config('repairprint.wp11_analytics_temporary_membership', 'false', true);
END
$$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.private_analytics_daily_aggregates
  FROM PUBLIC, repairprint_analytics_service, repairprint_analytics_maintenance;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb)
  FROM PUBLIC, repairprint_analytics_service, repairprint_analytics_maintenance;
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
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public
  TO repairprint_analytics_service, repairprint_analytics_maintenance
  GRANTED BY CURRENT_USER;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.private_analytics_daily_aggregates
  TO repairprint_analytics_maintenance
  GRANTED BY CURRENT_USER;
--> statement-breakpoint
GRANT SELECT ON TABLE public.public_catalogue_fitments
  TO repairprint_analytics_maintenance
  GRANTED BY CURRENT_USER;
--> statement-breakpoint
DO $$
BEGIN
  IF has_schema_privilege('repairprint_analytics_maintenance', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'ANALYTICS_MAINTENANCE_PREEXISTING_SCHEMA_CREATE';
  END IF;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO repairprint_analytics_maintenance GRANTED BY CURRENT_USER;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'repairprint_analytics_maintenance', 'SET') THEN
    EXECUTE format(
      'GRANT repairprint_analytics_maintenance TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY %I',
      current_user,
      current_user
    );
    PERFORM set_config('repairprint.wp11_analytics_temporary_membership', 'true', true);

    IF NOT EXISTS (
      SELECT 1
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      INNER JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      WHERE granted_role.rolname = 'repairprint_analytics_maintenance'
        AND member_role.rolname = current_user
        AND grantor_role.rolname = current_user
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option
    ) THEN
      RAISE EXCEPTION 'ANALYTICS_TEMPORARY_MEMBERSHIP_NOT_ESTABLISHED';
    END IF;
  END IF;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.record_private_analytics_event(text, jsonb)
  OWNER TO repairprint_analytics_maintenance;
--> statement-breakpoint
SET ROLE repairprint_analytics_maintenance;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb)
  FROM PUBLIC, repairprint_analytics_service
  GRANTED BY CURRENT_USER;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb) FROM anon GRANTED BY CURRENT_USER;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.record_private_analytics_event(text, jsonb) FROM authenticated GRANTED BY CURRENT_USER;
  END IF;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_private_analytics_event(text, jsonb)
  TO repairprint_analytics_service
  GRANTED BY CURRENT_USER;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
DO $$
DECLARE
  membership_after text;
BEGIN
  IF current_setting('repairprint.wp11_analytics_temporary_membership', true) = 'true' THEN
    EXECUTE format(
      'REVOKE repairprint_analytics_maintenance FROM %I GRANTED BY %I',
      current_user,
      current_user
    );
    PERFORM set_config('repairprint.wp11_analytics_temporary_membership', 'false', true);
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_array(
        granted_role.rolname,
        member_role.rolname,
        grantor_role.rolname,
        membership.admin_option,
        membership.inherit_option,
        membership.set_option
      ) ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname
    ),
    '[]'::jsonb
  )::text
  INTO membership_after
  FROM pg_auth_members AS membership
  INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
  LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
  WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
     OR member_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance');

  IF membership_after IS DISTINCT FROM current_setting('repairprint.wp11_analytics_membership_baseline', true) THEN
    RAISE EXCEPTION 'ANALYTICS_PROVIDER_MEMBERSHIP_CHANGED';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public
  FROM repairprint_analytics_maintenance
  GRANTED BY CURRENT_USER;
--> statement-breakpoint
SET LOCAL search_path = pg_catalog;
--> statement-breakpoint
DO $$
DECLARE
  extension_count integer;
  extension_owner text;
  routine_count integer;
  manifest_fingerprint text;
BEGIN
  SELECT count(*)::integer
  INTO extension_count
  FROM pg_extension AS extension
  WHERE extension.extname = 'pg_trgm';

  SELECT owner_role.rolname
  INTO extension_owner
  FROM pg_extension AS extension
  INNER JOIN pg_roles AS owner_role ON owner_role.oid = extension.extowner
  WHERE extension.extname = 'pg_trgm';

  IF extension_count <> 1 OR EXISTS (
    SELECT 1
    FROM pg_extension AS extension
    INNER JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    INNER JOIN pg_roles AS owner_role ON owner_role.oid = extension.extowner
    WHERE extension.extname = 'pg_trgm'
      AND (
        extension.extversion <> '1.6'
        OR namespace.nspname <> 'public'
        OR NOT extension.extrelocatable
        OR extension.extconfig IS NOT NULL
        OR extension.extcondition IS NOT NULL
        OR owner_role.rolname NOT IN ('repairprint', 'supabase_admin')
      )
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_EXTENSION_POSTCONDITION_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_depend AS dependency
    INNER JOIN pg_proc AS procedure
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = procedure.oid
    INNER JOIN pg_extension AS extension
      ON dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      AND dependency.refobjid = extension.oid
    WHERE extension.extname = 'pg_trgm'
      AND (
        dependency.objsubid <> 0
        OR dependency.refobjsubid <> 0
        OR dependency.deptype <> 'e'
      )
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_DEPENDENCY_POSTCONDITION_INVALID';
  END IF;

  WITH extension_state AS (
    SELECT extension.oid,
      extension.extowner,
      extension.extname,
      extension.extversion,
      namespace.nspname AS schema_name,
      owner_role.rolname AS owner_name,
      extension.extrelocatable,
      extension.extconfig,
      extension.extcondition
    FROM pg_extension AS extension
    INNER JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    INNER JOIN pg_roles AS owner_role ON owner_role.oid = extension.extowner
    WHERE extension.extname = 'pg_trgm'
  ), routine_manifest AS (
    SELECT format(
        '%I.%I(%s)',
        namespace.nspname,
        procedure.proname,
        pg_get_function_identity_arguments(procedure.oid)
      ) AS signature,
      jsonb_build_object(
        'schema', namespace.nspname,
        'signature', format(
          '%I.%I(%s)',
          namespace.nspname,
          procedure.proname,
          pg_get_function_identity_arguments(procedure.oid)
        ),
        'result', pg_get_function_result(procedure.oid),
        'owner', CASE
          WHEN procedure_owner.rolname = extension_state.owner_name THEN '<extension_owner>'
          ELSE procedure_owner.rolname
        END,
        'language', language.lanname,
        'kind', CASE procedure.prokind
          WHEN 'f' THEN 'function'
          WHEN 'p' THEN 'procedure'
          WHEN 'a' THEN 'aggregate'
          WHEN 'w' THEN 'window'
          ELSE procedure.prokind::text
        END,
        'securityDefiner', procedure.prosecdef,
        'volatility', CASE procedure.provolatile
          WHEN 'i' THEN 'immutable'
          WHEN 's' THEN 'stable'
          WHEN 'v' THEN 'volatile'
          ELSE procedure.provolatile::text
        END,
        'parallel', CASE procedure.proparallel
          WHEN 's' THEN 'safe'
          WHEN 'r' THEN 'restricted'
          WHEN 'u' THEN 'unsafe'
          ELSE procedure.proparallel::text
        END,
        'leakproof', procedure.proleakproof,
        'strict', procedure.proisstrict,
        'returnsSet', procedure.proretset,
        'configuration', COALESCE((
          SELECT jsonb_agg(setting ORDER BY setting COLLATE "C")
          FROM unnest(procedure.proconfig) AS setting
        ), '[]'::jsonb),
        'definitionSha256', encode(
          sha256(convert_to(pg_get_functiondef(procedure.oid), 'UTF8')),
          'hex'
        ),
        'aclDefaulted', procedure.proacl IS NULL,
        'acl', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'grantor', CASE
                WHEN acl.grantor = extension_state.extowner THEN '<extension_owner>'
                ELSE pg_get_userbyid(acl.grantor)
              END,
              'grantee', CASE
                WHEN acl.grantee = 0 THEN 'PUBLIC'
                WHEN acl.grantee = extension_state.extowner THEN '<extension_owner>'
                ELSE pg_get_userbyid(acl.grantee)
              END,
              'privilege', acl.privilege_type,
              'grantable', acl.is_grantable
            ) ORDER BY
              CASE
                WHEN acl.grantee = 0 THEN 'PUBLIC'
                WHEN acl.grantee = extension_state.extowner THEN '<extension_owner>'
                ELSE pg_get_userbyid(acl.grantee)
              END COLLATE "C",
              CASE
                WHEN acl.grantor = extension_state.extowner THEN '<extension_owner>'
                ELSE pg_get_userbyid(acl.grantor)
              END COLLATE "C",
              acl.privilege_type COLLATE "C",
              acl.is_grantable
          )
          FROM aclexplode(
            COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
          ) AS acl
        ), '[]'::jsonb)
      ) AS manifest_entry
    FROM pg_proc AS procedure
    INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    INNER JOIN pg_roles AS procedure_owner ON procedure_owner.oid = procedure.proowner
    INNER JOIN pg_language AS language ON language.oid = procedure.prolang
    INNER JOIN pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = procedure.oid
      AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      AND dependency.refobjsubid = 0
      AND dependency.deptype = 'e'
    INNER JOIN extension_state ON extension_state.oid = dependency.refobjid
  )
  SELECT count(*)::integer,
    encode(sha256(convert_to(jsonb_build_object(
      'extension', (
        SELECT jsonb_build_object(
          'name', extension_state.extname,
          'version', extension_state.extversion,
          'schema', extension_state.schema_name,
          'owner', '<extension_owner>',
          'relocatable', extension_state.extrelocatable,
          'configuration', COALESCE(to_jsonb(extension_state.extconfig::text[]), '[]'::jsonb),
          'conditions', COALESCE(to_jsonb(extension_state.extcondition), '[]'::jsonb)
        )
        FROM extension_state
      ),
      'routines', COALESCE(
        jsonb_agg(
          routine_manifest.manifest_entry ORDER BY routine_manifest.signature COLLATE "C"
        ),
        '[]'::jsonb
      )
    )::text, 'UTF8')), 'hex')
  INTO routine_count, manifest_fingerprint
  FROM routine_manifest;

  IF routine_count <> 31
    OR NOT (
      (
        extension_owner = 'repairprint'
        AND manifest_fingerprint = 'c0275d3247965414d0ab1902027ee33214f8f11fcd4def7cea0df155fd94efbf'
      ) OR (
        extension_owner = 'supabase_admin'
        AND manifest_fingerprint = 'f40dba0bec070313337e408557cc44ad59f4bafedc94121327bba8a6dc000164'
      )
    )
    OR manifest_fingerprint IS DISTINCT FROM current_setting(
      'repairprint.wp11_pg_trgm_manifest_fingerprint',
      true
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_MANIFEST_CHANGED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    INNER JOIN pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = procedure.oid
      AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      AND dependency.refobjsubid = 0
      AND dependency.deptype = 'e'
    INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
    WHERE extension.extname = 'pg_trgm'
      AND (procedure.prosecdef OR procedure.proconfig IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_ROUTINE_SECURITY_POSTCONDITION_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    INNER JOIN pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = procedure.oid
      AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      AND dependency.refobjsubid = 0
      AND dependency.deptype = 'e'
    INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
    INNER JOIN pg_roles AS grantee_role ON grantee_role.oid = acl.grantee
    WHERE extension.extname = 'pg_trgm'
      AND grantee_role.rolname IN (
        'repairprint_analytics_service',
        'repairprint_analytics_maintenance'
      )
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PG_TRGM_DIRECT_ANALYTICS_GRANT_POSTCONDITION';
  END IF;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  service_oid oid;
  maintenance_oid oid;
  recorder_oid oid;
  non_callable_baseline_oid oid;
  unexpected_identity text;
BEGIN
  SELECT oid INTO service_oid FROM pg_roles WHERE rolname = 'repairprint_analytics_service';
  SELECT oid INTO maintenance_oid FROM pg_roles WHERE rolname = 'repairprint_analytics_maintenance';
  recorder_oid := to_regprocedure('public.record_private_analytics_event(text,jsonb)')::oid;
  non_callable_baseline_oid := to_regprocedure('public.reject_audit_log_mutation()')::oid;

  IF service_oid IS NULL OR maintenance_oid IS NULL OR recorder_oid IS NULL
    OR non_callable_baseline_oid IS NULL
  THEN
    RAISE EXCEPTION 'ANALYTICS_POSTCONDITION_OBJECT_MISSING';
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
    RAISE EXCEPTION 'ANALYTICS_POSTCONDITION_ROLE_ATTRIBUTES';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_auth_members AS membership
    INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
    LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
    WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
       OR member_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
  ) NOT IN (0, 2, 4)
    OR current_setting('repairprint.wp11_analytics_temporary_membership', true) <> 'false'
  THEN
    RAISE EXCEPTION 'ANALYTICS_POSTCONDITION_MEMBERSHIP';
  END IF;

  IF (SELECT count(*) FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public' AND procedure.proname = 'record_private_analytics_event') <> 1
    OR EXISTS (
      SELECT 1 FROM pg_proc AS procedure
      WHERE procedure.oid = recorder_oid
        AND (procedure.proowner <> maintenance_oid OR NOT procedure.prosecdef
          OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[])
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_RECORDER_DEFINITION_INVALID';
  END IF;

  IF NOT has_function_privilege(service_oid, recorder_oid, 'EXECUTE')
    OR (SELECT count(*)
        FROM pg_proc AS procedure
        CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
        WHERE procedure.oid = recorder_oid AND acl.grantee = service_oid) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
      WHERE procedure.oid = recorder_oid
        AND acl.grantee = service_oid
        AND acl.grantor = maintenance_oid
        AND acl.privilege_type = 'EXECUTE'
        AND NOT acl.is_grantable
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_RECORDER_SERVICE_GRANT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
    WHERE namespace.nspname = 'public'
      AND acl.grantee = service_oid
      AND procedure.oid <> recorder_oid
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_UNEXPECTED_DIRECT_SERVICE_ROUTINE_GRANT';
  END IF;

  SELECT format(
    '%I.%I(%s)',
    namespace.nspname,
    procedure.proname,
    pg_get_function_identity_arguments(procedure.oid)
  )
  INTO unexpected_identity
  FROM pg_proc AS procedure
  INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.oid <> recorder_oid
    AND procedure.prokind IN ('f', 'p', 'a', 'w')
    AND procedure.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend AS dependency
      INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
      WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass
        AND dependency.objid = procedure.oid
        AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
        AND dependency.refobjsubid = 0
        AND dependency.deptype = 'e'
        AND extension.extname = 'pg_trgm'
    )
    AND has_function_privilege(service_oid, procedure.oid, 'EXECUTE')
  ORDER BY namespace.nspname, procedure.proname, pg_get_function_identity_arguments(procedure.oid)
  LIMIT 1;
  IF unexpected_identity IS NOT NULL THEN
    RAISE EXCEPTION 'ANALYTICS_UNEXPECTED_SERVICE_ROUTINE_EXECUTE: %', unexpected_identity;
  END IF;

  IF NOT has_function_privilege(service_oid, non_callable_baseline_oid, 'EXECUTE')
    OR NOT has_function_privilege(maintenance_oid, non_callable_baseline_oid, 'EXECUTE')
    OR EXISTS (
      SELECT 1
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.prorettype IN (
          'pg_catalog.trigger'::regtype,
          'pg_catalog.event_trigger'::regtype
        )
        AND procedure.oid <> non_callable_baseline_oid
        AND (
          has_function_privilege(service_oid, procedure.oid, 'EXECUTE')
          OR has_function_privilege(maintenance_oid, procedure.oid, 'EXECUTE')
        )
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_NON_CALLABLE_ROUTINE_BASELINE_INVALID';
  END IF;

  unexpected_identity := NULL;
  SELECT format('%I.%I', namespace.nspname, relation.relname)
  INTO unexpected_identity
  FROM pg_class AS relation
  INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      EXISTS (
        SELECT 1
        FROM (VALUES
          ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text), ('DELETE'::text),
          ('TRUNCATE'::text), ('REFERENCES'::text), ('TRIGGER'::text), ('MAINTAIN'::text)
        ) AS privilege(privilege_type)
        WHERE has_table_privilege(service_oid, relation.oid, privilege.privilege_type)
      )
      OR has_any_column_privilege(service_oid, relation.oid, 'SELECT')
      OR has_any_column_privilege(service_oid, relation.oid, 'INSERT')
      OR has_any_column_privilege(service_oid, relation.oid, 'UPDATE')
      OR has_any_column_privilege(service_oid, relation.oid, 'REFERENCES')
    )
  ORDER BY namespace.nspname, relation.relname
  LIMIT 1;
  IF unexpected_identity IS NOT NULL THEN
    RAISE EXCEPTION 'ANALYTICS_UNEXPECTED_SERVICE_RELATION_PRIVILEGE: %', unexpected_identity;
  END IF;

  unexpected_identity := NULL;
  SELECT format('%I.%I', namespace.nspname, sequence.relname)
  INTO unexpected_identity
  FROM pg_class AS sequence
  INNER JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
  WHERE namespace.nspname = 'public'
    AND sequence.relkind = 'S'
    AND EXISTS (
      SELECT 1
      FROM (VALUES ('USAGE'::text), ('SELECT'::text), ('UPDATE'::text)) AS privilege(privilege_type)
      WHERE has_sequence_privilege(service_oid, sequence.oid, privilege.privilege_type)
    )
  ORDER BY namespace.nspname, sequence.relname
  LIMIT 1;
  IF unexpected_identity IS NOT NULL THEN
    RAISE EXCEPTION 'ANALYTICS_UNEXPECTED_SERVICE_SEQUENCE_PRIVILEGE: %', unexpected_identity;
  END IF;

  IF NOT has_schema_privilege(service_oid, 'public', 'USAGE')
    OR has_schema_privilege(service_oid, 'public', 'CREATE')
    OR NOT has_schema_privilege(maintenance_oid, 'public', 'USAGE')
    OR has_schema_privilege(maintenance_oid, 'public', 'CREATE')
    OR EXISTS (
      SELECT 1
      FROM pg_namespace AS namespace
      WHERE namespace.nspname !~ '^pg_temp_[0-9]+$'
        AND namespace.nspname !~ '^pg_toast_temp_[0-9]+$'
        AND (
          has_schema_privilege(service_oid, namespace.oid, 'CREATE')
          OR has_schema_privilege(maintenance_oid, namespace.oid, 'CREATE')
        )
    )
    OR (SELECT count(*)
        FROM pg_namespace AS namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
        WHERE namespace.nspname = 'public'
          AND acl.grantee IN (service_oid, maintenance_oid)) <> 2
    OR EXISTS (
      SELECT 1
      FROM pg_namespace AS namespace
      CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
      WHERE namespace.nspname = 'public'
        AND acl.grantee IN (service_oid, maintenance_oid)
        AND (acl.privilege_type <> 'USAGE' OR acl.is_grantable)
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_SCHEMA_PRIVILEGE_BOUNDARY_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_shdepend AS dependency
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
      AND dependency.refobjid = service_oid
      AND dependency.deptype = 'o'
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_SERVICE_OWNS_OBJECT';
  END IF;

  IF (SELECT count(*)
      FROM pg_shdepend AS dependency
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
        AND dependency.refobjid = maintenance_oid
        AND dependency.deptype = 'o') <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM pg_shdepend AS dependency
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
        AND dependency.refobjid = maintenance_oid
        AND dependency.deptype = 'o'
        AND dependency.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND dependency.classid = 'pg_catalog.pg_proc'::regclass
        AND dependency.objid = recorder_oid
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_MAINTENANCE_OWNERSHIP_INVALID';
  END IF;

  IF EXISTS (
    WITH expected(relation_oid, privilege_type) AS (
      VALUES
        ('public.private_analytics_daily_aggregates'::regclass::oid, 'SELECT'::text),
        ('public.private_analytics_daily_aggregates'::regclass::oid, 'INSERT'::text),
        ('public.private_analytics_daily_aggregates'::regclass::oid, 'UPDATE'::text),
        ('public.public_catalogue_fitments'::regclass::oid, 'SELECT'::text)
    ), actual AS (
      SELECT relation.oid AS relation_oid, acl.privilege_type
      FROM pg_class AS relation
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
      WHERE namespace.nspname = 'public' AND acl.grantee = maintenance_oid
    )
    SELECT 1 FROM (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) AS difference
  ) OR (SELECT count(*)
        FROM pg_class AS relation
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
        WHERE namespace.nspname = 'public' AND acl.grantee = maintenance_oid) <> 4
    OR EXISTS (
      SELECT 1
      FROM pg_class AS relation
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
      WHERE namespace.nspname = 'public' AND acl.grantee = maintenance_oid AND acl.is_grantable
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_MAINTENANCE_DIRECT_RELATION_ACL_INVALID';
  END IF;

  IF EXISTS (
    WITH privilege_names(privilege_type) AS (
      VALUES
        ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text), ('DELETE'::text),
        ('TRUNCATE'::text), ('REFERENCES'::text), ('TRIGGER'::text), ('MAINTAIN'::text)
    ), expected(relation_oid, privilege_type) AS (
      VALUES
        ('public.private_analytics_daily_aggregates'::regclass::oid, 'SELECT'::text),
        ('public.private_analytics_daily_aggregates'::regclass::oid, 'INSERT'::text),
        ('public.private_analytics_daily_aggregates'::regclass::oid, 'UPDATE'::text),
        ('public.public_catalogue_fitments'::regclass::oid, 'SELECT'::text)
    ), actual AS (
      SELECT relation.oid AS relation_oid, privilege.privilege_type
      FROM pg_class AS relation
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN privilege_names AS privilege
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          has_table_privilege(maintenance_oid, relation.oid, privilege.privilege_type)
          OR (
            privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
            AND has_any_column_privilege(maintenance_oid, relation.oid, privilege.privilege_type)
          )
        )
    )
    SELECT 1 FROM (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) AS difference
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_MAINTENANCE_EFFECTIVE_RELATION_PRIVILEGE_INVALID';
  END IF;

  unexpected_identity := NULL;
  SELECT format('%I.%I', namespace.nspname, sequence.relname)
  INTO unexpected_identity
  FROM pg_class AS sequence
  INNER JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
  WHERE namespace.nspname = 'public'
    AND sequence.relkind = 'S'
    AND EXISTS (
      SELECT 1
      FROM (VALUES ('USAGE'::text), ('SELECT'::text), ('UPDATE'::text)) AS privilege(privilege_type)
      WHERE has_sequence_privilege(maintenance_oid, sequence.oid, privilege.privilege_type)
    )
  ORDER BY namespace.nspname, sequence.relname
  LIMIT 1;
  IF unexpected_identity IS NOT NULL THEN
    RAISE EXCEPTION 'ANALYTICS_UNEXPECTED_MAINTENANCE_SEQUENCE_PRIVILEGE: %', unexpected_identity;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
    WHERE namespace.nspname = 'public'
      AND acl.grantee = maintenance_oid
      AND procedure.oid <> recorder_oid
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_UNEXPECTED_DIRECT_MAINTENANCE_ROUTINE_GRANT';
  END IF;

  unexpected_identity := NULL;
  SELECT format(
    '%I.%I(%s)',
    namespace.nspname,
    procedure.proname,
    pg_get_function_identity_arguments(procedure.oid)
  )
  INTO unexpected_identity
  FROM pg_proc AS procedure
  INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.oid <> recorder_oid
    AND procedure.prokind IN ('f', 'p', 'a', 'w')
    AND procedure.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend AS dependency
      INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
      WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass
        AND dependency.objid = procedure.oid
        AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
        AND dependency.refobjsubid = 0
        AND dependency.deptype = 'e'
        AND extension.extname = 'pg_trgm'
    )
    AND has_function_privilege(maintenance_oid, procedure.oid, 'EXECUTE')
  ORDER BY namespace.nspname, procedure.proname, pg_get_function_identity_arguments(procedure.oid)
  LIMIT 1;
  IF unexpected_identity IS NOT NULL THEN
    RAISE EXCEPTION 'ANALYTICS_UNEXPECTED_MAINTENANCE_ROUTINE_EXECUTE: %', unexpected_identity;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) AS acl
    WHERE procedure.oid = recorder_oid AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PUBLIC_RECORDER_EXECUTE';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
      AND has_function_privilege('anon', recorder_oid, 'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
      AND has_function_privilege('authenticated', recorder_oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'ANALYTICS_ANONYMOUS_RECORDER_EXECUTE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) AS acl
    WHERE relation.oid = 'public.private_analytics_daily_aggregates'::regclass
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'ANALYTICS_PUBLIC_AGGREGATE_ACCESS';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND (
      has_table_privilege('anon', 'public.private_analytics_daily_aggregates',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR has_any_column_privilege('anon', 'public.private_analytics_daily_aggregates',
        'SELECT,INSERT,UPDATE,REFERENCES')
    ) OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AND (
      has_table_privilege('authenticated', 'public.private_analytics_daily_aggregates',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR has_any_column_privilege('authenticated', 'public.private_analytics_daily_aggregates',
        'SELECT,INSERT,UPDATE,REFERENCES')
    )
  THEN
    RAISE EXCEPTION 'ANALYTICS_ANONYMOUS_AGGREGATE_ACCESS';
  END IF;

  IF EXISTS (SELECT 1 FROM public.private_analytics_daily_aggregates) THEN
    RAISE EXCEPTION 'ANALYTICS_AGGREGATE_NOT_EMPTY';
  END IF;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  cleanup_oids oid[] := ARRAY[
    to_regprocedure('public.claim_expired_private_media(integer,uuid)')::oid,
    to_regprocedure('public.complete_private_media_cleanup(uuid,uuid[])')::oid,
    to_regprocedure('public.claim_private_media_quarantine_cleanup(integer,uuid)')::oid,
    to_regprocedure('public.complete_private_media_quarantine_cleanup(uuid,uuid[])')::oid,
    to_regprocedure('public.claim_private_media_pending_object_cleanup(integer,uuid)')::oid,
    to_regprocedure('public.complete_private_media_pending_object_cleanup(uuid,uuid[])')::oid
  ];
  maintenance_oid oid;
  service_oid oid;
BEGIN
  SELECT oid INTO maintenance_oid
  FROM pg_roles WHERE rolname = 'repairprint_submission_maintenance';
  SELECT oid INTO service_oid
  FROM pg_roles WHERE rolname = 'repairprint_submission_service';

  IF maintenance_oid IS NULL OR service_oid IS NULL
    OR array_position(cleanup_oids, NULL) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_proc AS procedure
      WHERE procedure.oid = ANY(cleanup_oids)
        AND (
          procedure.proowner <> maintenance_oid
          OR NOT procedure.prosecdef
          OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
          OR (SELECT count(*) FROM aclexplode(procedure.proacl)) <> 2
          OR EXISTS (
            SELECT 1 FROM aclexplode(procedure.proacl) AS acl
            WHERE acl.grantor <> maintenance_oid
              OR acl.grantee NOT IN (maintenance_oid, service_oid)
              OR acl.privilege_type <> 'EXECUTE'
              OR acl.is_grantable
          )
        )
    )
  THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_FINAL_DEFINITION_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles AS role
    CROSS JOIN pg_proc AS procedure
    WHERE procedure.oid = ANY(cleanup_oids)
      AND role.rolname IN (
        'anon', 'authenticated', 'service_role',
        'repairprint_source_service', 'repairprint_source_maintenance',
        'repairprint_analytics_service', 'repairprint_analytics_maintenance'
      )
      AND has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    WHERE procedure.oid = ANY(cleanup_oids)
      AND (
        NOT has_function_privilege(maintenance_oid, procedure.oid, 'EXECUTE')
        OR NOT has_function_privilege(service_oid, procedure.oid, 'EXECUTE')
      )
  )
  THEN
    RAISE EXCEPTION 'SUBMISSION_CLEANUP_ACL_FINAL_EXECUTION_INVALID';
  END IF;
END
$$;
