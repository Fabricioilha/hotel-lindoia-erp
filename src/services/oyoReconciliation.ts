import { db, onValue, ref, runTransaction } from './pocketbaseRealtime';
import { financeReceiptsInRange } from './financeAnalytics';
import { expensePaymentEvents, financeCents, financeMoney, financeMonthRange } from './financePayments';
import type { FinanceData, FinanceTransfer } from '../types/finance';

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

export type OyoClosingRecord = OyoReconciliation | { closingBalance: number; updatedAt: string };
export type OyoClosingRecords = Record<string, OyoClosingRecord>;

const RECONCILIATIONS_PATH = 'erp_geral/financeiro/oyoReconciliations';
const INITIAL_CLOSING = { month: '2026-10', balance: -19_676.01 };
const validMonth = (month: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
const oyoTransferMonth = (item: FinanceTransfer) => item.oyoRecomMonth ?? item.date.slice(0, 7);
const isOyoTransfer = (item: FinanceTransfer) => (item.from === 'oyo') !== (item.to === 'oyo');
const oyoTransferCents = (item: FinanceTransfer) => (item.to === 'oyo' ? 1 : -1) * financeCents(item.amount);

export function calculateOyoReconciliation(record: OyoReconciliation) {
  const cents = (value: number) => Math.round(value * 100);
  const calculatedShare = cents(record.revenue) - cents(record.costs) + cents(record.adjustments) + cents(record.priorBalance);
  const share = cents(record.reportedShare);
  const received = cents(record.collectedByHotel) + cents(record.paidToHotel) - cents(record.paidToOyo);
  return { calculatedShare: calculatedShare / 100, share: share / 100, difference: (share - calculatedShare) / 100, received: received / 100, balance: (share - received) / 100 };
}

export function oyoClosingBalance(records: OyoClosingRecords, month: string): number | null {
  const record = records[month];
  if (record && 'closingBalance' in record && Number.isFinite(record.closingBalance)) return record.closingBalance;
  // Nos fechamentos antigos, o campo C era calculado a partir do campo A e dos recebimentos.
  if (record && 'reportedShare' in record) {
    const balance = calculateOyoReconciliation(record).balance;
    if (Number.isFinite(balance)) return balance;
  }
  return month === INITIAL_CLOSING.month ? INITIAL_CLOSING.balance : null;
}

export function latestOyoClosing(records: OyoClosingRecords, throughMonth: string) {
  const months = [...new Set([...Object.keys(records), INITIAL_CLOSING.month])].filter((month) => validMonth(month) && month <= throughMonth).sort().reverse();
  for (const month of months) {
    const balance = oyoClosingBalance(records, month);
    if (balance !== null) return { month, balance };
  }
  return null;
}

export function oyoClosingAt(records: OyoClosingRecords, asOf: string) {
  const month = asOf.slice(0, 7);
  if (asOf >= financeMonthRange(month).to) return latestOyoClosing(records, month);
  const previousMonth = new Date(`${month}-01T00:00:00Z`);
  previousMonth.setUTCDate(0);
  return latestOyoClosing(records, previousMonth.toISOString().slice(0, 7));
}

export function oyoPosition(closing: { month: string; balance: number }, transfers: Record<string, FinanceTransfer>, asOf: string) {
  const applied = Object.values(transfers).filter((item) => item.date <= asOf && isOyoTransfer(item) && oyoTransferMonth(item) > closing.month);
  const adjustment = applied.reduce((total, item) => total + oyoTransferCents(item), 0);
  return { balance: (financeCents(closing.balance) + adjustment) / 100, transfers: applied.sort((a, b) => b.date.localeCompare(a.date)) };
}

export function oyoEstimatedPosition(data: FinanceData, closing: { month: string; balance: number }, asOf: string) {
  const position = oyoPosition(closing, data.transfers, asOf);
  const nextMonth = new Date(`${closing.month}-01T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const from = nextMonth.toISOString().slice(0, 10);
  const { prepaid } = financeReceiptsInRange(data, { from, to: asOf });
  const compensated = Object.values(data.expenses).filter((entry) => !data.suppressed[entry.id])
    .flatMap(expensePaymentEvents).filter((item) => item.wallet === 'oyo' && item.date >= from && item.date <= asOf)
    .reduce((sum, item) => sum + financeCents(item.amount), 0);
  return { ...position, prepaid, compensated: compensated / 100, balance: (financeCents(position.balance) + financeCents(prepaid) - compensated) / 100 };
}

export function oyoMonthPendingCash(closingBalance: number | null, month: string, transfers: Record<string, FinanceTransfer>, prepaid: number, compensated: number) {
  if (closingBalance !== null) return 0;
  const adjustment = Object.values(transfers).filter((item) => isOyoTransfer(item) && oyoTransferMonth(item) === month)
    .reduce((sum, item) => sum + oyoTransferCents(item), 0);
  return (financeCents(prepaid) - financeCents(compensated) + adjustment) / 100;
}

export function subscribeOyoClosings(onChange: (records: OyoClosingRecords) => void, onError: (error: Error) => void): () => void {
  return onValue(ref(db, RECONCILIATIONS_PATH), (snapshot) => onChange(snapshot.val<OyoClosingRecords>() ?? {}), onError);
}

export async function registerOyoClosing(month: string, balance: number): Promise<OyoClosingRecord> {
  if (!validMonth(month)) throw new Error('Selecione um mês válido para a conciliação.');
  if (!Number.isSafeInteger(Math.round(balance * 100)) || financeMoney(balance) !== balance) {
    throw new Error('Informe um valor válido com até duas casas decimais.');
  }
  const alreadyClosed = 'Já existe uma RECOM lançada para este mês.';
  if (month === INITIAL_CLOSING.month) throw new Error(alreadyClosed);
  const record = { closingBalance: financeMoney(balance) || 0, updatedAt: new Date().toISOString() };
  const result = await runTransaction<OyoClosingRecord>(ref(db, `${RECONCILIATIONS_PATH}/${month}`), (current) =>
    current === null ? record : undefined);
  if (!result.committed) throw new Error(alreadyClosed);
  return record;
}
