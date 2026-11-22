import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadTs(relPath, mocks = {}) {
  const cache = new Map();
  function inner(filePath) {
    const filename = resolve(root, filePath);
    const normalized = filename.replaceAll('\\', '/');
    for (const [suffix, value] of Object.entries(mocks)) {
      if (normalized.endsWith(suffix)) return value;
    }
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const src = readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(src, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const req = (spec) => {
      if (spec.startsWith('.')) {
        return inner(resolve(dirname(filename), spec.endsWith('.ts') ? spec : `${spec}.ts`));
      }
      if (mocks[spec]) return mocks[spec];
      throw new Error(`Unexpected external import in unit test: ${spec}`);
    };
    new Function('module', 'exports', 'require', compiled)(mod, mod.exports, req);
    return mod.exports;
  }
  return inner(relPath);
}

test('translatePathsToFinanceMutation routes every finance section and separates cross-module state updates', () => {
  const repo = loadTs('src/services/financeRepository.ts', {
    '/config/pocketbase.ts': {
      pb: { authStore: { record: null, token: '' } },
      inspectApiErrorStatus: () => undefined,
      reportSystemBanner: () => undefined,
    },
  });

  const translated = repo.translatePathsToFinanceMutation({
    'erp_geral/financeiro/incomes/inc-1': { id: 'inc-1', date: '2026-11-01', category: 'Diária', amount: 250, wallet: 'bank', note: '', createdAt: '', updatedAt: '' },
    'erp_geral/financeiro/expenses/exp-1': { id: 'exp-1', dueDate: '2026-11-05', category: 'Mercado', plannedAmount: 100, paidCash: 100, paidBank: 0, note: '', createdAt: '', updatedAt: '' },
    'erp_geral/financeiro/cardStatements/st-1': { id: 'st-1', cardCategory: 'Cartão', dueDate: '2026-11-10', originalDueDates: { 'exp-1': '2026-11-05' } },
    'erp_geral/financeiro/payroll/pr-1': { id: 'pr-1', month: '2026-11', dueDate: '2026-12-05', employee: 'Ana', position: 'Recepção', basePay: 2000, additions: 0, deductions: 0, paidCash: 0, paidBank: 2000, note: '', createdAt: '', updatedAt: '' },
    'erp_geral/financeiro/transfers/tr-1': { id: 'tr-1', date: '2026-11-02', from: 'cash', to: 'bank', amount: 500, note: 'Depósito', createdAt: '' },
    'erp_geral/financeiro/cashAdjustments/adj-1': { id: 'adj-1', date: '2026-11-03', amount: -10, note: 'Quebra', createdAt: '', updatedAt: '' },
    'erp_geral/financeiro/oyoReconciliations/2026-11': { closingBalance: -1500.5, updatedAt: '2026-11-22T00:00:00Z' },
    'erp_geral/financeiro/suppressed/old-1': true,
    'erp_geral/financeiro/deletions/del-1': { token: 't1', status: 'done' },
    'erp_geral/financeiro/cashCollectionAcks/ack-1': { signature: 's1', acknowledgedAt: '2026-11-01T00:00:00Z', acknowledgedBy: 'u1' },
    'erp_geral/financeiro/cleaningConcernAcks/cack-1': { signature: 's2', acknowledgedAt: '2026-11-01T00:00:00Z', acknowledgedBy: 'u1' },
    'erp_geral/financeiro/cardFeeSchedule/cf-1': { effectiveAt: '2026-11-01T00:00:00Z', credit: 3.19, debit: 1.5 },
    'erp_geral/financeiro/auditLog/ev-1': { id: 'ev-1', entity: 'finance-expense', recordId: 'exp-1', action: 'criado', actorUid: 'u1', occurredAt: '2026-11-01T00:00:00Z' },
    'erp_geral/financeiro/openingBalances': { cash: 100, bank: 200, oyo: 300 },
    'erp_geral/financeiro/incomeCategories': ['Diária', 'Frigobar'],
    'erp_geral/financeiro/expenseCategories': ['Mercado'],
    'erp_geral/financeiro/categoryAliases/expense/Antiga': 'Nova',
    'erp_geral/financeiro/managerWriteLock': { startedAt: Date.now() },
    'erp_geral/recepcao/stays/stay-1/voidedPayments/inc-1': true,
    'erp_geral/estoque/movements/mov-1': null,
  });

  assert.equal(translated.hasFinanceUpdates, true);
  assert.equal(translated.financeMutation.incomes['inc-1'].amount, 250);
  assert.equal(translated.financeMutation.expenses['exp-1'].plannedAmount, 100);
  assert.equal(translated.financeMutation.cardStatements['st-1'].dueDate, '2026-11-10');
  assert.equal(translated.financeMutation.payroll['pr-1'].employee, 'Ana');
  assert.equal(translated.financeMutation.transfers['tr-1'].amount, 500);
  assert.equal(translated.financeMutation.cashAdjustments['adj-1'].amount, -10);
  assert.equal(translated.financeMutation.oyoReconciliations['2026-11'].closingBalance, -1500.5);
  assert.equal(translated.financeMutation.suppressed['old-1'], true);
  assert.equal(translated.financeMutation.deletions['del-1'].status, 'done');
  assert.equal(translated.financeMutation.cashCollectionAcks['ack-1'].signature, 's1');
  assert.equal(translated.financeMutation.cleaningConcernAcks['cack-1'].signature, 's2');
  assert.equal(translated.financeMutation.cardFeeSchedule['cf-1'].credit, 3.19);
  assert.equal(translated.financeMutation.auditLog['ev-1'].action, 'criado');
  assert.deepEqual(translated.financeMutation.config.openingBalances, { cash: 100, bank: 200, oyo: 300 });
  assert.deepEqual(translated.financeMutation.config.incomeCategories, ['Diária', 'Frigobar']);
  assert.deepEqual(translated.financeMutation.config.expenseCategories, ['Mercado']);
  assert.deepEqual(translated.financeMutation.config.categoryAliases, { expense: { Antiga: 'Nova' } });
  assert.deepEqual(translated.stateUpdates, {
    'erp_geral/recepcao/stays/stay-1/voidedPayments/inc-1': true,
    'erp_geral/estoque/movements/mov-1': null,
  });

  assert.throws(
    () => repo.translatePathsToFinanceMutation({ 'erp_geral/financeiro': { incomes: {} } }),
    /monolítica/i,
  );
});

test('historicalBalancesFromSummaries matches exact cent balances from finance_monthly_summaries', () => {
  const analytics = loadTs('src/services/financeAnalytics.ts');
  const summaries = {
    '2026-09': {
      summaryKey: 'month:2026-09', month: '2026-09', wallet: 'all', category: '__all__',
      incomeDirectCents: 100000, incomePrepaidCents: 50000, expensePaidCents: 40000, payrollPaidCents: 0,
      transfersInCents: 0, transfersOutCents: 0, adjustmentsNetCents: 0, netChangeCents: 60000,
      closingCashCents: 12345, closingBankCents: 67890, closingOyoCents: 54321,
      entryCount: 10, breakdown: {}, rebuiltAt: '2026-10-01T00:00:00Z',
    },
    '2026-10': {
      summaryKey: 'month:2026-10', month: '2026-10', wallet: 'all', category: '__all__',
      incomeDirectCents: 200000, incomePrepaidCents: 25000, expensePaidCents: 90000, payrollPaidCents: 10000,
      transfersInCents: 0, transfersOutCents: 0, adjustmentsNetCents: 0, netChangeCents: 100000,
      closingCashCents: 33333, closingBankCents: 99999, closingOyoCents: 77777,
      entryCount: 20, breakdown: {}, rebuiltAt: '2026-11-01T00:00:00Z',
    },
  };
  const opening = { cash: 10, bank: 20, oyo: 30 };

  assert.deepEqual(analytics.historicalBalancesFromSummaries(summaries, opening, '2026-08'), { cash: 10, bank: 20, oyo: 30 });
  assert.deepEqual(analytics.historicalBalancesFromSummaries(summaries, opening, '2026-09'), { cash: 123.45, bank: 678.9, oyo: 543.21 });
  assert.deepEqual(analytics.historicalBalancesFromSummaries(summaries, opening, '2026-10'), { cash: 333.33, bank: 999.99, oyo: 777.77 });
  assert.deepEqual(analytics.historicalBalancesFromSummaries(summaries, opening, '2026-11'), { cash: 333.33, bank: 999.99, oyo: 777.77 });
});

test('balancesAtDate summary fast-path matches full-history balances to 0 cents (including operational-only & cross-month partial payments)', () => {
  const analytics = loadTs('src/services/financeAnalytics.ts');
  const opening = { cash: 100, bank: 500, oyo: 0 };

  // Full history: Sep 2026 (persisted + operational-only) + Oct 2026 (persisted + cross-month partial payment + transfer + adjustment)
  const fullData = {
    openingBalances: opening,
    incomes: {
      'inc-sep-persisted': { id: 'inc-sep-persisted', date: '2026-09-10', category: 'Diária', amount: 300, wallet: 'bank', items: [{ id: 'i1', description: 'Diária', amount: 300, paymentMethod: 'pix' }], note: '', createdAt: '', updatedAt: '' },
      'inc-sep-op-only': { id: 'inc-sep-op-only', date: '2026-09-20', category: 'Diária', amount: 50, wallet: 'cash', items: [{ id: 'i2', description: 'Diária', amount: 50, paymentMethod: 'cash' }], note: '', createdAt: '', updatedAt: '' },
      'inc-oct-persisted': { id: 'inc-oct-persisted', date: '2026-10-05', category: 'Diária', amount: 250.55, wallet: 'oyo', items: [{ id: 'i3', description: 'Diária', amount: 250.55, paymentMethod: 'prepaid' }], note: '', createdAt: '', updatedAt: '' },
    },
    expenses: {
      'exp-sep-persisted': { id: 'exp-sep-persisted', dueDate: '2026-09-15', category: 'Mercado', plannedAmount: 80, paidCash: 80, paidBank: 0, paidDate: '2026-09-15', payments: { p1: { id: 'p1', date: '2026-09-15', wallet: 'cash', amount: 80, dateSource: 'informed' } }, note: '', createdAt: '', updatedAt: '' },
      'exp-cross-month': {
        id: 'exp-cross-month', dueDate: '2026-10-10', category: 'Energia', plannedAmount: 200, paidCash: 0, paidBank: 200, paidDate: '2026-10-10',
        payments: {
          p2a: { id: 'p2a', date: '2026-09-28', wallet: 'bank', amount: 75.25, dateSource: 'informed' },
          p2b: { id: 'p2b', date: '2026-10-10', wallet: 'bank', amount: 124.75, dateSource: 'informed' },
        },
        note: '', createdAt: '', updatedAt: '',
      },
    },
    transfers: {
      'tr-sep': { id: 'tr-sep', date: '2026-09-29', from: 'cash', to: 'bank', amount: 10, note: '', createdAt: '' },
      'tr-oct': { id: 'tr-oct', date: '2026-10-12', from: 'bank', to: 'cash', amount: 25, note: '', createdAt: '' },
    },
    payroll: {},
    cashAdjustments: {
      'adj-oct': { id: 'adj-oct', date: '2026-10-15', amount: -3.5, note: '', createdAt: '', updatedAt: '' },
    },
    cardStatements: {}, auditLog: {}, suppressed: {}, incomeCategories: [], expenseCategories: [],
  };

  // Persisted-only September summary:
  // cash: 100 - 80 (exp-sep) - 10 (tr-sep) = 10.00 (1000c)
  // bank: 500 + 300 (inc-sep-persisted) - 75.25 (p2a) + 10 (tr-sep) = 734.75 (73475c)
  // oyo: 0
  const periodFilteredData = {
    openingBalances: opening,
    monthlySummaries: {
      '2026-09': {
        summaryKey: 'month:2026-09', month: '2026-09', wallet: 'all', category: '__all__',
        incomeDirectCents: 30000, incomePrepaidCents: 0, expensePaidCents: 15525, payrollPaidCents: 0,
        transfersInCents: 1000, transfersOutCents: 1000, adjustmentsNetCents: 0, netChangeCents: 14475,
        closingCashCents: 1000, closingBankCents: 73475, closingOyoCents: 0,
        entryCount: 4, breakdown: {}, rebuiltAt: '2026-10-01T00:00:00Z',
      },
    },
    loadedPeriod: { from: '2026-10-01', to: '2026-10-31' },
    persistedIds: { incomes: ['inc-oct-persisted'], expenses: ['exp-cross-month'] },
    incomes: {
      'inc-sep-op-only': fullData.incomes['inc-sep-op-only'],
      'inc-oct-persisted': fullData.incomes['inc-oct-persisted'],
    },
    expenses: {
      'exp-cross-month': fullData.expenses['exp-cross-month'],
    },
    transfers: { 'tr-oct': fullData.transfers['tr-oct'] },
    payroll: {},
    cashAdjustments: fullData.cashAdjustments,
    cardStatements: {}, auditLog: {}, suppressed: {}, incomeCategories: [], expenseCategories: [],
  };

  for (const date of ['2026-09-30', '2026-10-05', '2026-10-10', '2026-10-15', '2026-10-31']) {
    assert.deepEqual(
      analytics.balancesAtDate(periodFilteredData, date),
      analytics.balancesAtDate(fullData, date),
      `Period-filtered balance diverged from full history on ${date}`,
    );
  }
});

test('system banner reacts deterministically to HTTP 426 (upgrade required) and HTTP 503 (maintenance)', () => {
  const src = readFileSync(resolve(root, 'src/config/pocketbase.ts'), 'utf8');
  assert.match(src, /export const ERP_SCHEMA_VERSION = 2;/);
  assert.match(src, /headers\.set\('X-ERP-Schema-Version', String\(ERP_SCHEMA_VERSION\)\)/);

  const sanitized = src.replace(/import\.meta\.env\.VITE_POCKETBASE_URL/g, '"http://127.0.0.1:8090"');
  const compiled = ts.transpileModule(sanitized, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  class FakePocketBase {
    constructor(url) { this.url = url; this.beforeSend = null; }
    autoCancellation() {}
  }
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, (spec) => {
    if (spec === 'pocketbase') return { __esModule: true, default: FakePocketBase };
    throw new Error(`Unexpected import: ${spec}`);
  });
  const cfg = mod.exports;
  assert.equal(cfg.ERP_SCHEMA_VERSION, 2);
  const req = cfg.pb.beforeSend('http://127.0.0.1:8090/api/hotel/finance/meta', {});
  assert.equal(req.options.headers['x-erp-schema-version'], '2');

  const events = [];
  const stop = cfg.subscribeSystemBanner((s) => events.push({ ...s }));
  const err503 = Object.assign(new Error('Janela de cutover'), { status: 503 });
  cfg.inspectApiErrorStatus(err503);
  assert.equal(events.at(-1).maintenanceReadonly, true);
  assert.equal(events.at(-1).maintenanceMessage, 'Janela de cutover');
  const err426 = Object.assign(new Error('Recarregue'), { status: 426 });
  cfg.inspectApiErrorStatus(err426);
  assert.equal(events.at(-1).upgradeRequired, true);
  stop();
});

// Integration suite against real PocketBase v0.41.1 staging binary (runs automatically when local staging binary exists)
const STAGING_BIN = '/home/fabricio/Downloads/hotel-lindoia-staging/bin/pocketbase';
const hasStagingBinary = existsSync(STAGING_BIN);

async function startTempPocketBase(port, tmpDir) {
  mkdirSync(tmpDir, { recursive: true });
  const proc = spawn(STAGING_BIN, [
    'serve',
    `--http=127.0.0.1:${port}`,
    `--dir=${tmpDir}`,
    `--migrationsDir=${resolve(root, 'pocketbase/pb_migrations')}`,
    `--hooksDir=${resolve(root, 'pocketbase/pb_hooks')}`,
    '--hooksPool=3',
    '--hooksWatch=false',
  ], {
    env: { ...process.env, GOMEMLIMIT: '350MiB' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return { proc, baseUrl };
    } catch {
      // Wait for startup
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGTERM');
  throw new Error(`PocketBase did not start on ${baseUrl}`);
}

async function createSuperuser(tmpDir, email, password) {
  await new Promise((resolveDone, rejectDone) => {
    const proc = spawn(STAGING_BIN, [
      'superuser', 'upsert', email, password,
      `--dir=${tmpDir}`,
      `--migrationsDir=${resolve(root, 'pocketbase/pb_migrations')}`,
    ], { stdio: 'ignore' });
    proc.on('exit', (code) => (code === 0 ? resolveDone() : rejectDone(new Error(`superuser upsert failed (${code})`))));
  });
}

async function apiJson(baseUrl, path, { method = 'GET', token, body, schemaVersion = '2' } = {}) {
  const headers = {};
  if (token) headers.Authorization = token;
  if (schemaVersion !== null) headers['X-ERP-Schema-Version'] = schemaVersion;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, ok: res.ok, data: json };
}

test('PocketBase 0.41.1 integration: atomicity, 10-way concurrency (0 HTTP 409), CAS conflicts, RBAC, 503/426 guards', { skip: !hasStagingBinary }, async () => {
  const tmpDir = '/tmp/hotel-lindoia-test-pb-normalized';
  const port = 18094;
  const superEmail = 'admin-test@hotel.local';
  const superPass = 'TestPass123456!';

  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  await createSuperuser(tmpDir, superEmail, superPass);
  const { proc, baseUrl } = await startTempPocketBase(port, tmpDir);

  try {
    // Authenticate superuser
    const superAuth = await apiJson(baseUrl, '/api/collections/_superusers/auth-with-password', {
      method: 'POST',
      body: { identity: superEmail, password: superPass },
    });
    assert.equal(superAuth.status, 200);
    const superToken = superAuth.data.token;

    // Seed an admin user + viewer user + hotel_state branch
    const adminUser = await apiJson(baseUrl, '/api/collections/users/records', {
      method: 'POST',
      token: superToken,
      body: { email: 'gerente@hotel.local', password: 'UserPass123456!', passwordConfirm: 'UserPass123456!' },
    });
    assert.equal(adminUser.status, 200);
    const viewerUser = await apiJson(baseUrl, '/api/collections/users/records', {
      method: 'POST',
      token: superToken,
      body: { email: 'recepcao@hotel.local', password: 'UserPass123456!', passwordConfirm: 'UserPass123456!' },
    });
    assert.equal(viewerUser.status, 200);

    await apiJson(baseUrl, '/api/collections/user_roles/records', {
      method: 'POST',
      token: superToken,
      body: { user: adminUser.data.id, role: 'admin' },
    });
    await apiJson(baseUrl, '/api/collections/user_roles/records', {
      method: 'POST',
      token: superToken,
      body: { user: viewerUser.data.id, role: 'viewer' },
    });

    const adminAuth = await apiJson(baseUrl, '/api/collections/users/auth-with-password', {
      method: 'POST',
      body: { identity: 'gerente@hotel.local', password: 'UserPass123456!' },
    });
    const viewerAuth = await apiJson(baseUrl, '/api/collections/users/auth-with-password', {
      method: 'POST',
      body: { identity: 'recepcao@hotel.local', password: 'UserPass123456!' },
    });
    const adminToken = adminAuth.data.token;
    const viewerToken = viewerAuth.data.token;

    // Seed hotel_state branch erp_geral/recepcao
    const seedState = await apiJson(baseUrl, '/api/hotel/state/commit', {
      method: 'POST',
      token: adminToken,
      body: { expected: { 'erp_geral/recepcao': null }, updates: { 'erp_geral/recepcao/stays/s1': { id: 's1' } } },
    });
    assert.equal(seedState.status, 200);

    // 1) 10-way concurrent distinct expense writes -> ZERO HTTP 409, exact cent sum!
    const concurrentResults = await Promise.all(
      Array.from({ length: 10 }, (_, idx) => apiJson(baseUrl, '/api/hotel/finance/mutate', {
        method: 'POST',
        token: adminToken,
        body: {
          mutation: {
            expenses: {
              [`conc-exp-${idx}`]: {
                id: `conc-exp-${idx}`,
                dueDate: '2026-11-15',
                category: 'Mercado',
                plannedAmount: 12.34,
                paidCash: 12.34,
                paidBank: 0,
                paidDate: '2026-11-15',
                payments: {
                  [`p-${idx}`]: { id: `p-${idx}`, date: '2026-11-15', wallet: 'cash', amount: 12.34, dateSource: 'informed' },
                },
                note: `Concurrent #${idx}`,
                createdAt: '2026-11-15T10:00:00Z',
                updatedAt: '2026-11-15T10:00:00Z',
              },
            },
            auditLog: {
              [`ev-conc-${idx}`]: {
                id: `ev-conc-${idx}`,
                entity: 'finance-expense',
                recordId: `conc-exp-${idx}`,
                action: 'criado',
                actorUid: adminUser.data.id,
                occurredAt: '2026-11-15T10:00:00Z',
              },
            },
          },
        },
      })),
    );
    const conflictCount = concurrentResults.filter((r) => r.status === 409).length;
    assert.equal(conflictCount, 0, `Expected 0 HTTP 409 conflicts on distinct concurrent writes, got ${conflictCount}`);
    assert.ok(concurrentResults.every((r) => r.status === 200));

    const summariesAfterConc = await apiJson(baseUrl, '/api/hotel/finance/summaries', { token: adminToken });
    assert.equal(summariesAfterConc.status, 200);
    assert.equal(summariesAfterConc.data.items.length, 1);
    assert.equal(summariesAfterConc.data.items[0].expensePaidCents, 12340); // 10 * 1234 cents exact!
    assert.equal(summariesAfterConc.data.items[0].closingCashCents, -12340);

    // 2) Atomicity rollback: finance write + stale stateExpected MUST roll back BOTH finance and hotel_state!
    const failedAtomic = await apiJson(baseUrl, '/api/hotel/finance/mutate', {
      method: 'POST',
      token: adminToken,
      body: {
        stateUpdates: { 'erp_geral/recepcao/stays/s1/note': 'should-rollback' },
        stateExpected: { 'erp_geral/recepcao': 999 }, // stale revision!
        mutation: {
          expenses: {
            'rollback-exp': {
              id: 'rollback-exp',
              dueDate: '2026-11-16',
              category: 'Mercado',
              plannedAmount: 500,
              paidCash: 500,
              paidBank: 0,
              note: 'Must never commit',
              createdAt: '2026-11-16T10:00:00Z',
              updatedAt: '2026-11-16T10:00:00Z',
            },
          },
        },
      },
    });
    assert.equal(failedAtomic.status, 409);
    const verifyRollback = await apiJson(baseUrl, '/api/hotel/finance/path?path=expenses/rollback-exp', { token: adminToken });
    assert.equal(verifyRollback.data.value, null, 'Expense must be completely rolled back on transaction abort');

    // 3) Same-record optimistic concurrency (CAS): 2 concurrent writes to SAME expense with version=1 -> 1x200, 1x409
    const pathVer = await apiJson(baseUrl, '/api/hotel/finance/path?path=expenses/conc-exp-0', { token: adminToken });
    assert.equal(pathVer.data.versionKey, 'expense:conc-exp-0');
    assert.equal(pathVer.data.version, 1);
    const [casA, casB] = await Promise.all([
      apiJson(baseUrl, '/api/hotel/finance/mutate', {
        method: 'POST',
        token: adminToken,
        body: {
          mutation: {
            expectedVersions: { 'expense:conc-exp-0': 1 },
            expenses: { 'conc-exp-0': { ...pathVer.data.value, note: 'Winner A' } },
          },
        },
      }),
      apiJson(baseUrl, '/api/hotel/finance/mutate', {
        method: 'POST',
        token: adminToken,
        body: {
          mutation: {
            expectedVersions: { 'expense:conc-exp-0': 1 },
            expenses: { 'conc-exp-0': { ...pathVer.data.value, note: 'Winner B' } },
          },
        },
      }),
    ]);
    assert.deepEqual([casA.status, casB.status].sort(), [200, 409]);

    // 4) Concurrent deletion claim CAS on config:deletions -> 1x200, 1x409
    const delVer = await apiJson(baseUrl, '/api/hotel/finance/path?path=deletions', { token: adminToken });
    assert.equal(delVer.data.versionKey, 'config:deletions');
    const [delA, delB] = await Promise.all([
      apiJson(baseUrl, '/api/hotel/finance/mutate', {
        method: 'POST',
        token: adminToken,
        body: {
          mutation: {
            expectedVersions: { 'config:deletions': delVer.data.version },
            deletions: { 'stay-claim-1': { token: 'tA', status: 'pending' } },
          },
        },
      }),
      apiJson(baseUrl, '/api/hotel/finance/mutate', {
        method: 'POST',
        token: adminToken,
        body: {
          mutation: {
            expectedVersions: { 'config:deletions': delVer.data.version },
            deletions: { 'stay-claim-1': { token: 'tB', status: 'pending' } },
          },
        },
      }),
    ]);
    assert.deepEqual([delA.status, delB.status].sort(), [200, 409]);

    // 5) RBAC: viewer cannot read snapshot or mutate, but CAN read cardFeeSchedule & meta
    assert.equal((await apiJson(baseUrl, '/api/hotel/finance/meta', { token: viewerToken })).status, 200);
    assert.equal((await apiJson(baseUrl, '/api/hotel/finance/path?path=cardFeeSchedule', { token: viewerToken })).status, 200);
    assert.equal((await apiJson(baseUrl, '/api/hotel/finance/snapshot', { token: viewerToken })).status, 403);
    assert.equal((await apiJson(baseUrl, '/api/hotel/finance/mutate', { method: 'POST', token: viewerToken, body: { mutation: {} } })).status, 403);

    // 6) Maintenance 503 + Stale Schema 426 + Legacy Freeze 426
    await apiJson(baseUrl, '/api/hotel/finance/system-meta', {
      method: 'POST',
      token: superToken,
      body: { maintenanceReadonly: true, minSchemaVersion: 2, financeLegacyFrozen: true, financeMode: 'normalized' },
    });
    // Old client without X-ERP-Schema-Version: 2 -> HTTP 426!
    assert.equal((await apiJson(baseUrl, '/api/hotel/finance/snapshot', { token: adminToken, schemaVersion: '1' })).status, 426);
    // New client during maintenance -> read 200, write 503!
    assert.equal((await apiJson(baseUrl, '/api/hotel/finance/snapshot', { token: adminToken, schemaVersion: '2' })).status, 200);
    assert.equal((await apiJson(baseUrl, '/api/hotel/finance/mutate', { method: 'POST', token: adminToken, schemaVersion: '2', body: { mutation: {} } })).status, 503);
    // Disable maintenance, keep legacy frozen -> writing erp_geral/financeiro via legacy commit returns 426!
    await apiJson(baseUrl, '/api/hotel/finance/system-meta', {
      method: 'POST',
      token: superToken,
      body: { maintenanceReadonly: false },
    });
    const legacyWrite = await apiJson(baseUrl, '/api/hotel/state/commit', {
      method: 'POST',
      token: adminToken,
      schemaVersion: '2',
      body: { expected: { 'erp_geral/financeiro': null }, updates: { 'erp_geral/financeiro/incomes/x': { id: 'x' } } },
    });
    assert.equal(legacyWrite.status, 426);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.once('exit', r));
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
