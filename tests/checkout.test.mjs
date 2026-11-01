import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

// Execute only pure domain modules. Firebase initialization and network calls are never loaded.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = new Map();
function domainModule(path) {
  const filename = resolve(root, path);
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const require = (name) => {
    assert.ok(name.startsWith('.'), `Unexpected external dependency: ${name}`);
    return domainModule(resolve(dirname(filename), `${name}.ts`));
  };
  new Function('module', 'exports', 'require', output)(module, module.exports, require);
  return module.exports;
}

const { applyCheckout, checkoutPending, dueCheckouts, hotelDate } = domainModule('src/services/checkoutPolicy.ts');
const { currentOccupants, reservationOccupiesDate, stayOccupiesDate } = domainModule('src/services/occupantDirectory.ts');
const { departureDue } = domainModule('src/services/reservationAnalytics.ts');
const { checkoutStatus } = domainModule('netlify/lib/checkoutStatus.ts');

function statusDatabase(reservations, stays = {}) {
  const reads = [];
  const data = {
    'erp_geral/quartos/reservations': reservations,
    'erp_geral/recepcao/stays': stays,
  };
  return {
    reads,
    ref(path) {
      const query = {
        orderByChild() { return query; }, equalTo() { return query; },
        orderByKey() { return query; }, startAt() { return query; }, endAt() { return query; },
        async get() { reads.push(path); return { val: () => data[path] ?? {} }; },
      };
      return query;
    },
  };
}

test('checkout alerts exclude historical unpaid records without changing their data', async () => {
  const old = { ...fixture().quartos.reservations.r1, checkOutDate: '2026-10-23' };
  const stays = { old: { id: 'old', roomNumber: '101', guestName: 'Antigo', status: 'hospedado', kind: 'hospede', checkInDate: '2026-10-01', nights: 2 } };
  const reservations = { r1: old };
  const before = structuredClone({ reservations, stays });
  const db = statusDatabase(reservations, stays);
  assert.deepEqual(await checkoutStatus(db, noon), []);
  assert.deepEqual({ reservations, stays }, before);
  assert.ok(!db.reads.some((path) => path.includes('roomCharges') || path.includes('financeiro')));
});

test('checkout alerts select the current occupant before checking the departure date', async () => {
  const older = fixture().quartos.reservations.r1;
  const current = { id: 'new', roomNumber: '101', guestName: 'Atual', status: 'hospedado', kind: 'hospede', checkInDate: '2026-10-23', checkOutDate: '2026-10-26', nights: 3 };
  assert.deepEqual(await checkoutStatus(statusDatabase({ r1: older }, { new: current }), noon), []);
});

test('checkout alerts retain only the current unpaid departure, once per room', async () => {
  const current = fixture().quartos.reservations.r1;
  const older = { ...current, id: 'old', guestName: 'Anterior', checkInDate: '2026-10-20' };
  const future = { ...current, id: 'future', roomNumber: '102', checkInDate: '2026-10-25', checkOutDate: '2026-10-26' };
  const closed = { ...current, id: 'closed', roomNumber: '103', status: 'encerrada' };
  const result = await checkoutStatus(statusDatabase({ old: older, r1: current, future, closed }), noon);
  assert.deepEqual(result, [{ ...target, roomNumber: '101', guestName: 'Ana', pending: 200 }]);
});

test('departure is pending from noon in hotel time, regardless of browser timezone', () => {
  assert.equal(departureDue('2026-10-25', Date.parse('2026-10-25T14:59:59Z')), false);
  assert.equal(departureDue('2026-10-25', Date.parse('2026-10-25T15:00:00Z')), true);
  assert.equal(departureDue('2026-10-25', Date.parse('2026-10-26T01:00:00Z')), true);
  assert.equal(departureDue('2026-10-26', Date.parse('2026-10-25T20:00:00Z')), false);
  assert.equal(departureDue('', Date.now()), false);
});
const target = { sourceType: 'reservation', sourceId: 'r1' };
const noon = new Date('2026-10-24T15:00:00Z');
function fixture() {
  const r = { id: 'r1', roomId: 'room1', roomNumber: '101', guestName: 'Ana', checkInDate: '2026-10-22', checkOutDate: '2026-10-24',
    status: 'hospedado', channel: 'balcao', reservationAmount: 200, tax: 0, extras: [], adults: 1, children: 0 };
  return { quartos: { reservations: { r1: r }, reservationIndex: { r1: structuredClone(r) }, rooms: { room1: { id: 'room1', number: '101', cleaningStatus: 'limpo', maintenanceStatus: 'normal' } },
    reservationSlots: { room1: { '2026-10-22': 'r1', '2026-10-23': 'other' } } },
    financeiro: { incomes: { 'reservation-r1-initial': { id: 'reservation-r1-initial', amount: 200 } }, suppressed: {} },
    recepcao: { stays: {}, roomCharges: {} }, frigobar: { operations: { sales: {} } } };
}

