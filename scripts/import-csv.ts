import { resolve } from "node:path";

import { closeDatabase, db } from "../src/db/client";
import { commitCandidateImport, prepareCandidateImport, queueCandidateImportReview } from "../src/db/imports";
import { loadImportPack } from "./load-import-pack";

interface Arguments {
  directory: string;
  commit: boolean;
  queueReview: boolean;
  expectedChecksum?: string;
  actorId?: string;
  reason?: string;
  requestId?: string;
}

function parseArguments(values: string[]): Arguments {
  const value = (flag: string): string | undefined => {
    const index = values.indexOf(flag);
    return index >= 0 ? values[index + 1] : undefined;
  };
  return {
    directory: resolve(value("--dir") ?? "data/fixtures/phase0-demo"),
    commit: values.includes("--commit"),
    queueReview: values.includes("--queue-review"),
    expectedChecksum: value("--expected-checksum"),
    actorId: value("--actor-id"),
    reason: value("--reason"),
    requestId: value("--request-id"),
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const files = loadImportPack(options.directory);
  if (!options.commit && !options.queueReview) {
    console.log(JSON.stringify(await prepareCandidateImport(db, files), null, 2));
    return;
  }
  if (!options.expectedChecksum) throw new Error("IMPORT_DRY_RUN_REQUIRED");
  if (!options.actorId) throw new Error("IMPORT_ACTOR_REQUIRED");
  if (!options.reason) throw new Error("AUDIT_REASON_REQUIRED");
  if (!options.requestId) throw new Error("AUDIT_REQUEST_ID_REQUIRED");

  const operation = options.queueReview ? queueCandidateImportReview : commitCandidateImport;
  const result = await operation(db, {
    files,
    expectedInputChecksum: options.expectedChecksum,
    actorId: options.actorId,
    reason: options.reason,
    requestId: options.requestId,
  });
  console.log(JSON.stringify(result, null, 2));
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
