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

const { reservationFinancialTotal, reservationBalanceDue, reservationIncomeContext, validateReservationPayments } = domainModule('src/services/reservationFinance.ts');
const { withOperationalFinance, stayFinanceEntries } = domainModule('src/services/operationalLedger.ts');

const reservation = {
  id: 'r1', roomId: 'room1', roomNumber: '101', guestName: 'Ana Silva', phone: '', channel: 'balcao',
  checkInDate: '2026-10-14', checkOutDate: '2026-10-16', adults: 1, children: 0,
  reservationAmount: 200, tax: 20, extras: [{ id: 'e1', reservationId: 'r1', amount: 30 }],
  status: 'hospedado', note: '', createdAt: '2026-10-14T12:00:00Z', updatedAt: '2026-10-14T12:00:00Z',
};
const extras = { e1: { id: 'e1', reservationId: 'r1', amount: 30 }, e2: { id: 'e2', reservationId: 'r1', amount: 50 } };
const payment = (id, amount, method = 'cash') => ({
  id, date: '2026-10-14', category: 'Diária', amount, wallet: method === 'cash' ? 'cash' : 'bank',
  items: [{ id: `${id}-part`, amount, paymentMethod: method, description: 'Hospedagem · quarto 101' }],
  note: 'Recebimento da reserva de Ana Silva · Quarto 101', createdAt: reservation.createdAt, updatedAt: reservation.updatedAt,
});
const collection = (id, amount) => ({ id, reservationId: 'r1', amount, date: '2026-10-14', paymentMethod: 'pix', actor: 'Gerência', createdAt: reservation.createdAt });

test('reservation total includes booking extras and later extras exactly once', () => {
  assert.equal(reservationFinancialTotal(reservation, extras), 300);
  assert.equal(reservationFinancialTotal({ ...reservation, reservationAmount: undefined, nightlyRate: 100 }, extras), 300);
});

test('checkout reconciliation and retries do not charge or count the same receipt twice', () => {
  const incomes = { initial: payment('reservation-r1-initial', 100), checkout: payment('reservation-r1-checkout-c1', 150, 'pix') };
  const pending = { c1: collection('c1', 150) };
  // Collections and income maps are keyed by their persistent IDs in the database.
  const byId = Object.fromEntries(Object.values(incomes).map((entry) => [entry.id, entry]));
  assert.equal(reservationBalanceDue(reservation, byId, extras, pending), 50);
  assert.equal(reservationBalanceDue(reservation, byId, extras, { ...pending, c2: collection('c2', 50) }), 0);
  assert.equal(reservationBalanceDue(reservation, { ...byId, 'reservation-r1-checkout-c2': payment('reservation-r1-checkout-c2', 50) }, extras, { ...pending, c2: collection('c2', 50) }), 0);
});

test('voided receipts never reduce the outstanding balance or reappear from pending checkout', () => {
  const entry = payment('reservation-r1-checkout-c1', 150);
  const suppressed = { [entry.id]: true };
  assert.equal(reservationBalanceDue(reservation, { [entry.id]: entry }, extras, { c1: collection('c1', 150) }, suppressed), 300);
  assert.equal(reservationBalanceDue(reservation, {}, extras, { c1: collection('c1', 150) }, suppressed), 300);
});

test('changing guest, room and channel keeps receipt IDs, amounts and payment methods', () => {
  const before = payment('reservation-r1-checkout-c1', 150, 'pix');
  const after = reservationIncomeContext(before, reservation, { ...reservation, roomNumber: '202', guestName: 'Bruno Costa', channel: 'rotativo' });
  assert.equal(after.id, before.id);
  assert.equal(after.amount, 150);
  assert.equal(after.items[0].paymentMethod, 'pix');
  assert.equal(after.items[0].description, 'Hospedagem · quarto 202');
  assert.equal(after.note, 'Recebimento da reserva de Bruno Costa · Quarto 202');
  assert.equal(after.category, 'Rotativo');
});

