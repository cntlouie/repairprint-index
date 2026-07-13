import { createHash } from "node:crypto";

export const PG_TRGM_EXTENSION_NAME = "pg_trgm";
export const PG_TRGM_EXTENSION_VERSION = "1.6";
export const PG_TRGM_EXPECTED_ROUTINE_COUNT = 31;

export const PG_TRGM_FRESH_PG17_BASELINE = Object.freeze({
  owner: "repairprint",
  routineCount: PG_TRGM_EXPECTED_ROUTINE_COUNT,
  fingerprint: "fb1fec29b971acc669e9ebdfeb3b7f55cf2c6b5710f2ce99cbac020e70bdffac",
} as const);

export const PG_TRGM_STAGING_BASELINE = Object.freeze({
  owner: "supabase_admin",
  routineCount: PG_TRGM_EXPECTED_ROUTINE_COUNT,
  fingerprint: "9815bdde7ae8e74337c527c90b34d23d02ffb508ddc58c1f1a8323b430dcfc94",
} as const);

export const PG_TRGM_APPROVED_BASELINES = Object.freeze([
  PG_TRGM_FRESH_PG17_BASELINE,
  PG_TRGM_STAGING_BASELINE,
] as const);

export const ANALYTICS_EXTENSION_DENIED_GRANTEES = Object.freeze([
  "repairprint_analytics_service",
  "repairprint_analytics_maintenance",
] as const);

export interface PostgresExtensionRow {
  readonly conditions: readonly string[] | null;
  readonly configuration: readonly string[] | null;
  readonly name: string;
  readonly owner: string;
  readonly relocatable: boolean;
  readonly schema: string;
  readonly version: string;
}

export interface PostgresExtensionRoutineRow {
  readonly aclDefaulted: boolean;
  readonly configuration: readonly string[] | null;
  readonly definition: string;
  readonly kind: string;
  readonly language: string;
  readonly leakproof: boolean;
  readonly owner: string;
  readonly parallel: string;
  readonly result: string;
  readonly returnsSet: boolean;
  readonly schema: string;
  readonly securityDefiner: boolean;
  readonly signature: string;
  readonly strict: boolean;
  readonly volatility: string;
}

export interface PostgresExtensionAclRow {
  readonly grantable: boolean;
  readonly grantee: string;
  readonly grantor: string;
  readonly privilege: string;
  readonly signature: string;
}

export interface CanonicalPostgresExtensionAclEntry {
  readonly grantor: string;
  readonly grantee: string;
  readonly privilege: string;
  readonly grantable: boolean;
}

export interface CanonicalPostgresExtensionRoutine {
  readonly schema: string;
  readonly signature: string;
  readonly result: string;
  readonly owner: string;
  readonly language: string;
  readonly kind: string;
  readonly securityDefiner: boolean;
  readonly volatility: string;
  readonly parallel: string;
  readonly leakproof: boolean;
  readonly strict: boolean;
  readonly returnsSet: boolean;
  readonly configuration: readonly string[];
  readonly definitionSha256: string;
  readonly aclDefaulted: boolean;
  readonly acl: readonly CanonicalPostgresExtensionAclEntry[];
}

export interface CanonicalPostgresExtensionManifest {
  readonly extension: {
    readonly name: string;
    readonly version: string;
    readonly schema: string;
    readonly owner: string;
    readonly relocatable: boolean;
    readonly configuration: readonly string[];
    readonly conditions: readonly string[];
  };
  readonly routines: readonly CanonicalPostgresExtensionRoutine[];
}

