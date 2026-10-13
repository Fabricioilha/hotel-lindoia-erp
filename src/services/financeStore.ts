import { endAt, get, limitToLast, onValue, orderByChild, orderByKey, query, ref, startAt, update as updateDatabase } from 'firebase/database';
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

function fiveYearsAgoDateKey(): string {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
}

function fiveYearsAgoTimestamp(): string {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  return cutoff.toISOString();
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
    expenseCategories: [...new Set([...normalizeCategories(data.expenseCategories, EXPENSE_CATEGORIES), 'Adiantamento de salário'])]
      .filter((category) => !categoryAliases.expense[category]),
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
  options: { includeOperations?: boolean; transactionRange?: { from: string; to: string } } = {},
): () => void {
  const financeKeys = options.transactionRange
    ? ['incomes', 'expenses', 'payroll', 'incomeCategories', 'expenseCategories', 'suppressed', 'categoryAliases'] as const
    : ['incomes', 'expenses', 'transfers', 'payroll', 'openingBalances', 'incomeCategories', 'expenseCategories', 'auditLog', 'suppressed', 'categoryAliases'] as const;
  const operationalPaths = {
    stays: 'erp_geral/recepcao/stays',
    roomCharges: 'erp_geral/recepcao/roomCharges',
    cashOuts: 'erp_geral/recepcao/cashOuts',
    sales: 'erp_geral/frigobar/operations/sales',
    reservationCollections: 'erp_geral/reservationCollections',
  };
  const operationEntries = Object.entries(operationalPaths).flatMap(([key, location]) =>
    options.transactionRange && key === 'sales'
      ? [['salesCreatedAt', location], ['salesSettledAt', location]]
      : [[key, location]],
  );
  const paths = [...financeKeys.map((key) => [key, `erp_geral/financeiro/${key}`]), ...(options.includeOperations === false ? [] : operationEntries)];
  const loaded = new Set<string>();
  const values: Record<string, unknown> = {};
  const stops = paths.map(([key, location]) => {
    const path = ref(db, location);
    const transactionDateField = key === 'incomes' ? 'date'
      : key === 'expenses' || key === 'payroll' ? 'dueDate'
        : key === 'transfers' ? 'date' : '';
    const dateField = key === 'stays' ? 'checkInDate'
      : key === 'roomCharges' || key === 'cashOuts' ? 'date'
        : key === 'sales' || key === 'salesCreatedAt' ? 'createdAt'
          : key === 'salesSettledAt' ? 'settledAt' : '';
    const rangeField = transactionDateField || dateField;
    const isTimestampField = key === 'sales' || key === 'salesCreatedAt' || key === 'salesSettledAt';
    const rangeStart = options.transactionRange
      ? isTimestampField ? new Date(`${options.transactionRange.from}T00:00:00`).toISOString() : options.transactionRange.from
      : '';
    const rangeEnd = options.transactionRange
      ? isTimestampField ? new Date(`${options.transactionRange.to}T23:59:59.999`).toISOString() : options.transactionRange.to
      : '';
    const listener = key === 'auditLog'
      ? query(path, orderByChild('occurredAt'), limitToLast(100))
      : options.transactionRange && rangeField
        ? query(path, orderByChild(rangeField), startAt(rangeStart), endAt(rangeEnd))
        : transactionDateField
          ? query(path, orderByChild(transactionDateField), startAt(fiveYearsAgoDateKey()))
      : dateField
        ? query(path, orderByChild(dateField), startAt(dateField === 'createdAt' ? fiveYearsAgoTimestamp() : fiveYearsAgoDateKey()))
        : path;
    return onValue(listener, (snapshot) => {
      values[key] = snapshot.val() ?? {};
      loaded.add(key);
      if (loaded.size === paths.length) {
        const data = normalizeFinance(values);
        const sales = options.transactionRange
          ? { ...((values.salesCreatedAt ?? {}) as Record<string, unknown>), ...((values.salesSettledAt ?? {}) as Record<string, unknown>) }
          : values.sales;
        onChange(options.includeOperations === false ? data : withOperationalFinance(data, {
          stays: values.stays, roomCharges: values.roomCharges, cashOuts: values.cashOuts,
          sales, reservationCollections: values.reservationCollections,
        } as OperationalFinanceSources));
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
  const loaded = new Set<string>();
  onChange(normalizeFinance({}));
  const stops = ids.map((reservationId) => {
    const prefix = `reservation-${reservationId}-`;
    const incomeQuery = query(
      ref(db, 'erp_geral/financeiro/incomes'),
      orderByKey(),
      startAt(prefix),
      endAt(`${prefix}\uf8ff`),
    );
    return onValue(incomeQuery, (snapshot) => {
      groups.set(reservationId, (snapshot.val() ?? {}) as FinanceData['incomes']);
      loaded.add(reservationId);
      if (loaded.size === ids.length) onChange(normalizeFinance({ incomes: Object.assign({}, ...groups.values()) }));
    }, onError);
  });
  return () => stops.forEach((stop) => stop());
}

export async function updateFinance(
  update: (current: FinanceData) => FinanceData,
): Promise<void> {
  const operationId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const keys = ['incomes', 'expenses', 'transfers', 'payroll', 'openingBalances', 'incomeCategories', 'expenseCategories', 'suppressed', 'deletions', 'categoryAliases'] as const;
  const snapshots = await Promise.all(keys.map((key) => get(ref(db, `erp_geral/financeiro/${key}`))));
  const raw = Object.fromEntries(keys.map((key, index) => [key, snapshots[index].val() ?? {}]));
  const current = normalizeFinance(raw);
  const next = update(current);
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
