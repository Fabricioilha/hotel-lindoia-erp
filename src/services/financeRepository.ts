import { inspectApiErrorStatus, pb, reportSystemBanner } from '../config/pocketbase';
import type { AuditEvent } from '../types/audit';
import type {
  CardStatement,
  CashAdjustment,
  FinanceData,
  FinanceExpense,
  FinanceIncome,
  FinanceMonthlySummary,
  FinancePaymentEvent,
  FinanceTransfer,
  PayrollEntry,
} from '../types/finance';

export interface FinanceSystemMeta {
  schemaVersion: number;
  minSchemaVersion: number;
  maintenanceReadonly: boolean;
  maintenanceMessage: string;
  financeLegacyFrozen: boolean;
  financeMode: 'legacy' | 'normalized';
  lastBackfillAt: string | null;
}

export interface FinanceSnapshotResponse {
  data: FinanceData & {
    oyoReconciliations?: Record<string, unknown>;
    cashCollectionAcks?: Record<string, unknown>;
    cleaningConcernAcks?: Record<string, unknown>;
  };
  summaries: Record<string, FinanceMonthlySummary>;
  versions: Record<string, number>;
  filtered: boolean;
}

export interface FinanceMutationPayload {
  incomes?: Record<string, FinanceIncome | null>;
  expenses?: Record<string, FinanceExpense | null>;
  cardStatements?: Record<string, CardStatement | null>;
  payroll?: Record<string, PayrollEntry | null>;
  transfers?: Record<string, FinanceTransfer | null>;
  cashAdjustments?: Record<string, CashAdjustment | null>;
  oyoReconciliations?: Record<string, unknown | null>;
  suppressed?: Record<string, boolean | null>;
  deletions?: Record<string, { token: string; status: string } | null>;
  cashCollectionAcks?: Record<string, unknown | null>;
  cleaningConcernAcks?: Record<string, unknown | null>;
  cardFeeSchedule?: Record<string, { effectiveAt: string; credit: number; debit: number } | null>;
  config?: {
    openingBalances?: FinanceData['openingBalances'];
    incomeCategories?: string[];
    expenseCategories?: string[];
    categoryAliases?: {
      income?: Record<string, string | null>;
      expense?: Record<string, string | null>;
    };
  };
  auditLog?: Record<string, AuditEvent | null>;
  expectedVersions?: Record<string, number | null>;
  skipSummaryRebuild?: boolean;
}

export interface NormalizedSnapshotOptions {
  from?: string;
  to?: string;
  includeAudit?: boolean;
  auditLimit?: number;
  includeSummaries?: boolean;
  includePendingOutsideRange?: boolean;
}

const DEFAULT_META: FinanceSystemMeta = {
  schemaVersion: 2,
  minSchemaVersion: 1,
  maintenanceReadonly: false,
  maintenanceMessage: '',
  financeLegacyFrozen: false,
  financeMode: 'legacy',
  lastBackfillAt: null,
};

let cachedMeta: { value: FinanceSystemMeta; fetchedAt: number; authToken: string } | null = null;
let metaInFlight: Promise<FinanceSystemMeta> | null = null;
const META_TTL_MS = 15_000;

export function hasLivePocketBaseClient(): boolean {
  return Boolean(pb && typeof pb.send === 'function' && typeof pb.collection === 'function');
}

export function resetFinanceMetaCache(): void {
  cachedMeta = null;
  metaInFlight = null;
}