export interface PgTrgmManifestAssessment {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

export interface PgTrgmRoutineCountAssessment extends PgTrgmManifestAssessment {
  readonly actual: number;
  readonly expected: number;
}

export interface ApprovedPgTrgmManifestAssessment extends PgTrgmManifestAssessment {
  readonly fingerprint: string;
  readonly routineCount: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareAcl(
  left: CanonicalPostgresExtensionAclEntry,
  right: CanonicalPostgresExtensionAclEntry,
): number {
  return compareText(JSON.stringify(left), JSON.stringify(right));
}

function freezeStrings(values: readonly string[] | null): readonly string[] {
  return Object.freeze([...(values ?? [])].sort(compareText));
}

function freezeAcl(
  values: readonly CanonicalPostgresExtensionAclEntry[],
): readonly CanonicalPostgresExtensionAclEntry[] {
  return Object.freeze(values.map((value) => Object.freeze(value)).sort(compareAcl));
}

/**
 * Builds an OID-free, deterministically ordered extension manifest. The property
 * insertion order is part of the fingerprint contract and must remain stable.
 */
export function canonicalizePostgresExtensionManifest(
  extension: PostgresExtensionRow,
  routineRows: readonly PostgresExtensionRoutineRow[],
  aclRows: readonly PostgresExtensionAclRow[],
): CanonicalPostgresExtensionManifest {
  const knownSignatures = new Set<string>();
  for (const routine of routineRows) {
    if (knownSignatures.has(routine.signature)) {
      throw new Error("POSTGRES_EXTENSION_MANIFEST_DUPLICATE_ROUTINE_SIGNATURE");
    }
    knownSignatures.add(routine.signature);
  }

  const aclBySignature = new Map<string, CanonicalPostgresExtensionAclEntry[]>();
  for (const row of aclRows) {
    if (!knownSignatures.has(row.signature)) {
      throw new Error("POSTGRES_EXTENSION_MANIFEST_UNKNOWN_ACL_SIGNATURE");
    }
    const entries = aclBySignature.get(row.signature) ?? [];
    entries.push({
      grantor: row.grantor,
      grantee: row.grantee,
      privilege: row.privilege,
      grantable: row.grantable,
    });
    aclBySignature.set(row.signature, entries);
  }

  const routines = routineRows
    .map((routine): CanonicalPostgresExtensionRoutine => Object.freeze({
      schema: routine.schema,
      signature: routine.signature,
      result: routine.result,
      owner: routine.owner,
      language: routine.language,
      kind: routine.kind,
      securityDefiner: routine.securityDefiner,
      volatility: routine.volatility,
      parallel: routine.parallel,
      leakproof: routine.leakproof,
      strict: routine.strict,
      returnsSet: routine.returnsSet,
      configuration: freezeStrings(routine.configuration),
      definitionSha256: sha256(routine.definition),
      aclDefaulted: routine.aclDefaulted,
      acl: freezeAcl(aclBySignature.get(routine.signature) ?? []),
    }))
    .sort((left, right) => compareText(left.signature, right.signature));

  return Object.freeze({
    extension: Object.freeze({
      name: extension.name,
      version: extension.version,
      schema: extension.schema,
      owner: extension.owner,
      relocatable: extension.relocatable,
      configuration: freezeStrings(extension.configuration),
      conditions: freezeStrings(extension.conditions),
    }),
    routines: Object.freeze(routines),
  });
}

export function fingerprintPostgresExtensionManifest(
  manifest: CanonicalPostgresExtensionManifest,
): string {
  return sha256(JSON.stringify(manifest));
}

export function assessPgTrgmRoutineCount(
  actual: number,
  expected = PG_TRGM_EXPECTED_ROUTINE_COUNT,
): PgTrgmRoutineCountAssessment {
  const valid = Number.isSafeInteger(actual) && actual >= 0 && actual === expected;
  return Object.freeze({
    valid,
    violations: Object.freeze(valid ? [] : ["PG_TRGM_ROUTINE_COUNT_INVALID"]),
    actual,
    expected,
  });
}

export function assertPgTrgmRoutineCount(
  actual: number,
  expected = PG_TRGM_EXPECTED_ROUTINE_COUNT,
): void {
  if (!assessPgTrgmRoutineCount(actual, expected).valid) {
    throw new Error("PG_TRGM_ROUTINE_COUNT_INVALID");
  }
}

function expectedAclForOwner(
  owner: string,
): readonly CanonicalPostgresExtensionAclEntry[] | undefined {
  const grantees = owner === PG_TRGM_FRESH_PG17_BASELINE.owner
    ? ["PUBLIC", "repairprint"]
    : owner === PG_TRGM_STAGING_BASELINE.owner
      ? ["PUBLIC", "anon", "authenticated", "postgres", "service_role", "supabase_admin"]
      : undefined;
  if (!grantees) return undefined;

  return freezeAcl(grantees.map((grantee) => ({
    grantor: owner,
    grantee,
    privilege: "EXECUTE",
    grantable: false,
  })));
}

function aclEquals(
  actual: readonly CanonicalPostgresExtensionAclEntry[],
  expected: readonly CanonicalPostgresExtensionAclEntry[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Checks the security shape independently of a particular approved fingerprint.
 * This is useful for producing a precise failure before the exact baseline check.
 */
export function assessPgTrgmManifestSecurity(
  manifest: CanonicalPostgresExtensionManifest,
): PgTrgmManifestAssessment {
  const violations: string[] = [];
  const extension = manifest.extension;
  const expectedAcl = expectedAclForOwner(extension.owner);

  if (extension.name !== PG_TRGM_EXTENSION_NAME) {
    violations.push("PG_TRGM_EXTENSION_NAME_INVALID");
  }
  if (extension.version !== PG_TRGM_EXTENSION_VERSION) {
    violations.push("PG_TRGM_EXTENSION_VERSION_INVALID");
  }
  if (extension.schema !== "public") {
    violations.push("PG_TRGM_EXTENSION_SCHEMA_INVALID");
  }
  if (!expectedAcl) {
    violations.push("PG_TRGM_EXTENSION_OWNER_INVALID");
  }
  if (!extension.relocatable) {
    violations.push("PG_TRGM_EXTENSION_RELOCATABLE_INVALID");
  }
  if (extension.configuration.length !== 0) {
    violations.push("PG_TRGM_EXTENSION_CONFIGURATION_INVALID");
  }
  if (extension.conditions.length !== 0) {
    violations.push("PG_TRGM_EXTENSION_CONDITIONS_INVALID");
  }

  const seenSignatures = new Set<string>();
  for (const routine of manifest.routines) {
    if (seenSignatures.has(routine.signature)) {
      violations.push("PG_TRGM_ROUTINE_SIGNATURE_DUPLICATE");
    }
    seenSignatures.add(routine.signature);

    if (routine.schema !== "public") {
      violations.push("PG_TRGM_ROUTINE_SCHEMA_INVALID");
    }
    if (routine.owner !== extension.owner) {
      violations.push("PG_TRGM_ROUTINE_OWNER_INVALID");
    }
    if (routine.securityDefiner) {
      violations.push("PG_TRGM_ROUTINE_SECURITY_DEFINER");
    }
    if (routine.configuration.length !== 0) {
      violations.push("PG_TRGM_ROUTINE_CONFIGURATION_INVALID");
    }
    if (ANALYTICS_EXTENSION_DENIED_GRANTEES.some((role) => (
      routine.acl.some((entry) => entry.grantee === role && entry.privilege === "EXECUTE")
    ))) {
      violations.push("PG_TRGM_DIRECT_ANALYTICS_EXECUTE_GRANT");
    }
    if (expectedAcl && !aclEquals(routine.acl, expectedAcl)) {
      violations.push("PG_TRGM_ROUTINE_ACL_INVALID");
    }
    if (routine.aclDefaulted) {
      violations.push("PG_TRGM_ROUTINE_ACL_DEFAULT_STATE_INVALID");
    }
  }

  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

export function assessApprovedPgTrgmManifest(
  manifest: CanonicalPostgresExtensionManifest,
): ApprovedPgTrgmManifestAssessment {
  const security = assessPgTrgmManifestSecurity(manifest);
  const count = assessPgTrgmRoutineCount(manifest.routines.length);
  const fingerprint = fingerprintPostgresExtensionManifest(manifest);
  const baseline = PG_TRGM_APPROVED_BASELINES.find(
    (candidate) => candidate.owner === manifest.extension.owner,
  );
  const violations = [...security.violations, ...count.violations];

  if (!baseline || baseline.fingerprint !== fingerprint) {
    violations.push("PG_TRGM_MANIFEST_FINGERPRINT_INVALID");
  }

  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze(violations),
    fingerprint,
    routineCount: manifest.routines.length,
  });
}

export function assertApprovedPgTrgmManifest(
  manifest: CanonicalPostgresExtensionManifest,
): ApprovedPgTrgmManifestAssessment {
  const assessment = assessApprovedPgTrgmManifest(manifest);
  if (!assessment.valid) {
    throw new Error(assessment.violations[0] ?? "PG_TRGM_MANIFEST_INVALID");
  }
  return assessment;
}
