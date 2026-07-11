export const LICENSES = {
  CC0: { commercialUse: true, derivatives: true, shareAlike: false, attribution: false },
  "CC-BY": { commercialUse: true, derivatives: true, shareAlike: false, attribution: true },
  "CC-BY-SA": { commercialUse: true, derivatives: true, shareAlike: true, attribution: true },
  "CC-BY-ND": { commercialUse: true, derivatives: false, shareAlike: false, attribution: true },
  "CC-BY-NC": { commercialUse: false, derivatives: true, shareAlike: false, attribution: true },
  "CC-BY-NC-SA": { commercialUse: false, derivatives: true, shareAlike: true, attribution: true },
  "CC-BY-NC-ND": { commercialUse: false, derivatives: false, shareAlike: false, attribution: true },
  "NOT-STATED": { commercialUse: null, derivatives: null, shareAlike: null, attribution: null },
  CUSTOM: { commercialUse: null, derivatives: null, shareAlike: null, attribution: null },
} as const;

export type LicenseCode = keyof typeof LICENSES;

export function getLicenseCapabilities(code: LicenseCode) {
  return LICENSES[code];
}
