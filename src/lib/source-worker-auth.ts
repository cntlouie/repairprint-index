import { timingSafeEqual } from "node:crypto";
import { parseStrongHmacSecret } from "@/domain/hmac-secret";

const SECRET_PATTERN = /^[0-9a-f]{64}$/;

export function parseSourceWorkerSecret(value: string | undefined): string {
  try {
    parseStrongHmacSecret(value);
  } catch {
    throw new Error("SOURCE_LINK_WORKER_SECRET_INVALID");
  }
  return value!;
}

export function authorizeSourceWorker(header: string | null, configuredSecret: string | undefined): boolean {
  let expected: string;
  try {
    expected = parseSourceWorkerSecret(configuredSecret);
  } catch {
    return false;
  }
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice(7);
  if (!SECRET_PATTERN.test(presented)) return false;
  return timingSafeEqual(Buffer.from(presented, "hex"), Buffer.from(expected, "hex"));
}
