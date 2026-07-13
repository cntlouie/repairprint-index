import { describe, expect, it } from "vitest";

import {
  ANALYTICS_EXTENSION_DENIED_GRANTEES,
  PG_TRGM_EXPECTED_ROUTINE_COUNT,
  PG_TRGM_FRESH_PG17_BASELINE,
  PG_TRGM_STAGING_BASELINE,
  assessApprovedPgTrgmManifest,
  assessPgTrgmManifestSecurity,
  assessPgTrgmRoutineCount,
  assertPgTrgmRoutineCount,
  canonicalizePostgresExtensionManifest,
  fingerprintPostgresExtensionManifest,
  type CanonicalPostgresExtensionManifest,
  type PostgresExtensionAclRow,
  type PostgresExtensionRoutineRow,
  type PostgresExtensionRow,
} from "@/domain/postgres-extension-manifest";

const freshExtension: PostgresExtensionRow = {
  name: "pg_trgm",
  version: "1.6",
  schema: "public",
  owner: "repairprint",
  relocatable: true,
  configuration: null,
  conditions: null,
};

const routineA: PostgresExtensionRoutineRow = {
  schema: "public",
  signature: "public.similarity(text, text)",
  result: "real",
  owner: "repairprint",
  language: "c",
  kind: "function",
  securityDefiner: false,
  volatility: "immutable",
  parallel: "safe",
  leakproof: false,
  strict: true,
  returnsSet: false,
  configuration: null,
  definition: "CREATE OR REPLACE FUNCTION public.similarity(text, text) RETURNS real ...",
  aclDefaulted: false,
};

const routineB: PostgresExtensionRoutineRow = {
  ...routineA,
  signature: "public.word_similarity(text, text)",
  definition: "CREATE OR REPLACE FUNCTION public.word_similarity(text, text) RETURNS real ...",
};

function aclFor(signature: string, owner = "repairprint"): PostgresExtensionAclRow[] {
  const grantees = owner === "repairprint"
    ? ["PUBLIC", "repairprint"]
    : ["PUBLIC", "anon", "authenticated", "postgres", "service_role", "supabase_admin"];
  return grantees.map((grantee) => ({
    signature,
    grantor: owner,
    grantee,
    privilege: "EXECUTE",
    grantable: false,
  }));
}

function freshManifest(): CanonicalPostgresExtensionManifest {
  return canonicalizePostgresExtensionManifest(
    freshExtension,
    [routineA, routineB],
    [...aclFor(routineA.signature), ...aclFor(routineB.signature)],
  );
}

function stagingManifest(): CanonicalPostgresExtensionManifest {
  const owner = "supabase_admin";
  return canonicalizePostgresExtensionManifest(
    { ...freshExtension, owner },
    [
      { ...routineA, owner },
      { ...routineB, owner },
    ],
    [...aclFor(routineA.signature, owner), ...aclFor(routineB.signature, owner)],
  );
}

function replaceManifest(
  manifest: CanonicalPostgresExtensionManifest,
  update: Partial<CanonicalPostgresExtensionManifest>,
): CanonicalPostgresExtensionManifest {
  return { ...manifest, ...update };
}

