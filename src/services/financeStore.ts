import { endAt, get, limitToLast, onValue, orderByChild, orderByKey, query, ref, startAt, update as updateDatabase } from 'firebase/database';
import { db } from '../config/firebase';
import { buildAuditEvents } from '../types/audit';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type FinanceData } from '../types/finance';
import { withOperationalFinance, type OperationalFinanceSources } from './operationalLedger';
import { financeDateKeyFromTimestamp, financeMonthRange, withExpensePaymentTotals, withPayrollPaymentTotals } from './financePayments';
import { validateFinanceRecords } from './financeValidation';
import { withFinanceWriteLock } from './financeTransactions';

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
  Object.entries(data.suppressed ?? {}).forEach(([id, suppressed]) => { if (suppressed) { delete incomes[id]; delete expenses[id]; } });
  const categoryAliases = { income: data.categoryAliases?.income ?? {}, expense: data.categoryAliases?.expense ?? {} };
  Object.values(expenses).forEach((entry) => { if (categoryAliases.expense[entry.category]) expenses[entry.id] = { ...entry, category: categoryAliases.expense[entry.category] }; });
  Object.values(incomes).forEach((income) => {
    if (typeof income.category === 'string' && income.category.trim().toLocaleLowerCase('pt-BR') === 'oyo') {
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
    expenseCategories: [...new Set([...normalizeCategories(data.expenseCategories, EXPENSE_CATEGORIES), 'Adiantamento de salário'])]
      .filter((category) => !categoryAliases.expense[category]),
    auditLog: data.auditLog ?? {},
    suppressed: data.suppressed ?? {},
    deletions: data.deletions ?? {},
    categoryAliases,
  };
}

export const financeStorageMode = 'Firebase';

const FINANCE_KEYS = ['incomes', 'expenses', 'transfers', 'payroll', 'openingBalances', 'incomeCategories', 'expenseCategories', 'auditLog', 'suppressed', 'categoryAliases'] as const;
const OPERATIONAL_PATHS = {
  stays: 'erp_geral/recepcao/stays', roomCharges: 'erp_geral/recepcao/roomCharges', cashOuts: 'erp_geral/recepcao/cashOuts',
  sales: 'erp_geral/frigobar/operations/sales', reservationCollections: 'erp_geral/reservationCollections',
  movements: 'erp_geral/estoque/movements', reservations: 'erp_geral/quartos/reservations',
};

function financeView(values: Record<string, unknown>, includeOperations: boolean): FinanceData {
  const data = normalizeFinance(values);
  return includeOperations ? withOperationalFinance(data, {
    stays: values.stays ?? {}, roomCharges: values.roomCharges ?? {}, cashOuts: values.cashOuts ?? {}, sales: values.sales ?? {},
    reservationCollections: values.reservationCollections ?? {}, movements: values.movements ?? {}, reservations: values.reservations ?? {},
  } as OperationalFinanceSources) : data;
}

export async function loadFinanceForMonth(month: string): Promise<FinanceData> {
  financeMonthRange(month);
  // Opening and closing balances require the complete history, including payments on bills due in other months.
  const paths = [...FINANCE_KEYS.filter((key) => key !== 'auditLog').map((key) => [key, `erp_geral/financeiro/${key}`]), ...Object.entries(OPERATIONAL_PATHS)];
  const snapshots = await Promise.all(paths.map(([, location]) => get(ref(db, location))));
  return financeView(Object.fromEntries(paths.map(([key], index) => [key, snapshots[index].val() ?? {}])), true);
}

export function subscribeFinance(
  onChange: (data: FinanceData) => void,
  onError: (error: Error) => void,
  options: { includeOperations?: boolean; transactionRange?: { from: string; to: string } } = {},
): () => void {
  const paths = [...FINANCE_KEYS.map((key) => [key, `erp_geral/financeiro/${key}`]), ...(options.includeOperations === false ? [] : Object.entries(OPERATIONAL_PATHS))];
  const loaded = new Set<string>();
  const values: Record<string, unknown> = {};
  const stops = paths.map(([key, location]) => {
    const path = ref(db, location);
    // Filtering only the source due/check-in date omits later installments and corrupts accumulated balances.
    const listener = key === 'auditLog' ? query(path, orderByChild('occurredAt'), limitToLast(100)) : path;
    return onValue(listener, (snapshot) => {
      values[key] = snapshot.val() ?? {};
      loaded.add(key);
      if (loaded.size === paths.length) {
        onChange(financeView(values, options.includeOperations !== false));
      }
    }, onError);
  });
  return () => stops.forEach((stop) => stop());
}

export function subscribeReservationPaymentIncomes(
  reservationIds: string[],
  onChange: (data: FinanceData) => void,
  onError: (error: Error) => void,
): () => void {
  const ids = [...new Set(reservationIds)];
  if (ids.length === 0) {
    onChange(normalizeFinance({}));
    return () => undefined;
  }
  const groups = new Map<string, FinanceData['incomes']>();
  const suppressedGroups = new Map<string, FinanceData['suppressed']>();
  const loaded = new Set<string>();
  onChange(normalizeFinance({}));
  const publish = () => {
    if (loaded.size !== ids.length * 2) return;
    const suppressed = Object.assign({}, ...suppressedGroups.values()) as FinanceData['suppressed'];
    const incomes = Object.fromEntries(Object.entries(Object.assign({}, ...groups.values()) as FinanceData['incomes'])
      .filter(([id]) => !suppressed[id]));
    onChange(normalizeFinance({ incomes, suppressed }));
  };
  const stops = ids.flatMap((reservationId) => {
    const prefix = `reservation-${reservationId}-`;
    const incomeQuery = query(
      ref(db, 'erp_geral/financeiro/incomes'),
      orderByKey(),
      startAt(prefix),
      endAt(`${prefix}\uf8ff`),
    );
    const suppressedQuery = query(
      ref(db, 'erp_geral/financeiro/suppressed'),
      orderByKey(), startAt(prefix), endAt(`${prefix}\uf8ff`),
    );
    const stopIncomes = onValue(incomeQuery, (snapshot) => {
      groups.set(reservationId, (snapshot.val() ?? {}) as FinanceData['incomes']);
      loaded.add(`incomes:${reservationId}`);
      publish();
    }, onError);
    const stopSuppressed = onValue(suppressedQuery, (snapshot) => {
      suppressedGroups.set(reservationId, (snapshot.val() ?? {}) as FinanceData['suppressed']);
      loaded.add(`suppressed:${reservationId}`);
      publish();
    }, onError);
    return [stopIncomes, stopSuppressed];
  });
  return () => stops.forEach((stop) => stop());
}

export async function updateFinance(
  update: (current: FinanceData) => FinanceData,
): Promise<void> {
  return withFinanceWriteLock(() => commitFinanceUpdate(update));
}

async function commitFinanceUpdate(update: (current: FinanceData) => FinanceData): Promise<void> {
  const operationId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const keys = ['incomes', 'expenses', 'transfers', 'payroll', 'openingBalances', 'incomeCategories', 'expenseCategories', 'suppressed', 'deletions', 'categoryAliases'] as const;
  const sourcePaths = Object.entries(OPERATIONAL_PATHS);
  const [snapshots, sourceSnapshots] = await Promise.all([
    Promise.all(keys.map((key) => get(ref(db, `erp_geral/financeiro/${key}`)))),
    Promise.all(sourcePaths.map(([, location]) => get(ref(db, location)))),
  ]);
  const raw = { ...Object.fromEntries(keys.map((key, index) => [key, snapshots[index].val() ?? {}])),
    ...Object.fromEntries(sourcePaths.map(([key], index) => [key, sourceSnapshots[index].val() ?? {}])) };
  // The editor sees the same source-only entries as the cash-flow screen; unchanged derived entries are never copied.
  const current = financeView(raw, true);
  const proposed = update(current);
  const next = { ...proposed, incomes: { ...proposed.incomes }, expenses: { ...proposed.expenses }, payroll: { ...proposed.payroll } };
  const paymentDate = financeDateKeyFromTimestamp(occurredAt);
  Object.entries(next.incomes).forEach(([id, entry]) => {
    if (/^(recepcao-|room-charge-|frigobar-|minibar-|reservation-)/.test(id)
      && JSON.stringify(entry) !== JSON.stringify(current.incomes[id])) next.incomes[id] = { ...entry, operationalOverride: true };
  });
  Object.entries(next.expenses).forEach(([id, entry]) => {
    const previous = current.expenses[id];
    if (JSON.stringify(entry) === JSON.stringify(previous)) return;
    if (JSON.stringify(entry.payments) === JSON.stringify(previous?.payments)) {
      next.expenses[id] = withExpensePaymentTotals(previous, entry, entry.paidDate || paymentDate, operationId);
    }
    if (/^(stock-entry-|caixa-|recepcao-)/.test(id)) next.expenses[id] = { ...next.expenses[id], operationalOverride: true };
  });
  Object.entries(next.payroll).forEach(([id, entry]) => {
    const previous = current.payroll[id];
    if (JSON.stringify(entry) === JSON.stringify(previous)) return;
    if (JSON.stringify(entry.payments) === JSON.stringify(previous?.payments)) {
      next.payroll[id] = withPayrollPaymentTotals(previous, entry, entry.paidDate || paymentDate, operationId);
    }
  });
  validateFinanceRecords(current, next);
  const updates: Record<string, unknown> = {};
  const changedRecords = (path: string, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) => {
    const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    ids.forEach((id) => {
      const previous = before?.[id];
      const value = after?.[id];
      if (JSON.stringify(previous) === JSON.stringify(value)) return;
      updates[`erp_geral/financeiro/${path}/${id}`] = value ?? null;
    });
  };
  changedRecords('incomes', current.incomes, next.incomes);
  changedRecords('expenses', current.expenses, next.expenses);
  changedRecords('transfers', current.transfers, next.transfers);
  changedRecords('payroll', current.payroll, next.payroll);
  changedRecords('suppressed', current.suppressed, next.suppressed);
  changedRecords('deletions', current.deletions, next.deletions);
  changedRecords('categoryAliases/income', current.categoryAliases?.income, next.categoryAliases?.income);
  changedRecords('categoryAliases/expense', current.categoryAliases?.expense, next.categoryAliases?.expense);
  if (JSON.stringify(current.openingBalances) !== JSON.stringify(next.openingBalances)) updates['erp_geral/financeiro/openingBalances'] = next.openingBalances;
  if (JSON.stringify(current.incomeCategories) !== JSON.stringify(next.incomeCategories)) updates['erp_geral/financeiro/incomeCategories'] = next.incomeCategories;
  if (JSON.stringify(current.expenseCategories) !== JSON.stringify(next.expenseCategories)) updates['erp_geral/financeiro/expenseCategories'] = next.expenseCategories;

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
  Object.entries(auditEvents).forEach(([id, event]) => {
    updates[`erp_geral/financeiro/auditLog/${id}`] = event;
  });
  if (Object.keys(updates).length > 0) await updateDatabase(ref(db), updates);
}
