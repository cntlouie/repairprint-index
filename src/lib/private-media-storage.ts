import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { PRIVATE_MEDIA_LIMITS } from "@/domain/private-media";
import type { PrivateMediaConfig } from "./private-media-config";

export type PrivateMediaStorage = Readonly<{
  download: (bucket: string, path: string) => Promise<Uint8Array>;
  remove: (bucket: string, paths: readonly string[]) => Promise<void>;
  upload: (bucket: string, path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
}>;

export function createPrivateMediaStorage(config: PrivateMediaConfig): PrivateMediaStorage {
  void config;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || process.env.DEMO_MODE !== "false") throw new Error("MEDIA_STORAGE_UNAVAILABLE");
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return storageFromClient(client);
}

function storageFromClient(client: SupabaseClient): PrivateMediaStorage {
  return Object.freeze({
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data) throw new Error("MEDIA_STORAGE_READ_FAILED");
      if (data.size > PRIVATE_MEDIA_LIMITS.maxBytes) throw new Error("MEDIA_SIZE_INVALID");
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(bucket, paths) {
      if (paths.length === 0) return;
      const { error } = await client.storage.from(bucket).remove([...paths]);
      if (error) throw new Error("MEDIA_STORAGE_DELETE_FAILED");
    },
    async upload(bucket, path, bytes, contentType) {
      const { error } = await client.storage.from(bucket).upload(path, bytes, { contentType, upsert: false });
      if (error) throw new Error(error.message.includes("already exists") ? "MEDIA_OBJECT_EXISTS" : "MEDIA_STORAGE_WRITE_FAILED");
    },
  });
}
