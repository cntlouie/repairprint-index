import { db } from "./client";
import { slugHistory } from "./schema";
import { resolveRedirectChain } from "@/domain/catalogue";

export async function findArchivedRedirect(oldPath: string): Promise<string | null> {
  const redirects = await db
    .select({ oldPath: slugHistory.oldPath, replacementPath: slugHistory.replacementPath })
    .from(slugHistory);
  return resolveRedirectChain(redirects, oldPath);
}
