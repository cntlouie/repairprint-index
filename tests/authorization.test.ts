import { describe, expect, it } from "vitest";
import {
  authorizeStaff,
  requiresDecisionReason,
  STAFF_ACTIONS,
  type StaffIdentity,
} from "@/domain/authorization";

const editor: StaffIdentity = {
  id: "staff-editor",
  authUserId: "auth-editor",
  email: "editor@example.invalid",
  role: "editor",
  status: "active",
};

describe("staff authorization", () => {
  it("allows editors to prepare drafts but never publish", () => {
    expect(authorizeStaff(editor, "aal1", "draft:write")).toEqual({ allowed: true });
    expect(authorizeStaff(editor, "aal1", "import:commit")).toEqual({ allowed: true });
    expect(authorizeStaff(editor, "aal2", "publication:publish")).toEqual({
      allowed: false,
      code: "FORBIDDEN",
    });
  });

  it.each(["reviewer", "admin"] as const)("requires AAL2 MFA for %s", (role) => {
    const staff = { ...editor, role };
    expect(authorizeStaff(staff, "aal1", "draft:write")).toEqual({
      allowed: false,
      code: "MFA_REQUIRED",
    });
    expect(authorizeStaff(staff, "aal2", "publication:publish")).toEqual({ allowed: true });
  });

  it.each(["invited", "disabled"] as const)("rejects %s profiles", (status) => {
    expect(authorizeStaff({ ...editor, status }, "aal2", "draft:write")).toEqual({
      allowed: false,
      code: "STAFF_INACTIVE",
    });
  });

  it("requires reasons for material decisions and transitions", () => {
    for (const action of STAFF_ACTIONS) {
      expect(requiresDecisionReason(action)).toBe(action !== "draft:write" && action !== "staff:invite");
    }
  });
});
