export const IMPORT_ERROR_CODES = [
  "IMPORT_FILE_MISSING",
  "IMPORT_FILE_UNSUPPORTED",
  "IMPORT_HEADER_MISMATCH",
  "IMPORT_ROW_MALFORMED",
  "IMPORT_DUPLICATE_KEY",
  "IMPORT_AUTHORITY_EXCEEDED",
  "IMPORT_INPUT_CHANGED",
  "IMPORT_DRY_RUN_REQUIRED",
  "IMPORT_COMMIT_BLOCKED",
  "MISSING_PROVENANCE",
  "LICENSE_NOT_RECORDED",
  "DUPLICATE_EXTERNAL_ITEM",
  "MODEL_AMBIGUOUS",
  "PART_NUMBER_AMBIGUOUS",
  "REVISION_UNKNOWN",
  "REFERENCE_NOT_FOUND",
  "IDENTIFIER_KEY_MISMATCH",
  "SUPERSESSION_CYCLE",
] as const;

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

export interface ImportRowError {
  file: string;
  row: number;
  code: ImportErrorCode;
  detail: string;
}

export type ImportCollisionType =
  | "duplicate_external_item"
  | "model_ambiguous"
  | "part_number_ambiguous"
  | "supersession_cycle";

export interface ImportCollision {
  file: string;
  row: number;
  type: ImportCollisionType;
  collisionKey: string;
  conflictingKeys: string[];
}

export interface ImportResolutionIndex {
  idempotencyKeys: ReadonlySet<string>;
  designRevisionKeys: ReadonlyMap<string, readonly string[]>;
  modelStrictKeys: ReadonlyMap<string, readonly string[]>;
  modelLooseKeys: ReadonlyMap<string, readonly string[]>;
  oemStrictKeys: ReadonlyMap<string, readonly string[]>;
  oemLooseKeys: ReadonlyMap<string, readonly string[]>;
}

export function emptyImportResolutionIndex(): ImportResolutionIndex {
  return {
    idempotencyKeys: new Set(),
    designRevisionKeys: new Map(),
    modelStrictKeys: new Map(),
    modelLooseKeys: new Map(),
    oemStrictKeys: new Map(),
    oemLooseKeys: new Map(),
  };
}

export function collisionKey(...parts: string[]): string {
  return parts.map((part) => part.trim().toLocaleUpperCase("en")).join("|");
}

export function findSupersessionCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  function visit(node: string): void {
    if (active.has(node)) {
      const start = path.indexOf(node);
      const cycle = [...path.slice(start), node];
      const signature = canonicalCycle(cycle);
      if (!cycles.some((candidate) => canonicalCycle(candidate) === signature)) cycles.push(cycle);
      return;
    }
    if (visited.has(node)) return;

    active.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    path.pop();
    active.delete(node);
    visited.add(node);
  }

  for (const node of [...edges.keys()].sort()) visit(node);
  return cycles;
}

function canonicalCycle(cycle: readonly string[]): string {
  const nodes = cycle.slice(0, -1);
  if (nodes.length === 0) return "";
  const rotations = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)].join("->"));
  return rotations.sort()[0] ?? "";
}
