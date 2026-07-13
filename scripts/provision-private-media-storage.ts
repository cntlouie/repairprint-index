import { createClient } from "@supabase/supabase-js";

import { PRIVATE_MEDIA_LIMITS, PRIVATE_MEDIA_MIME_TYPES } from "../src/domain/private-media";
import { resolvePrivateMediaConfig } from "../src/lib/private-media-config";

const apply = process.argv.includes("--apply");
const config = resolvePrivateMediaConfig();
if (process.env.DEMO_MODE !== "false") throw new Error("MEDIA_STORAGE_PROVISIONING_REFUSES_DEMO_MODE");
const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

for (const bucket of [config.quarantineBucket, config.privateBucket]) {
  const { data, error } = await client.storage.getBucket(bucket);
  if (error && !apply) throw new Error(`MEDIA_BUCKET_MISSING:${bucket}`);
  if (error && apply) {
    const created = await client.storage.createBucket(bucket, { public: false, fileSizeLimit: PRIVATE_MEDIA_LIMITS.maxBytes, allowedMimeTypes: [...PRIVATE_MEDIA_MIME_TYPES] });
    if (created.error) throw new Error(`MEDIA_BUCKET_CREATE_FAILED:${bucket}`);
  } else if (data && (data.public || data.file_size_limit !== PRIVATE_MEDIA_LIMITS.maxBytes
    || [...PRIVATE_MEDIA_MIME_TYPES].some((mime) => !data.allowed_mime_types?.includes(mime)))) {
    if (!apply) throw new Error(`MEDIA_BUCKET_POLICY_INVALID:${bucket}`);
    const updated = await client.storage.updateBucket(bucket, { public: false, fileSizeLimit: PRIVATE_MEDIA_LIMITS.maxBytes, allowedMimeTypes: [...PRIVATE_MEDIA_MIME_TYPES] });
    if (updated.error) throw new Error(`MEDIA_BUCKET_UPDATE_FAILED:${bucket}`);
  }
}
console.log(JSON.stringify({ checked: 2, mode: apply ? "apply" : "check", private: true }));
