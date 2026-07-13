export {};

const origin = requiredEnvironment("SOURCE_LINK_WORKER_ORIGIN");
const secret = requiredEnvironment("SOURCE_LINK_WORKER_SECRET");

async function main(): Promise<void> {
  const endpoint = new URL("/api/internal/source-links", origin);
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost";
  if (endpoint.username || endpoint.password || (!loopback && (endpoint.protocol !== "https:" || (endpoint.port && endpoint.port !== "443")))) {
    throw new Error("SOURCE_LINK_WORKER_ORIGIN_INVALID");
  }
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  const body = await response.json() as { error?: { code?: string }; result?: unknown };
  if (!response.ok) throw new Error(body.error?.code ?? "SOURCE_LINK_BATCH_FAILED");
  console.log(JSON.stringify(body.result));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "SOURCE_LINK_WORKER_FAILED";
  console.error(JSON.stringify({ code }));
  process.exitCode = 1;
});
