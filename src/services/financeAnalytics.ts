import { incomeItems, incomePaymentWallet, payrollNet, type FinanceBalances, type FinanceData, type FinanceIncome, type FinanceIncomeItem } from '../types/finance';
import { expensePaymentEvents, financeCents, financeMonthRange, paymentEventTotals, paymentsInRange, payrollPaymentEvents } from './financePayments';

export interface PrepaidIncomeEntry {
  income: FinanceIncome;
  items: FinanceIncomeItem[];
  amount: number;
}

// OYO é um controle de pagamentos externos, sem calcular comissões ou o acerto líquido.
export function balancesAt(data: FinanceData, month: string): FinanceBalances {
  return balancesAtDate(data, financeMonthRange(month).to);
}

export function balancesAtDate(data: FinanceData, endDate: string): FinanceBalances {
  const balances = { cash: financeCents(data.openingBalances.cash), bank: financeCents(data.openingBalances.bank), oyo: financeCents(data.openingBalances.oyo) };
  Object.values(data.incomes).filter((item) => item.date <= endDate && !data.suppressed[item.id]).forEach((item) => {
    incomeItems(item).forEach((line) => {
      const wallet = incomePaymentWallet(line.paymentMethod);
      if (wallet && Number.isFinite(line.amount)) balances[wallet] += financeCents(line.amount);
    });
  });
  Object.values(data.expenses).filter((item) => !data.suppressed[item.id]).forEach((item) => {
    expensePaymentEvents(item).filter((event) => event.date <= endDate).forEach((event) => {
      if (event.wallet in balances && Number.isFinite(event.amount)) balances[event.wallet] -= financeCents(event.amount);
    });
  });
  Object.values(data.payroll).forEach((item) => {
    payrollPaymentEvents(item).filter((event) => event.date <= endDate).forEach((event) => {
      if (event.wallet in balances && Number.isFinite(event.amount)) balances[event.wallet] -= financeCents(event.amount);
    });
  });
  Object.values(data.transfers).filter((item) => item.date <= endDate).forEach((item) => {
    if (!Number.isFinite(item.amount) || !(item.from in balances) || !(item.to in balances)) return;
    balances[item.from] -= financeCents(item.amount);
    // Um pagamento do hotel à OYO não é um pré-pago feito por um hóspede.
    if (item.to !== 'oyo') balances[item.to] += financeCents(item.amount);
  });
  return { cash: balances.cash / 100, bank: balances.bank / 100, oyo: balances.oyo / 100 };
}

export function monthlyReceipts(data: FinanceData, month: string) {
  const { from, to } = financeMonthRange(month);
  let directCents = 0;
  let prepaidCents = 0;
  let repasseCents = 0;
  let sentToOyoCents = 0;
  Object.values(data.incomes).filter((entry) => entry.date >= from && entry.date <= to && !data.suppressed[entry.id]).forEach((entry) => {
    incomeItems(entry).forEach((item) => {
      if (item.paymentMethod === 'prepaid') prepaidCents += financeCents(item.amount);
      else if (incomePaymentWallet(item.paymentMethod)) directCents += financeCents(item.amount);
    });
  });
  Object.values(data.transfers).filter((entry) => entry.date >= from && entry.date <= to).forEach((entry) => {
    if (entry.from === 'oyo' && entry.to !== 'oyo') repasseCents += Math.round(entry.amount * 100);
    if (entry.to === 'oyo' && entry.from !== 'oyo') sentToOyoCents += Math.round(entry.amount * 100);
  });
  return { direct: directCents / 100, prepaid: prepaidCents / 100, repasses: repasseCents / 100,
    sentToOyo: sentToOyoCents / 100, received: (directCents + repasseCents) / 100,
    registered: (directCents + prepaidCents) / 100 };
}

export function hotelIncomeView(entry: FinanceIncome): FinanceIncome | null {
  const items = incomeItems(entry).filter((item) => item.paymentMethod !== 'prepaid');
  if (!items.length) return null;
  return { ...entry, items, amount: items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100 };
}

export function oyoPaymentsAt(data: FinanceData, month: string): number {
  return Object.values(data.transfers).filter((item) => item.date <= financeMonthRange(month).to && item.to === 'oyo' && item.from !== 'oyo')
    .reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100;
}

