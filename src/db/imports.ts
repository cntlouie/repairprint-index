import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { collisionKey, type ImportResolutionIndex } from "@/domain/import-resolution";
import {
  assertImportChecksum,
  checksumImportFiles,
  dryRunCsvImport,
  type ImportDryRunReport,
  type ImportFiles,
} from "@/lib/csv-import";
import { writeAuditEvent } from "./audit";
import {
  brands,
  designRevisions,
  designs,
  importRows,
  importRuns,
  oemParts,
  productIdentifiers,
  productModels,
  sources,
} from "./schema";
import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

export interface CommitCandidateImportInput {
  files: ImportFiles;
  expectedInputChecksum: string;
  actorId: string;
  reason: string;
  requestId: string;
  manifestChecksum?: string;
}

export interface CommitCandidateImportResult {
  runId: string;
  report: ImportDryRunReport;
  reused: boolean;
}

export async function prepareCandidateImport(
  database: Database,
  files: ImportFiles,
): Promise<ImportDryRunReport> {
  return dryRunCsvImport(files, await loadImportResolutionIndex(database));
}

export async function commitCandidateImport(
  database: Database,
  input: CommitCandidateImportInput,
): Promise<CommitCandidateImportResult> {
  const reason = input.reason.trim();
  const requestId = input.requestId.trim();
  if (!reason) throw new Error("AUDIT_REASON_REQUIRED");
  if (!requestId) throw new Error("AUDIT_REQUEST_ID_REQUIRED");

  const report = await prepareCandidateImport(database, input.files);
  assertImportChecksum(report, input.files, input.expectedInputChecksum);

  return database.transaction(async (transaction) => {
    const [existing] = await transaction
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(eq(importRuns.inputChecksum, report.inputChecksum))
      .limit(1);
    if (existing) return { runId: existing.id, report, reused: true };

    const [run] = await transaction
      .insert(importRuns)
      .values({
        publicId: `imp_${report.inputChecksum.slice(7, 27)}`,
        actorId: input.actorId,
        inputChecksum: report.inputChecksum,
        manifestChecksum: input.manifestChecksum,
        status: "committed",
        report: storedReport(report),
        reason,
        requestId,
        committedAt: new Date(),
      })
      .returning({ id: importRuns.id });
    if (!run) throw new Error("IMPORT_RUN_WRITE_FAILED");

    const candidates = report.rows.filter((row) => row.status === "candidate");
    if (candidates.length) {
      await transaction.insert(importRows).values(
        candidates.map((row) => ({
          importRunId: run.id,
          fileName: row.file,
          rowNumber: row.row,
          recordType: row.recordType,
          externalKey: row.externalKey,
          idempotencyKey: row.idempotencyKey,
          payload: row.payload,
          status: "candidate" as const,
          errorCodes: [],
        })),
      );
    }

    await writeAuditEvent(
      {
        actorId: input.actorId,
        action: "import.candidates.commit",
        entityType: "import_run",
        entityId: run.id,
        before: null,
        after: storedReport(report),
        reason,
        requestId,
      },
      transaction,
    );

    return { runId: run.id, report, reused: false };
  });
}

