import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { getSubmissionDatabase, closeSubmissionDatabase } from "../src/db/submission-client";
import { resolvePrivateMediaConfig } from "../src/lib/private-media-config";
import { createPrivateMediaStorage } from "../src/lib/private-media-storage";

const limit = Number(process.env.MEDIA_CLEANUP_BATCH_SIZE || "100");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("MEDIA_CLEANUP_BATCH_INVALID");
const config = resolvePrivateMediaConfig();
const database = await getSubmissionDatabase();
const leaseToken = randomUUID();
try {
  const quarantineLease = randomUUID();
  const quarantineOnly = await database.execute<{ sessionId: string; quarantineObjectPath: string }>(sql`
    SELECT session_id AS "sessionId", quarantine_object_path AS "quarantineObjectPath"
    FROM public.claim_private_media_quarantine_cleanup(${limit}, ${quarantineLease})
  `);
  if (quarantineOnly.length > 0) {
    const storage = createPrivateMediaStorage(config);
    for (const row of quarantineOnly) await storage.remove(config.quarantineBucket, [row.quarantineObjectPath]);
    const quarantineIds = quarantineOnly.map((row) => row.sessionId);
    await database.execute(sql`SELECT public.complete_private_media_quarantine_cleanup(${quarantineLease}, ${quarantineIds}::uuid[])`);
  }
  const claimed = await database.execute<{ sessionId: string; quarantineObjectPath: string; privateObjectPaths: string[] }>(sql`
    SELECT session_id AS "sessionId", quarantine_object_path AS "quarantineObjectPath", private_object_paths AS "privateObjectPaths"
    FROM public.claim_expired_private_media(${limit}, ${leaseToken})
  `);
  if (claimed.length === 0) { console.log(JSON.stringify({ quarantineRecovered: quarantineOnly.length, claimed: 0, deleted: 0 })); process.exitCode = 0; }
  else {
    const storage = createPrivateMediaStorage(config);
    for (const row of claimed) {
      await storage.remove(config.quarantineBucket, [row.quarantineObjectPath]);
      await storage.remove(config.privateBucket, row.privateObjectPaths);
    }
    const ids = claimed.map((row) => row.sessionId);
    const completed = await database.execute<{ deletedSessions: number }>(sql`
      SELECT deleted_sessions::int AS "deletedSessions" FROM public.complete_private_media_cleanup(${leaseToken}, ${ids}::uuid[])
    `);
    console.log(JSON.stringify({ quarantineRecovered: quarantineOnly.length, claimed: claimed.length, deleted: completed[0]?.deletedSessions ?? 0 }));
  }
} finally { await closeSubmissionDatabase(); }