// Histórico bruto dos pagamentos dos hóspedes à OYO; não é receita recebida no hotel.
export function prepaidEntriesAt(incomes: Record<string, FinanceIncome>, month: string): PrepaidIncomeEntry[] {
  const endDate = financeMonthRange(month).to;
  return Object.values(incomes)
    .filter((income) => income.date <= endDate)
    .flatMap((income) => {
      const items = incomeItems(income).filter((item) => item.paymentMethod === 'prepaid');
      if (items.length === 0) return [];
      const amount = Math.round(items.reduce((total, item) => total + Math.round(item.amount * 100), 0)) / 100;
      return [{ income, items, amount }];
    })
    .sort((a, b) => b.income.date.localeCompare(a.income.date) || b.income.createdAt.localeCompare(a.income.createdAt));
}

export function prepaidEntriesTotal(entries: PrepaidIncomeEntry[]): number {
  return entries.reduce((total, entry) => total + Math.round(entry.amount * 100), 0) / 100;
}

export function monthlyFinanceSummary(data: FinanceData, month: string) {
  const { from, to } = financeMonthRange(month);
  const previousDay = new Date(`${from}T00:00:00Z`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const expenses = Object.values(data.expenses).filter((entry) => !data.suppressed[entry.id]);
  const payroll = Object.values(data.payroll);
  const expenseEvents = expenses.flatMap(expensePaymentEvents);
  const payrollEvents = payroll.flatMap(payrollPaymentEvents);
  const periodEvents = paymentsInRange([...expenseEvents, ...payrollEvents], from, to);
  const payments = paymentEventTotals(periodEvents);
  const outstanding = (planned: number, events: ReturnType<typeof expensePaymentEvents>) => {
    const totals = paymentEventTotals(events.filter((event) => event.date <= to));
    return Math.max(0, financeCents(planned) - financeCents(totals.cash) - financeCents(totals.bank) - financeCents(totals.oyo));
  };
  const dueExpenses = expenses.filter((entry) => entry.dueDate >= from && entry.dueDate <= to);
  const competencePayroll = payroll.filter((entry) => entry.month === month);
  const receipts = monthlyReceipts(data, month);
  const cashPaidExpenses = (financeCents(payments.cash) + financeCents(payments.bank)) / 100;
  return {
    month,
    openingBalances: balancesAtDate(data, previousDay.toISOString().slice(0, 10)),
    closingBalances: balancesAtDate(data, to),
    receipts,
    payments,
    expensePayments: paymentEventTotals(paymentsInRange(expenseEvents, from, to)),
    payrollPayments: paymentEventTotals(paymentsInRange(payrollEvents, from, to)),
    cashPaidExpenses,
    oyoPaidExpenses: payments.oyo,
    paidExpenses: (financeCents(cashPaidExpenses) + financeCents(payments.oyo)) / 100,
    plannedExpenses: dueExpenses.reduce((sum, entry) => sum + financeCents(entry.plannedAmount), 0) / 100,
    plannedPayroll: competencePayroll.reduce((sum, entry) => sum + financeCents(payrollNet(entry)), 0) / 100,
    pendingExpenses: dueExpenses.reduce((sum, entry) => sum + outstanding(entry.plannedAmount, expensePaymentEvents(entry)), 0) / 100,
    pendingPayroll: competencePayroll.reduce((sum, entry) => sum + outstanding(payrollNet(entry), payrollPaymentEvents(entry)), 0) / 100,
    overdueExpenses: (expenses.filter((entry) => entry.dueDate < from).reduce((sum, entry) => sum + outstanding(entry.plannedAmount, expensePaymentEvents(entry)), 0)
      + payroll.filter((entry) => entry.dueDate < from && entry.month !== month).reduce((sum, entry) => sum + outstanding(payrollNet(entry), payrollPaymentEvents(entry)), 0)) / 100,
    cashResult: (financeCents(receipts.received) - financeCents(cashPaidExpenses) - financeCents(receipts.sentToOyo)) / 100,
    internalTransfers: Object.values(data.transfers).filter((entry) => entry.date >= from && entry.date <= to && entry.from !== 'oyo' && entry.to !== 'oyo')
      .reduce((sum, entry) => sum + financeCents(entry.amount), 0) / 100,
    legacyPaymentCount: periodEvents.filter((event) => event.dateSource === 'legacy_due_date').length,
  };
}
