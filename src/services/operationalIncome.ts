import { updateFinance } from './financeStore';
import {
  incomePaymentWallet,
  type FinanceIncome,
  type FinancePaymentMethod,
} from '../types/finance';

export interface OperationalIncomeInput {
  id: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  paymentMethod: FinancePaymentMethod;
  note: string;
}

// Ids já garantidos nesta sessão; evita regravar o financeiro a cada abertura de tela.
const ensured = new Set<string>();

// Cria as entradas que ainda não existem e não foram excluídas pela gerência; nunca sobrescreve edições.
export async function recordOperationalIncomes(inputs: OperationalIncomeInput[]): Promise<void> {
  const pending = inputs.filter((input) => !ensured.has(input.id));
  if (pending.length === 0) return;
  pending.forEach((input) => {
    if (!incomePaymentWallet(input.paymentMethod) || !Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error('O recebimento precisa ter uma forma de pagamento e valor válido.');
    }
  });

  await updateFinance((current) => {
    const timestamp = new Date().toISOString();
    let incomes = current.incomes;
    pending.forEach((input) => {
      if (current.suppressed[input.id] || incomes[input.id]) return;
      const wallet = incomePaymentWallet(input.paymentMethod);
      if (!wallet) return;
      const income: FinanceIncome = {
        id: input.id,
        date: input.date,
        category: input.category,
        amount: input.amount,
        wallet,
        items: [{ id: input.id, description: input.description, amount: input.amount, paymentMethod: input.paymentMethod }],
        note: input.note,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      incomes = { ...incomes, [income.id]: income };
    });
    return incomes === current.incomes ? current : { ...current, incomes };
  });
  pending.forEach((input) => ensured.add(input.id));
}

export function recordOperationalIncome(input: OperationalIncomeInput): Promise<void> {
  return recordOperationalIncomes([input]);
}
