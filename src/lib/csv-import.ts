import { createHash } from "node:crypto";

import {
  collisionKey,
  emptyImportResolutionIndex,
  findSupersessionCycles,
  type ImportCollision,
  type ImportErrorCode,
  type ImportResolutionIndex,
  type ImportRowError,
} from "@/domain/import-resolution";
import { looseIdentifierKey, strictIdentifierKey } from "@/domain/normalization";

export const IMPORT_FILE_NAMES = [
  "product_models.csv",
  "product_identifiers.csv",
  "components.csv",
  "oem_parts.csv",
  "product_components.csv",
  "designs.csv",
  "fitments.csv",
  "fitment_evidence.csv",
] as const;

export type ImportFileName = (typeof IMPORT_FILE_NAMES)[number];
export type ImportFiles = Record<ImportFileName, string>;

interface FileSpec {
  headers: readonly string[];
  keyField: string;
  required: readonly string[];
}

const FILE_SPECS: Record<ImportFileName, FileSpec> = {
  "product_models.csv": {
    headers: ["model_key", "brand_key", "category_key", "public_id", "model_name", "slug", "family_name", "market_codes", "production_start", "production_end", "label_location", "summary", "publication_status", "source_key"],
    keyField: "model_key",
    required: ["model_key", "brand_key", "category_key", "public_id", "model_name", "slug", "market_codes", "publication_status", "source_key"],
  },
  "product_identifiers.csv": {
    headers: ["identifier_key", "model_key", "display_value", "strict_key", "loose_key", "identifier_type", "market_code", "source_key", "source_locator", "review_status"],
    keyField: "identifier_key",
    required: ["identifier_key", "model_key", "display_value", "identifier_type", "source_key", "source_locator", "review_status"],
  },
  "components.csv": {
    headers: ["component_key", "category_key", "parent_component_key", "name", "slug", "common_names", "safety_profile"],
    keyField: "component_key",
    required: ["component_key", "category_key", "name", "slug", "safety_profile"],
  },
  "oem_parts.csv": {
    headers: ["oem_part_key", "public_id", "brand_key", "component_key", "part_number_display", "strict_part_key", "loose_part_key", "name", "alias_or_supersession_keys", "publication_status", "source_key", "source_locator"],
    keyField: "oem_part_key",
    required: ["oem_part_key", "public_id", "brand_key", "component_key", "part_number_display", "name", "publication_status", "source_key", "source_locator"],
  },
  "product_components.csv": {
    headers: ["product_component_key", "model_key", "component_key", "oem_part_key", "market_code", "serial_from", "serial_to", "mapping_status", "source_key", "source_locator"],
    keyField: "product_component_key",
    required: ["product_component_key", "model_key", "component_key", "mapping_status", "source_key", "source_locator"],
  },
  "designs.csv": {
    headers: ["design_key", "public_id", "slug", "creator_name", "creator_platform", "creator_profile_url", "title", "source_platform", "source_external_id", "source_url", "source_revision", "source_hash", "license_code", "license_version", "license_url", "license_evidence_url", "attribution_text", "file_formats", "source_published_at", "source_updated_at", "retrieved_at", "last_checked_at", "rights_checked_at", "rights_checked_by", "publication_status"],
    keyField: "design_key",
    required: ["design_key", "public_id", "slug", "creator_name", "creator_platform", "title", "source_platform", "source_external_id", "source_url", "source_revision", "license_code", "attribution_text", "retrieved_at", "last_checked_at", "rights_checked_at", "rights_checked_by", "publication_status"],
  },
  "fitments.csv": {
    headers: ["fitment_key", "public_id", "slug", "design_key", "source_revision", "product_component_key", "confidence_level", "confidence_score", "confidence_version", "publication_status", "reviewed_by", "reviewed_at"],
    keyField: "fitment_key",
    required: ["fitment_key", "public_id", "slug", "design_key", "source_revision", "product_component_key", "confidence_level", "confidence_score", "confidence_version", "publication_status"],
  },
  "fitment_evidence.csv": {
    headers: ["evidence_key", "fitment_key", "evidence_kind", "outcome", "actor_independence_key", "exact_model", "exact_design_revision", "has_model_label_photo", "has_installed_photo", "measurements_json", "modification_notes", "summary", "observed_at", "source_key", "source_locator", "moderation_status", "reviewed_by", "reviewed_at"],
    keyField: "evidence_key",
    required: ["evidence_key", "fitment_key", "evidence_kind", "summary", "observed_at", "source_key", "source_locator", "moderation_status"],
  },
};

