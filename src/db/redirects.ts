import { eq } from "drizzle-orm";

import { db } from "./client";
import { slugHistory } from "./schema";

export async function findArchivedRedirect(oldPath: string): Promise<string | null> {
  const [redirect] = await db
    .select({ replacementPath: slugHistory.replacementPath })
    .from(slugHistory)
    .where(eq(slugHistory.oldPath, oldPath))
    .limit(1);
  return redirect?.replacementPath ?? null;
}
