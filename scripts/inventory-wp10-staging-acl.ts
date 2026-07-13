import postgres from "postgres";

const functionNames = [
  "upsert_private_source_candidate",
  "transition_source_candidate_version",
  "claim_source_link_check_jobs",
  "complete_source_link_check",
] as const;

const expectedSignatures = [
  "public.upsert_private_source_candidate(text,text,public.source_candidate_origin,text,jsonb,text,uuid,timestamp with time zone,uuid,text,text,text,text)",
  "public.transition_source_candidate_version(uuid,public.source_ingestion_stage,public.source_ingestion_stage,uuid,text,text)",
  "public.claim_source_link_check_jobs(text,integer,integer)",
  "public.complete_source_link_check(uuid,uuid,uuid,integer,text,text,integer,text,integer,timestamp with time zone,text,text)",
] as const;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the WP-10 staging ACL inventory.");
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });

  try {
    const report = await sql.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION READ ONLY");
      const [readOnly] = await transaction<{ readOnly: string }[]>`SHOW transaction_read_only`;
      const functions = await transaction<{
        authenticatedExecute: boolean;
        identityArguments: string;
        oid: number;
        owner: string;
        proacl: string[] | null;
        securityDefiner: boolean;
        serviceExecute: boolean;
        signature: string;
        searchPath: string[] | null;
        anonExecute: boolean;
      }[]>`
        SELECT procedure.oid::int AS oid, procedure.oid::regprocedure::text AS signature,
          pg_get_function_identity_arguments(procedure.oid) AS "identityArguments",
          owner.rolname AS owner, procedure.prosecdef AS "securityDefiner",
          procedure.proconfig AS "searchPath", procedure.proacl::text[] AS proacl,
          has_function_privilege('repairprint_source_service', procedure.oid, 'EXECUTE') AS "serviceExecute",
          has_function_privilege('anon', procedure.oid, 'EXECUTE') AS "anonExecute",
          has_function_privilege('authenticated', procedure.oid, 'EXECUTE') AS "authenticatedExecute"
        FROM pg_proc AS procedure
        INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        INNER JOIN pg_roles AS owner ON owner.oid = procedure.proowner
        WHERE namespace.nspname = 'public' AND procedure.proname = ANY(${functionNames as unknown as string[]})
        ORDER BY procedure.proname, pg_get_function_identity_arguments(procedure.oid)
      `;
      const rawAclEntries = await transaction<{
        functionOid: number;
        signature: string;
        grantor: string;
        grantee: string;
        privilege: string;
        grantable: boolean;
      }[]>`
        SELECT procedure.oid::int AS "functionOid", procedure.oid::regprocedure::text AS signature,
          grantor.rolname AS grantor, CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
          acl.privilege_type AS privilege, acl.is_grantable AS grantable
        FROM pg_proc AS procedure
        INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
        INNER JOIN pg_roles AS grantor ON grantor.oid = acl.grantor
        LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
        WHERE namespace.nspname = 'public' AND procedure.proname = ANY(${functionNames as unknown as string[]})
        ORDER BY procedure.oid::regprocedure::text, grantee, grantor.rolname
      `;
      const effectiveAclEntries = await transaction<{
        functionOid: number;
        signature: string;
        grantor: string;
        grantee: string;
        privilege: string;
        grantable: boolean;
      }[]>`
        SELECT procedure.oid::int AS "functionOid", procedure.oid::regprocedure::text AS signature,
          grantor.rolname AS grantor, CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
          acl.privilege_type AS privilege, acl.is_grantable AS grantable
        FROM pg_proc AS procedure
        INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) AS acl
        INNER JOIN pg_roles AS grantor ON grantor.oid = acl.grantor
        LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
        WHERE namespace.nspname = 'public' AND procedure.proname = ANY(${functionNames as unknown as string[]})
        ORDER BY procedure.oid::regprocedure::text, grantee, grantor.rolname
      `;
      const informationSchemaRows = await transaction<{
        grantor: string;
        grantee: string;
        privilege: string;
        routine: string;
        specificName: string;
      }[]>`
        SELECT grantor, grantee, privilege_type AS privilege, routine_name AS routine,
          specific_name AS "specificName"
        FROM information_schema.routine_privileges
        WHERE specific_schema = 'public' AND routine_name = ANY(${functionNames as unknown as string[]})
        ORDER BY routine_name, specific_name, grantee, grantor
      `;
      const overloads = await transaction<{ name: string; count: number }[]>`
        SELECT procedure.proname AS name, count(*)::int AS count
        FROM pg_proc AS procedure
        INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public' AND procedure.proname = ANY(${functionNames as unknown as string[]})
        GROUP BY procedure.proname ORDER BY procedure.proname
      `;
      const resolution = await transaction<{ requested: string; resolved: string | null }[]>`
        SELECT requested, to_regprocedure(requested)::text AS resolved
        FROM unnest(${expectedSignatures as unknown as string[]}::text[]) AS requested
        ORDER BY requested
      `;

      return {
        code: "WP10_STAGING_ACL_READ_ONLY_INVENTORY",
        transactionReadOnly: readOnly?.readOnly === "on",
        functions,
        rawAclEntries,
        effectiveAclEntries,
        informationSchemaRows,
        informationSchemaAnonymousPublicCount: informationSchemaRows.filter((row) =>
          ["PUBLIC", "anon", "authenticated"].includes(row.grantee)).length,
        overloads,
        resolution,
      };
    });
    console.log(JSON.stringify(report));
    if (!report.transactionReadOnly) throw new Error("WP-10 staging ACL inventory was not read-only.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "WP-10 staging ACL inventory failed.");
  process.exitCode = 1;
});
