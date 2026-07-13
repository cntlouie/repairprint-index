import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { runSourceLinkBatch, SourceLinkBatchError } from "@/lib/source-link-worker";
import { authorizeSourceWorker } from "@/lib/source-worker-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleSourceLinkWorkerRequest(request);
}

export async function handleSourceLinkWorkerRequest(
  request: NextRequest,
  runBatch: typeof runSourceLinkBatch = runSourceLinkBatch,
) {
  if (!authorizeSourceWorker(request.headers.get("authorization"), process.env.SOURCE_LINK_WORKER_SECRET)) {
    return response({ error: { code: "SOURCE_LINK_WORKER_UNAUTHORIZED" } }, 401);
  }
  try {
    const actorId = requiredEnvironment("SOURCE_LINK_WORKER_ACTOR_ID");
    const workerId = requiredEnvironment("SOURCE_LINK_WORKER_ID");
    return response({ result: await runBatch(workerId, actorId) });
  } catch (error) {
    if (error instanceof SourceLinkBatchError) {
      const details = {
        mutationCommitted: error.mutationCommitted,
        affectedFitmentIds: error.affectedFitmentIds,
        affectedTags: error.affectedTags,
        failedTags: error.failedTags,
      };
      console.error("Source link batch requires operator attention.", { code: error.code, ...details });
      return response({ error: { code: error.code, details } }, 503);
    }
    console.error("Source link batch failed before a safe response was available.", { code: "SOURCE_LINK_BATCH_FAILED" });
    return response({ error: { code: "SOURCE_LINK_BATCH_FAILED" } }, 503);
  }
}

function response(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
