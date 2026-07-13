export interface ProviderIncompatibleRoleAlteration {
  readonly role: "repairprint_source_service" | "repairprint_source_maintenance";
  readonly statement: string;
}

export interface ProviderIncompatibleAnalyticsSchemaRevocation {
  readonly objectKind: "FUNCTIONS" | "PROCEDURES" | "ROUTINES" | "SEQUENCES" | "TABLES";
  readonly role: "repairprint_analytics_service" | "repairprint_analytics_maintenance";
  readonly statement: string;
}

const sourceRoleAlteration = /\bALTER\s+ROLE\s+"?(repairprint_source_(?:service|maintenance))"?\b[\s\S]*?;/giu;
const providerRestrictedAttribute = /\b(?:NO)?(?:SUPERUSER|CREATEDB|CREATEROLE|INHERIT|LOGIN|REPLICATION|BYPASSRLS)\b/iu;
const analyticsSchemaWideRevocation = /\bREVOKE\b[^;]*?\bON\s+ALL\s+(FUNCTIONS|PROCEDURES|ROUTINES|SEQUENCES|TABLES)\s+IN\s+SCHEMA\s+"?public"?\s+FROM\s+[^;]*;/giu;
const analyticsRoleReference = /"?(repairprint_analytics_(?:service|maintenance))"?/giu;

export function findProviderIncompatibleSourceRoleAlterations(
  migrationSql: string,
): readonly ProviderIncompatibleRoleAlteration[] {
  const violations: ProviderIncompatibleRoleAlteration[] = [];
  for (const match of migrationSql.matchAll(sourceRoleAlteration)) {
    const role = match[1];
    const statement = match[0];
    if (!role || !statement || !providerRestrictedAttribute.test(statement)) continue;
    violations.push(Object.freeze({
      role: role as ProviderIncompatibleRoleAlteration["role"],
      statement: statement.replace(/\s+/gu, " ").trim(),
    }));
  }
  return Object.freeze(violations);
}

export function findProviderIncompatibleAnalyticsSchemaRevocations(
  migrationSql: string,
): readonly ProviderIncompatibleAnalyticsSchemaRevocation[] {
  const violations: ProviderIncompatibleAnalyticsSchemaRevocation[] = [];
  for (const match of migrationSql.matchAll(analyticsSchemaWideRevocation)) {
    const objectKind = match[1];
    const statement = match[0];
    if (!objectKind || !statement) continue;

    const grantees = statement
      .replace(/^[\s\S]*\bFROM\b/iu, "")
      .replace(/\bGRANTED\s+BY\b[\s\S]*$/iu, "")
      .replace(/\b(?:CASCADE|RESTRICT)\s*;?\s*$/iu, "");
    for (const roleMatch of grantees.matchAll(analyticsRoleReference)) {
      const role = roleMatch[1];
      if (!role) continue;
      violations.push(Object.freeze({
        objectKind: objectKind.toUpperCase() as ProviderIncompatibleAnalyticsSchemaRevocation["objectKind"],
        role: role as ProviderIncompatibleAnalyticsSchemaRevocation["role"],
        statement: statement.replace(/\s+/gu, " ").trim(),
      }));
    }
  }
  return Object.freeze(violations);
}
