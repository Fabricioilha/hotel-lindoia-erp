import { incomeItems, incomePaymentWallet, type FinanceBalances, type FinanceData, type FinanceIncome, type FinanceIncomeItem } from '../types/finance';

export interface PrepaidIncomeEntry {
  income: FinanceIncome;
  items: FinanceIncomeItem[];
  amount: number;
}

// OYO é um controle de pagamentos externos, sem calcular comissões ou o acerto líquido.
export function balancesAt(data: FinanceData, month: string): FinanceBalances {
  const endDate = `${month}-31`;
  const balances = { ...data.openingBalances };
  Object.values(data.incomes).filter((item) => item.date <= endDate).forEach((item) => {
    incomeItems(item).forEach((line) => {
      const wallet = incomePaymentWallet(line.paymentMethod);
      if (wallet) balances[wallet] += line.amount;
    });
  });
  Object.values(data.expenses).filter((item) => item.dueDate <= endDate).forEach((item) => {
    balances.cash -= item.paidCash;
    balances.bank -= item.paidBank;
    balances.oyo -= item.paidOyo ?? 0;
  });
  Object.values(data.payroll).filter((item) => item.dueDate <= endDate).forEach((item) => {
    balances.cash -= item.paidCash;
    balances.bank -= item.paidBank;
  });
  Object.values(data.transfers).filter((item) => item.date <= endDate).forEach((item) => {
    balances[item.from] -= item.amount;
    // Um pagamento do hotel à OYO não é um pré-pago feito por um hóspede.
    if (item.to !== 'oyo') balances[item.to] += item.amount;
  });
  return { cash: Math.round(balances.cash * 100) / 100, bank: Math.round(balances.bank * 100) / 100, oyo: Math.round(balances.oyo * 100) / 100 };
}

export function monthlyReceipts(data: FinanceData, month: string) {
  let directCents = 0;
  let prepaidCents = 0;
  let repasseCents = 0;
  let sentToOyoCents = 0;
  Object.values(data.incomes).filter((entry) => entry.date.startsWith(month)).forEach((entry) => {
    incomeItems(entry).forEach((item) => {
      if (item.paymentMethod === 'prepaid') prepaidCents += Math.round(item.amount * 100);
      else directCents += Math.round(item.amount * 100);
    });
  });
  Object.values(data.transfers).filter((entry) => entry.date.startsWith(month)).forEach((entry) => {
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
  return Object.values(data.transfers).filter((item) => item.date <= `${month}-31` && item.to === 'oyo' && item.from !== 'oyo')
    .reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100;
}

// Histórico bruto dos pagamentos dos hóspedes à OYO; não é receita recebida no hotel.
export function prepaidEntriesAt(incomes: Record<string, FinanceIncome>, month: string): PrepaidIncomeEntry[] {
  const endDate = `${month}-31`;
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
