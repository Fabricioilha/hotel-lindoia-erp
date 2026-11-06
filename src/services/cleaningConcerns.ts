import { pb } from '../config/pocketbase';
import type { RoomCleaningLog } from '../types/housekeeping';
import { db, equalTo, onValue, orderByChild, query, ref, set } from './pocketbaseRealtime';

const ACK_PATH = 'erp_geral/financeiro/cleaningConcernAcks';

interface CleaningConcernAck {
  signature: string;
  acknowledgedAt: string;
  acknowledgedBy: string;
}

export function cleaningConcernSignature(log: RoomCleaningLog): string {
  return JSON.stringify([log.id, log.roomId, log.roomNumber, log.attendant, log.completedAt, log.reportedBy, log.usageConcern]);
}

export function pendingCleaningConcerns(logs: Record<string, RoomCleaningLog>, acks: Record<string, CleaningConcernAck>): RoomCleaningLog[] {
  return Object.values(logs).filter((log) => log.usageConcern && acks[log.id]?.signature !== cleaningConcernSignature(log))
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}

export function subscribeCleaningConcerns(onChange: (logs: RoomCleaningLog[]) => void, onError: (error: Error) => void): () => void {
  let logs: Record<string, RoomCleaningLog> | undefined;
  let acks: Record<string, CleaningConcernAck> | undefined;
  const publish = () => { if (logs && acks) onChange(pendingCleaningConcerns(logs, acks)); };
  const stopLogs = onValue(query(ref(db, 'erp_geral/quartos/cleaningLogs'), orderByChild('usageConcern'), equalTo(true)), (snapshot) => {
    logs = snapshot.val() ?? {};
    publish();
  }, onError);
  const stopAcks = onValue(ref(db, ACK_PATH), (snapshot) => { acks = snapshot.val() ?? {}; publish(); }, onError);
  return () => { stopLogs(); stopAcks(); };
}

export async function acknowledgeCleaningConcern(log: RoomCleaningLog): Promise<void> {
  const actor = pb.authStore.record?.id;
  if (!actor) throw new Error('Sessão inválida. Entre novamente para confirmar a conferência.');
  await set(ref(db, `${ACK_PATH}/${log.id}`), {
    signature: cleaningConcernSignature(log),
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: actor,
  } satisfies CleaningConcernAck);
}
