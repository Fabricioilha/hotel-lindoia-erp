import { limitToLast, onValue, orderByChild, query, ref, runTransaction } from 'firebase/database';
import { db } from '../config/firebase';
import { buildAuditEvents } from '../types/audit';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type FinanceData } from '../types/finance';
import { withOperationalFinance, type OperationalFinanceSources } from './operationalLedger';

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
    suppressed: {},
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
  const categoryAliases = { income: data.categoryAliases?.income ?? {}, expense: data.categoryAliases?.expense ?? {} };
  Object.values(expenses).forEach((entry) => { if (categoryAliases.expense[entry.category]) expenses[entry.id] = { ...entry, category: categoryAliases.expense[entry.category] }; });
  Object.values(incomes).forEach((income) => {
    if (income.category.trim().toLocaleLowerCase('pt-BR') === 'oyo') {
      incomes[income.id] = { ...income, category: 'OYO (histórico)' };
    }
    const entry = incomes[income.id];
    if (categoryAliases.income[entry.category]) incomes[income.id] = { ...entry, category: categoryAliases.income[entry.category] };
  });
  return {
    incomes,
    expenses,
    transfers: data.transfers ?? {},
    payroll: data.payroll ?? {},
    openingBalances: { ...emptyFinance().openingBalances, ...data.openingBalances },
    incomeCategories: [...new Set([...INCOME_CATEGORIES, ...normalizeCategories(data.incomeCategories, INCOME_CATEGORIES)])]
      .filter((category) => !categoryAliases.income[category] && category.toLocaleLowerCase('pt-BR') !== 'oyo'
        && !DEPRECATED_INCOME_CATEGORIES.some((deprecated) => deprecated.toLocaleLowerCase('pt-BR') === category.toLocaleLowerCase('pt-BR'))),
    expenseCategories: normalizeCategories(data.expenseCategories, EXPENSE_CATEGORIES).filter((category) => !categoryAliases.expense[category]),
    auditLog: data.auditLog ?? {},
    suppressed: data.suppressed ?? {},
    deletions: data.deletions ?? {},
    categoryAliases,
  };
}

export const financeStorageMode = 'Firebase';

export function subscribeFinance(
  onChange: (data: FinanceData) => void,
  onError: (error: Error) => void,
  options: { includeOperations?: boolean } = {},
): () => void {
  const financeKeys = ['incomes', 'expenses', 'transfers', 'payroll', 'openingBalances', 'incomeCategories', 'expenseCategories', 'auditLog', 'suppressed', 'categoryAliases'] as const;
  const operationalPaths = {
    stays: 'erp_geral/recepcao/stays',
    roomCharges: 'erp_geral/recepcao/roomCharges',
    cashOuts: 'erp_geral/recepcao/cashOuts',
    sales: 'erp_geral/frigobar/operations/sales',
    reservationCollections: 'erp_geral/reservationCollections',
  };
  const paths = [...financeKeys.map((key) => [key, `erp_geral/financeiro/${key}`]), ...(options.includeOperations === false ? [] : Object.entries(operationalPaths))];
  const loaded = new Set<string>();
  const values: Record<string, unknown> = {};
  const stops = paths.map(([key, location]) => {
    const path = ref(db, location);
    const listener = key === 'auditLog' ? query(path, orderByChild('occurredAt'), limitToLast(100)) : path;
    return onValue(listener, (snapshot) => {
      values[key] = snapshot.val() ?? {};
      loaded.add(key);
      if (loaded.size === paths.length) {
        const data = normalizeFinance(values);
        onChange(options.includeOperations === false ? data : withOperationalFinance(data, {
          stays: values.stays, roomCharges: values.roomCharges, cashOuts: values.cashOuts,
          sales: values.sales, reservationCollections: values.reservationCollections,
        } as OperationalFinanceSources));
      }
    }, onError);
  });
  return () => stops.forEach((stop) => stop());
}

export async function updateFinance(
  update: (current: FinanceData) => FinanceData,
): Promise<void> {
  const operationId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
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
}
