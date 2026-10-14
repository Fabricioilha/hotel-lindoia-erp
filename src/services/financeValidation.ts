import { incomeItems, incomePaymentWallet, payrollNet, type FinanceData, type FinanceExpense, type FinancePaymentEvent, type PayrollEntry } from '../types/finance';
import { expensePaymentEvents, financeCents, isFinanceDateKey, paymentEventTotals, payrollPaymentEvents } from './financePayments';

export interface FinanceIssue {
  recordId: string;
  kind: 'income' | 'expense' | 'payroll' | 'transfer';
  message: string;
}

function paymentIssues(entry: FinanceExpense | PayrollEntry, events: FinancePaymentEvent[], payroll: boolean): string[] {
  const issues: string[] = [];
  const totals = paymentEventTotals(events);
  if (events.some((event) => !event.id || !isFinanceDateKey(event.date) || !['cash', 'bank', 'oyo'].includes(event.wallet)
    || (payroll && event.wallet === 'oyo') || !Number.isFinite(event.amount) || !event.amount)) issues.push('Há parcela com data, carteira ou valor inválido.');
  if (new Set(events.map((event) => event.id)).size !== events.length) issues.push('Há IDs de parcelas duplicados.');
  if (financeCents(totals.cash) !== financeCents(entry.paidCash) || financeCents(totals.bank) !== financeCents(entry.paidBank)
    || (!payroll && financeCents(totals.oyo) !== financeCents((entry as FinanceExpense).paidOyo ?? 0))) issues.push('Os totais pagos divergem do histórico de parcelas.');
  if ([entry.paidCash, entry.paidBank, payroll ? 0 : (entry as FinanceExpense).paidOyo ?? 0].some((amount) => !Number.isFinite(amount) || amount < 0)) {
    issues.push('Os totais pagos em cada carteira precisam ser valores válidos e não negativos.');
  }
  return issues;
}

export function financeDataIssues(data: FinanceData): FinanceIssue[] {
  const issues: FinanceIssue[] = [];
  const add = (recordId: string, kind: FinanceIssue['kind'], message: string) => issues.push({ recordId, kind, message });
  Object.values(data.incomes).filter((entry) => !data.suppressed[entry.id]).forEach((entry) => {
    const items = incomeItems(entry);
    if (!entry.id || !isFinanceDateKey(entry.date) || !Number.isFinite(entry.amount) || entry.amount <= 0
      || typeof entry.category !== 'string' || !entry.category.trim()
      || items.some((item) => !incomePaymentWallet(item.paymentMethod) || !Number.isFinite(item.amount) || item.amount <= 0)) add(entry.id, 'income', 'Há recebimento com data, valor ou forma de pagamento inválida.');
    if (financeCents(entry.amount) !== items.reduce((sum, item) => sum + financeCents(item.amount), 0)) add(entry.id, 'income', 'O valor do recebimento diverge da soma dos seus itens.');
  });
  Object.values(data.expenses).filter((entry) => !data.suppressed[entry.id]).forEach((entry) => {
    if (!entry.id || !isFinanceDateKey(entry.dueDate) || !Number.isFinite(entry.plannedAmount) || entry.plannedAmount <= 0
      || typeof entry.category !== 'string' || !entry.category.trim()) add(entry.id, 'expense', 'Há despesa com vencimento ou valor previsto inválido.');
    const events = expensePaymentEvents(entry);
    paymentIssues(entry, events, false).forEach((message) => add(entry.id, 'expense', message));
    const totals = paymentEventTotals(events);
    if (financeCents(totals.cash) + financeCents(totals.bank) + financeCents(totals.oyo) > financeCents(entry.plannedAmount)) add(entry.id, 'expense', 'O total pago supera o valor previsto da despesa.');
  });
  Object.values(data.payroll).forEach((entry) => {
    if (!entry.id || !isFinanceDateKey(entry.dueDate) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(entry.month)
      || typeof entry.employee !== 'string' || !entry.employee.trim() || [entry.basePay, entry.additions, entry.deductions].some((amount) => !Number.isFinite(amount) || amount < 0)
      || entry.deductions > entry.basePay + entry.additions) add(entry.id, 'payroll', 'Confira a competência, o vencimento e os valores da folha.');
    const events = payrollPaymentEvents(entry);
    paymentIssues(entry, events, true).forEach((message) => add(entry.id, 'payroll', message));
    const totals = paymentEventTotals(events);
    if (financeCents(totals.cash) + financeCents(totals.bank) > financeCents(payrollNet(entry))) add(entry.id, 'payroll', 'O total pago supera o valor líquido da folha.');
  });
  Object.values(data.transfers).forEach((entry) => {
    if (!entry.id || !isFinanceDateKey(entry.date) || !['cash', 'bank', 'oyo'].includes(entry.from)
      || !['cash', 'bank', 'oyo'].includes(entry.to) || entry.from === entry.to
      || !Number.isFinite(entry.amount) || entry.amount <= 0) add(entry.id, 'transfer', 'Há transferência com data, valor ou carteiras inválidas.');
  });
  return issues;
}

export function validateFinanceRecords(previous: FinanceData, next: FinanceData): void {
  if (Object.values(next.openingBalances).some((amount) => !Number.isFinite(amount))) throw new Error('Confira os saldos iniciais.');
  const changed = new Set<string>();
  for (const collection of ['incomes', 'expenses', 'payroll', 'transfers'] as const) {
    Object.entries(next[collection]).forEach(([id, entry]) => {
      if (JSON.stringify(previous[collection][id]) !== JSON.stringify(entry)) changed.add(`${collection}:${id}`);
    });
  }
  const collectionNames = { income: 'incomes', expense: 'expenses', payroll: 'payroll', transfer: 'transfers' };
  const issue = financeDataIssues(next).find((entry) => changed.has(`${collectionNames[entry.kind]}:${entry.recordId}`));
  if (issue) throw new Error(issue.message);
}