export async function getFinanceSystemMeta(forceRefresh = false): Promise<FinanceSystemMeta> {
  if (!hasLivePocketBaseClient()) return { ...DEFAULT_META };
  const token = pb.authStore?.token ?? '';
  if (!token) return { ...DEFAULT_META };
  if (!forceRefresh && cachedMeta && cachedMeta.authToken === token && Date.now() - cachedMeta.fetchedAt < META_TTL_MS) {
    return cachedMeta.value;
  }
  if (!forceRefresh && metaInFlight) return metaInFlight;
  metaInFlight = pb.send<FinanceSystemMeta>('/api/hotel/finance/meta', {})
    .then((meta) => {
      const normalized: FinanceSystemMeta = { ...DEFAULT_META, ...meta };
      cachedMeta = { value: normalized, fetchedAt: Date.now(), authToken: token };
      if (typeof reportSystemBanner === 'function') {
        reportSystemBanner({
          maintenanceReadonly: Boolean(normalized.maintenanceReadonly),
          maintenanceMessage: normalized.maintenanceMessage || '',
        });
      }
      return normalized;
    })
    .catch((error) => {
      if (typeof inspectApiErrorStatus === 'function') inspectApiErrorStatus(error);
      return cachedMeta?.value ?? { ...DEFAULT_META };
    })
    .finally(() => {
      metaInFlight = null;
    });
  return metaInFlight;
}

export async function isNormalizedFinanceActive(forceRefresh = false): Promise<boolean> {
  const meta = await getFinanceSystemMeta(forceRefresh);
  return meta.financeMode === 'normalized';
}

export function translatePathsToFinanceMutation(
  absoluteUpdates: Record<string, unknown>,
): {
  hasFinanceUpdates: boolean;
  financeMutation: FinanceMutationPayload;
  stateUpdates: Record<string, unknown>;
} {
  const financeMutation: FinanceMutationPayload = {};
  const stateUpdates: Record<string, unknown> = {};
  let hasFinanceUpdates = false;

  const ensureMap = <K extends keyof FinanceMutationPayload>(key: K) => {
    const existing = financeMutation[key];
    if (existing && typeof existing === 'object') return existing as Record<string, unknown>;
    const fresh: Record<string, unknown> = {};
    (financeMutation as Record<string, unknown>)[key as string] = fresh;
    return fresh;
  };

  for (const [rawPath, value] of Object.entries(absoluteUpdates)) {
    const normalized = rawPath.split('/').filter(Boolean).join('/');
    if (normalized !== 'erp_geral/financeiro' && !normalized.startsWith('erp_geral/financeiro/')) {
      stateUpdates[normalized] = value;
      continue;
    }
    hasFinanceUpdates = true;
    const rel = normalized === 'erp_geral/financeiro' ? [] : normalized.slice('erp_geral/financeiro/'.length).split('/');
    if (rel.length === 0) {
      throw new Error('Sobrescrita monolítica de erp_geral/financeiro não é permitida na arquitetura normalizada.');
    }
    const [section, key, nested] = rel;
    if (section === 'managerWriteLock') {
      continue;
    }
    if (section === 'incomes' && key) {
      ensureMap('incomes')[key] = value as FinanceIncome | null;
    } else if (section === 'expenses' && key) {
      ensureMap('expenses')[key] = value as FinanceExpense | null;
    } else if (section === 'cardStatements' && key) {
      ensureMap('cardStatements')[key] = value as CardStatement | null;
    } else if (section === 'payroll' && key) {
      ensureMap('payroll')[key] = value as PayrollEntry | null;
    } else if (section === 'transfers' && key) {
      ensureMap('transfers')[key] = value as FinanceTransfer | null;
    } else if (section === 'cashAdjustments' && key) {
      ensureMap('cashAdjustments')[key] = value as CashAdjustment | null;
    } else if (section === 'oyoReconciliations' && key) {
      ensureMap('oyoReconciliations')[key] = value;
    } else if (section === 'suppressed' && key) {
      ensureMap('suppressed')[key] = value as boolean | null;
    } else if (section === 'deletions' && key) {
      ensureMap('deletions')[key] = value as { token: string; status: string } | null;
    } else if (section === 'deletions' && !key && value && typeof value === 'object') {
      Object.assign(ensureMap('deletions'), value as Record<string, unknown>);
    } else if (section === 'cashCollectionAcks' && key) {
      ensureMap('cashCollectionAcks')[key] = value;
    } else if (section === 'cleaningConcernAcks' && key) {
      ensureMap('cleaningConcernAcks')[key] = value;
    } else if (section === 'cardFeeSchedule' && key) {
      ensureMap('cardFeeSchedule')[key] = value as { effectiveAt: string; credit: number; debit: number } | null;
    } else if (section === 'auditLog' && key) {
      ensureMap('auditLog')[key] = value as AuditEvent | null;
    } else if (section === 'openingBalances') {
      financeMutation.config = { ...(financeMutation.config ?? {}), openingBalances: value as FinanceData['openingBalances'] };
    } else if (section === 'incomeCategories') {
      financeMutation.config = { ...(financeMutation.config ?? {}), incomeCategories: value as string[] };
    } else if (section === 'expenseCategories') {
      financeMutation.config = { ...(financeMutation.config ?? {}), expenseCategories: value as string[] };
    } else if (section === 'categoryAliases') {
      const cfg = (financeMutation.config ??= {});
      const aliases = (cfg.categoryAliases ??= {});
      if ((key === 'income' || key === 'expense') && nested) {
        aliases[key] = { ...(aliases[key] ?? {}), [nested]: value as string | null };
      } else if (key === 'income' || key === 'expense') {
        aliases[key] = value as Record<string, string | null>;
      } else if (value && typeof value === 'object') {
        cfg.categoryAliases = value as { income?: Record<string, string | null>; expense?: Record<string, string | null> };
      }
    }
  }

  return { hasFinanceUpdates, financeMutation, stateUpdates };
}