test('payment validation accepts split wallets and rejects foreign IDs, invalid dates and inconsistent amounts', () => {
  const split = { ...payment('reservation-r1-p1', 100), items: [
    { id: 'a', description: 'Hospedagem', amount: 40, paymentMethod: 'cash' },
    { id: 'b', description: 'Hospedagem', amount: 60, paymentMethod: 'pix' },
  ] };
  assert.doesNotThrow(() => validateReservationPayments('r1', [split]));
  assert.throws(() => validateReservationPayments('r1', [{ ...split, id: 'reservation-r2-p1' }]));
  assert.throws(() => validateReservationPayments('r1', [{ ...split, date: '2026-02-30' }]));
  assert.throws(() => validateReservationPayments('r1', [{ ...split, amount: 101 }]));
  assert.throws(() => validateReservationPayments('r1', [split, split]));
});

const stay = {
  id: 's1', kind: 'hospede', checkInDate: '2026-10-14', nights: 2, roomNumber: '101', guestName: 'Ana Silva',
  dailyRate: 100, dailyMethod: 'cash', hasBreakfast: false, breakfastRate: 0, taxAmount: 0, taxMethod: 'cash',
  extras: [], note: '', attendant: 'Equipe', status: 'hospedado', createdAt: reservation.createdAt,
};
const finance = (incomes = {}, suppressed = {}) => ({
  incomes, expenses: {}, transfers: {}, payroll: {}, openingBalances: { cash: 0, bank: 0, oyo: 0 },
  incomeCategories: [], expenseCategories: [], suppressed,
});
const sources = (value) => ({ stays: { [value.id]: value }, roomCharges: {}, cashOuts: {}, sales: {} });

test('cash flow reflects stay edits immediately while respecting manager overrides', () => {
  const original = stayFinanceEntries(stay)['recepcao-s1-diaria'];
  const updatedStay = { ...stay, dailyRate: 150, roomNumber: '202', guestName: 'Bruno Costa', dailyMethod: 'pix' };
  const reconciled = withOperationalFinance(finance({ [original.id]: original }), sources(updatedStay));
  assert.equal(reconciled.incomes[original.id].amount, 300);
  assert.equal(reconciled.incomes[original.id].items[0].paymentMethod, 'pix');
  assert.match(reconciled.incomes[original.id].note, /Quarto 202 · Bruno Costa/);
  const override = { ...original, amount: 175, operationalOverride: true };
  assert.equal(withOperationalFinance(finance({ [original.id]: override }), sources(updatedStay)).incomes[original.id].amount, 175);
});

test('stay and room-charge payment voids survive stale persisted cash flow copies', () => {
  const original = stayFinanceEntries(stay)['recepcao-s1-diaria'];
  assert.equal(withOperationalFinance(finance({ [original.id]: original }), sources({ ...stay, voidedPayments: { [original.id]: true } })).incomes[original.id], undefined);
  assert.equal(withOperationalFinance(finance({ [original.id]: original }, { [original.id]: true }), sources(stay)).incomes[original.id], undefined);
  const chargeId = 'room-charge-charge1-part1';
  const charge = { id: 'charge1', kind: 'cafe_avulso', sourceType: 'stay', sourceId: 's1', date: '2026-10-14', roomNumber: '101', guestName: 'Ana Silva', days: 1, amount: 20,
    payments: { part1: { method: 'cash', amount: 20 } }, voidedPayments: { [chargeId]: true }, attendant: 'Equipe', createdAt: reservation.createdAt };
  assert.equal(withOperationalFinance(finance({ [chargeId]: payment(chargeId, 20) }), { ...sources(stay), roomCharges: { charge1: charge } }).incomes[chargeId], undefined);
});