test('automatic checkout begins at noon São Paulo, excludes future stays and rotativos', () => {
  const state = fixture();
  assert.deepEqual(dueCheckouts(state, new Date('2026-10-24T14:59:59Z')), []);
  assert.deepEqual(dueCheckouts(state, noon), [target]);
  state.quartos.reservations.r1.channel = 'rotativo';
  assert.deepEqual(dueCheckouts(state, noon), []);
  assert.equal(hotelDate(new Date('2026-10-25T01:00:00Z')), '2026-10-24');
});
test('checkout is idempotent, preserves receipts, clears owned slots and marks the room dirty', () => {
  const state = fixture(); const finances = structuredClone(state.financeiro);
  assert.equal(applyCheckout(state, target, noon, 'employee'), true);
  assert.equal(state.quartos.reservations.r1.status, 'encerrada');
  assert.equal(state.quartos.reservations.r1.checkedOutAt, noon.toISOString());
  assert.equal(state.quartos.rooms.room1.cleaningStatus, 'sujo');
  assert.equal(state.quartos.reservationIndex.r1, undefined);
  assert.deepEqual(state.quartos.reservationSlots.room1, { '2026-10-23': 'other' });
  assert.deepEqual(state.financeiro, finances);
  assert.equal(applyCheckout(state, target, noon, 'retry'), false);
});

test('a later automatic retry completes a departure once its pending payment is settled', () => {
  const state = fixture();
  state.financeiro.incomes['reservation-r1-initial'].amount = 150;
  assert.equal(checkoutPending(state, target), 50);
  assert.throws(() => applyCheckout(state, target, noon, 'automatic'), /pendências/);
  state.financeiro.incomes['reservation-r1-initial'].amount = 200;
  const retry = new Date('2026-10-24T15:05:00Z');
  assert.deepEqual(dueCheckouts(state, retry), [target]);
  assert.equal(applyCheckout(state, target, retry, 'automatic'), true);
  assert.deepEqual(currentOccupants({}, state.quartos.reservations, '2026-10-24', retry.getTime()), []);
  assert.equal(state.quartos.rooms.room1.cleaningStatus, 'sujo');
  assert.deepEqual(dueCheckouts(state, retry), []);
});
test('unpaid booking, voided receipts and extras prevent checkout without changing data', () => {
  for (const change of [
    (s) => s.financeiro.incomes['reservation-r1-initial'].amount = 150,
    (s) => s.financeiro.suppressed['reservation-r1-initial'] = true,
    (s) => s.reservationExtras = { r1: { e: { id: 'e', reservationId: 'r1', amount: 10 } } },
  ]) {
    const state = fixture(); change(state); const before = structuredClone(state);
    assert.throws(() => applyCheckout(state, target, noon, 'test'), /pendências/);
    assert.deepEqual(state, before);
  }
});
test('pending minibar blocks by immutable lodging ID; legacy unlinked sale blocks conservatively', () => {
  const state = fixture();
  const sale = { id: 'sale', roomNumber: '101', amount: 10, settlement: 'cobrar_no_checkout', sourceType: 'reservation', sourceId: 'r1' };
  state.frigobar.operations.sales.sale = sale;
  assert.equal(checkoutPending(state, target), 10);
  sale.sourceId = 'older'; assert.equal(checkoutPending(state, target), 0);
  delete sale.sourceId; assert.equal(checkoutPending(state, target), 10);
  sale.settlement = 'pago_no_checkout'; assert.equal(checkoutPending(state, target), 0);
});
test('unpaid room extras block checkout; settled collections are counted only once', () => {
  const state = fixture();
  state.recepcao.roomCharges.c = { id: 'c', sourceType: 'reservation', sourceId: 'r1', amount: 20, payments: { part1: { amount: 10 } } };
  assert.equal(checkoutPending(state, target), 10);
  state.recepcao.roomCharges.c.payments.part1.amount = 20;
  assert.equal(checkoutPending(state, target), 0);
  state.reservationCollections = { r1: { c: { id: 'c', reservationId: 'r1', amount: 50 } } };
  state.financeiro.incomes['reservation-r1-initial'].amount = 150;
  assert.equal(checkoutPending(state, target), 0);
  state.financeiro.incomes['reservation-r1-checkout-c'] = { id: 'reservation-r1-checkout-c', amount: 50 };
  assert.equal(checkoutPending(state, target), 0);
});
test('active cleaning tasks are canceled at checkout, without altering unrelated rooms', () => {
  const state = fixture();
  state.limpeza = { tasks: { t: { id: 't', roomId: 'room1', roomNumber: '101', status: 'em_limpeza' }, other: { id: 'other', roomId: 'other', roomNumber: '102', status: 'em_limpeza' } }, activeRooms: { room1: { taskId: 't' } } };
  applyCheckout(state, target, noon, 'employee');
  assert.equal(state.limpeza.tasks.t.status, 'cancelado');
  assert.equal(state.limpeza.tasks.other.status, 'em_limpeza');
  assert.equal(state.limpeza.activeRooms.room1, undefined);
});
test('minibar selects the latest current arrival across both data sources', () => {
  const state = fixture();
  const current = { id: 's1', roomNumber: '101', guestName: 'Bia', status: 'hospedado', kind: 'hospede', checkInDate: '2026-10-23', checkOutDate: '2026-10-26', nights: 3 };
  const expired = { ...current, id: 'expired', guestName: 'Old', checkInDate: '2026-10-01', checkOutDate: '2026-10-02' };
  const choices = currentOccupants({ expired, current }, state.quartos.reservations, '2026-10-24', noon.getTime());
  assert.equal(choices.length, 1); assert.equal(choices[0].guestName, 'Bia'); assert.equal(choices[0].sourceId, 's1');
});
test('history includes closed bookings and future view includes continuing guests and confirmed reservations', () => {
  const r = fixture().quartos.reservations.r1;
  assert.equal(reservationOccupiesDate({ ...r, status: 'encerrada' }, '2026-10-23', '2026-10-24', noon.getTime()), true);
  assert.equal(reservationOccupiesDate({ ...r, status: 'cancelada' }, '2026-10-23', '2026-10-24', noon.getTime()), false);
  assert.equal(reservationOccupiesDate({ ...r, status: 'confirmada', checkOutDate: '2026-10-26' }, '2026-10-25', '2026-10-24', noon.getTime()), true);
  assert.equal(stayOccupiesDate({ kind: 'hospede', status: 'hospedado', checkInDate: '2026-10-23', checkOutDate: '2026-10-26' }, '2026-10-25', '2026-10-24', noon.getTime()), true);
});

