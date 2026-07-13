import "server-only";

export type PrivateMediaConfig = Readonly<{
  capabilitySecret: string;
  privateBucket: string;
  privacyVersion: string;
  quarantineBucket: string;
  retentionDays: number;
  retentionVersion: string;
  termsVersion: string;
}>;

export function resolvePrivateMediaConfig(environment: NodeJS.ProcessEnv = process.env): PrivateMediaConfig {
  const demo = environment.DEMO_MODE !== "false";
  const values = {
    capabilitySecret: environment.MEDIA_CAPABILITY_SECRET || (demo ? "d".repeat(64) : ""),
    privateBucket: environment.MEDIA_PRIVATE_BUCKET || (demo ? "repairprint-demo-private" : ""),
    privacyVersion: environment.MEDIA_PRIVACY_VERSION || (demo ? "wp09-demo-privacy-v1" : ""),
    quarantineBucket: environment.MEDIA_QUARANTINE_BUCKET || (demo ? "repairprint-demo-quarantine" : ""),
    retentionDays: readDays(environment.MEDIA_RETENTION_DAYS, demo ? 7 : undefined),
    retentionVersion: environment.MEDIA_RETENTION_POLICY_VERSION || (demo ? "wp09-demo-retention-v1" : ""),
    termsVersion: environment.MEDIA_TERMS_VERSION || (demo ? "wp09-demo-terms-v1" : ""),
  };
  if (!/^[0-9a-f]{64,}$/i.test(values.capabilitySecret)
    || !validBucket(values.privateBucket) || !validBucket(values.quarantineBucket)
    || values.privateBucket === values.quarantineBucket || !values.retentionDays
    || ![values.privacyVersion, values.retentionVersion, values.termsVersion].every(validVersion)
    || (!demo && (!environment.SUPABASE_URL || !environment.SUPABASE_SERVICE_ROLE_KEY))) {
    throw new Error("MEDIA_UNAVAILABLE");
  }
  return Object.freeze(values as PrivateMediaConfig);
}

function readDays(value: string | undefined, fallback: number | undefined): number | undefined {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : undefined;
}
function validBucket(value: string): boolean { return /^[a-z0-9][a-z0-9._-]{2,62}$/.test(value); }
function validVersion(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value); }
