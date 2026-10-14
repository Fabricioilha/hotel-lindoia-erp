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
  const firebase = {
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
    if (filename.endsWith('/config/firebase.ts')) return { db: {} };
    if (filename.endsWith('/types/audit.ts')) return { buildAuditEvents: () => ({}) };
    if (filename.endsWith('/services/cleaningStore.ts')) return { roomCleaningTaskUpdates: async () => ({}),
      renameRoomCleaningTasks: async () => ({}), deleteCleaningLogTaskUpdates: async () => ({}) };
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
    const require = (name) => {
      if (name === 'firebase/database') return firebase;
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
