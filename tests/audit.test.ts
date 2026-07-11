import { describe, expect, it, vi } from "vitest";
import { writeAuditEvent, type AuditExecutor } from "@/db/audit";

describe("audit writer", () => {
  it("requires attribution fields and writes before/after state", async () => {
    const returning = vi.fn(async () => [{ id: "audit-1" }]);
    const values = vi.fn(() => ({ returning }));
    const executor = { insert: vi.fn(() => ({ values })) } as unknown as AuditExecutor;
    const event = {
      actorId: "00000000-0000-4000-8000-000000000101",
      action: "fitment.review",
      entityType: "fitment",
      entityId: "00000000-0000-4000-8000-000000000201",
      reason: " Accepted exact fictional test. ",
      requestId: " req_fixture ",
      before: { status: "candidate_match" },
      after: { status: "verified_fit" },
    };

    await expect(writeAuditEvent(event, executor)).resolves.toBe("audit-1");
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      reason: "Accepted exact fictional test.",
      requestId: "req_fixture",
      before: event.before,
      after: event.after,
    }));
  });

  it.each([
    ["reason", "AUDIT_REASON_REQUIRED"],
    ["requestId", "AUDIT_REQUEST_ID_REQUIRED"],
  ] as const)("rejects a blank %s", async (field, code) => {
    const executor = { insert: vi.fn() } as unknown as AuditExecutor;
    await expect(writeAuditEvent({
      actorId: "actor",
      action: "action",
      entityType: "entity",
      entityId: "entity-id",
      reason: "reason",
      requestId: "request",
      before: null,
      after: {},
      [field]: " ",
    }, executor)).rejects.toThrow(code);
    expect(executor.insert).not.toHaveBeenCalled();
  });
});
