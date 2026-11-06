import { financeCents } from './financePayments';
import type { FinanceExpense, PurchaseMethod } from '../types/finance';

export const PURCHASE_CATEGORIES = ['Estoque', 'Material de limpeza', 'Manutenção'] as const;

// Pix e dinheiro saem da carteira na hora; cartão só gera dívida e debita quando a fatura é paga.
export function purchaseImmediatePayment(method: PurchaseMethod | '' | undefined, amount: number): { paidCash: number; paidBank: number } {
  if (method === 'cash') return { paidCash: amount, paidBank: 0 };
  if (method === 'pix') return { paidCash: 0, paidBank: amount };
  return { paidCash: 0, paidBank: 0 };
}

export function isPendingCardPurchase(expense: FinanceExpense): boolean {
  if (expense.purchaseMethod !== 'card') return false;
  const paid = financeCents(expense.paidCash) + financeCents(expense.paidBank) + financeCents(expense.paidOyo ?? 0);
  return paid < financeCents(expense.plannedAmount);
}