export async function queueCandidateImportReview(
  database: Database,
  input: CommitCandidateImportInput,
): Promise<CommitCandidateImportResult> {
  const reason = input.reason.trim();
  const requestId = input.requestId.trim();
  if (!reason) throw new Error("AUDIT_REASON_REQUIRED");
  if (!requestId) throw new Error("AUDIT_REQUEST_ID_REQUIRED");

  const report = await prepareCandidateImport(database, input.files);
  if (report.inputChecksum !== input.expectedInputChecksum || checksumImportFiles(input.files) !== input.expectedInputChecksum) {
    throw new Error("IMPORT_INPUT_CHANGED");
  }
  if (report.canCommit) throw new Error("IMPORT_REVIEW_QUEUE_NOT_REQUIRED");

  return database.transaction(async (transaction) => {
    const [existing] = await transaction
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(eq(importRuns.inputChecksum, report.inputChecksum))
      .limit(1);
    if (existing) return { runId: existing.id, report, reused: true };

    const [run] = await transaction
      .insert(importRuns)
      .values({
        publicId: `imp_${report.inputChecksum.slice(7, 27)}`,
        actorId: input.actorId,
        inputChecksum: report.inputChecksum,
        manifestChecksum: input.manifestChecksum,
        status: "failed",
        report: storedReport(report),
        reason,
        requestId,
      })
      .returning({ id: importRuns.id });
    if (!run) throw new Error("IMPORT_RUN_WRITE_FAILED");

    const rejected = report.rows.filter((row) => row.status === "ambiguous" || row.status === "rejected");
    const written = rejected.length
      ? await transaction
          .insert(importRows)
          .values(
            rejected.map((row) => ({
              importRunId: run.id,
              fileName: row.file,
              rowNumber: row.row,
              recordType: row.recordType,
              externalKey: row.externalKey,
              idempotencyKey: row.idempotencyKey,
              payload: row.payload,
              status: row.status,
              errorCodes: row.errors.map((entry) => entry.code),
            })),
          )
          .returning({ id: importRows.id, fileName: importRows.fileName, rowNumber: importRows.rowNumber })
      : [];
    const rowIds = new Map(written.map((row) => [`${row.fileName}:${row.rowNumber}`, row.id]));
    const queueEntries = report.collisions.flatMap((collision) => {
      const importRowId = rowIds.get(`${collision.file}:${collision.row}`);
      return importRowId
        ? [{
            importRunId: run.id,
            importRowId,
            collisionType: collision.type,
            collisionKey: collision.collisionKey,
            conflictingKeys: collision.conflictingKeys,
          }]
        : [];
    });
    if (queueEntries.length) await transaction.insert(schema.importCollisions).values(queueEntries);

    await writeAuditEvent(
      {
        actorId: input.actorId,
        action: "import.review_queue.create",
        entityType: "import_run",
        entityId: run.id,
        before: null,
        after: storedReport(report),
        reason,
        requestId,
      },
      transaction,
    );
    return { runId: run.id, report, reused: false };
  });
}

async function loadImportResolutionIndex(database: Database): Promise<ImportResolutionIndex> {
  const [imported, revisions, models, parts] = await Promise.all([
    database.select({ key: importRows.idempotencyKey }).from(importRows),
    database
      .select({ url: sources.canonicalUrl, revision: designRevisions.sourceRevision, entity: designs.publicId })
      .from(designRevisions)
      .innerJoin(sources, eq(designRevisions.sourceId, sources.id))
      .innerJoin(designs, eq(designRevisions.designId, designs.id)),
    database
      .select({ brand: brands.slug, strict: productIdentifiers.strictKey, loose: productIdentifiers.looseKey, entity: productModels.publicId })
      .from(productIdentifiers)
      .innerJoin(productModels, eq(productIdentifiers.productModelId, productModels.id))
      .innerJoin(brands, eq(productModels.brandId, brands.id)),
    database
      .select({ brand: brands.slug, strict: oemParts.strictPartKey, loose: oemParts.loosePartKey, entity: oemParts.publicId })
      .from(oemParts)
      .innerJoin(brands, eq(oemParts.brandId, brands.id)),
  ]);

  return {
    idempotencyKeys: new Set(imported.map((row) => row.key)),
    designRevisionKeys: group(revisions.map((row) => [collisionKey(row.url, row.revision), row.entity])),
    modelStrictKeys: group(models.map((row) => [collisionKey(row.brand, row.strict), row.entity])),
    modelLooseKeys: group(models.map((row) => [collisionKey(row.brand, row.loose), row.entity])),
    oemStrictKeys: group(parts.map((row) => [collisionKey(row.brand, row.strict), row.entity])),
    oemLooseKeys: group(parts.map((row) => [collisionKey(row.brand, row.loose), row.entity])),
  };
}

function group(entries: Array<[string, string]>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [key, entity] of entries) result.set(key, [...new Set([...(result.get(key) ?? []), entity])]);
  return result;
}

function storedReport(report: ImportDryRunReport): Record<string, unknown> {
  return {
    runId: report.runId,
    inputChecksum: report.inputChecksum,
    counts: report.counts,
    canCommit: report.canCommit,
    errors: report.errors,
    collisions: report.collisions,
  };
}
