import { balancesAt } from '../financeAnalytics';
import { expensePaymentEvents, payrollPaymentEvents } from '../financePayments';
import { financeDataIssues } from '../financeValidation';
import { incomeItems, incomePaymentWallet, payrollNet, type FinanceBalances, type FinanceData, type FinanceWallet } from '../../types/finance';

export interface AccountingReceipt {
  date: string;
  category: string;
  description: string;
  method: string;
  wallet: FinanceWallet;
  amount: number;
  reference: string;
  note: string;
}

export interface AccountingPayment {
  date: string;
  dueDate: string;
  type: 'Despesa' | 'Folha' | 'Correção de despesa' | 'Correção de folha';
  category: string;
  description: string;
  wallet: FinanceWallet;
  amount: number;
  reference: string;
  dateSource: 'Informada' | 'Vencimento usado em registro antigo';
  note: string;
}

export interface AccountingObligation {
  dueDate: string;
  type: 'Despesa' | 'Folha';
  competence: string;
  category: string;
  employee: string;
  planned: number;
  paid: number;
  pending: number;
  status: string;
  reference: string;
  note: string;
}

export interface AccountingTransfer {
  date: string;
  type: 'Transferência interna' | 'Repasse da OYO' | 'Pagamento à OYO';
  from: FinanceWallet;
  to: FinanceWallet;
  amount: number;
  hotelEffect: number;
  reference: string;
  note: string;
}

export interface AccountingWallet {
  wallet: FinanceWallet;
  opening: number;
  incoming: number;
  outgoing: number;
  calculatedClosing: number;
  closing: number;
  difference: number;
}

export interface MonthlyAccountingReport {
  month: string;
  from: string;
  to: string;
  generatedAt: string;
  receipts: AccountingReceipt[];
  prepaid: AccountingReceipt[];
  payments: AccountingPayment[];
  obligations: AccountingObligation[];
  transfers: AccountingTransfer[];
  wallets: AccountingWallet[];
  totals: {
    direct: number; prepaid: number; repasses: number; sentToOyo: number;
    paidHotel: number; paidOyo: number; cashResult: number;
    pendingMonth: number; pendingOverdue: number;
  };
  legacyPaymentCount: number;
}

const cents = (amount: number) => Math.round(amount * 100);
const sum = <T>(rows: T[], value: (row: T) => number) => rows.reduce((total, row) => total + cents(value(row)), 0) / 100;
const rounded = (amount: number) => cents(amount) / 100;
const emptyBalances = (): FinanceBalances => ({ cash: 0, bank: 0, oyo: 0 });