export async function loadNormalizedFinanceSnapshot(options: NormalizedSnapshotOptions = {}): Promise<FinanceSnapshotResponse> {
  try {
    const query: Record<string, string | number> = {};
    if (options.from) query.from = options.from;
    if (options.to) query.to = options.to;
    if (options.includeAudit === false) query.includeAudit = 0;
    if (options.auditLimit !== undefined) query.auditLimit = options.auditLimit;
    if (options.includeSummaries === false) query.includeSummaries = 0;
    if (options.includePendingOutsideRange === false) query.includePendingOutsideRange = 0;
    return await pb.send<FinanceSnapshotResponse>('/api/hotel/finance/snapshot', { query });
  } catch (error) {
    inspectApiErrorStatus(error);
    throw error;
  }
}

export async function loadNormalizedFinancePathWithVersion<T = unknown>(
  subPath: string,
): Promise<{ value: T | null; versionKey: string | null; version: number | null }> {
  try {
    const res = await pb.send<{ value: T | null; versionKey?: string | null; version?: number | null }>('/api/hotel/finance/path', {
      query: { path: subPath.replace(/^\/+|\/+$/g, '') },
    });
    return {
      value: res.value ?? null,
      versionKey: res.versionKey ?? null,
      version: res.version ?? null,
    };
  } catch (error) {
    inspectApiErrorStatus(error);
    throw error;
  }
}

export async function loadNormalizedFinancePath<T = unknown>(subPath: string): Promise<T | null> {
  const res = await loadNormalizedFinancePathWithVersion<T>(subPath);
  return res.value;
}

export async function loadMonthlySummaries(options: { fromMonth?: string; toMonth?: string } = {}): Promise<FinanceMonthlySummary[]> {
  try {
    const query: Record<string, string> = {};
    if (options.fromMonth) query.fromMonth = options.fromMonth;
    if (options.toMonth) query.toMonth = options.toMonth;
    const res = await pb.send<{ items: FinanceMonthlySummary[] }>('/api/hotel/finance/summaries', { query });
    return res.items ?? [];
  } catch (error) {
    inspectApiErrorStatus(error);
    throw error;
  }
}

