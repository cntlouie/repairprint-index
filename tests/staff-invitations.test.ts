import { describe, expect, it, vi } from "vitest";
import { inviteSupabaseStaffUser } from "@/lib/staff-invitations";

describe("invite-only staff authentication", () => {
  it("uses only the server-side admin invite endpoint", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: "00000000-0000-4000-8000-000000000301" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const invited = await inviteSupabaseStaffUser({
      email: " Reviewer@Example.invalid ",
      role: "reviewer",
      redirectTo: "https://example.invalid/admin/activate",
    }, {
      supabaseUrl: "https://project.supabase.co/",
      serviceRoleKey: "server-secret-fixture",
      fetchImplementation,
    });

    expect(invited).toEqual({
      authUserId: "00000000-0000-4000-8000-000000000301",
      email: "reviewer@example.invalid",
      role: "reviewer",
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/invite",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
