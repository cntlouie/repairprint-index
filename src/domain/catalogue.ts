export interface SlugRedirectRecord {
  oldPath: string;
  replacementPath: string;
}

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
  const redirects = new Map(records.map((record) => [record.oldPath, record.replacementPath]));
  const visited = new Set<string>([initialPath]);
  let current = initialPath;

  for (let hop = 0; hop < maximumHops; hop += 1) {
    const replacement = redirects.get(current);
    if (!replacement) return current === initialPath ? null : current;
    if (!isSafeInternalPath(replacement) || visited.has(replacement)) return null;
    visited.add(replacement);
    current = replacement;
  }

  return null;
}

function isSafeInternalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("://");
}
