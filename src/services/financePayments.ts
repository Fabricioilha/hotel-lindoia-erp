import type { FinanceExpense, FinancePaymentEvent, FinanceWallet, PayrollEntry } from '../types/finance';

export const FINANCE_TIME_ZONE = 'America/Sao_Paulo';
export const financeCents = (value: number) => Math.round(value * 100);
export const financeMoney = (value: number) => financeCents(value) / 100;
const financeDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: FINANCE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

export function isFinanceDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function financeDateKeyFromTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = financeDateFormatter.formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function financeMonthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Selecione um mês válido.');
  const end = new Date(`${month}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return { from: `${month}-01`, to: end.toISOString().slice(0, 10) };
}

type PaymentSource = Pick<FinanceExpense, 'id' | 'dueDate' | 'paidDate' | 'paidCash' | 'paidBank' | 'paidOyo' | 'payments'>;

function paymentEvents(entry: PaymentSource, includeOyo: boolean): FinancePaymentEvent[] {
  if (entry.payments !== undefined) return Object.values(entry.payments ?? {});
  const wallets = includeOyo ? ['cash', 'bank', 'oyo'] as const : ['cash', 'bank'] as const;
  const totals = { cash: entry.paidCash, bank: entry.paidBank, oyo: entry.paidOyo ?? 0 };
  const informed = Boolean(entry.paidDate);
  return wallets.flatMap((wallet) => totals[wallet] ? [{ id: `${entry.id}-legacy-${wallet}`,
    date: entry.paidDate || entry.dueDate, wallet, amount: financeMoney(totals[wallet]),
    dateSource: informed ? 'informed' as const : 'legacy_due_date' as const,
    ...(informed ? {} : { note: 'Histórico sem data de pagamento: utiliza o vencimento cadastrado.' }),
  }] : []);
}

export function expensePaymentEvents(entry: FinanceExpense): FinancePaymentEvent[] { return paymentEvents(entry, true); }
export function payrollPaymentEvents(entry: PayrollEntry): FinancePaymentEvent[] { return paymentEvents(entry, false); }

export function paymentEventTotals(events: FinancePaymentEvent[]): { cash: number; bank: number; oyo: number } {
  const cents = { cash: 0, bank: 0, oyo: 0 };
  events.forEach((event) => { if (event.wallet in cents && Number.isFinite(event.amount)) cents[event.wallet] += financeCents(event.amount); });
  return { cash: cents.cash / 100, bank: cents.bank / 100, oyo: cents.oyo / 100 };
}

function withPaymentTotals<T extends PaymentSource>(previous: T | undefined, next: T, date: string, operationId: string, includeOyo: boolean): T {
  const existing = previous ? paymentEvents(previous, includeOyo) : [];
  const paid = paymentEventTotals(existing);
  if (previous?.payments !== undefined && (financeCents(paid.cash) !== financeCents(previous.paidCash)
    || financeCents(paid.bank) !== financeCents(previous.paidBank)
    || (includeOyo && financeCents(paid.oyo) !== financeCents(previous.paidOyo ?? 0)))) {
    throw new Error('O histórico de parcelas diverge dos totais pagos. Confira as parcelas antes de alterar este lançamento.');
  }
  const target = { cash: next.paidCash, bank: next.paidBank, oyo: includeOyo ? next.paidOyo ?? 0 : 0 };
  if (Object.values(target).some((amount) => !Number.isFinite(amount) || amount < 0)) throw new Error('Confira os totais pagos em cada carteira.');
  const payments = Object.fromEntries(existing.map((event) => [event.id, event]));
  let changed = false;
  (['cash', 'bank', 'oyo'] as const).forEach((wallet) => {
    const delta = financeCents(target[wallet]) - financeCents(paid[wallet]);
    if (!delta) return;
    if (!isFinanceDateKey(date)) throw new Error('Informe uma data válida para o pagamento ou a correção.');
    changed = true;
    const id = `${operationId}-${wallet}`;
    if (payments[id]) throw new Error('Esta movimentação já foi registrada. Reabra o lançamento antes de corrigir.');
    payments[id] = { id, date, wallet, amount: delta / 100, dateSource: 'informed',
      ...(delta < 0 ? { note: 'Correção/estorno do total pago.' } : {}) };
  });
  const result = { ...next, payments, paidCash: financeMoney(target.cash), paidBank: financeMoney(target.bank),
    ...(includeOyo ? { paidOyo: financeMoney(target.oyo) } : {}),
    ...(changed ? { paidDate: date } : previous?.paidDate ? { paidDate: previous.paidDate } : {}),
  };
  if (!Object.keys(payments).length) delete result.paidDate;
  return result;
}

export function withExpensePaymentTotals(previous: FinanceExpense | undefined, next: FinanceExpense, date: string, operationId: string): FinanceExpense {
  return withPaymentTotals(previous, next, date, operationId, true);
}

export function withPayrollPaymentTotals(previous: PayrollEntry | undefined, next: PayrollEntry, date: string, operationId: string): PayrollEntry {
  return withPaymentTotals(previous, next, date, operationId, false);
}

export function expensePaidDate(entry: FinanceExpense): string { return entry.paidDate || entry.dueDate; }
export function payrollPaidDate(entry: PayrollEntry): string { return entry.paidDate || entry.dueDate; }

export function paymentsInRange(events: FinancePaymentEvent[], from: string, to: string): FinancePaymentEvent[] {
  return events.filter((event) => event.date >= from && event.date <= to);
}

export function walletIsHotel(wallet: FinanceWallet): boolean { return wallet === 'cash' || wallet === 'bank'; }

export function patchPaymentDates(payments: Record<string, FinancePaymentEvent>, dates: Record<string, string>): Record<string, FinancePaymentEvent> {
  const next = { ...payments };
  Object.entries(dates).forEach(([id, date]) => {
    if (!next[id]) throw new Error('Uma parcela mudou enquanto você editava. Reabra o lançamento.');
    if (!isFinanceDateKey(date)) throw new Error('Confira a data de pagamento de cada parcela.');
    if (next[id].date !== date || next[id].dateSource === 'legacy_due_date') {
      const event = { ...next[id], date, dateSource: 'informed' as const };
      if (event.note === 'Histórico sem data de pagamento: utiliza o vencimento cadastrado.') delete event.note;
      next[id] = event;
    }
  });
  return next;
}