export interface CandidateImportRow {
  file: ImportFileName;
  row: number;
  recordType: string;
  externalKey: string;
  idempotencyKey: string;
  payload: Record<string, string>;
  status: "candidate" | "unchanged" | "rejected" | "ambiguous";
  errors: ImportRowError[];
}

export interface ImportDryRunReport {
  runId: string;
  inputChecksum: string;
  counts: { insert: number; update: number; unchanged: number; reject: number };
  canCommit: boolean;
  rows: CandidateImportRow[];
  errors: ImportRowError[];
  collisions: ImportCollision[];
}

export function checksumImportFiles(files: ImportFiles): string {
  const hash = createHash("sha256");
  for (const file of IMPORT_FILE_NAMES) {
    hash.update(`${file}\0${files[file].replace(/\r\n/g, "\n")}\0`);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function dryRunCsvImport(
  files: ImportFiles,
  existing: ImportResolutionIndex = emptyImportResolutionIndex(),
): ImportDryRunReport {
  const inputChecksum = checksumImportFiles(files);
  const rows: CandidateImportRow[] = [];
  const errors: ImportRowError[] = [];
  const collisions: ImportCollision[] = [];

  for (const file of IMPORT_FILE_NAMES) {
    let parsed: ReturnType<typeof parseCsv>;
    try {
      parsed = parseCsv(files[file]);
    } catch {
      errors.push(error(file, 1, "IMPORT_ROW_MALFORMED", "CSV quoting is malformed."));
      continue;
    }
    const spec = FILE_SPECS[file];
    if (!sameHeaders(parsed.headers, spec.headers)) {
      errors.push(error(file, 1, "IMPORT_HEADER_MISMATCH", `Expected headers: ${spec.headers.join(",")}.`));
      continue;
    }

    parsed.records.forEach((values, index) => {
      const rowNumber = index + 2;
      const payload = Object.fromEntries(spec.headers.map((header, column) => [header, values[column] ?? ""]));
      const rowErrors: ImportRowError[] = [];
      if (values.length !== spec.headers.length) {
        rowErrors.push(error(file, rowNumber, "IMPORT_ROW_MALFORMED", `Expected ${spec.headers.length} columns, found ${values.length}.`));
      }
      for (const field of spec.required) {
        if (!payload[field]?.trim()) rowErrors.push(error(file, rowNumber, missingCode(field), `Required field ${field} is empty.`));
      }
      normalizeKeys(file, payload, rowNumber, rowErrors);
      enforceCandidateAuthority(file, payload, rowNumber, rowErrors);

      const externalKey = payload[spec.keyField]?.trim() ?? "";
      const idempotencyKey = checksumRow(file, externalKey, payload);
      rows.push({
        file,
        row: rowNumber,
        recordType: file.replace(/\.csv$/, ""),
        externalKey,
        idempotencyKey,
        payload,
        status: rowErrors.length ? "rejected" : existing.idempotencyKeys.has(idempotencyKey) ? "unchanged" : "candidate",
        errors: rowErrors,
      });
      errors.push(...rowErrors);
    });
  }

  analyzeReferences(rows, errors);
  analyzeDuplicates(rows, existing, errors, collisions);
  analyzeSupersessions(rows, errors, collisions);

  for (const row of rows) {
    row.errors = errors.filter((candidate) => candidate.file === row.file && candidate.row === row.row);
    if (row.errors.some((candidate) => ["MODEL_AMBIGUOUS", "PART_NUMBER_AMBIGUOUS"].includes(candidate.code))) {
      row.status = "ambiguous";
    } else if (row.errors.length) {
      row.status = "rejected";
    }
  }

  const counts = {
    insert: rows.filter((row) => row.status === "candidate").length,
    update: 0,
    unchanged: rows.filter((row) => row.status === "unchanged").length,
    reject: rows.filter((row) => row.status === "rejected" || row.status === "ambiguous").length,
  };

  return {
    runId: `imp_dry_${inputChecksum.slice(7, 19)}`,
    inputChecksum,
    counts,
    canCommit: errors.length === 0,
    rows,
    errors: stableErrors(errors),
    collisions: stableCollisions(collisions),
  };
}

export function assertImportChecksum(report: ImportDryRunReport, files: ImportFiles, expected: string): void {
  const actual = checksumImportFiles(files);
  if (report.inputChecksum !== expected || actual !== expected) throw new Error("IMPORT_INPUT_CHANGED");
  if (!report.canCommit) throw new Error("IMPORT_COMMIT_BLOCKED");
}

export function exportCandidateRows(rows: readonly CandidateImportRow[]): ImportFiles {
  return Object.fromEntries(
    IMPORT_FILE_NAMES.map((file) => {
      const headers = FILE_SPECS[file].headers;
      const lines = [headers.join(",")];
      for (const row of rows.filter((candidate) => candidate.file === file).sort((a, b) => a.row - b.row)) {
        lines.push(headers.map((header) => csvCell(row.payload[header] ?? "")).join(","));
      }
      return [file, `${lines.join("\n")}\n`];
    }),
  ) as ImportFiles;
}

function analyzeReferences(rows: CandidateImportRow[], errors: ImportRowError[]): void {
  const keys = new Map<string, Set<string>>();
  for (const file of IMPORT_FILE_NAMES) keys.set(file, new Set(rows.filter((row) => row.file === file).map((row) => row.externalKey)));
  const designs = new Set(rows.filter((row) => row.file === "designs.csv").map((row) => `${row.payload.design_key}|${row.payload.source_revision}`));

  const references: Array<[ImportFileName, string, ImportFileName, boolean]> = [
    ["product_identifiers.csv", "model_key", "product_models.csv", false],
    ["oem_parts.csv", "component_key", "components.csv", false],
    ["product_components.csv", "model_key", "product_models.csv", false],
    ["product_components.csv", "component_key", "components.csv", false],
    ["product_components.csv", "oem_part_key", "oem_parts.csv", true],
    ["fitments.csv", "product_component_key", "product_components.csv", false],
    ["fitment_evidence.csv", "fitment_key", "fitments.csv", false],
  ];
  for (const [file, field, target, optional] of references) {
    for (const row of rows.filter((candidate) => candidate.file === file)) {
      const value = row.payload[field] ?? "";
      if ((!value && optional) || keys.get(target)?.has(value)) continue;
      errors.push(error(file, row.row, "REFERENCE_NOT_FOUND", `${field} ${value || "(empty)"} is not present in ${target}.`));
    }
  }
  for (const row of rows.filter((candidate) => candidate.file === "fitments.csv")) {
    const revision = `${row.payload.design_key}|${row.payload.source_revision}`;
    if (!designs.has(revision)) errors.push(error(row.file, row.row, "REVISION_UNKNOWN", `Design revision ${revision} is not in the import pack.`));
  }
}

function analyzeDuplicates(
  rows: CandidateImportRow[],
  existing: ImportResolutionIndex,
  errors: ImportRowError[],
  collisions: ImportCollision[],
): void {
  for (const file of IMPORT_FILE_NAMES) {
    const seen = new Map<string, CandidateImportRow>();
    for (const row of rows.filter((candidate) => candidate.file === file)) {
      const first = seen.get(row.externalKey);
      if (first) errors.push(error(file, row.row, "IMPORT_DUPLICATE_KEY", `${row.externalKey} already appears on row ${first.row}.`));
      else seen.set(row.externalKey, row);
    }
  }

  const modelBrands = new Map(rows.filter((row) => row.file === "product_models.csv").map((row) => [row.externalKey, row.payload.brand_key ?? ""]));
  const modelStrict = cloneIndex(existing.modelStrictKeys);
  const modelLoose = cloneIndex(existing.modelLooseKeys);
  for (const row of rows.filter((candidate) => candidate.file === "product_models.csv")) {
    const brand = normalizeBrandReference(row.payload.brand_key ?? "");
    detectCollision(row, collisionKey(brand, strictIdentifierKey(row.payload.model_name ?? "")), row.externalKey, modelStrict, "MODEL_AMBIGUOUS", "model_ambiguous", errors, collisions);
    detectCollision(row, collisionKey(brand, looseIdentifierKey(row.payload.model_name ?? "")), row.externalKey, modelLoose, "MODEL_AMBIGUOUS", "model_ambiguous", errors, collisions);
  }
  for (const row of rows.filter((candidate) => candidate.file === "product_identifiers.csv")) {
    const brand = normalizeBrandReference(modelBrands.get(row.payload.model_key ?? "") ?? "");
    detectCollision(row, collisionKey(brand, row.payload.strict_key ?? ""), row.payload.model_key ?? "", modelStrict, "MODEL_AMBIGUOUS", "model_ambiguous", errors, collisions);
    detectCollision(row, collisionKey(brand, row.payload.loose_key ?? ""), row.payload.model_key ?? "", modelLoose, "MODEL_AMBIGUOUS", "model_ambiguous", errors, collisions);
  }

  const oemStrict = cloneIndex(existing.oemStrictKeys);
  const oemLoose = cloneIndex(existing.oemLooseKeys);
  for (const row of rows.filter((candidate) => candidate.file === "oem_parts.csv")) {
    const brand = normalizeBrandReference(row.payload.brand_key ?? "");
    detectCollision(row, collisionKey(brand, row.payload.strict_part_key ?? ""), row.externalKey, oemStrict, "PART_NUMBER_AMBIGUOUS", "part_number_ambiguous", errors, collisions);
    detectCollision(row, collisionKey(brand, row.payload.loose_part_key ?? ""), row.externalKey, oemLoose, "PART_NUMBER_AMBIGUOUS", "part_number_ambiguous", errors, collisions);
  }

  const revisions = cloneIndex(existing.designRevisionKeys);
  for (const row of rows.filter((candidate) => candidate.file === "designs.csv")) {
    const key = collisionKey(row.payload.source_url ?? "", row.payload.source_revision ?? "");
    detectCollision(row, key, row.externalKey, revisions, "DUPLICATE_EXTERNAL_ITEM", "duplicate_external_item", errors, collisions);
  }
}

function analyzeSupersessions(rows: CandidateImportRow[], errors: ImportRowError[], collisions: ImportCollision[]): void {
  const graph = new Map<string, string[]>();
  const byKey = new Map(rows.filter((row) => row.file === "oem_parts.csv").map((row) => [row.externalKey, row]));
  for (const row of byKey.values()) {
    const targets = (row.payload.alias_or_supersession_keys ?? "")
      .split("|")
      .map((value) => value.trim())
      .filter((value) => value.startsWith("superseded_by:"))
      .map((value) => value.slice("superseded_by:".length));
    graph.set(row.externalKey, targets);
  }
  for (const cycle of findSupersessionCycles(graph)) {
    for (const key of new Set(cycle.slice(0, -1))) {
      const row = byKey.get(key);
      if (!row) continue;
      errors.push(error(row.file, row.row, "SUPERSESSION_CYCLE", `Supersession cycle: ${cycle.join(" -> ")}.`));
      collisions.push({ file: row.file, row: row.row, type: "supersession_cycle", collisionKey: key, conflictingKeys: cycle });
    }
  }
}

function detectCollision(
  row: CandidateImportRow,
  key: string,
  entityKey: string,
  index: Map<string, string[]>,
  code: ImportErrorCode,
  type: ImportCollision["type"],
  errors: ImportRowError[],
  collisions: ImportCollision[],
): void {
  const existing = index.get(key) ?? [];
  const conflicts = [...new Set(existing.filter((candidate) => candidate !== entityKey))].sort();
  if (conflicts.length) {
    errors.push(error(row.file, row.row, code, `${key} also resolves to ${conflicts.join(", ")}.`));
    collisions.push({ file: row.file, row: row.row, type, collisionKey: key, conflictingKeys: conflicts });
  }
  index.set(key, [...new Set([...existing, entityKey])]);
}

function normalizeKeys(file: ImportFileName, payload: Record<string, string>, row: number, errors: ImportRowError[]): void {
  if (file === "product_identifiers.csv") {
    const strict = strictIdentifierKey(payload.display_value ?? "");
    const loose = looseIdentifierKey(payload.display_value ?? "");
    if (payload.strict_key && payload.strict_key !== strict) errors.push(error(file, row, "IDENTIFIER_KEY_MISMATCH", `strict_key must be ${strict}.`));
    if (payload.loose_key && payload.loose_key !== loose) errors.push(error(file, row, "IDENTIFIER_KEY_MISMATCH", `loose_key must be ${loose}.`));
    payload.strict_key = strict;
    payload.loose_key = loose;
  }
  if (file === "oem_parts.csv") {
    const strict = strictIdentifierKey(payload.part_number_display ?? "");
    const loose = looseIdentifierKey(payload.part_number_display ?? "");
    if (payload.strict_part_key && payload.strict_part_key !== strict) errors.push(error(file, row, "IDENTIFIER_KEY_MISMATCH", `strict_part_key must be ${strict}.`));
    if (payload.loose_part_key && payload.loose_part_key !== loose) errors.push(error(file, row, "IDENTIFIER_KEY_MISMATCH", `loose_part_key must be ${loose}.`));
    payload.strict_part_key = strict;
    payload.loose_part_key = loose;
  }
}

function enforceCandidateAuthority(file: ImportFileName, payload: Record<string, string>, row: number, errors: ImportRowError[]): void {
  const publication = payload.publication_status;
  if (publication && publication !== "draft") errors.push(error(file, row, "IMPORT_AUTHORITY_EXCEEDED", "Imported records must remain draft candidates."));
  if (file === "fitments.csv" && (payload.confidence_level !== "candidate_match" || payload.reviewed_by || payload.reviewed_at)) {
    errors.push(error(file, row, "IMPORT_AUTHORITY_EXCEEDED", "Imported fitment rows cannot carry verification or review authority."));
  }
  if (file === "fitment_evidence.csv" && (payload.moderation_status !== "pending" || payload.reviewed_by || payload.reviewed_at)) {
    errors.push(error(file, row, "IMPORT_AUTHORITY_EXCEEDED", "Imported evidence must enter pending moderation."));
  }
}

function parseCsv(input: string): { headers: string[]; records: string[][] } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (quoted) {
      if (character === '"' && normalized[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n") {
      record.push(field);
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("IMPORT_ROW_MALFORMED");
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  return { headers: records.shift() ?? [], records };
}

function missingCode(field: string): ImportErrorCode {
  if (["source_key", "source_locator", "source_url", "retrieved_at", "last_checked_at", "rights_checked_at", "rights_checked_by"].includes(field)) return "MISSING_PROVENANCE";
  if (field === "license_code") return "LICENSE_NOT_RECORDED";
  return "IMPORT_ROW_MALFORMED";
}

function checksumRow(file: string, externalKey: string, payload: Record<string, string>): string {
  const canonical = Object.keys(payload).sort().map((key) => `${key}\0${payload[key] ?? ""}`).join("\0");
  return `sha256:${createHash("sha256").update(`${file}\0${externalKey}\0${canonical}`).digest("hex")}`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function sameHeaders(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((header, index) => header === expected[index]);
}

function cloneIndex(source: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  return new Map([...source].map(([key, values]) => [key, [...values]]));
}

function normalizeBrandReference(value: string): string {
  return value.trim().replace(/^brand-/i, "");
}

function error(file: string, row: number, code: ImportErrorCode, detail: string): ImportRowError {
  return { file, row, code, detail };
}

function stableErrors(errors: ImportRowError[]): ImportRowError[] {
  return [...errors].sort((a, b) => a.file.localeCompare(b.file) || a.row - b.row || a.code.localeCompare(b.code));
}

function stableCollisions(collisions: ImportCollision[]): ImportCollision[] {
  const unique = new Map(collisions.map((collision) => [`${collision.file}:${collision.row}:${collision.type}:${collision.collisionKey}`, collision]));
  return [...unique.values()].sort((a, b) => a.file.localeCompare(b.file) || a.row - b.row || a.type.localeCompare(b.type));
}
