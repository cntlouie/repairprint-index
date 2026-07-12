import { createHmac, timingSafeEqual } from "node:crypto";

import {
  parseSubmissionHmacSecret,
  SUBMISSION_HMAC_ALGORITHM_VERSION,
  SubmissionIntakeError,
} from "./submission-security";

const KEY_PIN_PURPOSE = "repairprint/submission-hmac-key-pin/v1";
const commitmentPattern = /^[0-9a-f]{64}$/u;

// Stable transaction-advisory namespace shared by runtime writes and the
// owner/admin replacement command. These are coordination identifiers, not
// secrets; shared runtime holders block an exclusive replacement decision.
export const SUBMISSION_HMAC_KEY_PIN_LOCK_CLASS = 1_382_977_105;
export const SUBMISSION_HMAC_KEY_PIN_LOCK_OBJECT = 1;

export type SubmissionHmacKeyPin = Readonly<{
  hmacVersion: string;
  keyCommitment: string;
}>;

/** A purpose-separated commitment; the validated HMAC key itself is never persisted. */
export function deriveSubmissionHmacKeyCommitment(
  secret = process.env.SUBMISSION_HMAC_SECRET,
  hmacVersion = SUBMISSION_HMAC_ALGORITHM_VERSION,
): string {
  const key = parseSubmissionHmacSecret(secret);
  return createHmac("sha256", key)
    .update(`${KEY_PIN_PURPOSE}\0${hmacVersion}`, "utf8")
    .digest("hex");
}

export function assertSubmissionHmacKeyPin(
  pin: SubmissionHmacKeyPin | null | undefined,
  secret = process.env.SUBMISSION_HMAC_SECRET,
): void {
  const expected = deriveSubmissionHmacKeyCommitment(secret);
  if (
    !pin
    || pin.hmacVersion !== SUBMISSION_HMAC_ALGORITHM_VERSION
    || !commitmentPattern.test(pin.keyCommitment)
  ) {
    throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
  }

  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(pin.keyCommitment, "hex");
  if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
  }
}

export { SUBMISSION_HMAC_ALGORITHM_VERSION };
