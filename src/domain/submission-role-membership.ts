export const SUBMISSION_SERVICE_ROLE = "repairprint_submission_service";
export const SUBMISSION_MAINTENANCE_ROLE = "repairprint_submission_maintenance";

const submissionRoles = [SUBMISSION_SERVICE_ROLE, SUBMISSION_MAINTENANCE_ROLE] as const;

export type SubmissionRoleMembership = Readonly<{
  adminOption: boolean;
  grantedRole: string;
  grantorRole: string | null;
  inheritOption: boolean;
  memberRole: string;
  setOption: boolean;
}>;

export type SubmissionRoleMembershipAssessment = Readonly<{
  valid: boolean;
  violations: readonly string[];
}>;

function isSupabaseAdministrationMembership(membership: SubmissionRoleMembership): boolean {
  return submissionRoles.includes(membership.grantedRole as (typeof submissionRoles)[number])
    && membership.memberRole === "postgres"
    && membership.grantorRole === "supabase_admin"
    && membership.adminOption
    && !membership.inheritOption
    && !membership.setOption;
}

export function assessSubmissionRoleMemberships(
  memberships: readonly SubmissionRoleMembership[],
): SubmissionRoleMembershipAssessment {
  const violations: string[] = [];
  const allowedRoles = new Set<string>();

  for (const membership of memberships) {
    if (!isSupabaseAdministrationMembership(membership)) {
      violations.push(
        `unsafe:${membership.grantedRole}:${membership.memberRole}:${membership.grantorRole ?? "null"}`,
      );
      continue;
    }

    if (allowedRoles.has(membership.grantedRole)) {
      violations.push(`duplicate:${membership.grantedRole}`);
      continue;
    }
    allowedRoles.add(membership.grantedRole);
  }

  if (allowedRoles.size !== 0 && allowedRoles.size !== submissionRoles.length) {
    violations.push("incomplete-supabase-administration-pair");
  }

  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze([...violations]),
  });
}