export async function commitNormalizedFinance(
  mutation: FinanceMutationPayload,
  stateUpdates?: Record<string, unknown>,
  stateExpected?: Record<string, number | null>,
): Promise<{ committed: boolean; changed: number }> {
  const hasState = Boolean(stateUpdates && Object.keys(stateUpdates).length > 0);
  const stateRoots = hasState
    ? [...new Set(Object.keys(stateUpdates!).map((path) => path.split('/').filter(Boolean).slice(0, 2).join('/')))]
    : [];

  for (let attempt = 0; attempt < 8; attempt++) {
    const versions: Record<string, number | null> = {};
    if (hasState) {
      await Promise.all(stateRoots.map(async (root) => {
        if (stateExpected && Object.hasOwn(stateExpected, root)) {
          versions[root] = stateExpected[root];
          return;
        }
        const current = await pb.send<{ versions: Record<string, number | null> }>('/api/hotel/state', {
          query: { path: root, versionOnly: 1 },
        });
        versions[root] = current.versions[root] ?? null;
      }));
    }

    try {
      return await pb.send<{ committed: boolean; changed: number }>('/api/hotel/finance/mutate', {
        method: 'POST',
        body: {
          mutation,
          ...(hasState ? { stateUpdates, stateExpected: versions } : {}),
        },
      });
    } catch (error) {
      inspectApiErrorStatus(error);
      const isConflict = Boolean(error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 409);
      const callerPinned = Boolean(
        (stateExpected && Object.keys(stateExpected).length > 0)
        || (mutation.expectedVersions && Object.keys(mutation.expectedVersions).length > 0),
      );
      if (!isConflict || callerPinned || !hasState || attempt === 7) throw error;
    }
  }
  throw new Error('Não foi possível concluir a gravação financeira após várias tentativas.');
}

// Convert PocketBase SSE realtime record payloads into domain objects for in-memory delta patching.
function fromCents(value: unknown): number {
  return (Number(value) || 0) / 100;
}

function parseJsonField<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }
  return raw as T;
}

function pbRecordToIncome(rec: Record<string, unknown>): FinanceIncome {
  const items = parseJsonField<FinanceIncome['items'] | null>(rec.items_json, null);
  const out: FinanceIncome = {
    id: String(rec.entry_id),
    date: String(rec.date),
    category: String(rec.category),
    amount: fromCents(rec.amount_cents),
    wallet: (String(rec.wallet || 'bank')) as FinanceIncome['wallet'],
    note: String(rec.note ?? ''),
    createdAt: String(rec.created_at ?? ''),
    updatedAt: String(rec.updated_at ?? ''),
  };
  if (Array.isArray(items) && items.length > 0) out.items = items;
  if (rec.operational_override) out.operationalOverride = true;
  return out;
}

function pbRecordToPayment(rec: Record<string, unknown>): FinancePaymentEvent {
  const ev: FinancePaymentEvent = {
    id: String(rec.payment_id),
    date: String(rec.paid_at),
    wallet: String(rec.wallet) as FinancePaymentEvent['wallet'],
    amount: fromCents(rec.amount_cents),
  };
  if (rec.note) ev.note = String(rec.note);
  if (rec.statement_id) ev.cardStatementId = String(rec.statement_id);
  if (rec.date_source === 'informed' || rec.date_source === 'legacy_due_date') ev.dateSource = rec.date_source;
  return ev;
}

function pbRecordToExpense(rec: Record<string, unknown>, existingPayments?: Record<string, FinancePaymentEvent>): FinanceExpense {
  const out: FinanceExpense = {
    id: String(rec.entry_id),
    dueDate: String(rec.date),
    category: String(rec.category),
    plannedAmount: fromCents(rec.amount_cents),
    paidCash: fromCents(rec.paid_cash_cents),
    paidBank: fromCents(rec.paid_bank_cents),
    note: String(rec.note ?? ''),
    createdAt: String(rec.created_at ?? ''),
    updatedAt: String(rec.updated_at ?? ''),
  };
  const paidOyo = fromCents(rec.paid_oyo_cents);
  if (paidOyo !== 0) out.paidOyo = paidOyo;
  if (rec.paid_date) out.paidDate = String(rec.paid_date);
  if (rec.has_explicit_payments) out.payments = existingPayments ?? {};
  if (rec.purchase_method) out.purchaseMethod = String(rec.purchase_method) as FinanceExpense['purchaseMethod'];
  if (rec.purchase_date) out.purchaseDate = String(rec.purchase_date);
  if (rec.card_category) out.cardCategory = String(rec.card_category);
  if (rec.card_statement_id) out.cardStatementId = String(rec.card_statement_id);
  if (rec.employee) out.employee = String(rec.employee);
  if (rec.employee_id) out.employeeId = String(rec.employee_id);
  if (rec.advance_month) out.advanceMonth = String(rec.advance_month);
  if (rec.generated_from_income) out.generatedFromIncome = String(rec.generated_from_income);
  if (rec.operational_override) out.operationalOverride = true;
  return out;
}

