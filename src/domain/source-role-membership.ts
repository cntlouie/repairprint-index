export const SOURCE_SERVICE_ROLE = "repairprint_source_service";
export const SOURCE_MAINTENANCE_ROLE = "repairprint_source_maintenance";

const sourceRoles = [SOURCE_SERVICE_ROLE, SOURCE_MAINTENANCE_ROLE] as const;

export interface SourceRoleMembership {
  readonly adminOption: boolean;
  readonly grantedRole: string;
  readonly grantorRole: string | null;
  readonly inheritOption: boolean;
  readonly memberRole: string;
  readonly setOption: boolean;
}

export function assessSourceRoleMemberships(memberships: readonly SourceRoleMembership[]): Readonly<{
  valid: boolean;
  violations: readonly string[];
}> {
  const violations: string[] = [];
  const allowedRoles = new Set<string>();
  for (const membership of memberships) {
    const allowed = sourceRoles.includes(membership.grantedRole as (typeof sourceRoles)[number])
      && membership.memberRole === "postgres"
      && membership.grantorRole === "supabase_admin"
      && membership.adminOption
      && !membership.inheritOption
      && !membership.setOption;
    if (!allowed) {
      violations.push(`unsafe:${membership.grantedRole}:${membership.memberRole}:${membership.grantorRole ?? "null"}`);
    } else if (allowedRoles.has(membership.grantedRole)) {
      violations.push(`duplicate:${membership.grantedRole}`);
    } else {
      allowedRoles.add(membership.grantedRole);
    }
  }
  if (allowedRoles.size !== 0 && allowedRoles.size !== sourceRoles.length) {
    violations.push("incomplete-supabase-administration-pair");
  }
  return Object.freeze({ valid: violations.length === 0, violations: Object.freeze(violations) });
}
