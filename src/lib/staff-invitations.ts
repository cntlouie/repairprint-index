import type { StaffRole } from "@/domain/authorization";

export interface InvitedAuthUser {
  authUserId: string;
  email: string;
  role: StaffRole;
}

export async function inviteSupabaseStaffUser(
  input: { email: string; role: StaffRole; redirectTo: string },
  configuration: {
    supabaseUrl?: string;
    serviceRoleKey?: string;
    fetchImplementation?: typeof fetch;
  } = {},
): Promise<InvitedAuthUser> {
  const supabaseUrl = configuration.supabaseUrl ?? requiredEnvironment("SUPABASE_URL");
  const serviceRoleKey = configuration.serviceRoleKey ?? requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const fetchImplementation = configuration.fetchImplementation ?? fetch;
  const email = input.email.trim().toLocaleLowerCase("en");
  if (!email || !email.includes("@")) throw new Error("INVALID_STAFF_EMAIL");

  const response = await fetchImplementation(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/invite`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      redirect_to: input.redirectTo,
      data: { requested_staff_role: input.role },
    }),
  });

  if (!response.ok) throw new Error(`STAFF_INVITE_FAILED_${response.status}`);
  const body: unknown = await response.json();
  if (!isInvitedUser(body)) throw new Error("STAFF_INVITE_RESPONSE_INVALID");
  return { authUserId: body.id, email, role: input.role };
}

function isInvitedUser(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for staff invitations.`);
  return value;
}
