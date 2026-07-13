export interface ProviderIncompatibleRoleAlteration {
  readonly role: "repairprint_source_service" | "repairprint_source_maintenance";
  readonly statement: string;
}

const sourceRoleAlteration = /\bALTER\s+ROLE\s+"?(repairprint_source_(?:service|maintenance))"?\b[\s\S]*?;/giu;
const providerRestrictedAttribute = /\b(?:NO)?(?:SUPERUSER|CREATEDB|CREATEROLE|INHERIT|LOGIN|REPLICATION|BYPASSRLS)\b/iu;

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
