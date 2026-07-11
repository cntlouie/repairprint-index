/** Preserve leading zeros while removing formatting variation from model/OEM identifiers. */
export function normalizeIdentifier(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleUpperCase("en")
    .replace(/[^A-Z0-9]/g, "");
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
