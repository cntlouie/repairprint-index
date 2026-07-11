export const STAFF_ROLES = ["editor", "reviewer", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_STATUSES = ["invited", "active", "disabled"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];
export type AuthAssuranceLevel = "aal1" | "aal2";

export const STAFF_ACTIONS = [
  "draft:write",
  "import:commit",
  "fitment:review",
  "evidence:review",
  "safety:review",
  "rights:review",
  "publication:publish",
  "publication:unpublish",
  "staff:invite",
  "staff:manage",
  "policy:manage",
  "archive:write",
] as const;

export type StaffAction = (typeof STAFF_ACTIONS)[number];

export interface StaffIdentity {
  id: string;
  authUserId: string;
  email: string;
  role: StaffRole;
  status: StaffStatus;
}

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; code: "STAFF_INACTIVE" | "MFA_REQUIRED" | "FORBIDDEN" };

const ROLE_ACTIONS: Readonly<Record<StaffRole, ReadonlySet<StaffAction>>> = {
  editor: new Set(["draft:write", "import:commit"]),
  reviewer: new Set([
    "draft:write",
    "import:commit",
    "fitment:review",
    "evidence:review",
    "safety:review",
    "rights:review",
    "publication:publish",
    "publication:unpublish",
  ]),
  admin: new Set(STAFF_ACTIONS),
};

export function authorizeStaff(
  staff: StaffIdentity,
  assuranceLevel: AuthAssuranceLevel,
  action: StaffAction,
): AuthorizationDecision {
  if (staff.status !== "active") return { allowed: false, code: "STAFF_INACTIVE" };
  if ((staff.role === "reviewer" || staff.role === "admin") && assuranceLevel !== "aal2") {
    return { allowed: false, code: "MFA_REQUIRED" };
  }
  if (!ROLE_ACTIONS[staff.role].has(action)) return { allowed: false, code: "FORBIDDEN" };
  return { allowed: true };
}

export function requiresDecisionReason(action: StaffAction): boolean {
  return action !== "draft:write" && action !== "staff:invite";
}
