import { db, onValue, ref, runTransaction } from './pocketbaseRealtime';

export interface OyoReconciliation {
  revenue: number;
  costs: number;
  adjustments: number;
  priorBalance: number;
  reportedShare: number;
  collectedByHotel: number;
  paidToHotel: number;
  paidToOyo: number;
  updatedAt: string;
}

export function calculateOyoReconciliation(record: OyoReconciliation) {
  const cents = (value: number) => Math.round(value * 100);
  const calculatedShare = cents(record.revenue) - cents(record.costs) + cents(record.adjustments) + cents(record.priorBalance);
  const share = cents(record.reportedShare);
  const received = cents(record.collectedByHotel) + cents(record.paidToHotel) - cents(record.paidToOyo);
  return { calculatedShare: calculatedShare / 100, share: share / 100, difference: (share - calculatedShare) / 100, received: received / 100, balance: (share - received) / 100 };
}

function pathForMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Selecione um mês válido para a conciliação.');
  return `erp_geral/financeiro/oyoReconciliations/${month}`;
}

export function subscribeOyoReconciliation(month: string, onChange: (record: OyoReconciliation | null) => void, onError: (error: Error) => void): () => void {
  return onValue(ref(db, pathForMonth(month)), (snapshot) => onChange(snapshot.val<OyoReconciliation>()), onError);
}

export async function saveOyoReconciliation(month: string, record: OyoReconciliation, expected: OyoReconciliation | null): Promise<void> {
  const { revenue, costs, adjustments, priorBalance, reportedShare, collectedByHotel, paidToHotel, paidToOyo } = record;
  if (![revenue, costs, adjustments, priorBalance, reportedShare, collectedByHotel, paidToHotel, paidToOyo].every(Number.isFinite)
    || [revenue, costs, collectedByHotel, paidToHotel, paidToOyo].some((value) => value < 0)) {
    throw new Error('Confira os valores: receitas, custos e pagamentos devem ser iguais ou maiores que zero.');
  }
  const result = await runTransaction(ref(db, pathForMonth(month)), (current: OyoReconciliation | null) =>
    JSON.stringify(current) === JSON.stringify(expected) ? record : undefined);
  if (!result.committed) throw new Error('Esta conciliação foi alterada em outra sessão. Cancele e reabra o formulário.');
}