test('a legacy hospedado status does not occupy a room after the departure date', () => {
  const r = fixture().quartos.reservations.r1;
  const date = '2026-10-25';
  const now = new Date(`${date}T15:00:00Z`).getTime();
  const stay = { id: 'old', kind: 'hospede', roomNumber: '102', guestName: 'Antigo', status: 'hospedado', checkInDate: '2026-10-01', nights: 2 };
  assert.deepEqual(currentOccupants({ stay }, { r }, date, now), []);
  assert.equal(stayOccupiesDate(stay, '2026-10-02', date, now), true);
  assert.equal(reservationOccupiesDate(r, '2026-10-23', date, now), true);
});

test('current stays, departures today and future arrivals are distinguished from legacy records', () => {
  const r = fixture().quartos.reservations.r1;
  const now = noon.getTime();
  assert.equal(currentOccupants({}, { r }, '2026-10-24', now).length, 1);
  assert.equal(currentOccupants({}, { r: { ...r, checkInDate: '2026-10-25', checkOutDate: '2026-10-27' } }, '2026-10-24', now).length, 0);
  const stay = { id: 'current', kind: 'hospede', roomNumber: '102', status: 'hospedado', checkInDate: '2026-10-23', nights: 2 };
  assert.equal(currentOccupants({ stay }, {}, '2026-10-24', now).length, 1);
});

test('automatic checkout never processes old records or dirties rooms from historical stays', () => {
  const state = fixture();
  state.quartos.reservations.r1.checkOutDate = '2026-10-23';
  state.recepcao.stays.old = { id: 'old', kind: 'hospede', roomNumber: '102', status: 'hospedado', checkInDate: '2026-10-01', nights: 2 };
  const before = structuredClone(state);
  for (const target of dueCheckouts(state, noon)) applyCheckout(state, target, noon, 'automatic');
  assert.deepEqual(state, before);
});

