import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      throw new Error(`Unexpected import: ${spec}`);
    };
    new Function('module', 'exports', 'require', compiled)(mod, mod.exports, req);
    return mod.exports;
  }
  return inner(relPath);
}

const pbMock = {
  db: {},
  ref: (_db, path = '') => ({ path }),
  onValue: () => () => undefined,
  set: async () => undefined,
};

const engine = loadTs('src/services/customReportEngine.ts');
const store = loadTs('src/services/reportDashboardStore.ts', { '/services/pocketbaseRealtime.ts': pbMock });
const types = loadTs('src/types/reportCharts.ts');
const repo = loadTs('src/services/financeRepository.ts', {
  '/config/pocketbase.ts': {
    pb: { authStore: { record: null, token: '' } },
    inspectApiErrorStatus: () => undefined,
    reportSystemBanner: () => undefined,
  },
});

function baseFinanceData() {
  return {
    cardStatements: {},
    cardFeeSchedule: {},
    cashAdjustments: {},
    openingBalances: { cash: 0, bank: 0, oyo: 0 },
    incomeCategories: ['Diária', 'Café', 'Taxas', 'Consumo'],
    expenseCategories: ['Material de limpeza', 'Manutenção', 'Café da Manhã', 'OYO'],
    auditLog: {},
    suppressed: {},
    incomes: {
      'inc-1': {
        id: 'inc-1', date: '2026-11-05', category: 'Diária', amount: 350, wallet: 'oyo',
        items: [
          { id: 'i1', description: 'Diária', amount: 300, paymentMethod: 'prepaid' },
          { id: 'i2', description: 'Taxa', amount: 50, paymentMethod: 'cash' },
        ],
        note: '', createdAt: '2026-11-05T10:00:00Z', updatedAt: '2026-11-05T10:00:00Z',
      },
      'inc-2': {
        id: 'inc-2', date: '2026-11-06', category: 'Café', amount: 120, wallet: 'bank',
        items: [{ id: 'i3', description: 'Café da manhã', amount: 120, paymentMethod: 'pix' }],
        note: '', createdAt: '2026-11-06T09:00:00Z', updatedAt: '2026-11-06T09:00:00Z',
      },
      'inc-3': {
        id: 'inc-3', date: '2026-11-07', category: 'Taxas', amount: 35.5, wallet: 'bank',
        items: [{ id: 'i4', description: 'Taxa', amount: 35.5, paymentMethod: 'credit', cardFeeRate: 3, cardFeeAmount: 1.07, netAmount: 34.43 }],
        note: '', createdAt: '2026-11-07T11:00:00Z', updatedAt: '2026-11-07T11:00:00Z',
      },
    },
    expenses: {
      'exp-limp': {
        id: 'exp-limp', dueDate: '2026-11-05', category: 'Material de limpeza', plannedAmount: 185.4,
        paidCash: 185.4, paidBank: 0, paidDate: '2026-11-05',
        payments: { p1: { id: 'p1', date: '2026-11-05', wallet: 'cash', amount: 185.4, dateSource: 'informed' } },
        note: '', createdAt: '2026-11-05T12:00:00Z', updatedAt: '2026-11-05T12:00:00Z',
      },
      'exp-man': {
        id: 'exp-man', dueDate: '2026-11-10', purchaseDate: '2026-11-06', category: 'Manutenção', plannedAmount: 420,
        paidCash: 0, paidBank: 200, paidDate: '2026-11-08',
        payments: { p2: { id: 'p2', date: '2026-11-08', wallet: 'bank', amount: 200, dateSource: 'informed' } },
        note: 'Chuveiro', createdAt: '2026-11-06T12:00:00Z', updatedAt: '2026-11-08T12:00:00Z',
      },
      'exp-cafe': {
        id: 'exp-cafe', dueDate: '2026-11-06', category: 'Café da Manhã', plannedAmount: 45,
        paidCash: 45, paidBank: 0, paidDate: '2026-11-06',
        payments: { p3: { id: 'p3', date: '2026-11-06', wallet: 'cash', amount: 45, dateSource: 'informed' } },
        note: 'Pães e leite', createdAt: '2026-11-06T08:00:00Z', updatedAt: '2026-11-06T08:00:00Z',
      },
      'exp-oyo': {
        id: 'exp-oyo', dueDate: '2026-11-05', category: 'OYO', plannedAmount: 50,
        paidCash: 0, paidBank: 0, paidOyo: 50, paidDate: '2026-11-05',
        payments: { p4: { id: 'p4', date: '2026-11-05', wallet: 'oyo', amount: 50, dateSource: 'informed' } },
        note: 'Compensado OYO', createdAt: '2026-11-05T14:00:00Z', updatedAt: '2026-11-05T14:00:00Z',
      },
    },
    transfers: {
      'tr-oyo': { id: 'tr-oyo', date: '2026-11-09', from: 'oyo', to: 'bank', amount: 210, note: 'Repasse OYO', createdAt: '2026-11-09T10:00:00Z' },
    },
    payroll: {},
  };
}

