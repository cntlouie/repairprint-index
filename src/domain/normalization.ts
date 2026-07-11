/** Preserve suffix separators and leading zeroes for exact matching. */
export function strictIdentifierKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleUpperCase("en")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, "");
}

/** Remove formatting only for candidate search; a loose key never proves identity. */
export function looseIdentifierKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleUpperCase("en")
    .replace(/[^A-Z0-9]/g, "");
}

/** Backward-compatible loose search key. */
export const normalizeIdentifier = looseIdentifierKey;

export interface IdentifierCandidate {
  entityId: string;
  brandKey: string;
  displayValue: string;
}

export type IdentifierResolution =
  | { kind: "strict_exact" | "loose_unambiguous"; entityId: string; errorCodes: [] }
  | { kind: "ambiguous"; entityIds: string[]; errorCodes: ["FIT-001"] }
  | { kind: "not_found"; entityIds: []; errorCodes: [] };

export function resolveIdentifierWithinBrand(
  query: string,
  brandKey: string,
  candidates: IdentifierCandidate[],
): IdentifierResolution {
  const inBrand = candidates.filter((candidate) => candidate.brandKey === brandKey);
  const strictQuery = strictIdentifierKey(query);
  const strictIds = uniqueSorted(
    inBrand
      .filter((candidate) => strictIdentifierKey(candidate.displayValue) === strictQuery)
      .map((candidate) => candidate.entityId),
  );

  if (strictIds.length === 1) {
    return { kind: "strict_exact", entityId: strictIds[0]!, errorCodes: [] };
  }
  if (strictIds.length > 1) {
    return { kind: "ambiguous", entityIds: strictIds, errorCodes: ["FIT-001"] };
  }

  const looseQuery = looseIdentifierKey(query);
  const looseIds = uniqueSorted(
    inBrand
      .filter((candidate) => looseIdentifierKey(candidate.displayValue) === looseQuery)
      .map((candidate) => candidate.entityId),
  );

  if (looseIds.length === 1) {
    return { kind: "loose_unambiguous", entityId: looseIds[0]!, errorCodes: [] };
  }
  if (looseIds.length > 1) {
    return { kind: "ambiguous", entityIds: looseIds, errorCodes: ["FIT-001"] };
  }
  return { kind: "not_found", entityIds: [], errorCodes: [] };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

export function normalizeSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