function pbRecordToPayroll(rec: Record<string, unknown>, existingPayments?: Record<string, FinancePaymentEvent>): PayrollEntry {
  const advances = parseJsonField<Record<string, number> | null>(rec.advances_json, null);
  const out: PayrollEntry = {
    id: String(rec.payroll_id),
    month: String(rec.month),
    dueDate: String(rec.due_date),
    employee: String(rec.employee),
    position: String(rec.position ?? ''),
    basePay: fromCents(rec.base_pay_cents),
    additions: fromCents(rec.additions_cents),
    deductions: fromCents(rec.deductions_cents),
    paidCash: fromCents(rec.paid_cash_cents),
    paidBank: fromCents(rec.paid_bank_cents),
    note: String(rec.note ?? ''),
    createdAt: String(rec.created_at ?? ''),
    updatedAt: String(rec.updated_at ?? ''),
  };
  if (rec.employee_id) out.employeeId = String(rec.employee_id);
  if (rec.paid_date) out.paidDate = String(rec.paid_date);
  if (advances && Object.keys(advances).length > 0) out.advances = advances;
  if (rec.has_explicit_payments) out.payments = existingPayments ?? {};
  return out;
}

function pbRecordToStatement(rec: Record<string, unknown>): CardStatement {
  const out: CardStatement = {
    id: String(rec.statement_id),
    cardCategory: String(rec.card_category),
    dueDate: String(rec.due_date),
    originalDueDates: parseJsonField<Record<string, string>>(rec.original_due_dates_json, {}),
  };
  if (rec.paid) {
    out.payment = {
      date: String(rec.paid_date),
      wallet: String(rec.paid_wallet) as 'cash' | 'bank',
      amount: fromCents(rec.paid_amount_cents),
    };
  }
  return out;
}

function pbRecordToSummary(rec: Record<string, unknown>): FinanceMonthlySummary {
  return {
    summaryKey: String(rec.summary_key),
    month: String(rec.month),
    wallet: String(rec.wallet ?? 'all'),
    category: String(rec.category ?? '__all__'),
    incomeDirectCents: Number(rec.income_direct_cents) || 0,
    incomePrepaidCents: Number(rec.income_prepaid_cents) || 0,
    expensePaidCents: Number(rec.expense_paid_cents) || 0,
    payrollPaidCents: Number(rec.payroll_paid_cents) || 0,
    transfersInCents: Number(rec.transfers_in_cents) || 0,
    transfersOutCents: Number(rec.transfers_out_cents) || 0,
    adjustmentsNetCents: Number(rec.adjustments_net_cents) || 0,
    netChangeCents: Number(rec.net_change_cents) || 0,
    closingCashCents: Number(rec.closing_cash_cents) || 0,
    closingBankCents: Number(rec.closing_bank_cents) || 0,
    closingOyoCents: Number(rec.closing_oyo_cents) || 0,
    entryCount: Number(rec.entry_count) || 0,
    breakdown: parseJsonField(rec.breakdown_json, {}),
    rebuiltAt: String(rec.rebuilt_at ?? ''),
  };
}

/**
 * Delta-based PocketBase SSE realtime subscription for the normalized finance domain.
 * Downloads initial snapshot once (filtered by period if supplied), then patches individual
 * records in memory on SSE create/update/delete events instead of refetching the full JSON.
 */