test('OYO retained, counter fees, repasses and compensated expenses match exact cent totals', () => {
  const widget = {
    id: 'w-oyo', title: 'OYO', description: '', chartType: 'bar', dimension: 'timeline', size: 'full', height: 'normal',
    series: [
      { id: 'ret', metricId: 'oyo_retained', color: '#4f46e5' },
      { id: 'cnt', metricId: 'oyo_counter_fees', color: '#ea580c' },
      { id: 'rep', metricId: 'oyo_repasses', color: '#147d6b' },
      { id: 'cmp', metricId: 'oyo_compensated', color: '#a37a36' },
      { id: 'cf', metricId: 'card_fees', color: '#d97706' },
    ],
    style: { ...types.DEFAULT_CHART_STYLE, showComparison: false },
  };
  const result = engine.evaluateChartWidget(widget, {
    data: baseFinanceData(),
    range: { from: '2026-11-01', to: '2026-11-30' },
    today: '2026-11-22',
    granularity: 'month',
  });
  const byId = Object.fromEntries(result.series.map((s) => [s.id, s.total]));
  assert.equal(byId.ret, 300);
  assert.equal(byId.cnt, 85.5); // 50 cash + 35.50 credit
  assert.equal(byId.rep, 210);
  assert.equal(byId.cmp, 50);
  assert.equal(byId.cf, 1.07);
});

test('dynamic expense categories support single category, multi-category sum, accrual vs cash basis and breakfast profit', () => {
  const widget = {
    id: 'w-cat', title: 'Categorias', description: '', chartType: 'bar', dimension: 'timeline', size: 'full', height: 'normal',
    series: [
      { id: 'limp', metricId: 'expense_by_category', categories: ['Material de limpeza'], basis: 'accrual', color: '#0891b2' },
      { id: 'man-accrual', metricId: 'expense_by_category', categories: ['Manutenção'], basis: 'accrual', color: '#c2410c' },
      { id: 'man-cash', metricId: 'expense_by_category', categories: ['Manutenção'], basis: 'cash', color: '#dc2626' },
      { id: 'combined', metricId: 'expense_by_category', categories: ['Material de limpeza', 'Manutenção'], basis: 'accrual', color: '#334155' },
      { id: 'cafe-profit', metricId: 'breakfast_profit', color: '#147d6b' },
      { id: 'cafe-margin', metricId: 'breakfast_margin', color: '#059669' },
    ],
    style: { ...types.DEFAULT_CHART_STYLE, showComparison: false },
  };
  const result = engine.evaluateChartWidget(widget, {
    data: baseFinanceData(),
    range: { from: '2026-11-01', to: '2026-11-30' },
    today: '2026-11-22',
    granularity: 'month',
  });
  const byId = Object.fromEntries(result.series.map((s) => [s.id, s.total]));
  assert.equal(byId.limp, 185.4);
  assert.equal(byId['man-accrual'], 420);
  assert.equal(byId['man-cash'], 200);
  assert.equal(byId.combined, 605.4);
  assert.equal(byId['cafe-profit'], 75); // 120 - 45
  assert.equal(byId['cafe-margin'], 62.5); // 75 / 120 * 100
  assert.equal(result.hasRightAxis, true); // mixed currency + percent
  assert.equal(result.rightUnit, 'percent');
});

