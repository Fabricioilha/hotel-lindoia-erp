import { ref, runTransaction, update } from 'firebase/database';
import { db } from '../config/firebase';
import type { RoomCharge } from '../types/reception';

const FINANCE = 'erp_geral/financeiro';

export function removeFinanceEntries(updates: Record<string, unknown>, ids: string[], kind: 'incomes' | 'expenses' = 'incomes') {
  ids.forEach((id) => {
    updates[`${FINANCE}/${kind}/${id}`] = null;
    updates[`${FINANCE}/suppressed/${id}`] = true;
  });
}

export function removeChargeUpdates(updates: Record<string, unknown>, charge: RoomCharge) {
  updates[`erp_geral/recepcao/roomCharges/${charge.id}`] = null;
  removeFinanceEntries(updates, Object.keys(charge.payments ?? {}).map((id) => `room-charge-${charge.id}-${id}`));
}

// Claims prevent two manager sessions from returning the same stock twice.
// The source, stock and linked financial records are then changed in one atomic update.
export async function commitDeletion(ids: string[], updates: Record<string, unknown>): Promise<void> {
  const token = crypto.randomUUID();
  const locks = ref(db, `${FINANCE}/deletions`);
  const result = await runTransaction(locks, (value) => {
    const current = value ?? {};
    if (ids.some((id) => current[id])) return;
    return { ...current, ...Object.fromEntries(ids.map((id) => [id, { token, status: 'pending' }])) };
  });
  if (!result.committed) throw new Error('Este registro já foi excluído ou está sendo excluído. Atualize a tela.');
  ids.forEach((id) => { updates[`${FINANCE}/deletions/${id}`] = { token, status: 'done' }; });
  try { await update(ref(db), updates); }
  catch (cause) {
    await runTransaction(locks, (value) => {
      if (!value) return;
      const current = { ...value };
      ids.forEach((id) => { if (current[id]?.token === token && current[id]?.status === 'pending') delete current[id]; });
      return current;
    });
    throw cause;
  }
}