export function subscribeNormalizedFinance(
  onChange: (snapshot: FinanceSnapshotResponse) => void,
  onError: (error: Error) => void,
  options: NormalizedSnapshotOptions = {},
): () => void {
  let active = true;
  let state: FinanceSnapshotResponse | null = null;
  let emitTimer: number | null = null;
  const unsubscribes: (() => Promise<void> | void)[] = [];
  const auditLimit = options.auditLimit ?? 100;
  const rangeFrom = options.from ?? '';
  const rangeTo = options.to ?? '';

  const inRange = (date: string) => !rangeFrom || !rangeTo || (date >= rangeFrom && date <= rangeTo);

  const scheduleEmit = () => {
    if (!active || !state) return;
    if (emitTimer !== null) return;
    // Coalesce multi-table events from a single transaction into one React render frame.
    emitTimer = window.setTimeout(() => {
      emitTimer = null;
      if (!active || !state) return;
      onChange({
        data: {
          ...state.data,
          incomes: { ...state.data.incomes },
          expenses: { ...state.data.expenses },
          cardStatements: { ...(state.data.cardStatements ?? {}) },
          transfers: { ...state.data.transfers },
          payroll: { ...state.data.payroll },
          cashAdjustments: { ...(state.data.cashAdjustments ?? {}) },
          auditLog: { ...state.data.auditLog },
          suppressed: { ...state.data.suppressed },
          monthlySummaries: { ...state.summaries },
          ...(rangeFrom && rangeTo ? { loadedPeriod: { from: rangeFrom, to: rangeTo } } : {}),
        },
        summaries: { ...state.summaries },
        versions: { ...state.versions },
        filtered: state.filtered,
      });
    }, 40);
  };

  const applyEvent = (collectionName: string, action: string, rec: Record<string, unknown>) => {
    if (!state) return;
    if (collectionName === 'finance_entries') {
      const id = String(rec.entry_id);
      const type = String(rec.type);
      if (action === 'delete') {
        if (type === 'income') delete state.data.incomes[id];
        else delete state.data.expenses[id];
      } else if (type === 'income') {
        if (inRange(String(rec.date))) state.data.incomes[id] = pbRecordToIncome(rec);
        else delete state.data.incomes[id];
      } else if (type === 'expense') {
        const keep = inRange(String(rec.date))
          || (rec.purchase_date ? inRange(String(rec.purchase_date)) : false)
          || (rec.paid_date ? inRange(String(rec.paid_date)) : false)
          || (options.includePendingOutsideRange !== false && ['pending', 'partial', 'unassigned_card'].includes(String(rec.status)));
        if (keep) {
          const prevPayments = state.data.expenses[id]?.payments;
          state.data.expenses[id] = pbRecordToExpense(rec, prevPayments);
        } else {
          delete state.data.expenses[id];
        }
      }
      scheduleEmit();
      return;
    }

    if (collectionName === 'finance_payments') {
      if (!rec.is_explicit) return;
      const parentType = String(rec.parent_type);
      const entryId = String(rec.entry_id);
      const paymentId = String(rec.payment_id);
      if (parentType === 'expense' && state.data.expenses[entryId]) {
        const current = state.data.expenses[entryId];
        const nextPayments = { ...(current.payments ?? {}) };
        if (action === 'delete') delete nextPayments[paymentId];
        else nextPayments[paymentId] = pbRecordToPayment(rec);
        state.data.expenses[entryId] = { ...current, payments: nextPayments };
        scheduleEmit();
      } else if (parentType === 'payroll' && state.data.payroll[entryId]) {
        const current = state.data.payroll[entryId];
        const nextPayments = { ...(current.payments ?? {}) };
        if (action === 'delete') delete nextPayments[paymentId];
        else nextPayments[paymentId] = pbRecordToPayment(rec);
        state.data.payroll[entryId] = { ...current, payments: nextPayments };
        scheduleEmit();
      }
      return;
    }

    if (collectionName === 'finance_card_statements') {
      const id = String(rec.statement_id);
      const map = (state.data.cardStatements ??= {});
      if (action === 'delete') delete map[id];
      else map[id] = pbRecordToStatement(rec);
      scheduleEmit();
      return;
    }

    if (collectionName === 'finance_payroll_records') {
      const id = String(rec.payroll_id);
      if (action === 'delete') delete state.data.payroll[id];
      else {
        const prevPayments = state.data.payroll[id]?.payments;
        state.data.payroll[id] = pbRecordToPayroll(rec, prevPayments);
      }
      scheduleEmit();
      return;
    }

    if (collectionName === 'finance_transfers_adjustments') {
      const kind = String(rec.kind);
      const id = String(rec.record_id);
      if (kind === 'transfer') {
        if (action === 'delete') delete state.data.transfers[id];
        else if (inRange(String(rec.date))) {
          state.data.transfers[id] = {
            id,
            date: String(rec.date),
            from: String(rec.from_wallet) as FinanceTransfer['from'],
            to: String(rec.to_wallet) as FinanceTransfer['to'],
            amount: fromCents(rec.amount_cents),
            note: String(rec.note ?? ''),
            createdAt: String(rec.created_at ?? ''),
            ...(rec.oyo_recom_month ? { oyoRecomMonth: String(rec.oyo_recom_month) } : {}),
          };
        }
      } else if (kind === 'cash_adjustment') {
        const map = (state.data.cashAdjustments ??= {});
        if (action === 'delete') delete map[id];
        else if (inRange(String(rec.date))) {
          map[id] = {
            id,
            date: String(rec.date),
            amount: fromCents(rec.amount_cents),
            note: String(rec.note ?? ''),
            createdAt: String(rec.created_at ?? ''),
            updatedAt: String(rec.updated_at ?? ''),
          };
        }
      } else if (kind === 'oyo_reconciliation') {
        const map = (state.data.oyoReconciliations ??= {});
        if (action === 'delete') delete map[id];
        else map[id] = parseJsonField(rec.payload_json, {});
      }
      scheduleEmit();
      return;
    }

    if (collectionName === 'finance_config') {
      const key = String(rec.config_key);
      const val = parseJsonField(rec.value_json, null);
      if (key === 'systemMeta' && val && typeof val === 'object') {
        const meta = val as Partial<FinanceSystemMeta>;
        reportSystemBanner({
          maintenanceReadonly: Boolean(meta.maintenanceReadonly),
          maintenanceMessage: meta.maintenanceMessage ?? '',
        });
        return;
      }
      if (key === 'openingBalances' && val) state.data.openingBalances = val as FinanceData['openingBalances'];
      else if (key === 'incomeCategories' && Array.isArray(val)) state.data.incomeCategories = val as string[];
      else if (key === 'expenseCategories' && Array.isArray(val)) state.data.expenseCategories = val as string[];
      else if (key === 'categoryAliases' && val) state.data.categoryAliases = val as FinanceData['categoryAliases'];
      else if (key === 'cardFeeSchedule' && val) state.data.cardFeeSchedule = val as FinanceData['cardFeeSchedule'];
      else if (key === 'suppressed' && val) state.data.suppressed = val as Record<string, boolean>;
      else if (key === 'deletions' && val) state.data.deletions = val as FinanceData['deletions'];
      else if (key === 'cashCollectionAcks' && val) state.data.cashCollectionAcks = val as Record<string, unknown>;
      else if (key === 'cleaningConcernAcks' && val) state.data.cleaningConcernAcks = val as Record<string, unknown>;
      scheduleEmit();
      return;
    }

    if (collectionName === 'finance_monthly_summaries') {
      const month = String(rec.month);
      if (action === 'delete') delete state.summaries[month];
      else state.summaries[month] = pbRecordToSummary(rec);
      scheduleEmit();
      return;
    }

    if (collectionName === 'finance_audit_logs' && options.includeAudit !== false) {
      const id = String(rec.event_id);
      if (action === 'delete') {
        delete state.data.auditLog[id];
      } else {
        state.data.auditLog[id] = {
          id,
          entity: String(rec.entity_type),
          recordId: String(rec.entity_id ?? ''),
          action: String(rec.action) as AuditEvent['action'],
          actorUid: String(rec.actor_uid ?? ''),
          occurredAt: String(rec.occurred_at ?? ''),
        };
        const keys = Object.keys(state.data.auditLog);
        if (auditLimit > 0 && keys.length > auditLimit) {
          const sorted = Object.values(state.data.auditLog)
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
            .slice(0, auditLimit);
          state.data.auditLog = Object.fromEntries(sorted.map((ev) => [ev.id, ev]));
        }
      }
      scheduleEmit();
    }
  };

  void (async () => {
    try {
      const initial = await loadNormalizedFinanceSnapshot(options);
      if (!active) return;
      state = initial;
      scheduleEmit();

      const collections = [
        'finance_entries',
        'finance_payments',
        'finance_card_statements',
        'finance_payroll_records',
        'finance_transfers_adjustments',
        'finance_config',
        ...(options.includeSummaries !== false ? ['finance_monthly_summaries'] : []),
        ...(options.includeAudit !== false ? ['finance_audit_logs'] : []),
      ];

      await Promise.all(collections.map(async (name) => {
        try {
          const unsub = await pb.collection(name).subscribe('*', (ev) => {
            applyEvent(name, ev.action, ev.record as Record<string, unknown>);
          });
          if (!active) {
            void unsub();
            return;
          }
          unsubscribes.push(unsub);
        } catch (subErr) {
          // Graceful fallback if SSE fails transiently (e.g. proxy hiccup)
          inspectApiErrorStatus(subErr);
        }
      }));
    } catch (cause) {
      if (active) {
        onError(cause instanceof Error ? cause : new Error('Falha ao carregar o financeiro normalizado.'));
      }
    }
  })();

  return () => {
    active = false;
    if (emitTimer !== null) {
      window.clearTimeout(emitTimer);
      emitTimer = null;
    }
    unsubscribes.forEach((unsub) => {
      try { void unsub(); } catch { /* ignore cleanup error */ }
    });
  };
}