test('fridge profit computes exact revenue, CMV, profit, margin, product ranking and coverage notice', () => {
  const inventoryProducts = {
    'p-agua': { id: 'p-agua', name: 'Água 500ml', sku: '', category: 'frigobar', unit: 'un', minimumQuantity: 5, cost: 1.5, averageCost: 1.25, salePrice: 5, locationQuantities: {}, supplierId: '', expiresAt: '', description: '', createdAt: '', updatedAt: '' },
    'p-refri': { id: 'p-refri', name: 'Refrigerante', sku: '', category: 'frigobar', unit: 'un', minimumQuantity: 5, cost: 3.0, salePrice: 8, locationQuantities: {}, supplierId: '', expiresAt: '', description: '', createdAt: '', updatedAt: '' },
  };
  const frigobarSales = {
    's1': {
      id: 's1', amount: 26, settlement: 'pago_na_recepcao', paymentMethod: 'pix', roomNumber: '101', guestName: 'João', actor: 'Rec',
      createdAt: '2026-11-10T15:00:00Z',
      items: [
        { productId: 'p-agua', productName: 'Água 500ml', quantity: 2, unit: 'un', unitPrice: 5 }, // rev 10, cmv 2.50, profit 7.50
        { productId: 'p-refri', productName: 'Refrigerante', quantity: 2, unit: 'un', unitPrice: 8 }, // rev 16, cmv 6.00, profit 10.00
      ],
    },
    's2': {
      id: 's2', amount: 10, settlement: 'pago_na_recepcao', paymentMethod: 'dinheiro', roomNumber: '102', guestName: 'Maria', actor: 'Rec',
      createdAt: '2026-11-11T15:00:00Z',
      items: [
        { productId: 'p-antigo', productName: 'Snack antigo', quantity: 1, unit: 'un', unitPrice: 10 }, // no cost in inventory!
      ],
    },
  };
  const widget = {
    id: 'w-fridge', title: 'Geladeira', description: '', chartType: 'horizontal_bar', dimension: 'fridge_product', size: 'full', height: 'normal',
    series: [
      { id: 'rev', metricId: 'fridge_revenue', color: '#2563eb' },
      { id: 'cmv', metricId: 'fridge_cogs', color: '#bd624a' },
      { id: 'prof', metricId: 'fridge_profit', color: '#059669' },
      { id: 'qty', metricId: 'fridge_units', color: '#7b5cb8' },
    ],
    style: { ...types.DEFAULT_CHART_STYLE, showComparison: false },
  };
  const result = engine.evaluateChartWidget(widget, {
    data: baseFinanceData(),
    range: { from: '2026-11-01', to: '2026-11-30' },
    today: '2026-11-22',
    granularity: 'month',
    inventoryProducts,
    frigobarSales,
  });
  const byId = Object.fromEntries(result.series.map((s) => [s.id, s.total]));
  assert.equal(byId.rev, 36);
  assert.equal(byId.cmv, 8.5);
  assert.equal(byId.prof, 27.5);
  assert.equal(byId.qty, 5);
  assert.equal(result.rows[0].label, 'Refrigerante');
  assert.equal(result.rows[0].values.prof, 10);
  assert.ok(result.dataNotes.some((n) => n.includes('2 de 3 itens')), 'Should report transparent CMV coverage');
});