function offlineStore(state) {
  const cache = new Map();
  const writes = [];
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
    ref: (_db, path = '') => ({ path }),
    query: (location, ...clauses) => ({ ...location, clauses }),
    get: async (location) => {
      let value = read(location.path);
      if (location.clauses && value) {
        const order = location.clauses.find((clause) => clause.type === 'key' || clause.type === 'child');
        value = Object.fromEntries(Object.entries(value).filter(([key, item]) => location.clauses.every((clause) => {
          const field = order?.type === 'child' ? item[order.value] : key;
          return clause.type === 'start' ? field >= clause.value : clause.type === 'end' ? field <= clause.value
            : clause.type === 'equal' ? field === clause.value : true;
        })));
      }
      return snapshot(value);
    },
    runTransaction: async (location, transform) => {
      const value = transform(structuredClone(read(location.path)));
      if (value === undefined) return { committed: false, snapshot: snapshot(read(location.path)) };
      write(location.path, value);
      return { committed: true, snapshot: snapshot(value) };
    },
    update: async (location, changes) => {
      writes.push(structuredClone(changes));
      Object.entries(changes).forEach(([path, value]) => write([location.path, path].filter(Boolean).join('/'), value));
    },
    set: async (location, value) => write(location.path, value),
    onValue: (location, onChange) => { onChange(snapshot(read(location.path))); return () => undefined; },
    orderByKey: () => ({ type: 'key' }), orderByChild: (value) => ({ type: 'child', value }),
    startAt: (value) => ({ type: 'start', value }), endAt: (value) => ({ type: 'end', value }),
    equalTo: (value) => ({ type: 'equal', value }), limitToLast: (value) => ({ type: 'limit', value }),
  };
  function load(path) {
    const filename = resolve(root, path);
    if (filename.endsWith('/config/firebase.ts')) return { db: {} };
    if (filename.endsWith('/types/audit.ts')) return { buildAuditEvents: () => ({}) };
    if (filename.endsWith('/services/cleaningStore.ts')) return {
      roomCleaningTaskUpdates: async () => ({}), renameRoomCleaningTasks: async () => ({}), deleteCleaningLogTaskUpdates: async () => ({}),
    };
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const require = (name) => {
      if (name === 'firebase/database') return firebase;
      assert.ok(name.startsWith('.'), `Unexpected external dependency: ${name}`);
      return load(resolve(dirname(filename), `${name}.ts`));
    };
    new Function('module', 'exports', 'require', output)(module, module.exports, require);
    return module.exports;
  }
  return { service: load('src/services/housekeepingStore.ts'), writes };
}

function databaseFixture() {
  return { erp_geral: {
    quartos: { reservations: { r1: structuredClone(reservation) }, reservationIndex: { r1: structuredClone(reservation) }, rooms: {
      room1: { id: 'room1', number: '101', cleaningStatus: 'limpo', maintenanceStatus: 'normal', note: '' },
      room2: { id: 'room2', number: '202', cleaningStatus: 'limpo', maintenanceStatus: 'normal', note: '' },
    }, reservationSlots: {} },
    financeiro: { incomes: {}, suppressed: {} }, reservationExtras: { r1: structuredClone(extras) }, reservationCollections: {},
    recepcao: { stays: {}, rooms: {}, roomCharges: {} },
  } };
}

test('occupied reservation edits commit source, directory, receipts and linked charges together', async () => {
  const state = databaseFixture();
  const deposit = payment('reservation-r1-deposit', 100);
  const checkout = payment('reservation-r1-checkout-c1', 50, 'pix');
  const voided = payment('reservation-r1-voided', 75);
  state.erp_geral.financeiro.incomes = { [deposit.id]: deposit, [checkout.id]: checkout };
  state.erp_geral.financeiro.suppressed[voided.id] = true;
  state.erp_geral.recepcao.roomCharges.charge1 = { id: 'charge1', sourceType: 'reservation', sourceId: 'r1', roomNumber: '101', guestName: 'Ana Silva',
    kind: 'cafe_avulso', days: 1, amount: 20, date: '2026-10-14', payments: { part1: { method: 'pix', amount: 20 } }, attendant: 'Equipe', createdAt: reservation.createdAt };
  state.erp_geral.recepcao.roomCharges.extraGuest = { ...state.erp_geral.recepcao.roomCharges.charge1,
    id: 'extraGuest', kind: 'hospede_extra', guestName: 'Maria Souza' };
  const { service, writes } = offlineStore(state);
  const changed = { ...reservation, roomId: 'room2', roomNumber: '202', guestName: 'Bruno Costa', reservationAmount: 300 };
  await service.saveReservationRecord(changed, reservation, [{ ...deposit, amount: 200, items: [{ ...deposit.items[0], amount: 200 }] }]);
  assert.equal(state.erp_geral.quartos.reservations.r1.status, 'hospedado');
  assert.equal(state.erp_geral.quartos.reservations.r1.balanceDue, 150);
  assert.equal(state.erp_geral.quartos.reservationIndex.r1.roomNumber, '202');
  assert.equal(state.erp_geral.quartos.rooms.room1.cleaningStatus, 'sujo');
  assert.equal(state.erp_geral.financeiro.incomes[deposit.id].amount, 200);
  assert.equal(state.erp_geral.financeiro.incomes[checkout.id].amount, 50);
  assert.equal(state.erp_geral.financeiro.suppressed[voided.id], true);
  assert.equal(state.erp_geral.financeiro.incomes[voided.id], undefined);
  assert.equal(state.erp_geral.recepcao.roomCharges.charge1.guestName, 'Bruno Costa');
  assert.equal(state.erp_geral.recepcao.roomCharges.charge1.roomNumber, '202');
  assert.equal(state.erp_geral.recepcao.roomCharges.extraGuest.roomNumber, '202');
  assert.equal(state.erp_geral.recepcao.roomCharges.extraGuest.guestName, 'Maria Souza');
  assert.match(state.erp_geral.financeiro.incomes['room-charge-extraGuest-part1'].note, /Maria Souza/);
  assert.equal(writes.length, 1);
  assert.ok(writes[0]['erp_geral/quartos/reservations/r1']);
  assert.ok(writes[0][`erp_geral/financeiro/incomes/${deposit.id}`]);
});

