export interface SlugRedirectRecord {
  oldPath: string;
  replacementPath: string;
}

const CATALOGUE_PART_PATH = /^\/parts\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const NON_ASCII_CHARACTER = /[^\u0020-\u007e]/;
const INVALID_PERCENT_ENCODING = /%(?![0-9a-fA-F]{2})/;

/**
 * Resolves stored redirect chains before issuing an HTTP redirect, so a
 * historical URL reaches its final destination in one response. Cycles,
 * external targets, and unreasonable chains fail closed.
 */
export function resolveRedirectChain(
  records: readonly SlugRedirectRecord[],
  initialPath: string,
  maximumHops = 20,
): string | null {
  const normalizedInitialPath = normalizeCataloguePath(initialPath);
  if (!normalizedInitialPath || maximumHops < 1) return null;

  const redirects = normalizedRedirects(records);
  const visited = new Set<string>([normalizedInitialPath]);
  let current = normalizedInitialPath;

  for (let hop = 0; hop < maximumHops; hop += 1) {
    const replacement = redirects.get(current);
    if (replacement === undefined) return current === normalizedInitialPath ? null : current;
    if (replacement === null || visited.has(replacement)) return null;
    visited.add(replacement);
    current = replacement;
  }

  return null;
}

/**
 * Stored slug-history values are untrusted. Normalize only exact public part
 * routes, and reject inputs whose decoded form can change path structure.
 */
function normalizeCataloguePath(path: string): string | null {
  if (
    path.length === 0
    || CONTROL_CHARACTER.test(path)
    || NON_ASCII_CHARACTER.test(path)
    || path.includes("?")
    || path.includes("#")
    || path.includes("\\")
    || INVALID_PERCENT_ENCODING.test(path)
  ) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }

  if (
    CONTROL_CHARACTER.test(decoded)
    || NON_ASCII_CHARACTER.test(decoded)
    || decoded.includes("?")
    || decoded.includes("#")
    || decoded.includes("\\")
    // A remaining percent sign is either double encoding or a character that
    // cannot occur in a canonical RepairPrint slug.
    || decoded.includes("%")
    || !CATALOGUE_PART_PATH.test(decoded)
  ) return null;

  return decoded;
}

function normalizedRedirects(records: readonly SlugRedirectRecord[]): Map<string, string | null> {
  const redirects = new Map<string, string | null>();

  for (const record of records) {
    const oldPath = normalizeCataloguePath(record.oldPath);
    if (!oldPath) continue;

    const replacementPath = normalizeCataloguePath(record.replacementPath);
    const existing = redirects.get(oldPath);

    // Conflicting records that normalize to the same source path are
    // ambiguous. Mark them invalid instead of depending on row order.
    if (existing !== undefined && existing !== replacementPath) redirects.set(oldPath, null);
    else redirects.set(oldPath, replacementPath);
  }

  return redirects;
}
