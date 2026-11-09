import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isolatedDomain(state = {}, options = {}) {
  const cache = new Map();
  const writes = [];
  const listeners = [];
  let remainingUpdateFailures = options.failUpdates ?? 0;
  const read = (path) => path.split('/').filter(Boolean).reduce((value, key) => value?.[key], state) ?? null;
  const write = (path, value) => {
    const keys = path.split('/').filter(Boolean);
    let parent = state;
    keys.slice(0, -1).forEach((key) => { parent = parent[key] ??= {}; });
    if (value === null) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = structuredClone(value);
  };
  const snapshot = (value) => ({ exists: () => value !== null, val: () => structuredClone(value) });
  const pocketbaseDatabase = {
    ref: (_db, path = '') => ({ path }), query: (location, ...clauses) => ({ ...location, clauses }),
    get: async (location) => {
      let value = read(location.path);
      if (location.clauses && value) {
        const order = location.clauses.find((clause) => clause.type === 'key' || clause.type === 'child');
        value = Object.fromEntries(Object.entries(value).filter(([key, item]) => location.clauses.every((clause) => {
          const field = order?.type === 'child' ? item[order.value] : key;
          return clause.type === 'start' ? field >= clause.value : clause.type === 'end' ? field <= clause.value : true;
        })));
      }
      return snapshot(value);
    },
    onValue: (location, onChange) => { listeners.push(location); onChange(snapshot(read(location.path))); return () => undefined; },
    update: async (location, changes) => {
      if (remainingUpdateFailures > 0) { remainingUpdateFailures -= 1; throw new Error('Simulated database update failure.'); }
      writes.push(structuredClone(changes)); Object.entries(changes).forEach(([path, value]) => write([location.path, path].filter(Boolean).join('/'), value));
    },
    set: async (location, value) => write(location.path, value), remove: async (location) => write(location.path, null),
    runTransaction: async (location, transform) => {
      const value = transform(structuredClone(read(location.path)));
      if (value === undefined) return { committed: false, snapshot: snapshot(read(location.path)) };
      write(location.path, value);
      return { committed: true, snapshot: snapshot(value) };
    },
    orderByChild: (value) => ({ type: 'child', value }), orderByKey: () => ({ type: 'key' }),
    startAt: (value) => ({ type: 'start', value }), endAt: (value) => ({ type: 'end', value }), limitToLast: (value) => ({ type: 'limit', value }),
  };
  function load(path) {
    const filename = resolve(root, path);
    if (filename.replaceAll('\\', '/').endsWith('/config/pocketbase.ts')) return { pb: { authStore: { record: null } } };
    if (filename.replaceAll('\\', '/').endsWith('/types/audit.ts')) return { buildAuditEvents: () => ({}) };
    if (filename.replaceAll('\\', '/').endsWith('/services/cleaningStore.ts')) return { roomCleaningTaskUpdates: async () => ({}),
      renameRoomCleaningTasks: async () => ({}), deleteCleaningLogTaskUpdates: async () => ({}) };
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
    const require = (name) => {
      if (name === './pocketbaseRealtime') return pocketbaseDatabase;
      if (name === 'react') return { useEffect: () => undefined, useRef: (value) => ({ current: value }) };
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`);
      return load(resolve(dirname(filename), `${name}.ts`));
    };
    new Function('module', 'exports', 'require', compiled)(module, module.exports, require);
    return module.exports;
  }
  return { load, writes, listeners };
}

const domain = isolatedDomain();
const payments = domain.load('src/services/financePayments.ts');
const analytics = domain.load('src/services/financeAnalytics.ts');
const validation = domain.load('src/services/financeValidation.ts');
const ledger = domain.load('src/services/operationalLedger.ts');
const financeTypes = domain.load('src/types/finance.ts');
const stamp = '2026-10-14T12:00:00Z';
const expense = (extra = {}) => ({ id: 'e1', dueDate: '2026-10-31', category: 'Energia elétrica', plannedAmount: 100, paidCash: 0, paidBank: 0, note: '', createdAt: stamp, updatedAt: stamp, ...extra });
const payroll = (extra = {}) => ({ id: 'p1', month: '2026-10', dueDate: '2026-11-05', employee: 'Maria', position: 'Camareira', basePay: 100, additions: 0, deductions: 0, paidCash: 0, paidBank: 0, note: '', createdAt: stamp, updatedAt: stamp, ...extra });
const receipt = (id, date, amount, method = 'cash') => ({ id, date, category: 'Diária', amount, wallet: financeTypes.incomePaymentWallet(method),
  items: [{ id: `${id}-item`, description: 'Hospedagem', amount, paymentMethod: method }], note: '', createdAt: stamp, updatedAt: stamp });
const data = (extra = {}) => ({ incomes: {}, expenses: {}, payroll: {}, transfers: {}, openingBalances: { cash: 100, bank: 200, oyo: 0 }, incomeCategories: [], expenseCategories: [], auditLog: {}, suppressed: {}, ...extra });
const db = (extra = {}) => ({ erp_geral: { financeiro: data(extra), recepcao: { stays: {}, roomCharges: {}, cashOuts: {} },
  quartos: { reservations: {} }, estoque: { movements: {} }, frigobar: { operations: { sales: {} } }, reservationCollections: {} } });

test('management reports compare equal elapsed dates and distinguish expense registration from payment', () => {
  const { financeReport, reportChange } = domain.load('src/services/financeReports.ts');
  const source = data({
    incomes: {
      older: receipt('older', '2026-10-05', 200),
      present: receipt('present', '2026-11-05', 240),
      outsideComparison: receipt('outsideComparison', '2026-10-20', 400),
      future: receipt('future', '2026-11-10', 300),
    },
    expenses: { card: expense({ id: 'card', purchaseMethod: 'card', purchaseDate: '2026-10-04', dueDate: '2026-11-06',
      plannedAmount: 80, paidBank: 80, paidDate: '2026-11-06' }) },
  });
  const month = { from: '2026-11-01', to: '2026-11-30' };
  const report = financeReport(source, month, '2026-11-09', 'day');
  assert.deepEqual(report.comparison.range, { from: '2026-10-01', to: '2026-10-09' });
  assert.equal(report.current.points.length, 9);
  assert.equal(report.current.revenue, 240);
  assert.equal(reportChange(report.current.revenue, report.previous.revenue), 20);
  assert.equal(report.previous.profit, 120);
  assert.equal(report.current.profit, 240);
  assert.equal(report.current.cashResult, 160);
  assert.equal(report.current.points[5].outgoing, 80);
  const monthly = financeReport(source, { from: '2026-10-04', to: '2026-11-30' }, '2026-11-09', 'month');
  assert.deepEqual(monthly.current.points.map(({ from, to, revenue, expenses, outgoing }) => [from, to, revenue, expenses, outgoing]), [
    ['2026-10-04', '2026-10-31', 600, 80, 0], ['2026-11-01', '2026-11-09', 240, 0, 80],
  ]);
});

test('report occupancy counts booked nights once and excludes pending arrivals and day-use rooms', () => {
  const { reportOccupancy } = domain.load('src/services/financeReports.ts');
  const stay = { roomNumber: '101', kind: 'hospede', status: 'encerrado', checkInDate: '2026-10-31', checkOutDate: '2026-11-05', checkedOutAt: '2026-11-03T14:00:00Z' };
  const reservation = { roomNumber: '101', status: 'encerrada', checkInDate: '2026-11-01', checkOutDate: '2026-11-03' };
  const source = data({ stays: { stay, future: { ...stay, roomNumber: '102', awaitingArrival: true }, period: { ...stay, roomNumber: '102', kind: 'periodo' } },
    reservations: { duplicate: reservation, confirmed: { ...reservation, roomNumber: '102', status: 'confirmada' }, other: { ...reservation, roomNumber: '102', checkInDate: '2026-11-02' } } });
  const range = { from: '2026-11-01', to: '2026-11-03' };
  assert.deepEqual(reportOccupancy(source, new Set(['101', '102']), range), { available: 6, occupied: 3, rate: 50 });
  assert.equal(reportOccupancy(source, new Set(), range).rate, null);
});

const adjustment = (amount, date = '2025-01-15') => ({ id: 'a1', date, amount, note: 'Acerto histórico', createdAt: stamp, updatedAt: stamp });

test('finance persists the card net and expense without charging twice on later saves', async () => {
  const state = db({ cardFeeSchedule: { v1: { effectiveAt: '2026-01-01T00:00:00Z', credit: 3, debit: 1 } } });
  const { load } = isolatedDomain(state);
  const store = load('src/services/financeStore.ts');
  await store.updateFinance((current) => ({ ...current, incomes: { ...current.incomes, card: receipt('card', '2026-10-14', 100, 'credit') } }));
  await store.updateFinance((current) => current);
  assert.equal(state.erp_geral.financeiro.incomes.card.items[0].netAmount, 97);
  assert.equal(state.erp_geral.financeiro.expenses['card-fee-card'].paidBank, 3);
  assert.equal(Object.values(state.erp_geral.financeiro.expenses).filter((entry) => entry.generatedFromIncome).length, 1);
  await assert.rejects(store.updateFinance((current) => ({ ...current, cardFeeSchedule: {} })), /histórico/);
});

test('editing an explicit stay receipt updates its account and stored card net together', async () => {
  const state = db({ cardFeeSchedule: { v1: { effectiveAt: '2026-01-01T00:00:00Z', credit: 3, debit: 1 } } });
  state.erp_geral.recepcao.stays.s = { id: 's', kind: 'hospede', checkInDate: '2026-10-14', nights: 1, dailyRate: 100, dailyMethod: 'credit', roomNumber: '101', guestName: 'Teste', attendant: 'Equipe', status: 'hospedado', hasBreakfast: false, breakfastRate: 0, taxAmount: 0, taxMethod: 'cash', extras: [], note: '', createdAt: stamp, receiptsInitialized: true,
    receipts: { 'recepcao-s-paid': { id: 'recepcao-s-paid', date: '2026-10-14', receivedAt: stamp, createdAt: stamp, attendant: 'Equipe', amount: 100, method: 'credit', label: 'Diária', category: 'Diária', cardFeeRate: 3, cardFeeAmount: 3, netAmount: 97 } } };
  const { load } = isolatedDomain(state);
  await load('src/services/financeStore.ts').updateFinance((current) => {
    const entry = current.incomes['recepcao-s-paid'];
    return { ...current, incomes: { ...current.incomes, [entry.id]: { ...entry, amount: 50, items: [{ ...entry.items[0], amount: 50 }] } } };
  });
  const saved = state.erp_geral.recepcao.stays.s;
  assert.equal(saved.receipts['recepcao-s-paid'].netAmount, 48.5);
  assert.equal(saved.receipts['recepcao-s-paid'].amount, 50);
  assert.equal(load('src/types/reception.ts').stayAmountDue(saved), 50);
});

test('signed historical cash adjustment carries through months once, alongside later receipts and payments', () => {
  const source = data({ cashAdjustments: { a1: adjustment(-500) }, incomes: { feb: receipt('feb', '2025-02-10', 200), oct: receipt('oct', '2026-10-01', 100) },
    expenses: { e1: expense({ dueDate: '2025-03-10', paidCash: 50, paidDate: '2025-03-10' }) } });
  assert.equal(analytics.balancesAtDate(source, '2025-01-14').cash, 100);
  assert.equal(analytics.balancesAt(source, '2025-01').cash, -400);
  assert.equal(analytics.balancesAt(source, '2025-02').cash, -200);
  assert.equal(analytics.balancesAt(source, '2025-03').cash, -250);
  assert.equal(analytics.balancesAt(source, '2026-10').cash, -150);
  assert.equal(analytics.monthlyFinanceSummary(source, '2025-02').openingBalances.cash, -400);
  assert.equal(analytics.monthlyReceipts(source, '2025-01').direct, 0);
  assert.equal(analytics.balancesAt(source, '2026-10').bank, 200);
  source.cashAdjustments.a1.amount = 500;
  assert.equal(analytics.balancesAt(source, '2026-10').cash, 850);
  source.cashAdjustments.a1.date = '2025-03-01';
  assert.equal(analytics.balancesAt(source, '2025-02').cash, 300);
  delete source.cashAdjustments.a1;
  assert.equal(analytics.balancesAt(source, '2026-10').cash, 350);
});

test('historical adjustments persist, reload and can be removed without modifying other entries', async () => {
  const state = db(); const { load } = isolatedDomain(state); const store = load('src/services/financeStore.ts');
  await store.updateFinance((latest) => ({ ...latest, cashAdjustments: { ...latest.cashAdjustments, a1: adjustment(-123.45) } }));
  const snapshot = await store.loadFinanceForMonth('2026-10');
  assert.equal(snapshot.cashAdjustments.a1.amount, -123.45);
  assert.equal(analytics.balancesAt(snapshot, '2026-10').cash, -23.45);
  assert.deepEqual(state.erp_geral.financeiro.incomes, {});
  await store.updateFinance((latest) => ({ ...latest, cashAdjustments: {} }));
  assert.equal(analytics.balancesAt(await store.loadFinanceForMonth('2026-10'), '2026-10').cash, 100);
});

test('cash adjustments reject invalid dates, zero, nonfinite amounts and missing reasons', () => {
  for (const entry of [adjustment(0), adjustment(NaN), adjustment(Infinity), adjustment(1, '2025-02-30'), { ...adjustment(1), note: '' }]) {
    assert.throws(() => validation.validateFinanceRecords(data(), data({ cashAdjustments: { a1: entry } })), /ajuste de caixa/);
  }
  assert.doesNotThrow(() => validation.validateFinanceRecords(data(), data({ cashAdjustments: { a1: adjustment(-10) } })));
});

test('payment methods reject unknown values and retain mixed-wallet item allocation', () => {
  assert.equal(financeTypes.incomePaymentWallet('cash'), 'cash');
  assert.equal(financeTypes.incomePaymentWallet('prepaid'), 'oyo');
  assert.equal(financeTypes.incomePaymentWallet('bitcoin'), null);
  assert.equal(financeTypes.incomePaymentWallet(undefined), null);
  const mixed = { ...receipt('mixed', '2026-10-14', 150), items: {
    a: { id: 'a', amount: 100, paymentMethod: 'cash' }, b: { id: 'b', amount: 50, paymentMethod: 'prepaid' },
  } };
  assert.deepEqual(analytics.balancesAt(data({ incomes: { mixed } }), '2026-10'), { cash: 200, bank: 200, oyo: 50 });
});

test('timestamp dates consistently use São Paulo, including the UTC month boundary', () => {
  assert.equal(payments.financeDateKeyFromTimestamp('2026-11-01T01:30:00Z'), '2026-10-31');
  assert.equal(payments.financeDateKeyFromTimestamp('invalid'), '');
  assert.deepEqual(payments.financeMonthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.throws(() => payments.financeMonthRange('2026-13'));
  const movement = { id: 'sale1', type: 'consumo_frigobar', quantity: 2, unitPrice: 5, productName: 'Água', unit: 'un', settlement: 'pago_no_checkout', paymentMethod: 'pix', createdAt: '2026-10-29T12:00:00Z', settledAt: '2026-11-01T01:30:00Z' };
  const sale = { id: 'sale1', amount: 10, items: [{ productName: 'Água', quantity: 2 }], settlement: movement.settlement, paymentMethod: movement.paymentMethod, createdAt: movement.createdAt, settledAt: movement.settledAt };
  assert.equal(ledger.minibarMovementFinanceEntry(movement).date, '2026-10-31');
  assert.equal(ledger.frigobarFinanceEntry(sale).date, '2026-10-31');
});

test('installments keep their original dates when the paid total increases next month', () => {
  const first = payments.withExpensePaymentTotals(undefined, expense({ paidCash: 40 }), '2026-10-14', 'oct-payment');
  const next = payments.withExpensePaymentTotals(first, { ...first, paidCash: 100 }, '2026-11-03', 'nov-payment');
  assert.deepEqual(payments.expensePaymentEvents(next).map((event) => [event.date, event.amount]), [['2026-10-14', 40], ['2026-11-03', 60]]);
  const source = data({ expenses: { e1: next } });
  assert.equal(analytics.balancesAt(source, '2026-10').cash, 60);
  assert.equal(analytics.balancesAt(source, '2026-11').cash, 0);
  assert.equal(analytics.monthlyFinanceSummary(source, '2026-10').pendingExpenses, 60);
  assert.equal(analytics.monthlyFinanceSummary(source, '2026-11').cashPaidExpenses, 60);
});

test('legacy dates are disclosed and date correction affects only the selected installment', () => {
  const old = expense({ paidBank: 30 });
  const next = payments.withExpensePaymentTotals(old, { ...old, paidBank: 70 }, '2026-11-07', 'new-payment');
  assert.equal(next.payments['e1-legacy-bank'].dateSource, 'legacy_due_date');
  const corrected = payments.patchPaymentDates(next.payments, { 'e1-legacy-bank': '2026-10-22' });
  assert.equal(corrected['e1-legacy-bank'].date, '2026-10-22');
  assert.equal(corrected['e1-legacy-bank'].dateSource, 'informed');
  assert.equal(corrected['new-payment-bank'].date, '2026-11-07');
  assert.equal(corrected['new-payment-bank'].amount, 40);
  assert.throws(() => payments.patchPaymentDates(corrected, { unknown: '2026-10-22' }));
});

test('corrections record a signed dated event and do not rewrite prior-month cash', () => {
  const first = payments.withExpensePaymentTotals(undefined, expense({ paidCash: 40 }), '2026-10-14', 'first');
  const corrected = payments.withExpensePaymentTotals(first, { ...first, paidCash: 10 }, '2026-11-03', 'correction');
  assert.equal(corrected.payments['correction-cash'].amount, -30);
  const source = data({ expenses: { e1: corrected } });
  assert.equal(analytics.balancesAt(source, '2026-10').cash, 60);
  assert.equal(analytics.balancesAt(source, '2026-11').cash, 90);
  assert.equal(analytics.monthlyFinanceSummary(source, '2026-11').payments.cash, -30);
  assert.equal(validation.financeDataIssues(source).length, 0);
});

test('cash movement dates are independent of future due dates and payroll competence', () => {
  const advance = payments.withExpensePaymentTotals(undefined, expense({ dueDate: '2026-11-10', paidBank: 50 }), '2026-10-15', 'advance');
  const salary = payments.withPayrollPaymentTotals(undefined, payroll({ paidCash: 80 }), '2026-11-05', 'salary');
  const source = data({ expenses: { e1: advance }, payroll: { p1: salary } });
  assert.deepEqual(analytics.balancesAt(source, '2026-10'), { cash: 100, bank: 150, oyo: 0 });
  assert.deepEqual(analytics.balancesAt(source, '2026-11'), { cash: 20, bank: 150, oyo: 0 });
  assert.equal(analytics.monthlyFinanceSummary(source, '2026-10').plannedPayroll, 100);
  assert.equal(analytics.monthlyFinanceSummary(source, '2026-10').pendingPayroll, 100);
  assert.equal(analytics.monthlyFinanceSummary(source, '2026-10').payments.bank, 50);
  assert.equal(analytics.monthlyFinanceSummary(source, '2026-11').payments.cash, 80);
});

test('monthly closing separates prepaid OYO, remittances, hotel payments and internal transfers', () => {
  const source = data({
    incomes: { hotel: receipt('hotel', '2026-10-14', 300), oyo: receipt('oyo', '2026-10-14', 150, 'prepaid') },
    expenses: { e1: payments.withExpensePaymentTotals(undefined, expense({ paidCash: 50 }), '2026-10-14', 'expense') },
    payroll: { p1: payments.withPayrollPaymentTotals(undefined, payroll({ paidBank: 80 }), '2026-10-14', 'salary') },
    transfers: { remit: { id: 'remit', date: '2026-10-14', from: 'oyo', to: 'bank', amount: 100 }, internal: { id: 'internal', date: '2026-10-14', from: 'cash', to: 'bank', amount: 20 } },
  });
  const summary = analytics.monthlyFinanceSummary(source, '2026-10');
  assert.equal(summary.receipts.direct, 300);
  assert.equal(summary.receipts.prepaid, 150);
  assert.equal(summary.receipts.repasses, 100);
  assert.equal(summary.cashResult, 270);
  assert.equal(summary.internalTransfers, 20);
  assert.deepEqual(summary.openingBalances, { cash: 100, bank: 200, oyo: 0 });
  assert.deepEqual(summary.closingBalances, { cash: 330, bank: 240, oyo: 50 });
});

test('source stock purchases, minibar sales and voided OYO tax payments reconcile without duplicates', () => {
  const purchase = { id: 'purchase1', type: 'entrada', productName: 'Água', quantity: 2, unitPrice: 5, unit: 'un', entryPayment: 'banco', paidDate: '2026-10-14', createdAt: stamp };
  const pending = { ...purchase, id: 'purchase2', entryPayment: 'pendente', paidDate: undefined };
  const sale = { ...purchase, id: 'sale1', type: 'consumo_frigobar', settlement: 'pago_na_recepcao', paymentMethod: 'dinheiro' };
  const stored = ledger.stockPurchaseExpense(purchase);
  const view = ledger.withOperationalFinance(data({ expenses: { [stored.id]: stored } }), { stays: {}, roomCharges: {}, cashOuts: {}, sales: {}, movements: { purchase, pending, sale } });
  assert.equal(Object.keys(view.expenses).length, 2);
  assert.equal(view.expenses['stock-entry-purchase1'].paidBank, 10);
  assert.equal(view.expenses['stock-entry-purchase2'].paidBank, 0);
  assert.equal(view.incomes['minibar-sale1'].amount, 10);
  const stay = { id: 's1', checkInDate: '2026-10-14', taxAmount: 20, taxMethod: 'cash', voidedPayments: { 'recepcao-s1-taxa': true } };
  assert.equal(ledger.stayOyoFeeExpense(stay), undefined);
});

test('monthly loading includes ancient balances and payments on bills due outside the month', async () => {
  const future = payments.withExpensePaymentTotals(undefined, expense({ dueDate: '2026-11-10', paidCash: 40 }), '2026-10-14', 'pay');
  const state = db({ incomes: { old: receipt('old', '2018-03-01', 10) }, expenses: { e1: future } });
  const { load, listeners } = isolatedDomain(state);
  const store = load('src/services/financeStore.ts');
  const monthly = await store.loadFinanceForMonth('2026-10');
  assert.equal(monthly.incomes.old.amount, 10);
  assert.equal(load('src/services/financeAnalytics.ts').balancesAt(monthly, '2026-10').cash, 70);
  let subscribed;
  store.subscribeFinance((value) => { subscribed = value; }, (cause) => { throw cause; }, { transactionRange: { from: '2026-10-14', to: '2026-10-14' } });
  assert.equal(subscribed.incomes.old.amount, 10);
  assert.equal(subscribed.openingBalances.cash, 100);
  assert.ok(listeners.some((location) => location.path === 'erp_geral/financeiro/transfers'));
  assert.equal(listeners.find((location) => location.path === 'erp_geral/financeiro/incomes').clauses, undefined);
});

test('editing a source-only purchase persists just its correction and keeps it paid in later views', async () => {
  const state = db();
  state.erp_geral.estoque.movements.purchase1 = { id: 'purchase1', type: 'entrada', productName: 'Água', quantity: 2, unitPrice: 5, unit: 'un', entryPayment: 'pendente', createdAt: stamp };
  const { load, writes } = isolatedDomain(state);
  const store = load('src/services/financeStore.ts');
  await store.updateFinance((current) => {
    const existing = current.expenses['stock-entry-purchase1'];
    assert.equal(existing.plannedAmount, 10);
    const updated = { ...existing, paidBank: 10, paidDate: '2026-10-15', updatedAt: '2026-10-15T15:00:00Z' };
    return { ...current, expenses: { ...current.expenses, [updated.id]: updated } };
  });
  assert.equal(state.erp_geral.financeiro.expenses['stock-entry-purchase1'].operationalOverride, true);
  assert.equal(state.erp_geral.financeiro.expenses['stock-entry-purchase1'].payments[Object.keys(state.erp_geral.financeiro.expenses['stock-entry-purchase1'].payments)[0]].amount, 10);
  assert.equal((await store.loadFinanceForMonth('2026-10')).expenses['stock-entry-purchase1'].paidBank, 10);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]), ['erp_geral/financeiro/expenses/stock-entry-purchase1']);
});

test('unchanged derived stay and cash-out sources are not copied when editing another record', async () => {
  const state = db({ expenses: { e1: expense() } });
  state.erp_geral.recepcao.cashOuts.cash1 = { id: 'cash1', date: '2026-10-14', amount: 15, reason: 'Mercado', note: '', attendant: 'Equipe', createdAt: stamp };
  state.erp_geral.recepcao.stays.s1 = { id: 's1', kind: 'hospede', checkInDate: '2026-10-14', nights: 1, roomNumber: '101', guestName: 'Ana', dailyRate: 50, dailyMethod: 'cash', hasBreakfast: false, breakfastRate: 0, taxAmount: 0, taxMethod: 'cash', extras: [], attendant: 'Equipe', createdAt: stamp };
  const { load, writes } = isolatedDomain(state);
  await load('src/services/financeStore.ts').updateFinance((current) => {
    assert.ok(current.expenses['caixa-cash1']);
    assert.ok(current.incomes['recepcao-s1-diaria']);
    return { ...current, expenses: { ...current.expenses, e1: { ...current.expenses.e1, note: 'Conta prevista conferida.' } } };
  });
  assert.equal(state.erp_geral.financeiro.incomes['recepcao-s1-diaria'], undefined);
  assert.equal(state.erp_geral.financeiro.expenses['caixa-cash1'], undefined);
  assert.equal(writes.length, 1);
  assert.ok(Object.keys(writes[0]).every((path) => path.endsWith('/e1')));
});

test('management cash collection remains in the hotel wallet and is not an expense', () => {
  const collection = { id: 'c1', date: '2026-10-14', amount: 50, reason: 'Recolhido pela Gerência', note: '', attendant: 'Equipe', createdAt: stamp };
  const ordinary = { ...collection, id: 'c2', reason: 'Farmácia', amount: 10 };
  const staleExpense = { ...expense(), id: 'caixa-c1', paidCash: 50 };
  const view = ledger.withOperationalFinance(data({ expenses: { 'caixa-c1': staleExpense } }), { stays: {}, roomCharges: {}, cashOuts: { c1: collection, c2: ordinary }, sales: {} });
  assert.equal(view.expenses['caixa-c1'], undefined);
  assert.equal(view.expenses['caixa-c2'].paidCash, 10);
  assert.equal(analytics.monthlyFinanceSummary(view, '2026-10').closingBalances.cash, 90);
});

test('correcting a cash-out to and from a collection updates its financial expense', async () => {
  const state = db();
  const item = { id: 'c1', date: '2026-10-14', amount: 50, reason: 'Farmácia', note: '', attendant: 'Equipe', createdAt: stamp };
  state.erp_geral.recepcao.cashOuts.c1 = item;
  state.erp_geral.financeiro.expenses['caixa-c1'] = ledger.cashOutFinanceEntry(item);
  const { load } = isolatedDomain(state);
  const edits = load('src/services/cashEdits.ts');
  await edits.updateCashOut('c1', { amount: 50, reason: 'Recolhido pela Gerência', note: 'cofre' });
  assert.equal(state.erp_geral.financeiro.expenses['caixa-c1'], undefined);
  assert.equal(state.erp_geral.recepcao.cashOuts.c1.note, 'cofre');
  await edits.updateCashOut('c1', { amount: 25, reason: 'Farmácia', note: '' });
  assert.equal(state.erp_geral.financeiro.expenses['caixa-c1'].paidCash, 25);
});

test('cash-flow cannot separately override an operational cash-out, and stale correction is rejected', async () => {
  const state = db();
  const item = { id: 'c1', date: '2026-10-14', amount: 50, reason: 'Farmácia', note: '', attendant: 'Equipe', createdAt: stamp };
  state.erp_geral.recepcao.cashOuts.c1 = item;
  const { load } = isolatedDomain(state);
  const store = load('src/services/financeStore.ts');
  await assert.rejects(store.updateFinance((current) => ({ ...current, expenses: { ...current.expenses, 'caixa-c1': { ...current.expenses['caixa-c1'], plannedAmount: 20 } } })), /formulário próprio/);
  assert.equal(state.erp_geral.recepcao.cashOuts.c1.amount, 50);
  const edits = load('src/services/cashEdits.ts');
  await assert.rejects(edits.updateCashOut('c1', { amount: 20, reason: 'Farmácia', note: '' }, { ...item, amount: 40 }), /mudou em outra sessão/);
  await edits.updateCashOut('c1', { amount: 20, reason: 'Farmácia', note: 'correção', date: '2026-10-15', attendant: 'Gerência' }, item);
  assert.equal(state.erp_geral.recepcao.cashOuts.c1.amount, 20);
  assert.equal(state.erp_geral.recepcao.cashOuts.c1.date, '2026-10-15');
  assert.equal(state.erp_geral.recepcao.cashOuts.c1.attendant, 'Gerência');
  assert.equal((await store.loadFinanceForMonth('2026-10')).expenses['caixa-c1'].paidCash, 20);
  assert.equal((await store.loadFinanceForMonth('2026-10')).expenses['caixa-c1'].dueDate, '2026-10-15');
});

test('collection confirmation is invalidated when its details change', () => {
  const collections = domain.load('src/services/cashCollections.ts');
  const item = { id: 'c1', date: '2026-10-14', amount: 50, reason: 'Recolhido pela Gerência', note: '', attendant: 'Equipe', createdAt: stamp };
  const acks = { c1: { signature: collections.cashCollectionSignature(item), acknowledgedAt: stamp, acknowledgedBy: 'manager' } };
  assert.equal(collections.pendingCashCollections({ c1: item }, {}).length, 1);
  assert.equal(collections.pendingCashCollections({ c1: item }, acks).length, 0);
  assert.equal(collections.pendingCashCollections({ c1: { ...item, amount: 60 } }, acks).length, 1);
  assert.equal(collections.pendingCashCollections({ c1: { ...item, reason: 'Farmácia' } }, acks).length, 0);
});

test('cleaning reports stay pending until reviewed and changes require a new review', () => {
  const concerns = domain.load('src/services/cleaningConcerns.ts');
  const log = { id: 'log1', roomId: 'r1', roomNumber: '101', attendant: 'Ana', completedAt: stamp, reportedBy: 'Equipe', usageConcern: true };
  const acks = { log1: { signature: concerns.cleaningConcernSignature(log), acknowledgedAt: stamp, acknowledgedBy: 'manager' } };
  assert.equal(concerns.pendingCleaningConcerns({ log1: log }, {}).length, 1);
  assert.equal(concerns.pendingCleaningConcerns({ log1: log }, acks).length, 0);
  assert.equal(concerns.pendingCleaningConcerns({ log1: { ...log, roomNumber: '102' } }, acks).length, 1);
  assert.equal(concerns.pendingCleaningConcerns({ log1: { ...log, usageConcern: false } }, acks).length, 0);
});

test('OYO closing is registered once per month and clears only that month’s pending OYO cash', async () => {
  const state = db();
  const { load } = isolatedDomain(state);
  const oyo = load('src/services/oyoReconciliation.ts');
  const record = { revenue: 1000, costs: 200, adjustments: 10, priorBalance: -100, reportedShare: 700, collectedByHotel: 600, paidToHotel: 20, paidToOyo: 30, updatedAt: stamp };
  assert.deepEqual(oyo.calculateOyoReconciliation(record), { calculatedShare: 710, share: 700, difference: -10, received: 590, balance: 110 });
  assert.equal(oyo.calculateOyoReconciliation({ ...record, collectedByHotel: 800 }).balance, -90);
  const report = { revenue: 81925.60, costs: 20535.75, adjustments: 0, priorBalance: -22828.98, reportedShare: 33301.36, collectedByHotel: 52977.37, paidToHotel: 0, paidToOyo: 0, updatedAt: stamp };
  assert.deepEqual(oyo.calculateOyoReconciliation(report), { calculatedShare: 38560.87, share: 33301.36, difference: -5259.51, received: 52977.37, balance: -19676.01 });
  assert.deepEqual(oyo.latestOyoClosing({}, '2026-11'), { month: '2026-10', balance: -19676.01 });
  assert.equal(oyo.latestOyoClosing({}, '2026-09'), null);
  const finance = state.erp_geral.financeiro;
  const originalFinance = structuredClone(finance);
  await assert.rejects(oyo.registerOyoClosing('2026-10', -19000), /Já existe uma RECOM/);
  finance.oyoReconciliations = { '2026-10': report };
  const closings = finance.oyoReconciliations;
  const transfers = { remit: { id: 'remit', date: '2026-11-30', oyoRecomMonth: '2026-12', from: 'oyo', to: 'bank', amount: 100 } };
  const pending = (month, prepaid, compensated) => oyo.oyoMonthPendingCash(oyo.oyoClosingBalance(closings, month), month, transfers, prepaid, compensated);
  assert.equal(oyo.oyoClosingBalance(closings, '2026-10'), -19676.01);
  assert.equal(pending('2026-10', 28948.23, 1268.61), 0);
  assert.equal(pending('2026-11', 3500.21, 248.12), 3252.09);
  await oyo.registerOyoClosing('2026-11', -17000);
  assert.equal(pending('2026-11', 3500.21, 248.12), 0);
  assert.equal(pending('2026-12', 420.50, 20), 300.50);
  await assert.rejects(oyo.registerOyoClosing('2026-11', 100), /Já existe uma RECOM/);
  await assert.rejects(oyo.registerOyoClosing('2026-12', 12.345), /duas casas/);
  await oyo.registerOyoClosing('2026-12', 0);
  assert.equal(pending('2026-12', 420.50, 20), 0);
  assert.deepEqual(closings['2026-10'], report);
  assert.deepEqual(oyo.latestOyoClosing(closings, '2026-11'), { month: '2026-11', balance: -17000 });
  assert.deepEqual(oyo.latestOyoClosing(closings, '2026-12'), { month: '2026-12', balance: 0 });
  const { oyoReconciliations, ...after } = finance;
  assert.deepEqual(after, originalFinance);
  assert.equal(oyoReconciliations, closings);
});

test('OYO counter fees follow the date and method of the receipts, separate from prepaid money', () => {
  const stay = { id: 's', roomNumber: '101', guestName: 'Ana', receiptsInitialized: true, receipts: {
    counter: { id: 'counter', category: 'Taxas', method: 'pix', amount: 29.60, date: '2026-10-31' },
    prepaid: { id: 'prepaid', category: 'Taxas', method: 'prepaid', amount: 50, date: '2026-10-31' },
    next: { id: 'next', category: 'Taxas', method: 'cash', amount: 20, date: '2026-11-01' },
  } };
  const incomes = ledger.stayFinanceEntries(stay);
  const finance = data({ stays: { s: stay }, incomes, expenses: {
    fee: expense({ paidOyo: 29.60, paidDate: '2026-11-01' }),
  } });
  assert.equal(analytics.monthlyReceipts(finance, '2026-10').counterFees, 29.60);
  assert.equal(analytics.monthlyReceipts(finance, '2026-11').counterFees, 20);
  assert.equal(analytics.monthlyReceipts({ ...finance, suppressed: { counter: true } }, '2026-10').counterFees, 0);
});

test('hotel revenue, cash movement and the OYO estimate reconcile mixed and historical fees once', async () => {
  const date = '2026-11-05';
  const item = (id, description, amount, paymentMethod) => ({ id, description, amount, paymentMethod });
  const mixed = { ...receipt('mixed', date, 332, 'prepaid'), items: [
    item('lodging', 'Diária', 300, 'prepaid'), item('prepaid-fee', 'Taxa', 20, 'prepaid'), item('counter-fee', 'Taxa', 12, 'cash'),
  ] };
  const reservation = { ...receipt('reservation-s-paid', date, 8), items: [item('fee', 'Taxa · quarto 101', 8, 'cash')] };
  const state = db({ incomes: { mixed, [reservation.id]: reservation, old: receipt('old', '2026-10-30', 1000, 'prepaid') },
    expenses: { other: expense({ id: 'other', dueDate: date, paidDate: date, plannedAmount: 70, paidOyo: 70 }) },
    payroll: { p1: payroll({ paidBank: 100, paidDate: date }) }, cashAdjustments: { a1: adjustment(-5, date) },
    transfers: {
      remit: { id: 'remit', date, from: 'oyo', to: 'bank', amount: 200, oyoRecomMonth: '2026-11', createdAt: stamp, note: '' },
      pay: { id: 'pay', date, from: 'bank', to: 'oyo', amount: 10, createdAt: stamp, note: '' },
      internal: { id: 'internal', date, from: 'cash', to: 'bank', amount: 20, createdAt: stamp, note: '' },
    },
  });
  state.erp_geral.recepcao.stays.s = { id: 's', roomNumber: '101', guestName: 'Teste', createdAt: stamp, checkInDate: date,
    receipts: Object.fromEntries([
      item('lodging', 'Diária', 500, 'prepaid'), item('prepaid', 'Taxas', 18, 'prepaid'), item('counter', 'Taxas', 30, 'pix'),
    ].map((line) => [line.id, { ...line, date, method: line.paymentMethod, category: line.description, label: line.description, createdAt: stamp }])) };
  const { load } = isolatedDomain(state);
  const store = load('src/services/financeStore.ts');
  const { dailyRevenueRows } = load('src/services/dailyRevenue.ts');
  const { oyoEstimatedPosition } = load('src/services/oyoReconciliation.ts');
  const { buildMonthlyAccountingReport } = load('src/services/accounting/monthlyAccounting.ts');
  const view = await store.loadFinanceForMonth('2026-11');
  const summary = analytics.monthlyFinanceSummary(view, '2026-11');
  assert.equal(summary.receipts.prepaid, 800);
  assert.equal(summary.receipts.counterFees, 50);
  assert.equal(summary.receipts.received, 250);
  assert.equal(summary.cashOutflow, 110);
  assert.equal(summary.cashResult, 135);
  assert.equal(summary.oyoPaidExpenses, 120);
  assert.equal(view.expenses['recepcao-s-oyo-fee'].paidOyo, 30);
  assert.equal(view.expenses['oyo-fee-mixed'].paidOyo, 12);
  assert.equal(view.expenses['oyo-fee-reservation-s-paid'].paidOyo, 8);
  assert.equal(dailyRevenueRows(view.incomes, view.stays).filter((row) => row.date === date).reduce((sum, row) => sum + row.amount, 0), 800);
  assert.equal(buildMonthlyAccountingReport(view, '2026-11', stamp).totals.prepaid, 800);
  const estimate = oyoEstimatedPosition(view, { month: '2026-10', balance: -19676.01 }, date);
  assert.equal(estimate.balance, -19186.01);
  assert.deepEqual(estimate.transfers.map((entry) => entry.id), ['remit', 'pay']);
  assert.equal(oyoEstimatedPosition(view, { month: '2026-11', balance: -17000 }, date).balance, -17000);

  await store.updateFinance((current) => ({ ...current, incomes: { ...current.incomes, mixed: {
    ...current.incomes.mixed, amount: 320, items: current.incomes.mixed.items.slice(0, 2),
  } } }));
  assert.equal((await store.loadFinanceForMonth('2026-11')).expenses['oyo-fee-mixed'], undefined);
});

test('OYO position applies later transfers once and absorbs them at the linked closing', () => {
  const { oyoPosition } = domain.load('src/services/oyoReconciliation.ts');
  const transfers = {
    old: { id: 'old', date: '2026-10-25', from: 'bank', to: 'oyo', amount: 500 },
    sent: { id: 'sent', date: '2026-11-01', from: 'bank', to: 'oyo', amount: 1000 },
    received: { id: 'received', date: '2026-11-02', from: 'oyo', to: 'bank', amount: 150, oyoRecomMonth: '2026-12' },
    internal: { id: 'internal', date: '2026-11-03', from: 'cash', to: 'bank', amount: 200 },
    future: { id: 'future', date: '2026-12-22', from: 'bank', to: 'oyo', amount: 3000 },
  };
  const october = oyoPosition({ month: '2026-10', balance: -19676.01 }, transfers, '2026-11-10');
  assert.equal(october.balance, -18826.01);
  assert.deepEqual(october.transfers.map((item) => item.id), ['received', 'sent']);
  const november = oyoPosition({ month: '2026-11', balance: -18676.01 }, transfers, '2026-12-02');
  assert.equal(november.balance, -18826.01);
  assert.deepEqual(november.transfers.map((item) => item.id), ['received']);
  assert.deepEqual(oyoPosition({ month: '2026-12', balance: -17000 }, transfers, '2026-12-31'), { balance: -17000, transfers: [] });
});

test('summary and reports use the same cross-month totals, preserving receipt and sale dates', async () => {
  const mixed = { ...receipt('mixed', '2026-10-31', 140), items: [
    { id: 'lodging', amount: 100, description: 'Diária', paymentMethod: 'cash' },
    { id: 'extra', amount: 30, description: 'Colchão extra', paymentMethod: 'debit' },
    { id: 'tax', amount: 10, description: 'Taxa', paymentMethod: 'cash' },
  ] };
  const state = db({
    incomes: { history: receipt('history', '2026-10-20', 40), mixed,
      breakfast: { ...receipt('breakfast', '2026-11-01', 50, 'prepaid'), category: 'Café' },
      tax: { ...receipt('tax', '2026-11-01', 12, 'prepaid'), category: 'Taxas' },
      future: receipt('future', '2026-11-03', 500) },
    expenses: { e1: expense({ dueDate: '2026-11-01', plannedAmount: 80, paidBank: 60, paidDate: '2026-11-01' }) },
    transfers: {
      remit: { id: 'remit', date: '2026-11-01', from: 'oyo', to: 'cash', amount: 20 },
      internal: { id: 'internal', date: '2026-11-01', from: 'cash', to: 'bank', amount: 5 },
    },
    cardFeeSchedule: { v1: { effectiveAt: '2026-01-01T00:00:00Z', credit: 0, debit: 1 } },
  });
  state.erp_geral.frigobar.operations.sales = {
    later: { id: 'later', createdAt: '2026-10-31T15:00:00Z', amount: 25, settlement: 'pago_no_checkout', paymentMethod: 'cartao_credito', settledAt: '2026-11-02T15:00:00Z', items: [] },
    pending: { id: 'pending', createdAt: '2026-11-01T15:00:00Z', amount: 15, settlement: 'cobrar_no_checkout', items: [] },
  };
  const { load } = isolatedDomain(state);
  const view = await load('src/services/financeStore.ts').loadFinanceForMonth('2026-11');
  const { financeOverview } = load('src/services/financeOverview.ts');
  const period = financeOverview(view, { from: '2026-10-31', to: '2026-11-03' }, '2026-11-01');
  assert.deepEqual(period.sales, { geladeira: 40, breakfast: 50, extras: 30 });
  assert.deepEqual([period.incomingCash, period.cardGross, period.cardNet], [130, 30, 29.70]);
  assert.deepEqual([period.counterFees, period.prepaid, period.expenses, period.expensesPaid], [10, 50, 90.30, 70.30]);
  assert.deepEqual([period.balances.cash, period.balances.bank], [265, 174.70]);
  assert.deepEqual(period.timeline.map(({ incoming, outgoing }) => [incoming, outgoing]), [[140, .30], [20, 60]]);
  assert.equal(period.received, 160);
  assert.equal(period.outflow, 60.30);
  const second = financeOverview(view, { from: '2026-11-01', to: '2026-11-02' }, '2026-11-02');
  assert.equal(second.sales.geladeira, 15);
  assert.equal(second.cardGross, 25);

  const { oyoClosingAt, oyoEstimatedPosition } = load('src/services/oyoReconciliation.ts');
  const records = { '2026-11': { closingBalance: -1000, updatedAt: stamp } };
  const closing = oyoClosingAt(records, period.asOf);
  assert.equal(closing.month, '2026-10');
  assert.equal(oyoEstimatedPosition(view, closing, period.asOf).balance, -19646.01);
  assert.equal(oyoClosingAt(records, '2026-11-30').balance, -1000);
});

test('a card statement uses its due date and records one withdrawal for the remaining purchases', async () => {
  const cardCategory = 'Cartão Mercado Pago · Fabricio';
  const state = db({ expenses: {
    a: expense({ id: 'a', dueDate: '2026-10-20', plannedAmount: 50.10, paidBank: 5, purchaseMethod: 'card', cardCategory }),
    b: expense({ id: 'b', dueDate: '2026-10-25', plannedAmount: 20.20, purchaseMethod: 'card', cardCategory }),
  } });
  const { load } = isolatedDomain(state);
  const { updateFinance, loadFinanceForMonth } = load('src/services/financeStore.ts');
  const { groupCardPurchases, payCardStatement, reopenCardStatement, ungroupCardStatement } = load('src/services/cardStatements.ts');
  const { outstandingAccounts, accountsInScope } = load('src/services/outstandingAccounts.ts');
  const { buildMonthlyAccountingReport } = load('src/services/accounting/monthlyAccounting.ts');
  const { deleteFinancialExpense } = load('src/services/financeDeletion.ts');
  const now = '2026-11-10T14:00:00Z';
  const input = { id: 'invoice', cardCategory, dueDate: '2026-11-12', expenseIds: ['a', 'b'], expectedAmount: 65.30 };
  const before = await loadFinanceForMonth('2026-11');
  const ungroupedAccounts = outstandingAccounts(before, '2026-11-10');
  assert.equal(accountsInScope(ungroupedAccounts, 'overdue', '2026-11-10', '2026-11-30').length, 0);
  assert.equal(accountsInScope(ungroupedAccounts, 'unassignedCards', '2026-11-10', '2026-11-30').length, 2);
  assert.deepEqual(accountsInScope(ungroupedAccounts, 'all', '2026-11-10', '2026-10-31').map(({ detail, pending }) => [detail, pending]), [
    [cardCategory, 45.10], [cardCategory, 20.20],
  ]);
  await updateFinance((current) => groupCardPurchases(current, input, now));
  const open = await loadFinanceForMonth('2026-11');
  assert.equal(open.expenses.a.dueDate, '2026-11-12');
  assert.equal(payments.expensePaymentEvents(open.expenses.a)[0].date, '2026-10-20');
  const openAccounts = outstandingAccounts(open, '2026-11-10');
  assert.deepEqual(accountsInScope(openAccounts, 'throughMonth', '2026-11-10', '2026-10-31'), []);
  assert.deepEqual(accountsInScope(openAccounts, 'all', '2026-11-10', '2026-10-31').map(({ statementId, dueDate, pending }) => ({ statementId, dueDate, pending })), [
    { statementId: 'invoice', dueDate: '2026-11-12', pending: 65.30 },
  ]);
  assert.deepEqual(analytics.balancesAt(open, '2026-11'), analytics.balancesAt(before, '2026-11'));
  await assert.rejects(deleteFinancialExpense(open.expenses.a), /vinculada a uma fatura/);
  const pay = (current) => payCardStatement(current, 'invoice', { date: '2026-11-10', amount: 65.30, wallet: 'bank' }, now);
  await updateFinance(pay);
  await assert.rejects(updateFinance(pay), /já está paga/);
  const paid = await loadFinanceForMonth('2026-11');
  assert.equal(outstandingAccounts(paid, '2026-11-10').length, 0);
  assert.equal(analytics.balancesAt(paid, '2026-11').bank, 129.70);
  const report = buildMonthlyAccountingReport(paid, '2026-11');
  assert.deepEqual(report.payments.map((item) => [item.type, item.amount, item.wallet]), [['Pagamento de fatura', 65.30, 'bank']]);
  assert.equal(report.wallets.find((wallet) => wallet.wallet === 'bank').difference, 0);
  await updateFinance((current) => reopenCardStatement(current, paid.cardStatements.invoice, now));
  await updateFinance((current) => ungroupCardStatement(current, 'invoice', now));
  const restored = await loadFinanceForMonth('2026-11');
  assert.equal(restored.expenses.a.dueDate, '2026-10-20');
  assert.deepEqual(analytics.balancesAt(restored, '2026-11'), analytics.balancesAt(before, '2026-11'));
});

test('card purchases register on their own dates and join the same payable statement', async () => {
  const cardCategory = 'Cartão Nubank · Ana';
  const state = db({ expenseCategories: [cardCategory] });
  const { load } = isolatedDomain(state);
  const { updateFinance, loadFinanceForMonth } = load('src/services/financeStore.ts');
  const { expenseCashMovements, payCardStatement, scheduleCardPurchase } = load('src/services/cardStatements.ts');
  const { financeOverview } = load('src/services/financeOverview.ts');
  const { outstandingAccounts } = load('src/services/outstandingAccounts.ts');
  const { buildMonthlyAccountingReport } = load('src/services/accounting/monthlyAccounting.ts');
  const now = '2026-11-12T15:00:00Z';
  const first = expense({ id: 'first', purchaseMethod: 'card', cardCategory, purchaseDate: '2026-10-30', dueDate: '2026-11-12', plannedAmount: 50 });
  const second = { ...first, id: 'second', purchaseDate: '2026-11-02', plannedAmount: 20 };
  await assert.rejects(updateFinance((current) => scheduleCardPurchase(current, { ...first, dueDate: '2026-10-29' }, 'fatura', now)), /data da compra/);
  await updateFinance((current) => scheduleCardPurchase(current, first, 'fatura', now));
  await updateFinance((current) => scheduleCardPurchase(current, second, 'outra', now));

  const open = await loadFinanceForMonth('2026-10');
  assert.deepEqual(Object.keys(open.cardStatements), ['fatura']);
  assert.deepEqual(outstandingAccounts(open, '2026-11-11').map(({ dueDate, pending }) => [dueDate, pending]), [['2026-11-12', 70]]);
  assert.equal(financeOverview(open, { from: '2026-10-01', to: '2026-10-31' }, '2026-11-12').expenses, 50);
  assert.equal(financeOverview(open, { from: '2026-11-01', to: '2026-11-30' }, '2026-11-12').expenses, 20);
  assert.equal(buildMonthlyAccountingReport(open, '2026-10').obligations[0].competence, '2026-10');
  assert.equal(expenseCashMovements(open).length, 0);
  assert.equal(analytics.balancesAt(open, '2026-11').bank, 200);

  await updateFinance((current) => payCardStatement(current, 'fatura', { date: '2026-11-12', amount: 70, wallet: 'bank' }, now));
  const paid = await loadFinanceForMonth('2026-11');
  assert.deepEqual(expenseCashMovements(paid).map(({ payment }) => [payment.date, payment.amount]), [['2026-11-12', 70]]);
  assert.equal(analytics.balancesAt(paid, '2026-11').bank, 130);
  assert.equal(outstandingAccounts(paid, '2026-11-12').length, 0);
});

test('old payroll editors automatically preserve history and add only the new paid difference', async () => {
  const prior = payroll({ dueDate: '2026-10-31', paidCash: 40 });
  const state = db({ payroll: { p1: prior } });
  const { load } = isolatedDomain(state);
  await load('src/services/financeStore.ts').updateFinance((current) => ({ ...current, payroll: { p1: { ...current.payroll.p1, paidCash: 80, paidDate: '2026-11-07' } } }));
  const events = load('src/services/financePayments.ts').payrollPaymentEvents(state.erp_geral.financeiro.payroll.p1);
  assert.deepEqual(events.map((event) => [event.date, event.amount]), [['2026-10-31', 40], ['2026-11-07', 40]]);
  assert.equal(events[0].dateSource, 'legacy_due_date');
});

test('invalid payment histories and overpayments are rejected without changing unrelated records', () => {
  const invalid = expense({ paidCash: 110 });
  assert.throws(() => validation.validateFinanceRecords(data(), data({ expenses: { e1: invalid } })), /supera/);
  const mismatch = expense({ paidCash: 50, payments: {} });
  assert.throws(() => payments.withExpensePaymentTotals(mismatch, { ...mismatch, paidCash: 60 }, '2026-10-14', 'broken'), /diverge/);
  assert.ok(validation.financeDataIssues(data({ expenses: { e1: mismatch } })).length);
});

test('stock finance sync cannot recreate a deleted movement as a financeSynced-only shell', async () => {
  const state = db();
  const { load } = isolatedDomain(state);
  await load('src/services/minibarFinanceSync.ts').syncStockMovementFinance({ id: 'deleted-movement', type: 'entrada' });
  assert.equal(state.erp_geral.estoque.movements['deleted-movement'], undefined);
  assert.deepEqual(state.erp_geral.financeiro.expenses, {});
});

test('concurrent finance saves preserve both installments instead of replacing their history', async () => {
  const state = db({ expenses: { e1: expense() } });
  const { load } = isolatedDomain(state);
  const store = load('src/services/financeStore.ts');
  await Promise.all([20, 30].map((amount) => store.updateFinance((current) => {
    const previous = current.expenses.e1;
    const updated = { ...previous, paidCash: previous.paidCash + amount, paidDate: '2026-10-14' };
    return { ...current, expenses: { ...current.expenses, e1: updated } };
  })));
  const saved = state.erp_geral.financeiro.expenses.e1;
  assert.equal(saved.paidCash, 50);
  assert.equal(Object.keys(saved.payments).length, 2);
  assert.equal(load('src/services/financePayments.ts').paymentEventTotals(Object.values(saved.payments)).cash, 50);
  assert.equal(state.erp_geral.financeiro.managerWriteLock, undefined);
});

test('reservation and cash-flow edits share a financial lock and reject a stale receipt version', async () => {
  const incoming = receipt('reservation-r1-deposit', '2026-10-14', 100);
  const state = db({ incomes: { [incoming.id]: incoming } });
  const reservation = { id: 'r1', roomId: 'room1', roomNumber: '101', guestName: 'Ana', phone: '', adults: 1, children: 0,
    checkInDate: '2026-10-14', checkOutDate: '2026-10-16', reservationAmount: 200, channel: 'balcao', status: 'hospedado', note: '', createdAt: stamp, updatedAt: stamp };
  state.erp_geral.quartos.reservations.r1 = reservation;
  state.erp_geral.quartos.rooms = { room1: { id: 'room1', number: '101', cleaningStatus: 'limpo', maintenanceStatus: 'normal', note: '' } };
  const { load } = isolatedDomain(state);
  const result = await Promise.allSettled([
    load('src/services/financeStore.ts').updateFinance((current) => ({ ...current, incomes: { ...current.incomes,
      [incoming.id]: { ...current.incomes[incoming.id], amount: 150, items: [{ ...incoming.items[0], amount: 150 }], updatedAt: '2026-10-14T13:00:00Z' } } })),
    load('src/services/housekeepingStore.ts').saveReservationRecord({ ...reservation, guestName: 'Bruno' }, reservation, [incoming]),
  ]);
  assert.equal(result[0].status, 'fulfilled');
  assert.equal(result[1].status, 'rejected');
  assert.match(result[1].reason.message, /mudou no Fluxo de caixa/);
  assert.equal(state.erp_geral.financeiro.incomes[incoming.id].amount, 150);
  assert.equal(state.erp_geral.quartos.reservations.r1.guestName, 'Ana');
  assert.equal(state.erp_geral.financeiro.managerWriteLock, undefined);
});

test('a failed financial deletion releases its pending claim and can be retried', async () => {
  const incoming = receipt('receipt1', '2026-10-14', 100);
  const state = db({ incomes: { receipt1: incoming } });
  const { load } = isolatedDomain(state, { failUpdates: 1 });
  const { commitDeletion, removeFinanceEntries } = load('src/services/deletionStore.ts');
  const failed = {};
  removeFinanceEntries(failed, ['receipt1']);
  await assert.rejects(commitDeletion(['payment-receipt1'], failed), /Simulated database update failure/);
  assert.equal(state.erp_geral.financeiro.incomes.receipt1.amount, 100);
  assert.equal(state.erp_geral.financeiro.deletions['payment-receipt1'], undefined);
  const retried = {};
  removeFinanceEntries(retried, ['receipt1']);
  await commitDeletion(['payment-receipt1'], retried);
  assert.equal(state.erp_geral.financeiro.incomes.receipt1, undefined);
  assert.equal(state.erp_geral.financeiro.suppressed.receipt1, true);
  assert.equal(state.erp_geral.financeiro.deletions['payment-receipt1'].status, 'done');
});

const editableStay = (extra = {}) => ({ id: 's', kind: 'hospede', checkInDate: '2026-10-14', nights: 1, dailyRate: 100, dailyMethod: 'credit', roomNumber: '101', guestName: 'Teste', attendant: 'Equipe', status: 'hospedado', hasBreakfast: false, breakfastRate: 0, taxAmount: 0, taxMethod: 'cash', extras: [], note: '', createdAt: stamp, ...extra });
const storedReceipt = (extra = {}) => ({ id: 'recepcao-s-diaria', date: '2026-10-14', receivedAt: stamp, createdAt: stamp, attendant: 'Equipe', amount: 100, method: 'credit', label: 'Diária', category: 'Diária', cardFeeRate: 3, cardFeeAmount: 3, netAmount: 97, ...extra });
const viewOf = (domain, state) => domain.load('src/services/operationalLedger.ts').withOperationalFinance(state.erp_geral.financeiro, {
  stays: state.erp_geral.recepcao.stays, roomCharges: state.erp_geral.recepcao.roomCharges, cashOuts: state.erp_geral.recepcao.cashOuts,
  sales: state.erp_geral.frigobar.operations.sales });

test('deleting an erroneous reception stay removes linked financial data without checkout or touching other stays', async () => {
  const state = db();
  const stay = editableStay({ dailyMethod: 'cash' });
  state.erp_geral.recepcao.stays = { s: stay, other: editableStay({ id: 'other', roomNumber: '102' }) };
  state.erp_geral.recepcao.roomCharges.c1 = { id: 'c1', sourceType: 'stay', sourceId: 's', kind: 'cama_extra', payments: { p1: { amount: 10, method: 'cash' } } };
  state.erp_geral.financeiro.incomes['recepcao-s-diaria'] = receipt('recepcao-s-diaria', '2026-10-14', 100);
  state.erp_geral.financeiro.incomes['room-charge-c1-p1'] = receipt('room-charge-c1-p1', '2026-10-14', 10);
  const { load } = isolatedDomain(state);
  const service = load('src/services/receptionStore.ts');
  await service.deleteStay(stay);
  assert.equal(state.erp_geral.recepcao.stays.s, undefined);
  assert.equal(state.erp_geral.recepcao.stays.other.roomNumber, '102');
  assert.equal(state.erp_geral.recepcao.roomCharges.c1, undefined);
  assert.equal(state.erp_geral.financeiro.incomes['recepcao-s-diaria'], undefined);
  assert.equal(state.erp_geral.financeiro.suppressed['recepcao-s-diaria'], true);
  assert.equal(state.erp_geral.financeiro.suppressed['room-charge-c1-p1'], true);
  await assert.rejects(service.deleteStay(stay), /não existe mais/);
});

test('deleting a reservation releases only its own slots and linked records', async () => {
  const state = db();
  const reservation = { id: 'r1', roomId: 'room1', roomNumber: '101', guestName: 'Teste' };
  state.erp_geral.quartos = { reservations: { r1: reservation, r2: { ...reservation, id: 'r2' } }, reservationIndex: { r1: {}, r2: {} }, reservationSlots: { room1: { '2026-10-14': 'r1', '2026-10-15': 'r2' } } };
  state.erp_geral.reservationCollections = { r1: { c1: { id: 'c1' } } };
  state.erp_geral.reservationExtras = { r1: { e1: { id: 'e1' } } };
  state.erp_geral.financeiro.incomes['reservation-r1-initial'] = receipt('reservation-r1-initial', '2026-10-14', 100);
  const { load } = isolatedDomain(state);
  const service = load('src/services/hospitalityDeletion.ts');
  await service.deleteReservation(reservation);
  assert.equal(state.erp_geral.quartos.reservations.r1, undefined);
  assert.equal(state.erp_geral.quartos.reservations.r2.id, 'r2');
  assert.equal(state.erp_geral.quartos.reservationSlots.room1['2026-10-14'], undefined);
  assert.equal(state.erp_geral.quartos.reservationSlots.room1['2026-10-15'], 'r2');
  assert.equal(state.erp_geral.financeiro.incomes['reservation-r1-initial'], undefined);
  assert.equal(state.erp_geral.financeiro.suppressed['reservation-r1-checkout-c1'], true);
  assert.equal(state.erp_geral.reservationExtras.r1.e1, undefined);
  await assert.rejects(service.deleteReservation(reservation), /não existe mais/);
});

test('manager stay edit moves a stored receipt to the new payment method even after a cash-flow override', async () => {
  const state = db({ incomes: { 'recepcao-s-diaria': { ...receipt('recepcao-s-diaria', '2026-10-14', 100, 'credit'), operationalOverride: true } } });
  state.erp_geral.recepcao.stays.s = editableStay({ receiptsInitialized: true, receipts: { 'recepcao-s-diaria': storedReceipt() } });
  const domain = isolatedDomain(state);
  await domain.load('src/services/receptionStore.ts').updateStayAndFinance(editableStay({ dailyMethod: 'pix', receiptsInitialized: true, receipts: { 'recepcao-s-diaria': storedReceipt() } }));
  const saved = state.erp_geral.recepcao.stays.s.receipts['recepcao-s-diaria'];
  assert.equal(saved.method, 'pix');
  assert.equal(saved.cardFeeRate, undefined);
  assert.equal(state.erp_geral.financeiro.incomes['recepcao-s-diaria'].items[0].paymentMethod, 'pix');
  assert.equal(state.erp_geral.financeiro.incomes['recepcao-s-diaria'].wallet, 'bank');
  assert.equal(viewOf(domain, state).incomes['recepcao-s-diaria'].items[0].paymentMethod, 'pix');
});

test('manager can edit the room and rate when PocketBase returns the same stay with a different key order', async () => {
  const state = db();
  const original = editableStay({ receiptsInitialized: true, receipts: { 'recepcao-s-diaria': storedReceipt() } });
  state.erp_geral.recepcao.stays.s = JSON.parse(JSON.stringify(original, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
  state.erp_geral.quartos.rooms = { old: { id: 'old', number: '101', cleaningStatus: 'limpo' } };
  const { load } = isolatedDomain(state);
  const { updateStayAndFinance } = load('src/services/receptionStore.ts');

  await updateStayAndFinance({ ...original, roomNumber: '102', dailyRate: 125 }, original);
  assert.equal(state.erp_geral.recepcao.stays.s.roomNumber, '102');
  assert.equal(state.erp_geral.recepcao.stays.s.dailyRate, 125);
  assert.deepEqual(state.erp_geral.recepcao.stays.s.receipts, original.receipts);
  assert.equal(state.erp_geral.quartos.rooms.old.cleaningStatus, 'sujo');
});

test('manager stay edit rejects a real change to a receipt since the form opened', async () => {
  const state = db();
  const original = editableStay({ receiptsInitialized: true, receipts: { 'recepcao-s-diaria': storedReceipt() } });
  state.erp_geral.recepcao.stays.s = { ...original, receipts: { 'recepcao-s-diaria': storedReceipt({ amount: 90 }) } };
  const { load, writes } = isolatedDomain(state);
  const { updateStayAndFinance } = load('src/services/receptionStore.ts');

  await assert.rejects(updateStayAndFinance({ ...original, roomNumber: '102', dailyRate: 125 }, original), /hospedagem mudou enquanto você editava/);
  assert.equal(state.erp_geral.recepcao.stays.s.receipts['recepcao-s-diaria'].amount, 90);
  assert.equal(writes.length, 0);
});

test('individual stay courtesies waive the selected charges and remove their receipts and fees', async () => {
  const state = db({ cardFeeSchedule: { old: { effectiveAt: '2026-01-01T00:00:00Z', credit: 5, debit: 0 } } });
  const domain = isolatedDomain(state);
  const { updateStayAndFinance } = domain.load('src/services/receptionStore.ts');
  const { addStayReceipt } = domain.load('src/services/stayReceipts.ts');
  const { stayAmountDue, stayPayments } = domain.load('src/types/reception.ts');
  const { loadFinanceForMonth, updateFinance } = domain.load('src/services/financeStore.ts');
  const stay = editableStay({ receiptsInitialized: true, hasBreakfast: true, breakfastRate: 20, breakfastMethod: 'cash',
    taxAmount: 12, extras: [{ id: 'waive', type: 'outros', label: 'Primeiro extra', amount: 8, method: 'cash' },
      { id: 'keep', type: 'outros', label: 'Segundo extra', amount: 9, method: 'cash' }] });
  const paid = addStayReceipt(stay, { id: 'checkout', amount: 144, method: 'credit', date: stay.checkInDate, attendant: stay.attendant }, stamp);
  // Simulate the earlier allocation format, which identified checkout payments by description and category.
  for (const entry of Object.values(paid.receipts)) delete entry.billingLineId;
  state.erp_geral.recepcao.stays.s = paid;
  await updateFinance((current) => current);
  const before = await loadFinanceForMonth('2026-10');
  assert.equal(stayAmountDue(paid), 5);
  assert.equal(before.expenses['recepcao-s-oyo-fee'].plannedAmount, 12);

  await updateStayAndFinance({ ...paid, dailyMethod: 'courtesy', breakfastMethod: 'courtesy', taxMethod: 'courtesy',
    extras: [{ ...paid.extras[0], method: 'courtesy' }, paid.extras[1]] }, paid);
  const updated = state.erp_geral.recepcao.stays.s;
  const finance = await loadFinanceForMonth('2026-10');
  assert.deepEqual(stayPayments(updated).map(({ amount }) => amount), [4]);
  assert.equal(stayAmountDue(updated), 5);
  assert.deepEqual(Object.keys(finance.incomes), ['checkout-5']);
  assert.deepEqual(Object.keys(finance.expenses), ['card-fee-checkout-5']);
  assert.equal(state.erp_geral.financeiro.incomes.checkout, undefined);
  assert.equal(state.erp_geral.financeiro.expenses['card-fee-checkout'], undefined);
  assert.equal(updated.receipts.checkout.method, 'courtesy');
  const settled = addStayReceipt(updated, { id: 'remaining', amount: 5, method: 'pix', date: stay.checkInDate, attendant: stay.attendant }, stamp);
  assert.equal(settled.receipts.remaining.billingLineId, 'recepcao-s-extra-keep');
  assert.equal(stayAmountDue(settled), 0);
});

test('courtesy clears the whole legacy lodging split and an unpaid item without disturbing other items', async () => {
  const state = db();
  const { load } = isolatedDomain(state);
  const { updateStayAndFinance } = load('src/services/receptionStore.ts');
  const { stayAmountDue } = load('src/types/reception.ts');
  const { stayFinanceEntries } = load('src/services/operationalLedger.ts');
  const previous = editableStay({ dailyMethod: 'pix', dailySplit: { method: 'cash', amount: 50 },
    hasBreakfast: true, breakfastRate: 20, breakfastMethod: 'cash' });
  state.erp_geral.recepcao.stays.s = previous;
  await updateStayAndFinance({ ...previous, dailyMethod: 'courtesy', dailySplit: undefined });
  const waived = state.erp_geral.recepcao.stays.s;
  assert.deepEqual(Object.keys(stayFinanceEntries(waived)), ['recepcao-s-cafe']);
  assert.equal(stayAmountDue(waived), 0);
  await updateStayAndFinance({ ...waived, dailyMethod: 'pix' });
  const restored = state.erp_geral.recepcao.stays.s;
  assert.equal(stayAmountDue(restored), 0);
  assert.deepEqual(Object.values(stayFinanceEntries(restored)).filter((income) => income.category === 'Diária').map(({ amount, wallet }) => [amount, wallet]), [[50, 'bank'], [50, 'bank']]);

  const unpaid = editableStay({ receiptsInitialized: true, taxAmount: 12, hasBreakfast: true, breakfastRate: 20, breakfastMethod: 'cash' });
  state.erp_geral.recepcao.stays.s = unpaid;
  await updateStayAndFinance({ ...unpaid, breakfastMethod: 'courtesy' });
  const updated = state.erp_geral.recepcao.stays.s;
  assert.equal(stayAmountDue(updated), 112);
  assert.deepEqual(stayFinanceEntries(updated), {});
});

test('cash review corrections reach the cash flow for receipts, legacy stays, extra charges, fridge sales and cash outs', async () => {
  const state = db({ incomes: { 'recepcao-legacy-diaria': { ...receipt('recepcao-legacy-diaria', '2026-10-14', 100, 'cash'), operationalOverride: true } } });
  const { stays, roomCharges, cashOuts } = state.erp_geral.recepcao;
  stays.s = editableStay({ receiptsInitialized: true, receipts: { 'recepcao-s-diaria': storedReceipt() } });
  stays.legacy = editableStay({ id: 'legacy', dailyMethod: 'cash' });
  roomCharges.c1 = { id: 'c1', roomNumber: '101', sourceType: 'stay', sourceId: 's', kind: 'cama_extra', guestName: 'Teste', amount: 30, days: 1, date: '2026-10-14', payments: { p1: { method: 'cash', amount: 30 } }, attendant: 'Equipe', createdAt: stamp };
  cashOuts.o1 = { id: 'o1', date: '2026-10-14', amount: 15, reason: 'Outros', note: '', attendant: 'Equipe', createdAt: stamp };
  state.erp_geral.frigobar.operations.sales.f1 = { id: 'f1', items: [{ productId: 'a', productName: 'Água', quantity: 1, unit: 'un', unitPrice: 5 }], amount: 5, settlement: 'pago_na_recepcao', paymentMethod: 'dinheiro', roomNumber: '101', guestName: 'Teste', actor: 'Equipe', createdAt: stamp };
  const domain = isolatedDomain(state);
  const edits = domain.load('src/services/cashEdits.ts');
  await edits.updateStayReceipts('s', { 'recepcao-s-diaria': { method: 'cash', amount: 100, date: '2026-10-14' } }, '2026-10-20');
  await edits.updateStayReceipts('legacy', { 'recepcao-legacy-diaria': { method: 'pix', amount: 100, date: '2026-10-14' } }, '2026-10-20');
  await edits.updateRoomChargePayment('c1', 'p1', 'debit');
  await edits.updateFrigobarSaleMethod('f1', 'credit');
  await edits.updateCashOut('o1', { amount: 20, reason: 'Farmácia', note: 'Ajuste' });
  const view = viewOf(domain, state);
  assert.equal(state.erp_geral.recepcao.stays.s.receipts['recepcao-s-diaria'].cardFeeRate, undefined);
  assert.equal(view.incomes['recepcao-s-diaria'].items[0].paymentMethod, 'cash');
  assert.equal(view.incomes['recepcao-legacy-diaria'].items[0].paymentMethod, 'pix');
  assert.equal(state.erp_geral.recepcao.stays.legacy.receiptsInitialized, true);
  assert.equal(view.incomes['room-charge-c1-p1'].items[0].paymentMethod, 'debit');
  assert.equal(view.incomes['frigobar-f1'].items[0].paymentMethod, 'credit');
  assert.equal(view.expenses['caixa-o1'].paidCash, 20);
  assert.equal(view.expenses['caixa-o1'].category, 'Farmácia');
  await assert.rejects(edits.updateStayReceipts('s', { 'recepcao-s-diaria': { method: 'cash', amount: 500, date: '2026-10-14' } }, '2026-10-20'), /ultrapassar/);
  await assert.rejects(edits.updateStayReceipts('s', { 'recepcao-s-diaria': { method: 'cash', amount: 100, date: '2026-12-31' } }, '2026-10-20'), /data válida/);
});

test('manager purchases: cash and pix debit the wallet at once, card only debits when paid', () => {
  const purchases = domain.load('src/services/purchases.ts');
  assert.deepEqual(purchases.purchaseImmediatePayment('cash', 80), { paidCash: 80, paidBank: 0 });
  assert.deepEqual(purchases.purchaseImmediatePayment('pix', 80), { paidCash: 0, paidBank: 80 });
  assert.deepEqual(purchases.purchaseImmediatePayment('card', 80), { paidCash: 0, paidBank: 0 });
  const card = 'Cartão Nubank · Ana';
  const entry = { id: 'p-card', type: 'entrada', productName: 'Sabão', quantity: 2, unitPrice: 10, unit: 'un', entryPayment: 'cartao', entryCard: card, createdAt: stamp };
  const onCard = ledger.stockPurchaseExpense(entry);
  assert.equal(onCard.purchaseMethod, 'card');
  assert.equal(onCard.cardCategory, card);
  assert.equal(onCard.category, 'Estoque');
  assert.equal(onCard.paidCash + onCard.paidBank, 0);
  assert.equal(purchases.isPendingCardPurchase(onCard), true);
  const pix = ledger.stockPurchaseExpense({ ...entry, id: 'p-pix', entryPayment: 'banco', paidDate: '2026-10-14' });
  assert.equal(pix.purchaseMethod, 'pix');
  assert.equal(pix.paidBank, 20);
  assert.equal(ledger.stockPurchaseExpense({ ...entry, id: 'p-cash', entryPayment: 'caixa' }).purchaseMethod, 'cash');
  const before = analytics.balancesAtDate(data({ expenses: { [onCard.id]: onCard }, openingBalances: { '2026-10': { cash: 100, bank: 100, oyo: 0 } } }), '2026-10-31');
  const paid = payments.withExpensePaymentTotals(onCard, { ...onCard, paidBank: 20, operationalOverride: true }, '2026-10-20', 'pay-card');
  assert.equal(purchases.isPendingCardPurchase(paid), false);
  const after = analytics.balancesAtDate(data({ expenses: { [paid.id]: paid }, openingBalances: { '2026-10': { cash: 100, bank: 100, oyo: 0 } } }), '2026-10-31');
  assert.equal(after.bank, before.bank - 20);
  assert.equal(after.cash, before.cash);
});

test('finance edits initialize all legacy stay receipts and propagate methods to the reception record', async () => {
  const state = db();
  state.erp_geral.recepcao.stays.s = editableStay({ dailyMethod: 'cash', hasBreakfast: true, breakfastCount: 1, breakfastDays: 1, breakfastRate: 20, breakfastMethod: 'cash' });
  const isolated = isolatedDomain(state);
  const store = isolated.load('src/services/financeStore.ts');
  await store.updateFinance((current) => {
    const entry = current.incomes['recepcao-s-diaria'];
    return { ...current, incomes: { ...current.incomes, [entry.id]: { ...entry, wallet: 'bank', items: [{ ...entry.items[0], paymentMethod: 'pix' }], operationalOverride: true } } };
  });
  const stay = state.erp_geral.recepcao.stays.s;
  assert.equal(stay.receiptsInitialized, true);
  assert.equal(stay.receipts['recepcao-s-diaria'].method, 'pix');
  assert.equal(stay.dailyMethod, 'pix');
  assert.equal(stay.receipts['recepcao-s-cafe'].amount, 20);
  assert.equal(viewOf(isolated, state).incomes['recepcao-s-diaria'].items[0].paymentMethod, 'pix');
});

test('finance edits of a room charge update the source without allowing overpayment or mixed payments', async () => {
  const state = db();
  state.erp_geral.recepcao.roomCharges.c1 = { id: 'c1', roomNumber: '101', sourceType: 'stay', sourceId: 's', kind: 'cama_extra', guestName: 'Teste', amount: 30, days: 1, date: '2026-10-14', payments: { p1: { method: 'cash', amount: 20 }, p2: { method: 'pix', amount: 10 } }, attendant: 'Equipe', createdAt: stamp };
  const isolated = isolatedDomain(state);
  const store = isolated.load('src/services/financeStore.ts');
  const edit = (transform) => store.updateFinance((current) => {
    const id = 'room-charge-c1-p1';
    return { ...current, incomes: { ...current.incomes, [id]: transform(current.incomes[id]) } };
  });
  await edit((entry) => ({ ...entry, wallet: 'bank', items: [{ ...entry.items[0], paymentMethod: 'debit' }], operationalOverride: true }));
  assert.equal(state.erp_geral.recepcao.roomCharges.c1.payments.p1.method, 'debit');
  await assert.rejects(edit((entry) => ({ ...entry, amount: 25, items: [{ ...entry.items[0], amount: 25 }] })), /ultrapassar/);
  await assert.rejects(edit((entry) => ({ ...entry, items: [{ ...entry.items[0], amount: 10 }, { ...entry.items[0], id: 'second', amount: 10, paymentMethod: 'cash' }] })), /única forma/);
  assert.equal(state.erp_geral.recepcao.roomCharges.c1.payments.p1.amount, 20);
});

test('card corrections preserve historical rates, recalculate fees and keep partial receipts partial', async () => {
  const state = db({ cardFeeSchedule: { old: { effectiveAt: '2026-01-01T00:00:00Z', credit: 5, debit: 1 } } });
  state.erp_geral.recepcao.stays.s = editableStay({ receiptsInitialized: true, receipts: { 'recepcao-s-diaria': storedReceipt({ amount: 40, cardFeeRate: 3, cardFeeAmount: 1.2, netAmount: 38.8 }) } });
  const isolated = isolatedDomain(state);
  await isolated.load('src/services/cashEdits.ts').updateStayReceipts('s', { 'recepcao-s-diaria': { method: 'credit', amount: 50, date: '2026-10-14' } }, '2026-10-20');
  const corrected = state.erp_geral.recepcao.stays.s.receipts['recepcao-s-diaria'];
  assert.equal(corrected.cardFeeRate, 3);
  assert.equal(corrected.cardFeeAmount, 1.5);
  assert.equal(corrected.netAmount, 48.5);
  await isolated.load('src/services/receptionStore.ts').updateStayAndFinance({ ...state.erp_geral.recepcao.stays.s, guestName: 'Outro nome' });
  assert.equal(state.erp_geral.recepcao.stays.s.receipts['recepcao-s-diaria'].amount, 50);
  assert.equal(state.erp_geral.financeiro.incomes['recepcao-s-diaria'].amount, 50);
});

test('card category subscription reads only category metadata', () => {
  const state = db({ expenseCategories: ['Cartão Banco · Titular'], categoryAliases: { expense: {} } });
  const isolated = isolatedDomain(state);
  let categories;
  isolated.load('src/services/financeStore.ts').subscribeExpenseCategories((value) => { categories = value; }, (error) => { throw error; });
  assert.ok(categories.includes('Cartão Banco · Titular'));
  assert.deepEqual(isolated.listeners.map((item) => item.path).sort(), ['erp_geral/financeiro/categoryAliases', 'erp_geral/financeiro/expenseCategories']);
});

test('staff base salary persists, stays optional for legacy members and is only cleared explicitly', async () => {
  const legacy = { id: 'staff-ana', name: 'Ana', categoryId: 'reception', active: true };
  const state = { erp_geral: { escala: { days: {}, employees: ['Ana'], staff: { configured: true,
    categories: { reception: { id: 'reception', name: 'Recepção plantonista', duty: 'reception' } }, members: { 'staff-ana': legacy } } } } };
  const isolated = isolatedDomain(state);
  const staffStore = isolated.load('src/services/staffStore.ts');
  const staffTypes = isolated.load('src/types/staff.ts');
  const members = () => state.erp_geral.escala.staff.members;
  assert.equal(staffTypes.staffBaseSalary(legacy), 0, 'legacy members without baseSalary read as 0');

  await staffStore.saveStaffMember({ id: 'staff-bruno', name: 'Bruno', categoryId: 'reception', active: true, baseSalary: 2150.456 });
  assert.equal(members()['staff-bruno'].baseSalary, 2150.46, 'saved in reais, rounded to cents');
  assert.deepEqual(members()['staff-ana'], legacy, 'unrelated legacy members are untouched');
  assert.deepEqual(state.erp_geral.escala.employees, ['Ana', 'Bruno']);

  await staffStore.saveStaffMember({ ...legacy, baseSalary: 1800 });
  assert.equal(members()['staff-ana'].baseSalary, 1800);
  // An editor that does not know the field (baseSalary undefined) must not wipe the stored salary.
  await staffStore.saveStaffMember({ ...legacy, name: 'Ana Paula' });
  assert.equal(members()['staff-ana'].baseSalary, 1800);
  assert.deepEqual(members()['staff-ana'].previousNames, ['Ana']);
  // Informing 0 (or an invalid value) clears it, and loaded data is read back through the tolerant helper.
  await staffStore.saveStaffMember({ ...legacy, name: 'Ana Paula', baseSalary: 0 });
  assert.equal('baseSalary' in members()['staff-ana'], false);
  assert.equal(staffTypes.staffBaseSalary(members()['staff-ana']), 0);
  assert.deepEqual(['1800,5', 1800.5, '', 'abc', -5, NaN, null, undefined].map(staffTypes.normalizeBaseSalary), [1800.5, 1800.5, 0, 0, 0, 0, 0, 0]);
});

test('payroll with an advance records the vale on the payroll but only the payslip leaves the cash balance', async () => {
  const vale = expense({ id: 'vale', category: 'Adiantamento de salário', employee: 'Maria', employeeId: 'e1', advanceMonth: '2026-10', dueDate: '2026-10-10',
    plannedAmount: 300, paidCash: 300, paidDate: '2026-10-10', payments: { 'vale-cash': { id: 'vale-cash', date: '2026-10-10', wallet: 'cash', amount: 300, dateSource: 'informed' } } });
  const state = db({ openingBalances: { cash: 1000, bank: 5000, oyo: 0 }, expenses: { vale } });
  const isolated = isolatedDomain(state);
  const store = isolated.load('src/services/financeStore.ts');
  const advancesModule = isolated.load('src/services/payrollAdvances.ts');
  const reportModule = isolated.load('src/services/accounting/monthlyAccounting.ts');
  const finance = isolated.load('src/types/finance.ts');
  const events = (entry) => isolated.load('src/services/financePayments.ts').payrollPaymentEvents(entry);

  const before = await store.loadFinanceForMonth('2026-10');
  const advances = advancesModule.availablePayrollAdvances(before, { id: 'p1', employee: 'Maria', employeeId: 'e1', month: '2026-10' });
  assert.deepEqual(advances, { vale: 300 });
  const totals = advancesModule.payrollLaunchTotals({ baseSalary: 2000, advances, paidCash: 0, paidBank: 1500 });
  assert.deepEqual([totals.basePay, totals.additions, totals.deductions, totals.net, totals.registered, totals.pending, totals.closing], [2000, 0, 200, 1500, 1800, 0, true]);
  const entry = payroll({ id: 'p1', employeeId: 'e1', month: '2026-10', dueDate: '2026-10-31', basePay: totals.basePay, additions: totals.additions, deductions: totals.deductions, advances, paidBank: 1500, paidDate: '2026-10-30' });
  await store.updateFinance((current) => ({ ...current, payroll: { ...current.payroll, p1: entry } }));

  const saved = state.erp_geral.financeiro.payroll.p1;
  assert.deepEqual(saved.advances, { vale: 300 }, 'the vale stays linked to the payroll record');
  assert.deepEqual(events(saved).map((event) => [event.wallet, event.amount, event.date]), [['bank', 1500, '2026-10-30']], 'only the payslip is a payment');
  assert.equal(state.erp_geral.financeiro.expenses.vale.paidCash, 300, 'the vale keeps its own history');

  const snapshot = await store.loadFinanceForMonth('2026-10');
  assert.deepEqual(analytics.balancesAt(snapshot, '2026-10'), { cash: 700, bank: 3500, oyo: 0 }, 'cash -300 (vale, paid earlier) and bank -1500 (payslip); never -2100');
  assert.equal(finance.payrollNet(snapshot.payroll.p1), 1500);
  assert.equal(finance.payrollRegistered(snapshot.payroll.p1), 1800);
  const summary = analytics.monthlyFinanceSummary(snapshot, '2026-10');
  assert.equal(summary.payrollPayments.bank + summary.payrollPayments.cash, 1500);
  assert.equal(summary.expensePayments.cash, 300);
  assert.equal(summary.cashPaidExpenses, 1800);
  const report = reportModule.buildMonthlyAccountingReport(snapshot, '2026-10', stamp);
  assert.equal(report.totals.paidHotel, 1800);
  assert.ok(report.wallets.every((wallet) => wallet.difference === 0));
  assert.match(report.payments.find((payment) => payment.type === 'Folha').note, /Vales compensados nesta folha: R\$\s300,00.*não debitam novamente/);
  assert.match(report.obligations.find((row) => row.type === 'Folha').note, /adiantamentos compensados 300; remuneração registrada 1800/);

  // Editing the payroll again must not create another payment or release the vale.
  await store.updateFinance((current) => ({ ...current, payroll: { ...current.payroll, p1: { ...current.payroll.p1, note: 'Conferida' } } }));
  assert.equal(Object.keys(state.erp_geral.financeiro.payroll.p1.payments).length, 1);
  assert.deepEqual(analytics.balancesAt(await store.loadFinanceForMonth('2026-10'), '2026-10'), { cash: 700, bank: 3500, oyo: 0 });
  // Paying the whole remuneration again (double deduction) or deleting the linked vale is refused.
  await assert.rejects(store.updateFinance((current) => ({ ...current, payroll: { ...current.payroll, p1: { ...current.payroll.p1, paidBank: 1800, payments: undefined } } })), /supera o valor líquido/);
  await assert.rejects(store.updateFinance((current) => { const expenses = { ...current.expenses }; delete expenses.vale; return { ...current, expenses }; }), /adiantamento/);
});
