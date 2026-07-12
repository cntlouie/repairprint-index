import { cleanupExpiredAnonymousSubmissions } from "../src/db/submissions";

const DEFAULT_BATCH_LIMIT = 100;
const MAX_BATCH_LIMIT = 1000;
let closeDatabase: (() => Promise<void>) | undefined;

async function main(): Promise<void> {
  if (process.env.DEMO_MODE !== "false") {
    throw new Error("SUBMISSION_CLEANUP_REQUIRES_PRODUCTION_MODE");
  }

  const batchLimit = parseBatchLimit(process.env.SUBMISSION_CLEANUP_BATCH_SIZE);
  const submissionClient = await import("../src/db/submission-client");
  closeDatabase = submissionClient.closeSubmissionDatabase;
  const result = await cleanupExpiredAnonymousSubmissions(
    await submissionClient.getSubmissionDatabase(),
    new Date(),
    batchLimit,
  );
  console.log(JSON.stringify({
    batchLimit,
    code: "SUBMISSION_RETENTION_CLEANUP_COMPLETE",
    deletedSubmissions: result.deletedSubmissions,
    redactedContacts: result.redactedContacts,
  }));
}

function parseBatchLimit(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_BATCH_LIMIT;
  if (!/^\d+$/.test(value)) throw new Error("SUBMISSION_CLEANUP_BATCH_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_LIMIT) {
    throw new Error("SUBMISSION_CLEANUP_BATCH_INVALID");
  }
  return parsed;
}

void main()
  .catch(() => {
    console.error(JSON.stringify({ code: "SUBMISSION_RETENTION_CLEANUP_FAILED" }));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!closeDatabase) return;
    try {
      await closeDatabase();
    } catch {
      console.error(JSON.stringify({ code: "SUBMISSION_DATABASE_CLOSE_FAILED" }));
      process.exitCode = 1;
    }
  });