describe("canonical PostgreSQL extension manifest", () => {
  it("is stable across routine, ACL, and configuration input order", () => {
    const forward = canonicalizePostgresExtensionManifest(
      { ...freshExtension, configuration: ["z=2", "a=1"], conditions: ["b", "a"] },
      [{ ...routineA, configuration: ["z=2", "a=1"] }, routineB],
      [...aclFor(routineA.signature), ...aclFor(routineB.signature)],
    );
    const reversed = canonicalizePostgresExtensionManifest(
      { ...freshExtension, configuration: ["a=1", "z=2"], conditions: ["a", "b"] },
      [routineB, { ...routineA, configuration: ["a=1", "z=2"] }],
      [...aclFor(routineB.signature), ...aclFor(routineA.signature)].reverse(),
    );

    expect(reversed).toEqual(forward);
    expect(fingerprintPostgresExtensionManifest(reversed)).toBe(
      fingerprintPostgresExtensionManifest(forward),
    );
    expect(forward.routines.map((routine) => routine.signature)).toEqual([
      routineA.signature,
      routineB.signature,
    ]);
  });

  it("uses the approved OID-free property order and hashes definitions", () => {
    const manifest = freshManifest();
    expect(Object.keys(manifest.extension)).toEqual([
      "name",
      "version",
      "schema",
      "owner",
      "relocatable",
      "configuration",
      "conditions",
    ]);
    expect(Object.keys(manifest.routines[0] ?? {})).toEqual([
      "schema",
      "signature",
      "result",
      "owner",
      "language",
      "kind",
      "securityDefiner",
      "volatility",
      "parallel",
      "leakproof",
      "strict",
      "returnsSet",
      "configuration",
      "definitionSha256",
      "aclDefaulted",
      "acl",
    ]);
    expect(Object.keys(manifest.routines[0]?.acl[0] ?? {})).toEqual([
      "grantor",
      "grantee",
      "privilege",
      "grantable",
    ]);
    expect(manifest.routines[0]?.definitionSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(manifest)).not.toContain("definition\"");
    expect(JSON.stringify(manifest)).not.toMatch(/\boid\b/iu);
  });

  it("fails closed on duplicate routines and ACLs for unknown routines", () => {
    expect(() => canonicalizePostgresExtensionManifest(
      freshExtension,
      [routineA, routineA],
      aclFor(routineA.signature),
    )).toThrow("POSTGRES_EXTENSION_MANIFEST_DUPLICATE_ROUTINE_SIGNATURE");
    expect(() => canonicalizePostgresExtensionManifest(
      freshExtension,
      [routineA],
      [{ ...aclFor(routineA.signature)[0]!, signature: "public.unknown()" }],
    )).toThrow("POSTGRES_EXTENSION_MANIFEST_UNKNOWN_ACL_SIGNATURE");
  });

  it("records the separately approved fresh and staging baselines", () => {
    expect(PG_TRGM_FRESH_PG17_BASELINE).toEqual({
      owner: "repairprint",
      routineCount: 31,
      fingerprint: "fb1fec29b971acc669e9ebdfeb3b7f55cf2c6b5710f2ce99cbac020e70bdffac",
    });
    expect(PG_TRGM_STAGING_BASELINE).toEqual({
      owner: "supabase_admin",
      routineCount: 31,
      fingerprint: "9815bdde7ae8e74337c527c90b34d23d02ffb508ddc58c1f1a8323b430dcfc94",
    });
  });

  it("validates the exact routine count", () => {
    expect(assessPgTrgmRoutineCount(PG_TRGM_EXPECTED_ROUTINE_COUNT)).toEqual({
      valid: true,
      violations: [],
      actual: 31,
      expected: 31,
    });
    for (const count of [-1, 30, 32, 31.5, Number.NaN]) {
      expect(assessPgTrgmRoutineCount(count).valid).toBe(false);
      expect(() => assertPgTrgmRoutineCount(count)).toThrow("PG_TRGM_ROUTINE_COUNT_INVALID");
    }
  });
});

describe("pg_trgm security profile", () => {
  it("allows only the exact fresh and staging owner-specific ACL shapes", () => {
    expect(assessPgTrgmManifestSecurity(freshManifest())).toEqual({
      valid: true,
      violations: [],
    });
    expect(assessPgTrgmManifestSecurity(stagingManifest())).toEqual({
      valid: true,
      violations: [],
    });
  });

  it.each([
    ["name", (manifest: CanonicalPostgresExtensionManifest) => replaceManifest(manifest, {
      extension: { ...manifest.extension, name: "not_pg_trgm" },
    })],
    ["version", (manifest: CanonicalPostgresExtensionManifest) => replaceManifest(manifest, {
      extension: { ...manifest.extension, version: "1.7" },
    })],
    ["schema", (manifest: CanonicalPostgresExtensionManifest) => replaceManifest(manifest, {
      extension: { ...manifest.extension, schema: "extensions" },
    })],
    ["owner", (manifest: CanonicalPostgresExtensionManifest) => replaceManifest(manifest, {
      extension: { ...manifest.extension, owner: "postgres" },
    })],
    ["relocatable", (manifest: CanonicalPostgresExtensionManifest) => replaceManifest(manifest, {
      extension: { ...manifest.extension, relocatable: false },
    })],
    ["extension configuration", (manifest: CanonicalPostgresExtensionManifest) => replaceManifest(manifest, {
      extension: { ...manifest.extension, configuration: ["search_path=public"] },
    })],
    ["extension conditions", (manifest: CanonicalPostgresExtensionManifest) => replaceManifest(manifest, {
      extension: { ...manifest.extension, conditions: ["condition"] },
    })],
  ])("rejects an altered extension %s", (_label, mutate) => {
    expect(assessPgTrgmManifestSecurity(mutate(freshManifest())).valid).toBe(false);
  });

  it.each([
    ["schema", { schema: "extensions" }],
    ["owner", { owner: "postgres" }],
    ["security definer", { securityDefiner: true }],
    ["configuration", { configuration: ["search_path=public"] }],
    ["ACL default state", { aclDefaulted: true }],
  ] satisfies readonly [string, Partial<CanonicalPostgresExtensionManifest["routines"][number]>][])(
    "rejects an altered routine %s security property",
    (_label, update) => {
      const manifest = freshManifest();
      const [first, ...rest] = manifest.routines;
      expect(first).toBeDefined();
      const changed = replaceManifest(manifest, {
        routines: [{ ...first!, ...update }, ...rest],
      });
      expect(assessPgTrgmManifestSecurity(changed).valid).toBe(false);
    },
  );

  it("rejects any explicit analytics-role grant", () => {
    for (const grantee of ANALYTICS_EXTENSION_DENIED_GRANTEES) {
      const manifest = freshManifest();
      const [first, ...rest] = manifest.routines;
      const changed = replaceManifest(manifest, {
        routines: [{
          ...first!,
          acl: [...first!.acl, {
            grantor: "repairprint",
            grantee,
            privilege: "EXECUTE",
            grantable: false,
          }],
        }, ...rest],
      });
      expect(assessPgTrgmManifestSecurity(changed).violations).toContain(
        "PG_TRGM_DIRECT_ANALYTICS_EXECUTE_GRANT",
      );
    }
  });

  it.each([
    ["missing", (acl: CanonicalPostgresExtensionManifest["routines"][number]["acl"]) => acl.slice(1)],
    ["extra", (acl: CanonicalPostgresExtensionManifest["routines"][number]["acl"]) => [...acl, acl[0]!]],
    ["grantor", (acl: CanonicalPostgresExtensionManifest["routines"][number]["acl"]) => [{ ...acl[0]!, grantor: "postgres" }, ...acl.slice(1)]],
    ["grantee", (acl: CanonicalPostgresExtensionManifest["routines"][number]["acl"]) => [{ ...acl[0]!, grantee: "service_role" }, ...acl.slice(1)]],
    ["privilege", (acl: CanonicalPostgresExtensionManifest["routines"][number]["acl"]) => [{ ...acl[0]!, privilege: "ALTER" }, ...acl.slice(1)]],
    ["grantable", (acl: CanonicalPostgresExtensionManifest["routines"][number]["acl"]) => [{ ...acl[0]!, grantable: true }, ...acl.slice(1)]],
  ])("rejects an ACL with %s state", (_label, mutateAcl) => {
    const manifest = freshManifest();
    const [first, ...rest] = manifest.routines;
    const changed = replaceManifest(manifest, {
      routines: [{ ...first!, acl: mutateAcl(first!.acl) }, ...rest],
    });
    expect(assessPgTrgmManifestSecurity(changed).valid).toBe(false);
  });
});

