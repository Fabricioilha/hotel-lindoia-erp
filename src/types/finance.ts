export type FinanceWallet = 'cash' | 'bank' | 'oyo';
export type FinancePaymentMethod = 'credit' | 'debit' | 'cash' | 'pix' | 'bank_transfer' | 'prepaid';

export interface FinanceIncomeItem {
  id: string;
  description: string;
  amount: number;
  paymentMethod: FinancePaymentMethod;
}

export interface FinanceBalances {
  cash: number;
  bank: number;
  oyo: number;
}

export interface FinanceIncome {
  id: string;
  date: string;
  category: string;
  amount: number;
  wallet: FinanceWallet;
  items?: FinanceIncomeItem[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceExpense {
  id: string;
  dueDate: string;
  category: string;
  plannedAmount: number;
  paidCash: number;
  paidBank: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceTransfer {
  id: string;
  date: string;
  from: FinanceWallet;
  to: FinanceWallet;
  amount: number;
  note: string;
  createdAt: string;
}

export interface PayrollEntry {
  id: string;
  month: string;
  dueDate: string;
  employee: string;
  position: string;
  basePay: number;
  additions: number;
  deductions: number;
  paidCash: number;
  paidBank: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceData {
  incomes: Record<string, FinanceIncome>;
  expenses: Record<string, FinanceExpense>;
  transfers: Record<string, FinanceTransfer>;
  payroll: Record<string, PayrollEntry>;
  openingBalances: FinanceBalances;
  incomeCategories: string[];
  expenseCategories: string[];
}

export const INCOME_CATEGORIES = [
  'Diária',
  'Rotativo',
  'Consumo',
  'Café',
];

export const DAILY_INCOME_ITEMS = [
  'Diária',
  'Taxa',
  'Colchão extra',
  'Adicional de troca de quarto',
  'Adicional de hóspede',
  'Check-in antecipado',
  'Checkout tardio',
  'Modificação de reserva',
];

export const PAYMENT_METHOD_LABELS: Record<FinancePaymentMethod, string> = {
  credit: 'Cartão de crédito',
  debit: 'Cartão de débito',
  cash: 'Dinheiro',
  pix: 'Pix',
  bank_transfer: 'Transferência bancária',
  prepaid: 'Pré-pago',
};

export function incomePaymentWallet(method: FinancePaymentMethod): FinanceWallet | null {
  if (method === 'cash') return 'cash';
  if (method === 'prepaid') return null;
  return 'bank';
}

export function incomeItems(entry: FinanceIncome): FinanceIncomeItem[] {
  if (entry.items?.length) return entry.items;
  const paymentMethod: FinancePaymentMethod = entry.wallet === 'cash'
    ? 'cash'
    : entry.wallet === 'oyo' ? 'prepaid' : 'bank_transfer';
  return [{ id: entry.id, description: entry.category, amount: entry.amount, paymentMethod }];
}

export const EXPENSE_CATEGORIES = [
  'Aluguel',
  'Água',
  'Antena',
  'Cartões',
  'Contador',
  'Consumo',
  'Empréstimos',
  'Energia elétrica',
  'Ecad',
  'Faculdade',
  'FGTS',
  'GPS',
  'Gás',
  'IPTU',
  'Internet',
  'Material de limpeza',
  'OYO',
  'Plano de saúde',
  'Simples',
  'Vale-transporte',
  'Folha de pagamento',
  'Outros',
];

export const WALLET_LABELS: Record<FinanceWallet, string> = {
  cash: 'Caixa físico',
  bank: 'Banco',
  oyo: 'OYO a receber',
};

export function payrollNet(entry: Pick<PayrollEntry, 'basePay' | 'additions' | 'deductions'>) {
  return Math.max(0, entry.basePay + entry.additions - entry.deductions);
}