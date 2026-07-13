export const ANALYTICS_SERVICE_ROLE = "repairprint_analytics_service";
export const ANALYTICS_MAINTENANCE_ROLE = "repairprint_analytics_maintenance";

const analyticsRoles = [ANALYTICS_SERVICE_ROLE, ANALYTICS_MAINTENANCE_ROLE] as const;

export interface AnalyticsRoleMembership {
  readonly adminOption: boolean;
  readonly grantedRole: string;
  readonly grantorRole: string | null;
  readonly inheritOption: boolean;
  readonly memberRole: string;
  readonly setOption: boolean;
}

export function assessAnalyticsRoleMemberships(
  memberships: readonly AnalyticsRoleMembership[],
): Readonly<{ valid: boolean; violations: readonly string[] }> {
  const violations: string[] = [];
  const allowedRoles = new Set<string>();

  for (const membership of memberships) {
    const allowed = analyticsRoles.includes(membership.grantedRole as (typeof analyticsRoles)[number])
      && membership.memberRole === "postgres"
      && membership.grantorRole === "supabase_admin"
      && membership.adminOption
      && !membership.inheritOption
      && !membership.setOption;
    if (!allowed) {
      violations.push(
        `unsafe:${membership.grantedRole}:${membership.memberRole}:${membership.grantorRole ?? "null"}`,
      );
    } else if (allowedRoles.has(membership.grantedRole)) {
      violations.push(`duplicate:${membership.grantedRole}`);
    } else {
      allowedRoles.add(membership.grantedRole);
    }
  }

  if (allowedRoles.size !== 0 && allowedRoles.size !== analyticsRoles.length) {
    violations.push("incomplete-supabase-administration-pair");
  }

  return Object.freeze({ valid: violations.length === 0, violations: Object.freeze(violations) });
}