describe("pg_trgm exact manifest fingerprint", () => {
  it.each([
    ["result", { result: "double precision" }],
    ["language", { language: "sql" }],
    ["kind", { kind: "procedure" }],
    ["volatility", { volatility: "stable" }],
    ["parallel", { parallel: "restricted" }],
    ["leakproof", { leakproof: true }],
    ["strict", { strict: false }],
    ["returnsSet", { returnsSet: true }],
    ["definition hash", { definitionSha256: "0".repeat(64) }],
  ] satisfies readonly [string, Partial<CanonicalPostgresExtensionManifest["routines"][number]>][])(
    "changes when routine %s changes",
    (_label, update) => {
      const manifest = freshManifest();
      const [first, ...rest] = manifest.routines;
      const changed = replaceManifest(manifest, {
        routines: [{ ...first!, ...update }, ...rest],
      });
      expect(fingerprintPostgresExtensionManifest(changed)).not.toBe(
        fingerprintPostgresExtensionManifest(manifest),
      );
      expect(assessApprovedPgTrgmManifest(changed).valid).toBe(false);
    },
  );

  it("changes for added, removed, renamed, or redefined routines", () => {
    const manifest = freshManifest();
    const [first, second] = manifest.routines;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const variants: CanonicalPostgresExtensionManifest[] = [
      replaceManifest(manifest, { routines: [first!] }),
      replaceManifest(manifest, { routines: [...manifest.routines, { ...second!, signature: "public.extra()" }] }),
      replaceManifest(manifest, { routines: [{ ...first!, signature: "public.changed(text, text)" }, second!] }),
      replaceManifest(manifest, { routines: [{ ...first!, definitionSha256: "f".repeat(64) }, second!] }),
    ];
    for (const changed of variants) {
      expect(fingerprintPostgresExtensionManifest(changed)).not.toBe(
        fingerprintPostgresExtensionManifest(manifest),
      );
      expect(assessApprovedPgTrgmManifest(changed).valid).toBe(false);
    }

    const redefinedInput = canonicalizePostgresExtensionManifest(
      freshExtension,
      [{ ...routineA, definition: `${routineA.definition} changed` }, routineB],
      [...aclFor(routineA.signature), ...aclFor(routineB.signature)],
    );
    expect(redefinedInput.routines[0]?.definitionSha256).not.toBe(
      manifest.routines[0]?.definitionSha256,
    );
    expect(fingerprintPostgresExtensionManifest(redefinedInput)).not.toBe(
      fingerprintPostgresExtensionManifest(manifest),
    );
  });

  it("changes when any extension, ACL, or ACL-default property changes", () => {
    const manifest = freshManifest();
    const extensionChanged = replaceManifest(manifest, {
      extension: { ...manifest.extension, version: "changed" },
    });
    const first = manifest.routines[0]!;
    const aclChanged = replaceManifest(manifest, {
      routines: [{ ...first, acl: [{ ...first.acl[0]!, grantable: true }, ...first.acl.slice(1)] }, ...manifest.routines.slice(1)],
    });
    const defaultChanged = replaceManifest(manifest, {
      routines: [{ ...first, aclDefaulted: !first.aclDefaulted }, ...manifest.routines.slice(1)],
    });
    for (const changed of [extensionChanged, aclChanged, defaultChanged]) {
      expect(fingerprintPostgresExtensionManifest(changed)).not.toBe(
        fingerprintPostgresExtensionManifest(manifest),
      );
      expect(assessApprovedPgTrgmManifest(changed).valid).toBe(false);
    }
  });
});
