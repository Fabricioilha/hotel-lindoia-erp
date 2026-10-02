import { onValue, ref, runTransaction } from 'firebase/database';
import { db } from '../config/firebase';
import { buildAuditEvents } from '../types/audit';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type FinanceData } from '../types/finance';

const STORAGE_KEY = 'hotel-lindoia:finance:v1';
const LOCAL_UPDATE_EVENT = 'hotel-lindoia:finance-updated';
const DEPRECATED_INCOME_CATEGORIES = ['Rotativo cartão', 'Consumo Cartão', 'Diária Cartão', 'Café da manhã', 'Café da manhã cartão', 'Outros'];

export function emptyFinance(): FinanceData {
  return {
    incomes: {},
    expenses: {},
    transfers: {},
    payroll: {},
    openingBalances: { cash: 0, bank: 0, oyo: 0 },
    incomeCategories: [...INCOME_CATEGORIES],
    expenseCategories: [...EXPENSE_CATEGORIES],
    auditLog: {},
  };
}

function normalizeCategories(value: unknown, defaults: string[]) {
  if (!Array.isArray(value)) return [...defaults];
  const seen = new Set<string>();
  return value.filter((category): category is string => {
    if (typeof category !== 'string') return false;
    const normalized = category.trim();
    const key = normalized.toLocaleLowerCase('pt-BR');
    if (!normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((category) => category.trim());
}

function normalizeFinance(value: unknown): FinanceData {
  const data = value && typeof value === 'object' ? value as Partial<FinanceData> : {};
  const incomes = { ...data.incomes };
  const expenses = { ...data.expenses };
  Object.values(incomes).forEach((income) => {
    if (income.category.trim().toLocaleLowerCase('pt-BR') !== 'oyo') return;
    if (!expenses[income.id]) {
      expenses[income.id] = {
        id: income.id,
        dueDate: income.date,
        category: 'OYO',
        plannedAmount: income.amount,
        paidCash: 0,
        paidBank: 0,
        note: income.note,
        createdAt: income.createdAt,
        updatedAt: income.updatedAt,
      };
    }
    delete incomes[income.id];
  });
  return {
    incomes,
    expenses,
    transfers: data.transfers ?? {},
    payroll: data.payroll ?? {},
    openingBalances: { ...emptyFinance().openingBalances, ...data.openingBalances },
    incomeCategories: normalizeCategories(data.incomeCategories, INCOME_CATEGORIES)
      .filter((category) => category.toLocaleLowerCase('pt-BR') !== 'oyo'
        && !DEPRECATED_INCOME_CATEGORIES.some((deprecated) => deprecated.toLocaleLowerCase('pt-BR') === category.toLocaleLowerCase('pt-BR'))),
    expenseCategories: normalizeCategories(data.expenseCategories, EXPENSE_CATEGORIES),
    auditLog: data.auditLog ?? {},
  };
}

function readLocalFinance(): FinanceData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeFinance(JSON.parse(saved)) : emptyFinance();
  } catch {
    return emptyFinance();
  }
}

export const financeStorageMode = db ? 'Firebase' : 'neste navegador';

export function subscribeFinance(
  onChange: (data: FinanceData) => void,
  onError: (error: Error) => void,
): () => void {
  if (db) {
    return onValue(
      ref(db, 'erp_geral/financeiro'),
      (snapshot) => onChange(normalizeFinance(snapshot.val())),
      (error) => onError(error),
    );
  }

  const refresh = () => onChange(readLocalFinance());
  refresh();
  window.addEventListener('storage', refresh);
  window.addEventListener(LOCAL_UPDATE_EVENT, refresh);
  return () => {
    window.removeEventListener('storage', refresh);
    window.removeEventListener(LOCAL_UPDATE_EVENT, refresh);
  };
}

export async function updateFinance(
  update: (current: FinanceData) => FinanceData,
): Promise<void> {
  const operationId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  if (db) {
    const result = await runTransaction(ref(db, 'erp_geral/financeiro'), (value) => {
      const current = normalizeFinance(value);
      const next = update(current);
      const auditEvents = buildAuditEvents(operationId, occurredAt, [
        { entity: 'finance-income', before: current.incomes, after: next.incomes },
        { entity: 'finance-expense', before: current.expenses, after: next.expenses },
        { entity: 'finance-transfer', before: current.transfers, after: next.transfers },
        { entity: 'payroll', before: current.payroll, after: next.payroll },
        {
          entity: 'finance-settings',
          before: { openingBalances: current.openingBalances, incomeCategories: current.incomeCategories, expenseCategories: current.expenseCategories },
          after: { openingBalances: next.openingBalances, incomeCategories: next.incomeCategories, expenseCategories: next.expenseCategories },
        },
      ]);
      return { ...next, auditLog: { ...next.auditLog, ...auditEvents } };
    });
    if (!result.committed) throw new Error('A gravação financeira não foi confirmada.');
    return;
  }

  const current = readLocalFinance();
  const next = update(current);
  const auditEvents = buildAuditEvents(operationId, occurredAt, [
    { entity: 'finance-income', before: current.incomes, after: next.incomes },
    { entity: 'finance-expense', before: current.expenses, after: next.expenses },
    { entity: 'finance-transfer', before: current.transfers, after: next.transfers },
    { entity: 'payroll', before: current.payroll, after: next.payroll },
    {
      entity: 'finance-settings',
      before: { openingBalances: current.openingBalances, incomeCategories: current.incomeCategories, expenseCategories: current.expenseCategories },
      after: { openingBalances: next.openingBalances, incomeCategories: next.incomeCategories, expenseCategories: next.expenseCategories },
    },
  ]);
  const audited = { ...next, auditLog: { ...next.auditLog, ...auditEvents } };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(audited));
  window.dispatchEvent(new Event(LOCAL_UPDATE_EVENT));
}