import { get, ref, remove, runTransaction, set } from 'firebase/database';
import { db } from '../config/firebase';
import { buildAuditEvents } from '../types/audit';
import {
  incomePaymentWallet,
  type FinanceExpense,
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

export interface OperationalExpenseInput {
  id: string;
  dueDate: string;
  category: string;
  plannedAmount: number;
  paidCash: number;
  paidBank: number;
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

  await Promise.all(pending.map(async (input) => {
    const suppressed = await get(ref(db, `erp_geral/financeiro/suppressed/${input.id}`));
    if (suppressed.val() === true) {
      ensured.add(input.id);
      return;
    }

    const timestamp = new Date().toISOString();
    const wallet = incomePaymentWallet(input.paymentMethod);
    if (!wallet) throw new Error('O recebimento precisa ter uma forma de pagamento válida.');
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

    let created = false;
    const result = await runTransaction(ref(db, `erp_geral/financeiro/incomes/${input.id}`), (current) => {
      if (current !== null) {
        created = false;
        return;
      }
      created = true;
      return income;
    });
    if (!result.committed && created) throw new Error('O recebimento não foi confirmado no Financeiro.');

    if (created) {
      const events = buildAuditEvents(crypto.randomUUID(), timestamp, [
        { entity: 'finance-income', before: {}, after: { [input.id]: income } },
      ]);
      await Promise.all(Object.entries(events).map(([id, event]) =>
        set(ref(db, `erp_geral/financeiro/auditLog/${id}`), event),
      ));
    }
    ensured.add(input.id);
  }));
}

export function recordOperationalIncome(input: OperationalIncomeInput): Promise<void> {
  return recordOperationalIncomes([input]);
}

export async function recordOperationalExpenses(inputs: OperationalExpenseInput[]): Promise<void> {
  const pending = inputs.filter((input) => !ensured.has(input.id));
  pending.forEach((input) => {
    if (!Number.isFinite(input.plannedAmount) || input.plannedAmount <= 0
      || !Number.isFinite(input.paidCash) || input.paidCash < 0
      || !Number.isFinite(input.paidBank) || input.paidBank < 0) {
      throw new Error('A despesa precisa ter valores válidos.');
    }
  });

  await Promise.all(pending.map(async (input) => {
    const suppressed = await get(ref(db, `erp_geral/financeiro/suppressed/${input.id}`));
    if (suppressed.val() === true) {
      ensured.add(input.id);
      return;
    }

    const timestamp = new Date().toISOString();
    const expense: FinanceExpense = { ...input, createdAt: timestamp, updatedAt: timestamp };
    let created = false;
    const result = await runTransaction(ref(db, `erp_geral/financeiro/expenses/${input.id}`), (current) => {
      if (current !== null) {
        created = false;
        return;
      }
      created = true;
      return expense;
    });
    if (!result.committed && created) throw new Error('A despesa não foi confirmada no Financeiro.');

    if (created) {
      const events = buildAuditEvents(crypto.randomUUID(), timestamp, [
        { entity: 'finance-expense', before: {}, after: { [input.id]: expense } },
      ]);
      await Promise.all(Object.entries(events).map(([eventId, event]) =>
        set(ref(db, `erp_geral/financeiro/auditLog/${eventId}`), event),
      ));
    }
    ensured.add(input.id);
  }));
}

export async function suppressOperationalIncome(id: string): Promise<void> {
  const incomeRef = ref(db, `erp_geral/financeiro/incomes/${id}`);
  const current = await get(incomeRef);
  await set(ref(db, `erp_geral/financeiro/suppressed/${id}`), true);
  await remove(incomeRef);
  if (current.exists()) {
    const occurredAt = new Date().toISOString();
    const events = buildAuditEvents(crypto.randomUUID(), occurredAt, [
      { entity: 'finance-income', before: { [id]: current.val() }, after: {} },
    ]);
    await Promise.all(Object.entries(events).map(([eventId, event]) =>
      set(ref(db, `erp_geral/financeiro/auditLog/${eventId}`), event),
    ));
  }
  ensured.add(id);
}

export async function suppressOperationalExpense(id: string): Promise<void> {
  const expenseRef = ref(db, `erp_geral/financeiro/expenses/${id}`);
  const current = await get(expenseRef);
  await set(ref(db, `erp_geral/financeiro/suppressed/${id}`), true);
  await remove(expenseRef);
  if (current.exists()) {
    const occurredAt = new Date().toISOString();
    const events = buildAuditEvents(crypto.randomUUID(), occurredAt, [
      { entity: 'finance-expense', before: { [id]: current.val() }, after: {} },
    ]);
    await Promise.all(Object.entries(events).map(([eventId, event]) =>
      set(ref(db, `erp_geral/financeiro/auditLog/${eventId}`), event),
    ));
  }
  ensured.add(id);
}
