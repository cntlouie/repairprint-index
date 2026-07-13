import { describe, expect, it } from "vitest";

import {
  assessSourceRoleMemberships,
  SOURCE_MAINTENANCE_ROLE,
  SOURCE_SERVICE_ROLE,
  type SourceRoleMembership,
} from "../src/domain/source-role-membership";

const service: SourceRoleMembership = {
  grantedRole: SOURCE_SERVICE_ROLE, memberRole: "postgres", grantorRole: "supabase_admin",
  adminOption: true, inheritOption: false, setOption: false,
};
const maintenance: SourceRoleMembership = { ...service, grantedRole: SOURCE_MAINTENANCE_ROLE };

describe("WP-10 source worker role boundary", () => {
  it("allows local PostgreSQL without provider memberships", () => {
    expect(assessSourceRoleMemberships([])).toEqual({ valid: true, violations: [] });
  });

  it("allows only the complete PostgreSQL 17 Supabase administration pair", () => {
    expect(assessSourceRoleMemberships([service, maintenance])).toEqual({ valid: true, violations: [] });
  });

  it.each([
    ["reversed", { ...service, grantedRole: "postgres", memberRole: SOURCE_SERVICE_ROLE }],
    ["public role", { ...service, memberRole: "anon" }],
    ["wrong grantor", { ...service, grantorRole: "postgres" }],
    ["unsafe set", { ...service, setOption: true }],
    ["unsafe inherit", { ...service, inheritOption: true }],
  ])("rejects %s membership", (_label, row) => {
    expect(assessSourceRoleMemberships([row, maintenance]).valid).toBe(false);
  });

  it("rejects incomplete, duplicate and extra memberships", () => {
    expect(assessSourceRoleMemberships([service]).valid).toBe(false);
    expect(assessSourceRoleMemberships([service, service, maintenance]).valid).toBe(false);
    expect(assessSourceRoleMemberships([service, maintenance, { ...service, memberRole: "service_role" }]).valid).toBe(false);
  });
});
