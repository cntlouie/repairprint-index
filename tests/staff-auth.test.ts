import { describe, expect, it } from "vitest";
import { type JWTPayload } from "jose";
import {
  requireStaffAuthorization,
  StaffAuthorizationError,
  staffTokenFromClaims,
} from "@/lib/staff-auth";

describe("server-side staff authentication", () => {
  it("extracts a verified Supabase subject, email, and assurance level", () => {
    expect(staffTokenFromClaims({
      sub: "00000000-0000-4000-8000-000000000101",
      email: "reviewer@example.invalid",
      aal: "aal2",
      role: "authenticated",
      is_anonymous: false,
    } as JWTPayload)).toEqual({
      authUserId: "00000000-0000-4000-8000-000000000101",
      email: "reviewer@example.invalid",
      assuranceLevel: "aal2",
    });
  });

  it("treats a legacy token without an AAL claim as AAL1", () => {
    expect(staffTokenFromClaims({
      sub: "00000000-0000-4000-8000-000000000102",
      email: "editor@example.invalid",
      role: "authenticated",
      is_anonymous: false,
    } as JWTPayload).assuranceLevel).toBe("aal1");
  });

  it("rejects anonymous requests before a profile lookup", async () => {
    let lookedUp = false;
    await expect(requireStaffAuthorization(null, "draft:write", {
      findStaffByAuthUserId: async () => {
        lookedUp = true;
        return null;
      },
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    expect(lookedUp).toBe(false);
  });

  it("enforces the database role after token verification", async () => {
    await expect(requireStaffAuthorization("Bearer fixture", "publication:publish", {
      verifyToken: async () => ({ authUserId: "auth-editor", email: "editor@example.invalid", assuranceLevel: "aal2" }),
      findStaffByAuthUserId: async () => ({
        id: "staff-editor",
        authUserId: "auth-editor",
        email: "editor@example.invalid",
        role: "editor",
        status: "active",
      }),
    })).rejects.toEqual(new StaffAuthorizationError("FORBIDDEN", 403));
  });
});
