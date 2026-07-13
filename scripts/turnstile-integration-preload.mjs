const siteverifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const testSecret = "1x0000000000000000000000000000000AA";
const allowedActions = new Set(["missing_part", "fit_confirmation", "design_submission"]);

assertIntegrationProcess();

const originalFetch = globalThis.fetch;
const usedTokens = new Set();

globalThis.fetch = async (input, init) => {
  const target = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  if (target !== siteverifyUrl) return originalFetch(input, init);

  const parameters = bodyParameters(init?.body);
  const token = parameters.get("response") ?? "";
  const secret = parameters.get("secret") ?? "";
  const remoteIp = parameters.get("remoteip") ?? "";
  const verificationId = parameters.get("idempotency_key") ?? "";
  const parsed = parseIntegrationToken(token);
  const allowedRemoteIp = /^203\.0\.113\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(remoteIp)
    || remoteIp === "2001:db8::1";
  const valid = secret === testSecret
    && allowedRemoteIp
    && /^[0-9a-f-]{36}$/.test(verificationId)
    && parsed !== null
    && !usedTokens.has(token);

  if (valid) usedTokens.add(token);
  return Response.json(valid ? {
    action: parsed.action,
    challenge_ts: new Date().toISOString(),
    "error-codes": [],
    hostname: "127.0.0.1",
    success: true,
  } : {
    "error-codes": [usedTokens.has(token) ? "timeout-or-duplicate" : "invalid-input-response"],
    success: false,
  });
};

function assertIntegrationProcess() {
  const site = safeUrl(process.env.NEXT_PUBLIC_SITE_URL);
  const database = safeUrl(process.env.SUBMISSION_DATABASE_URL);
  const testDatabase = safeUrl(process.env.DATABASE_TEST_URL);
  const nonce = process.env.REPAIRPRINT_HTTP_TEST_NONCE ?? "";
  const safeDatabase = database
    && testDatabase
    && (database.protocol === "postgres:" || database.protocol === "postgresql:")
    && (testDatabase.protocol === "postgres:" || testDatabase.protocol === "postgresql:")
    && database.username === "repairprint_submission_service"
    && database.hostname === testDatabase.hostname
    && database.port === testDatabase.port
    && database.pathname === "/repairprint_test"
    && testDatabase.pathname === "/repairprint_test";

  if (
    process.env.CI !== "true"
    || process.env.NODE_ENV !== "production"
    || process.env.VERCEL !== "1"
    || process.env.VERCEL_ENV !== "production"
    || process.env.REPAIRPRINT_INTEGRATION_TEST !== "production-render"
    || process.env.DEMO_MODE !== "false"
    || site?.hostname !== "127.0.0.1"
    || site.port !== "3197"
    || process.env.TURNSTILE_SECRET_KEY !== testSecret
    || !safeDatabase
    || !/^[a-f0-9]{48}$/.test(nonce)
  ) {
    throw new Error("Turnstile integration preload refused a non-test process.");
  }
}

function bodyParameters(body) {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  throw new Error("Turnstile integration expected a URL-encoded Siteverify body.");
}

function parseIntegrationToken(token) {
  const nonce = process.env.REPAIRPRINT_HTTP_TEST_NONCE;
  const prefix = `wp08.${nonce}.`;
  if (!token.startsWith(prefix)) return null;
  const remainder = token.slice(prefix.length);
  const separator = remainder.lastIndexOf(".");
  if (separator < 1) return null;
  const action = remainder.slice(0, separator);
  const tokenId = remainder.slice(separator + 1);
  if (!allowedActions.has(action) || !/^[0-9a-f-]{36}$/.test(tokenId)) return null;
  return { action };
}

function safeUrl(value) {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}
