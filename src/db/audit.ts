import { auditLog } from "./schema";

export interface AuditEvent {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string;
  requestId: string;
  before: unknown;
  after: unknown;
}

export interface AuditExecutor {
  insert(table: typeof auditLog): {
    values(values: typeof auditLog.$inferInsert): {
      returning(selection: { id: typeof auditLog.id }): Promise<Array<{ id: string }>>;
    };
  };
}

export async function writeAuditEvent(
  event: AuditEvent,
  executor: AuditExecutor,
): Promise<string> {
  const reason = event.reason.trim();
  const requestId = event.requestId.trim();
  if (!reason) throw new Error("AUDIT_REASON_REQUIRED");
  if (!requestId) throw new Error("AUDIT_REQUEST_ID_REQUIRED");

  const [written] = await executor
    .insert(auditLog)
    .values({ ...event, reason, requestId })
    .returning({ id: auditLog.id });
  if (!written) throw new Error("AUDIT_WRITE_FAILED");
  return written.id;
}
