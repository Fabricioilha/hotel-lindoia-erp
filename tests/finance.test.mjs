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

test('OYO reconciliation follows the report and rejects stale or invalid edits', async () => {
  const state = db();
  const { load } = isolatedDomain(state);
  const oyo = load('src/services/oyoReconciliation.ts');
  const record = { revenue: 1000, costs: 200, adjustments: 10, priorBalance: -100, reportedShare: 700, collectedByHotel: 600, paidToHotel: 20, paidToOyo: 30, updatedAt: stamp };
  assert.deepEqual(oyo.calculateOyoReconciliation(record), { calculatedShare: 710, share: 700, difference: -10, received: 590, balance: 110 });
  assert.equal(oyo.calculateOyoReconciliation({ ...record, collectedByHotel: 800 }).balance, -90);
  const report = { revenue: 81925.60, costs: 20535.75, adjustments: 0, priorBalance: -22828.98, reportedShare: 33301.36, collectedByHotel: 52977.37, paidToHotel: 0, paidToOyo: 0, updatedAt: stamp };
  assert.deepEqual(oyo.calculateOyoReconciliation(report), { calculatedShare: 38560.87, share: 33301.36, difference: -5259.51, received: 52977.37, balance: -19676.01 });
  await oyo.saveOyoReconciliation('2026-10', record, null);
  assert.deepEqual(state.erp_geral.financeiro.oyoReconciliations['2026-10'], record);
  await assert.rejects(oyo.saveOyoReconciliation('2026-10', { ...record, revenue: 999 }, null), /outra sessão/);
  await assert.rejects(oyo.saveOyoReconciliation('2026-10', { ...record, costs: -1 }, record), /Confira/);
  await oyo.saveOyoReconciliation('2026-10', { ...record, revenue: 999 }, record);
  assert.equal(state.erp_geral.financeiro.oyoReconciliations['2026-10'].revenue, 999);
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