export function accountingMonthRange(month: string): { from: string; to: string; previousMonth: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900) throw new Error('Selecione um mês válido para a planilha.');
  const [year, monthNumber] = month.split('-').map(Number);
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1));
  return {
    from: `${month}-01`,
    to: `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`,
    previousMonth: `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

// Uses a complete, independent finance snapshot; no screen filter enters this report.
export function buildMonthlyAccountingReport(data: FinanceData, month: string, generatedAt = new Date().toISOString()): MonthlyAccountingReport {
  const { from, to, previousMonth } = accountingMonthRange(month);
  const issues = financeDataIssues(data);
  if (issues.length) throw new Error(`Corrija o lançamento ${issues[0].recordId} antes de exportar: ${issues[0].message}`);
  const inMonth = (date: string) => date >= from && date <= to;
  const receipts: AccountingReceipt[] = [];
  const prepaid: AccountingReceipt[] = [];
  const payments: AccountingPayment[] = [];
  const obligations: AccountingObligation[] = [];
  const transfers: AccountingTransfer[] = [];
  const incoming = emptyBalances();
  const outgoing = emptyBalances();

  for (const income of Object.values(data.incomes)) {
    if (!inMonth(income.date) || data.suppressed[income.id]) continue;
    for (const item of incomeItems(income)) {
      const wallet = incomePaymentWallet(item.paymentMethod);
      if (!wallet || !Number.isFinite(item.amount)) throw new Error(`Pagamento inválido no lançamento ${income.id}. Corrija o registro antes de exportar.`);
      const row: AccountingReceipt = { date: income.date, category: income.category, description: item.description, method: item.paymentMethod, wallet, amount: rounded(item.amount), reference: `${income.id}/${item.id}`, note: income.note };
      (wallet === 'oyo' ? prepaid : receipts).push(row);
      incoming[wallet] += row.amount;
    }
  }

  for (const expense of Object.values(data.expenses)) {
    if (data.suppressed[expense.id]) continue;
    const events = expensePaymentEvents(expense);
    let paidAtClosing = 0;
    for (const payment of events) {
      if (payment.date <= to) paidAtClosing += payment.amount;
      if (!inMonth(payment.date)) continue;
      payments.push({ date: payment.date, dueDate: expense.dueDate, type: payment.amount < 0 ? 'Correção de despesa' : 'Despesa', category: expense.category, description: expense.employee || expense.note || expense.category, wallet: payment.wallet, amount: rounded(payment.amount), reference: `${expense.id}/${payment.id}`, dateSource: payment.dateSource === 'legacy_due_date' ? 'Vencimento usado em registro antigo' : 'Informada', note: [expense.note, payment.note].filter(Boolean).join(' · ') });
      outgoing[payment.wallet] += payment.amount;
    }
    const pending = rounded(Math.max(0, expense.plannedAmount - paidAtClosing));
    if (inMonth(expense.dueDate) || (expense.dueDate < from && pending > 0)) obligations.push({ dueDate: expense.dueDate, type: 'Despesa', competence: expense.dueDate.slice(0, 7), category: expense.category, employee: expense.employee ?? '', planned: expense.plannedAmount, paid: rounded(paidAtClosing), pending, status: pending <= 0 ? 'Quitada até o fechamento' : expense.dueDate < from ? 'Pendente de mês anterior' : paidAtClosing > 0 ? 'Parcialmente paga' : 'A pagar', reference: expense.id, note: expense.note });
  }

  for (const payroll of Object.values(data.payroll)) {
    const events = payrollPaymentEvents(payroll);
    let paidAtClosing = 0;
    for (const payment of events) {
      if (payment.date <= to) paidAtClosing += payment.amount;
      if (!inMonth(payment.date)) continue;
      payments.push({ date: payment.date, dueDate: payroll.dueDate, type: payment.amount < 0 ? 'Correção de folha' : 'Folha', category: 'Folha de pagamento', description: `${payroll.employee}${payroll.position ? ` · ${payroll.position}` : ''}`, wallet: payment.wallet, amount: rounded(payment.amount), reference: `${payroll.id}/${payment.id}`, dateSource: payment.dateSource === 'legacy_due_date' ? 'Vencimento usado em registro antigo' : 'Informada', note: [payroll.note, payment.note].filter(Boolean).join(' · ') });
      outgoing[payment.wallet] += payment.amount;
    }
    const planned = payrollNet(payroll);
    const pending = rounded(Math.max(0, planned - paidAtClosing));
    if (payroll.month === month || inMonth(payroll.dueDate) || (payroll.dueDate < from && pending > 0)) obligations.push({ dueDate: payroll.dueDate, type: 'Folha', competence: payroll.month, category: 'Folha de pagamento', employee: payroll.employee, planned, paid: rounded(paidAtClosing), pending, status: pending <= 0 ? 'Quitada até o fechamento' : payroll.dueDate < from ? 'Pendente de mês anterior' : paidAtClosing > 0 ? 'Parcialmente paga' : 'A pagar', reference: payroll.id, note: `${payroll.note}${payroll.note ? ' · ' : ''}Base ${payroll.basePay}; adicionais ${payroll.additions}; descontos ${payroll.deductions}` });
  }

  for (const transfer of Object.values(data.transfers)) {
    if (!inMonth(transfer.date)) continue;
    const type = transfer.from === 'oyo' ? 'Repasse da OYO' : transfer.to === 'oyo' ? 'Pagamento à OYO' : 'Transferência interna';
    transfers.push({ date: transfer.date, type, from: transfer.from, to: transfer.to, amount: rounded(transfer.amount), hotelEffect: type === 'Repasse da OYO' ? transfer.amount : type === 'Pagamento à OYO' ? -transfer.amount : 0, reference: transfer.id, note: transfer.note });
    outgoing[transfer.from] += transfer.amount;
    // Payments sent to OYO settle its obligations; they do not create guest prepayments.
    if (transfer.to !== 'oyo') incoming[transfer.to] += transfer.amount;
  }

  const opening = balancesAt(data, previousMonth);
  const closing = balancesAt(data, month);
  const wallets: AccountingWallet[] = (['cash', 'bank', 'oyo'] as FinanceWallet[]).map((wallet) => {
    const calculatedClosing = rounded(opening[wallet] + incoming[wallet] - outgoing[wallet]);
    return { wallet, opening: opening[wallet], incoming: rounded(incoming[wallet]), outgoing: rounded(outgoing[wallet]), calculatedClosing, closing: closing[wallet], difference: rounded(calculatedClosing - closing[wallet]) };
  });
  const direct = sum(receipts, (row) => row.amount);
  const prepaidTotal = sum(prepaid, (row) => row.amount);
  const repasses = sum(transfers.filter((row) => row.type === 'Repasse da OYO'), (row) => row.amount);
  const sentToOyo = sum(transfers.filter((row) => row.type === 'Pagamento à OYO'), (row) => row.amount);
  const paidHotel = sum(payments.filter((row) => row.wallet !== 'oyo'), (row) => row.amount);
  const paidOyo = sum(payments.filter((row) => row.wallet === 'oyo'), (row) => row.amount);
  receipts.sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));
  prepaid.sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));
  payments.sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));
  obligations.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.reference.localeCompare(b.reference));
  transfers.sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));
  return { month, from, to, generatedAt, receipts, prepaid, payments, obligations, transfers, wallets, totals: { direct, prepaid: prepaidTotal, repasses, sentToOyo, paidHotel, paidOyo, cashResult: rounded(direct + repasses - paidHotel - sentToOyo), pendingMonth: sum(obligations.filter((row) => row.competence === month), (row) => row.pending), pendingOverdue: sum(obligations.filter((row) => row.dueDate < from && row.competence !== month), (row) => row.pending) }, legacyPaymentCount: payments.filter((row) => row.dateSource !== 'Informada').length };
}
