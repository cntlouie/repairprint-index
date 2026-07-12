import postgres from "postgres";

import {
  deriveSubmissionHmacKeyCommitment,
  SUBMISSION_HMAC_ALGORITHM_VERSION,
  SUBMISSION_HMAC_KEY_PIN_LOCK_CLASS,
  SUBMISSION_HMAC_KEY_PIN_LOCK_OBJECT,
} from "../src/lib/submission-key-pin";

async function main(): Promise<void> {
  if (process.env.DEMO_MODE !== "false") throw new Error("KEY_PIN_REQUIRES_PRODUCTION_MODE");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  const replace = parseArguments(process.argv.slice(2));
  const keyCommitment = deriveSubmissionHmacKeyCommitment();
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });

  try {
    const outcome = await sql.begin(async (transaction) => {
      const [identity] = await transaction<{ currentUser: string }[]>`
        SELECT current_user AS "currentUser"
      `;
      if (!identity || identity.currentUser === "repairprint_submission_service") {
        throw new Error("KEY_PIN_ADMIN_ROLE_REQUIRED");
      }

      await transaction`
        SELECT pg_catalog.pg_advisory_xact_lock(
          ${SUBMISSION_HMAC_KEY_PIN_LOCK_CLASS},
          ${SUBMISSION_HMAC_KEY_PIN_LOCK_OBJECT}
        )
      `;
      // The pin is table-locked after the exclusive advisory lock so every
      // transactional runtime pin check either
      // finishes before this maintenance decision or observes the new pin.
      // Dependency locks then drain already-verified writes before zero-state
      // is evaluated; no A-derived row can commit after installing key B.
      await transaction`LOCK TABLE public.submission_hmac_key_pin IN ACCESS EXCLUSIVE MODE`;
      await transaction`
        LOCK TABLE
          public.submissions,
          public.submission_idempotency_bindings,
          public.submission_intake_contacts,
          public.submission_email_follow_ups,
          public.submission_rate_limit_buckets
        IN SHARE ROW EXCLUSIVE MODE
      `;
      const [existing] = await transaction<{ hmacVersion: string; keyCommitment: string }[]>`
        SELECT hmac_version AS "hmacVersion", key_commitment AS "keyCommitment"
        FROM public.submission_hmac_key_pin
        WHERE singleton = true
      `;
      if (
        existing?.hmacVersion === SUBMISSION_HMAC_ALGORITHM_VERSION
        && existing.keyCommitment === keyCommitment
      ) {
        return "unchanged" as const;
      }
      if (existing && !replace) throw new Error("KEY_PIN_MISMATCH");

      const [dependencies] = await transaction<{
        contacts: number;
        followUps: number;
        intakes: number;
        rateBuckets: number;
        submissions: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM public.submissions WHERE intake_version = 1) AS submissions,
          (SELECT count(*)::int FROM public.submission_idempotency_bindings) AS intakes,
          (SELECT count(*)::int FROM public.submission_intake_contacts) AS contacts,
          (SELECT count(*)::int FROM public.submission_email_follow_ups) AS "followUps",
          (SELECT count(*)::int FROM public.submission_rate_limit_buckets) AS "rateBuckets"
      `;
      if (!dependencies || Object.values(dependencies).some((count) => count !== 0)) {
        throw new Error("KEY_PIN_RETAINED_DATA");
      }

      if (existing) {
        await transaction`DELETE FROM public.submission_hmac_key_pin WHERE singleton = true`;
      }

      await transaction`
        INSERT INTO public.submission_hmac_key_pin (singleton, hmac_version, key_commitment)
        VALUES (true, ${SUBMISSION_HMAC_ALGORITHM_VERSION}, ${keyCommitment})
      `;
      return existing ? "replaced" as const : "provisioned" as const;
    });
    console.log(JSON.stringify({ code: "SUBMISSION_HMAC_KEY_PIN_READY", outcome }));
  } finally {
    await sql.end();
  }
}

function parseArguments(arguments_: readonly string[]): boolean {
  if (arguments_.length === 0) return false;
  if (arguments_.length === 1 && arguments_[0] === "--replace") return true;
  throw new Error("KEY_PIN_ARGUMENT_INVALID");
}

void main().catch(() => {
  console.error(JSON.stringify({ code: "SUBMISSION_HMAC_KEY_PIN_FAILED" }));
  process.exitCode = 1;
});
