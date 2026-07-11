export type PublicRecordStatus = "draft" | "in_review" | "published" | "needs_review" | "archived";

export function anonymousCanRead(status: PublicRecordStatus): boolean {
  return status === "published";
}
