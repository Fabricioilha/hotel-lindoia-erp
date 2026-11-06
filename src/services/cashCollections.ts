import { pb } from '../config/pocketbase';
import { MANAGEMENT_COLLECTION_REASON, type CashOut } from '../types/reception';
import { db, equalTo, onValue, orderByChild, query, ref, set } from './pocketbaseRealtime';

const ACK_PATH = 'erp_geral/financeiro/cashCollectionAcks';

export interface CashCollectionAck {
  signature: string;
  acknowledgedAt: string;
  acknowledgedBy: string;
}

export function cashCollectionSignature(item: CashOut): string {
  return JSON.stringify([item.id, item.amount, item.reason, item.note, item.attendant, item.date, item.createdAt]);
}

export function pendingCashCollections(items: Record<string, CashOut>, acknowledgements: Record<string, CashCollectionAck>): CashOut[] {
  return Object.values(items)
    .filter((item) => item.reason === MANAGEMENT_COLLECTION_REASON && acknowledgements[item.id]?.signature !== cashCollectionSignature(item))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function subscribeCashCollections(onChange: (items: CashOut[]) => void, onError: (error: Error) => void): () => void {
  let items: Record<string, CashOut> | undefined;
  let acknowledgements: Record<string, CashCollectionAck> | undefined;
  const publish = () => {
    if (items && acknowledgements) onChange(pendingCashCollections(items, acknowledgements));
  };
  const stopItems = onValue(query(ref(db, 'erp_geral/recepcao/cashOuts'), orderByChild('reason'), equalTo(MANAGEMENT_COLLECTION_REASON)), (snapshot) => {
    items = snapshot.val() ?? {};
    publish();
  }, onError);
  const stopAcks = onValue(ref(db, ACK_PATH), (snapshot) => {
    acknowledgements = snapshot.val() ?? {};
    publish();
  }, onError);
  return () => { stopItems(); stopAcks(); };
}

export async function acknowledgeCashCollection(item: CashOut): Promise<void> {
  const actor = pb.authStore.record?.id;
  if (!actor) throw new Error('Sessão inválida. Entre novamente para confirmar o recolhimento.');
  await set(ref(db, `${ACK_PATH}/${item.id}`), {
    signature: cashCollectionSignature(item),
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: actor,
  } satisfies CashCollectionAck);
}