test('housekeeper performance computes completed rooms, avg cleaning minutes (excluding >8h outliers) and logs', () => {
  const cleaningTasks = {
    t1: { id: 't1', roomNumber: '101', camareira: 'Juliana', status: 'concluido', assignedBy: 'Rec', assignedAt: '2026-11-10T10:00:00Z', completedAt: '2026-11-10T10:30:00Z', date: '2026-11-10' }, // 30m
    t2: { id: 't2', roomNumber: '102', camareira: 'Juliana', status: 'concluido', assignedBy: 'Rec', assignedAt: '2026-11-10T11:00:00Z', completedAt: '2026-11-10T11:40:00Z', date: '2026-11-10' }, // 40m -> avg 35m
    t3: { id: 't3', roomNumber: '103', camareira: 'Amanda', status: 'concluido', assignedBy: 'Rec', assignedAt: '2026-11-10T09:00:00Z', completedAt: '2026-11-10T09:20:00Z', date: '2026-11-10' }, // 20m
    t4: { id: 't4', roomNumber: '104', camareira: 'Amanda', status: 'concluido', assignedBy: 'Rec', assignedAt: '2026-11-10T08:00:00Z', completedAt: '2026-11-10T20:00:00Z', date: '2026-11-10' }, // 12h outlier -> excluded from avg
    t5: { id: 't5', roomNumber: '105', camareira: 'Amanda', status: 'cancelado', assignedBy: 'Rec', assignedAt: '2026-11-10T10:00:00Z', date: '2026-11-10' },
  };
  const cleaningLogs = {
    l1: { id: 'l1', roomId: 'r1', roomNumber: '101', attendant: 'Juliana', date: '2026-11-10', completedAt: '2026-11-10T10:30:00Z', doorsAndWindows: true, usageConcern: true, note: '' },
  };
  const widget = {
    id: 'w-hk', title: 'Camareiras', description: '', chartType: 'composed', dimension: 'housekeeper', size: 'full', height: 'normal',
    series: [
      { id: 'done', metricId: 'cleaning_completed', color: '#4c60cf', visualType: 'bar', yAxis: 'left' },
      { id: 'avg', metricId: 'cleaning_avg_minutes', color: '#d97706', visualType: 'line', yAxis: 'right' },
      { id: 'canc', metricId: 'cleaning_canceled', color: '#dc2626', visualType: 'bar', yAxis: 'left' },
      { id: 'dw', metricId: 'cleaning_doors_windows', color: '#147d6b', visualType: 'bar', yAxis: 'left' },
      { id: 'conc', metricId: 'cleaning_concerns', color: '#be185d', visualType: 'bar', yAxis: 'left' },
    ],
    style: { ...types.DEFAULT_CHART_STYLE, showComparison: false },
  };
  const result = engine.evaluateChartWidget(widget, {
    data: baseFinanceData(),
    range: { from: '2026-11-01', to: '2026-11-30' },
    today: '2026-11-22',
    granularity: 'month',
    cleaningTasks,
    cleaningLogs,
  });
  const byName = Object.fromEntries(result.rows.map((r) => [r.label, r.values]));
  assert.equal(byName.Juliana.done, 2);
  assert.equal(byName.Juliana.avg, 35);
  assert.equal(byName.Juliana.dw, 1);
  assert.equal(byName.Juliana.conc, 1);
  assert.equal(byName.Amanda.done, 2);
  assert.equal(byName.Amanda.avg, 20); // outlier 12h excluded!
  assert.equal(byName.Amanda.canc, 1);
  assert.equal(result.hasRightAxis, true);
  assert.equal(result.rightUnit, 'minutes');
});

test('dashboard config sanitizer, on-demand source detection and FinanceRepository persistence routing work cleanly', () => {
  // Invalid input falls back to curated 4 default dashboards
  const fallback = store.normalizeDashboardsConfig(null);
  assert.equal(fallback.dashboards.length, 4);

  // On-demand operational sources: Visão Geral needs 0 extra operational subscriptions!
  const overviewSources = store.requiredSourcesForDashboard(fallback.dashboards[0]);
  assert.equal(overviewSources.size, 0);

  // Operação & Camareiras needs cleaning, cleaningLogs, outputs, inventory
  const opsSources = store.requiredSourcesForDashboard(fallback.dashboards[3]);
  assert.ok(opsSources.has('cleaning'));
  assert.ok(opsSources.has('cleaningLogs'));
  assert.ok(opsSources.has('outputs'));
  assert.ok(opsSources.has('inventory'));

  // FinanceRepository maps erp_geral/financeiro/reportDashboards into financeMutation.config.reportDashboards
  const translated = repo.translatePathsToFinanceMutation({
    'erp_geral/financeiro/reportDashboards': fallback,
  });
  assert.equal(translated.hasFinanceUpdates, true);
  assert.deepEqual(translated.financeMutation.config.reportDashboards, fallback);
  assert.deepEqual(translated.stateUpdates, {});
});
