import { submissions } from "@/db/schema";

export type SubmissionKind = "missing_part" | "fit_confirmation" | "design_submission";

export async function saveSubmission(kind: SubmissionKind, payload: Record<string, unknown>) {
  if (!process.env.DATABASE_URL || process.env.DEMO_MODE !== "false") {
    return { id: `demo-${crypto.randomUUID()}`, persisted: false };
  }

  const { db } = await import("@/db/client");
  const [created] = await db
    .insert(submissions)
    .values({ kind, payload, status: "pending" })
    .returning({ id: submissions.id });

  if (!created) throw new Error("Submission could not be recorded.");
  return { id: created.id, persisted: true };
}
