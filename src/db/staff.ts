import { eq } from "drizzle-orm";
import type { StaffIdentity } from "@/domain/authorization";
import { db } from "./client";
import { staffProfiles } from "./schema";

export async function findStaffByAuthUserId(authUserId: string): Promise<StaffIdentity | null> {
  const [profile] = await db
    .select({
      id: staffProfiles.id,
      authUserId: staffProfiles.authUserId,
      email: staffProfiles.email,
      role: staffProfiles.role,
      status: staffProfiles.status,
    })
    .from(staffProfiles)
    .where(eq(staffProfiles.authUserId, authUserId))
    .limit(1);
  return profile ?? null;
}