test('checkout respects in-flight booking edits and cannot dirty a newer occupied room', () => {
  const state = fixture();
  state.reservationCollectionReconciliations = { r1: { writeLock: { startedAt: noon.getTime() } } };
  assert.throws(() => applyCheckout(state, target, noon, 'test'), /atualizado/);
  delete state.reservationCollectionReconciliations;
  state.recepcao.stays.newer = { id: 'newer', roomNumber: '101', status: 'hospedado', checkInDate: '2026-10-24' };
  applyCheckout(state, target, noon, 'test');
  assert.equal(state.quartos.rooms.room1.cleaningStatus, 'limpo');
  assert.equal(state.recepcao.stays.newer.status, 'hospedado');
});

test('cash history queries are bounded and include late settlement of an older sale', () => {
  const queries = [];
  const listeners = [];
  const firebase = {
    ref: (_db, path) => ({ path }), orderByChild: (field) => ({ field }), startAt: (start) => ({ start }), endAt: (end) => ({ end }),
    query: (reference, ...clauses) => { const q = { ...reference, ...Object.assign({}, ...clauses) }; queries.push(q); return q; },
    onValue: (q, callback) => { listeners.push({ q, callback }); return () => {}; },
  };
  const module = { exports: {} };
  const js = ts.transpileModule(readFileSync(resolve(root, 'src/services/cashHistory.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('module', 'exports', 'require', js)(module, module.exports, (name) => {
    if (name === 'firebase/database') return firebase;
    if (name === '../config/firebase') return { db: {} };
    if (name === './receptionStore') return { emptyReception: () => ({ stays: {}, roomCharges: {}, cashOuts: {}, floatChecks: {}, rooms: {}, attendants: {} }) };
    throw new Error(name);
  });
  const service = module.exports;
  let reception;
  service.subscribeCashDay('2026-10-24', (next) => { reception = next; }, () => {});
  let sales;
  service.subscribeCashSales('2026-10-24', (next) => { sales = next; }, () => {});
  assert.equal(queries.length, 7);
  assert.ok(queries.filter((q) => q.field !== 'lastReceiptAt').every((q) => q.start === '2026-10-24T10:00:00.000Z' && q.end === '2026-10-25T09:59:59.999Z'));
  const receiptsQuery = queries.find((q) => q.field === 'lastReceiptAt');
  assert.equal(receiptsQuery.start, '2026-10-24T10:00:00.000Z');
  // No upper bound: a later payment must not hide the stay's earlier receipts.
  assert.equal(receiptsQuery.end, undefined);
  listeners.filter(({q}) => !q.path.endsWith('/sales')).forEach(({q, callback}) => callback({ val: () => q.field === 'lastReceiptAt' ? { old: { id: 'old', lastReceiptAt: '2026-11-10T12:00:00Z', receipts: { r: { date: '2026-10-24' } } } } : {} }));
  assert.equal(reception.stays.old.receipts.r.date, '2026-10-24');
  const saleListeners = listeners.filter(({ q }) => q.path.endsWith('/sales'));
  saleListeners.find(({ q }) => q.field === 'createdAt').callback({ val: () => ({}) });
  const oldSale = { id: 'old', createdAt: '2026-10-10T12:00:00Z', settledAt: '2026-10-25T04:00:00Z', amount: 20 };
  saleListeners.find(({ q }) => q.field === 'settledAt').callback({ val: () => ({ old: oldSale }) });
  assert.deepEqual(sales, { old: oldSale });
});


const { cashShiftDate } = domainModule('src/services/cashShiftDate.ts');
test('night cashier keeps the starting date from 19:00 through 06:59:59 São Paulo', () => {
  for (const time of ['2026-10-24T19:00:00-03:00', '2026-10-24T23:59:59-03:00', '2026-10-25T00:00:00-03:00', '2026-10-25T06:59:59-03:00']) assert.equal(cashShiftDate(time), '2026-10-24');
  assert.equal(cashShiftDate('2026-10-25T07:00:00-03:00'), '2026-10-25');
  assert.equal(cashShiftDate('2026-10-25T19:00:00-03:00'), '2026-10-25');
  assert.equal(cashShiftDate('2025-01-01T06:59:59-03:00'), '2024-12-31');
  assert.equal(cashShiftDate('2028-03-01T02:00:00-03:00'), '2028-02-29');
});
test('future occupancy shows continuing guests and leaves departed or unreserved rooms empty', () => {
  const r = fixture().quartos.reservations.r1;
  assert.equal(reservationOccupiesDate({ ...r, checkOutDate: '2026-10-26' }, '2026-10-25', '2026-10-24', noon.getTime()), true);
  assert.equal(reservationOccupiesDate(r, '2026-10-25', '2026-10-24', noon.getTime()), false);
  assert.equal(reservationOccupiesDate({ ...r, status: 'encerrada', checkOutDate: '2026-10-26' }, '2026-10-25', '2026-10-24', noon.getTime()), false);
  assert.equal(stayOccupiesDate({ kind: 'hospede', status: 'hospedado', checkInDate: '2026-10-24', nights: 3 }, '2026-10-26', '2026-10-24', noon.getTime()), true);
  assert.equal(stayOccupiesDate({ kind: 'hospede', status: 'hospedado', checkInDate: '2026-10-24', nights: 1 }, '2026-10-26', '2026-10-24', noon.getTime()), false);
});

test('faturamento diário divide diárias e café prépagos em cada dia', () => {
  const { dailyRevenueRows } = domainModule('src/services/dailyRevenue.ts');
  const stay = { id: 's1', kind: 'hospede', checkInDate: '2026-10-01', nights: 3, dailyRate: 100, hasBreakfast: true, breakfastRate: 10, breakfastCount: 1, breakfastDays: 3 };
  const item = (id, amount, paymentMethod) => ({ id, description: id, amount, paymentMethod });
  const rows = dailyRevenueRows({
    'recepcao-s1-diaria': { id: 'recepcao-s1-diaria', date: '2026-10-01', category: 'Diária', amount: 300, wallet: 'oyo', items: [item('a', 300, 'prepaid')], note: '', createdAt: '', updatedAt: '' },
    'recepcao-s1-cafe': { id: 'recepcao-s1-cafe', date: '2026-10-01', category: 'Café', amount: 30, wallet: 'cash', items: [item('b', 30, 'cash')], note: '', createdAt: '', updatedAt: '' },
  }, { s1: stay });
  const diarias = rows.filter((row) => row.category === 'Diária');
  assert.deepEqual(diarias.map((row) => [row.date, row.amount, row.prepaid]), [['2026-10-01', 100, 100], ['2026-10-02', 100, 100], ['2026-10-03', 100, 100]]);
  assert.deepEqual(rows.filter((row) => row.category === 'Café').map((row) => [row.date, row.amount]), [['2026-10-02', 10], ['2026-10-03', 10], ['2026-10-04', 10]]);
});

test('resultado de caixa fecha com a variação de caixa físico e banco', () => {
  const { monthlyFinanceSummary } = domainModule('src/services/financeAnalytics.ts');
  const inc = (id, date, items) => ({ id, date, category: 'Diária', amount: items.reduce((s, i) => s + i.amount, 0), wallet: 'cash', items: items.map((i, n) => ({ id: `${id}${n}`, description: 'x', ...i })), note: '', createdAt: '', updatedAt: '' });
  const data = {
    openingBalances: { cash: 100, bank: 50, oyo: 0 }, suppressed: {}, deletions: {},
    cashAdjustments: { a1: { id: 'a1', date: '2026-10-10', amount: -30, note: '' } },
    incomes: {
      i0: inc('i0', '2026-09-20', [{ amount: 70, paymentMethod: 'cash' }]),
      i1: inc('i1', '2026-10-05', [{ amount: 100, paymentMethod: 'cash' }, { amount: 40.1, paymentMethod: 'pix' }, { amount: 500, paymentMethod: 'prepaid' }]),
    },
    expenses: { e1: { id: 'e1', dueDate: '2026-10-08', category: 'Gás', plannedAmount: 60, paidCash: 60, paidBank: 0, paidOyo: 0, note: '' } },
    payroll: {},
    transfers: {
      t1: { id: 't1', date: '2026-10-12', from: 'cash', to: 'bank', amount: 20, note: '', createdAt: '' },
      t2: { id: 't2', date: '2026-10-15', from: 'oyo', to: 'bank', amount: 200, note: '', createdAt: '' },
      t3: { id: 't3', date: '2026-10-20', from: 'cash', to: 'oyo', amount: 10, note: '', createdAt: '' },
    },
  };
  const s = monthlyFinanceSummary(data, '2026-10');
  const open = s.openingBalances.cash + s.openingBalances.bank;
  const close = s.closingBalances.cash + s.closingBalances.bank;
  assert.equal(Math.round((close - open) * 100), Math.round(s.cashResult * 100));
});
