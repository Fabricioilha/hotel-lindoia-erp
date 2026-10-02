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

export function recordOperationalIncome(input: OperationalIncomeInput): Promise<void> {
  const wallet = incomePaymentWallet(input.paymentMethod);
  if (!wallet || !Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('O recebimento precisa ter uma forma de pagamento e valor válido.');
  }

  return updateFinance((current) => {
    const existing = current.incomes[input.id];
    const existingItem = existing?.items?.[0];
    if (existing
      && existing.date === input.date
      && existing.category === input.category
      && existing.amount === input.amount
      && existing.wallet === wallet
      && existing.note === input.note
      && existing.items?.length === 1
      && existingItem?.description === input.description
      && existingItem.amount === input.amount
      && existingItem.paymentMethod === input.paymentMethod) return current;
    const timestamp = new Date().toISOString();
    const income: FinanceIncome = {
      id: input.id,
      date: input.date,
      category: input.category,
      amount: input.amount,
      wallet,
      items: [{
        id: input.id,
        description: input.description,
        amount: input.amount,
        paymentMethod: input.paymentMethod,
      }],
      note: input.note,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    return { ...current, incomes: { ...current.incomes, [income.id]: income } };
  });
}