test('stale or voided financial edits are rejected without changing the reservation', async () => {
  for (const reason of ['changed', 'voided']) {
    const state = databaseFixture();
    const original = payment('reservation-r1-deposit', 100);
    state.erp_geral.financeiro.incomes[original.id] = { ...original, updatedAt: reason === 'changed' ? '2026-10-14T13:00:00Z' : original.updatedAt };
    if (reason === 'voided') state.erp_geral.financeiro.suppressed[original.id] = true;
    const { service, writes } = offlineStore(state);
    await assert.rejects(service.saveReservationRecord({ ...reservation, guestName: 'Bruno Costa' }, reservation, [original]));
    assert.equal(state.erp_geral.quartos.reservations.r1.guestName, 'Ana Silva');
    assert.equal(writes.length, 0);
  }
});

test('checkout reconciliation preserves existing receipts and is idempotent with all extras', async () => {
  const state = databaseFixture();
  const existing = payment('reservation-r1-checkout-c1', 100);
  state.erp_geral.financeiro.incomes[existing.id] = existing;
  state.erp_geral.reservationCollections.r1 = { c1: collection('c1', 100), c2: collection('c2', 200) };
  const { service, writes } = offlineStore(state);
  await service.syncReservationCollections(['r1']);
  assert.equal(state.erp_geral.quartos.reservations.r1.balanceDue, 0);
  assert.equal(state.erp_geral.financeiro.incomes[existing.id].updatedAt, existing.updatedAt);
  assert.equal(Object.keys(state.erp_geral.financeiro.incomes).length, 2);
  assert.deepEqual(state.erp_geral.reservationCollections.r1, {});
  await service.syncReservationCollections(['r1']);
  assert.equal(writes.length, 1);
  assert.equal(state.erp_geral.quartos.reservations.r1.balanceDue, 0);
});

test('legacy stay release creates a dirty room record and preserves its payments', async () => {
  const state = databaseFixture();
  state.erp_geral.quartos.rooms = {};
  state.erp_geral.recepcao.stays.s1 = structuredClone(stay);
  state.erp_geral.recepcao.rooms.reception101 = { id: 'reception101', number: '101' };
  const receipt = stayFinanceEntries(stay)['recepcao-s1-diaria'];
  state.erp_geral.financeiro.incomes[receipt.id] = receipt;
  const { service } = offlineStore(state);
  await service.releaseOccupiedRoom({ stayId: 's1' });
  assert.equal(state.erp_geral.recepcao.stays.s1.status, 'encerrado');
  assert.equal(state.erp_geral.quartos.rooms.reception101.cleaningStatus, 'sujo');
  assert.deepEqual(state.erp_geral.financeiro.incomes[receipt.id], receipt);
});

test('releasing obsolete slots cannot erase a slot now owned by another reservation', async () => {
  const state = databaseFixture();
  state.erp_geral.quartos.reservationSlots.room1 = { '2026-10-14': 'r1', '2026-10-15': 'another-reservation' };
  const { service } = offlineStore(state);
  await service.releaseReservationSlots(reservation);
  assert.equal(state.erp_geral.quartos.reservationSlots.room1['2026-10-14'], undefined);
  assert.equal(state.erp_geral.quartos.reservationSlots.room1['2026-10-15'], 'another-reservation');
});
