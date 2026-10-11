import { limitToLast, onValue, orderByChild, query, ref, remove, set } from 'firebase/database';
import { db } from '../config/firebase';
import type { ShiftHandoff } from '../types/reception';

const PATH = 'erp_geral/recepcao/shiftHandoffs';

export function deleteShiftHandoff(id: string): Promise<void> { return remove(ref(db, `${PATH}/${id}`)); }

export function subscribeShiftHandoffs(
  onChange: (handoffs: Record<string, ShiftHandoff>) => void,
  onError: (error: Error) => void,
): () => void {
  return onValue(query(ref(db, PATH), orderByChild('createdAt'), limitToLast(100)), (snapshot) => {
    onChange(snapshot.val() ?? {});
  }, onError);
}

export async function saveShiftHandoff(handoff: ShiftHandoff): Promise<void> {
  if (!handoff.id || !handoff.fromAttendant.trim() || !handoff.toAttendant.trim()
    || handoff.fromAttendant === handoff.toAttendant
    || !Number.isFinite(handoff.expectedCash) || handoff.expectedCash < 0
    || !Number.isFinite(handoff.cashLeft) || handoff.cashLeft < 0
    || (handoff.cashLeft !== 300 && !handoff.justification.trim())
    || !Number.isFinite(Date.parse(handoff.createdAt))
    || !Number.isFinite(Date.parse(handoff.endsAt))
    || Date.parse(handoff.endsAt) <= Date.parse(handoff.createdAt)) {
    throw new Error('Confira o próximo plantonista e os valores da passagem de turno.');
  }
  await set(ref(db, `${PATH}/${handoff.id}`), handoff);
}
