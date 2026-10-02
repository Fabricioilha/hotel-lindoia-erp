import { getAuth } from 'firebase/auth';
import { app } from '../config/firebase';

export type AuditAction = 'criado' | 'alterado' | 'excluido';

export interface AuditEvent {
  id: string;
  action: AuditAction;
  entity: string;
  recordId: string;
  actorUid: string;
  occurredAt: string;
}

export interface AuditBucket {
  entity: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export function buildAuditEvents(operationId: string, occurredAt: string, buckets: AuditBucket[]) {
  const user = getAuth(app).currentUser;
  const actorUid = user?.uid ?? 'local';
  const events: Record<string, AuditEvent> = {};

  buckets.forEach((bucket) => {
    const recordIds = new Set([...Object.keys(bucket.before), ...Object.keys(bucket.after)]);
    recordIds.forEach((recordId) => {
      const previous = bucket.before[recordId];
      const next = bucket.after[recordId];
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      const action: AuditAction = previous === undefined ? 'criado' : next === undefined ? 'excluido' : 'alterado';
      const id = `${operationId}-${Object.keys(events).length}`;
      events[id] = { id, action, entity: bucket.entity, recordId, actorUid, occurredAt };
    });
  });

  return events;
}