/**
 * Targeted delta realtime listener for a specific sub-path under erp_geral/financeiro/...
 * Subscribes only to the minimal PocketBase collection backing that sub-path.
 */
export function subscribeNormalizedFinancePath(
  subPath: string,
  onChange: (value: unknown) => void,
  onError?: (error: Error) => void,
): () => void {
  let active = true;
  let previous = '';
  let refreshTimer: number | null = null;
  const unsubscribes: (() => Promise<void> | void)[] = [];
  const clean = subPath.replace(/^\/+|\/+$/g, '');
  const section = clean.split('/')[0] || '';

  const collectionMap: Record<string, string[]> = {
    incomes: ['finance_entries'],
    expenses: ['finance_entries', 'finance_payments'],
    payroll: ['finance_payroll_records', 'finance_payments'],
    cardStatements: ['finance_card_statements'],
    transfers: ['finance_transfers_adjustments'],
    cashAdjustments: ['finance_transfers_adjustments'],
    oyoReconciliations: ['finance_transfers_adjustments'],
    auditLog: ['finance_audit_logs'],
    openingBalances: ['finance_config'],
    incomeCategories: ['finance_config'],
    expenseCategories: ['finance_config'],
    categoryAliases: ['finance_config'],
    cardFeeSchedule: ['finance_config'],
    suppressed: ['finance_config'],
    deletions: ['finance_config'],
    cashCollectionAcks: ['finance_config'],
    cleaningConcernAcks: ['finance_config'],
  };
  const targetCollections = collectionMap[section] ?? ['finance_entries', 'finance_config'];

  const refresh = async () => {
    try {
      const value = await loadNormalizedFinancePath(clean);
      if (!active) return;
      const serialized = JSON.stringify(value);
      if (serialized === previous) return;
      previous = serialized;
      onChange(value);
    } catch (cause) {
      if (active) onError?.(cause instanceof Error ? cause : new Error('Falha ao consultar o financeiro.'));
    }
  };

  const scheduleRefresh = () => {
    if (!active || refreshTimer !== null) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      if (active) void refresh();
    }, 50);
  };

  void (async () => {
    await refresh();
    if (!active) return;
    await Promise.all(targetCollections.map(async (name) => {
      try {
        const unsub = await pb.collection(name).subscribe('*', () => scheduleRefresh());
        if (!active) { void unsub(); return; }
        unsubscribes.push(unsub);
      } catch (subErr) {
        inspectApiErrorStatus(subErr);
      }
    }));
  })();

  return () => {
    active = false;
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    unsubscribes.forEach((unsub) => {
      try { void unsub(); } catch { /* ignore */ }
    });
  };
}
