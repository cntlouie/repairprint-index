import { emptyImportResolutionIndex } from "../src/domain/import-resolution";
import { dryRunCsvImport, exportCandidateRows } from "../src/lib/csv-import";
import { loadImportPack } from "./load-import-pack";

const files = loadImportPack("data/fixtures/phase0-demo");
const first = dryRunCsvImport(files);
if (!first.canCommit || first.counts.insert !== 20 || first.counts.reject !== 0) {
  throw new Error(`Fictional Phase 0 import failed: ${JSON.stringify(first.errors)}`);
}

const roundTrip = dryRunCsvImport(exportCandidateRows(first.rows));
if (!roundTrip.canCommit || roundTrip.rows.length !== 20) throw new Error("Fictional Phase 0 CSV round-trip failed.");

const existing = {
  ...emptyImportResolutionIndex(),
  idempotencyKeys: new Set(first.rows.map((row) => row.idempotencyKey)),
};
const second = dryRunCsvImport(files, existing);
if (second.counts.unchanged !== 20 || second.counts.insert !== 0 || second.counts.reject !== 0) {
  throw new Error("Repeated fictional Phase 0 import was not idempotent.");
}

console.log("Import checks passed: 20 fictional rows round-trip and repeat without duplication.");
