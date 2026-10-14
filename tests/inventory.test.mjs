import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

// All service imports use this local database; no Firebase app or network is loaded.
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(readFileSync(resolve(rootDirectory, 'database.rules.json'), 'utf8')).rules;
const product = (id, category, locations) => ({ id, name: id === 'water' ? 'Água' : 'Sabonete', sku: id, category, unit: 'un.', minimumQuantity: 1, cost: 2, salePrice: category === 'frigobar' ? 5 : 0, locationQuantities: locations, supplierId: '', expiresAt: '', description: '', active: true, createdAt: '2026-10-14T12:00:00Z', updatedAt: '2026-10-14T12:00:00Z' });
const fixture = () => ({ roles: { user: { role: 'admin' } }, erp_geral: { estoque: { revision: 0, products: { water: product('water', 'frigobar', { 'Almoxarifado central': 5, 'Geladeira - Recepção': 10 }), soap: product('soap', 'limpeza', { 'Almoxarifado central': 10 }) }, movements: {}, suppliers: {}, assets: {} }, frigobar: { catalog: {}, operations: { stock: {}, sales: {} } }, saidas: { catalog: {}, records: {} }, financeiro: { incomes: {}, expenses: {}, suppressed: {}, deletions: {} }, stockProductLocks: {} } });

function offlineStore(state = fixture()) {
  const modules = new Map(); const warmed = new Map(); let failSaleWrite = false;
  const read = (tree, path) => path.split('/').filter(Boolean).reduce((value, key) => value?.[key], tree) ?? null;
  function snapshot(tree, path = '') {
    const value = read(tree, path);
    return { val: () => structuredClone(value), exists: () => value !== null,
      child: (child) => snapshot(tree, [path, child].filter(Boolean).join('/')),
      parent: () => snapshot(tree, path.split('/').slice(0, -1).join('/')),
      isString: () => typeof value === 'string', isNumber: () => typeof value === 'number', isBoolean: () => typeof value === 'boolean',
      hasChildren: (names) => value && typeof value === 'object' && (names ? names.every((key) => read(tree, [path, key].filter(Boolean).join('/')) !== null) : Object.keys(value).length > 0) };
  }
  function write(tree, path, value) {
    const keys = path.split('/').filter(Boolean); let parent = tree;
    keys.slice(0, -1).forEach((key) => { parent = parent[key] ??= {}; });
    if (value?.__increment !== undefined) parent[keys.at(-1)] = Number(parent[keys.at(-1)] ?? 0) + value.__increment;
    else if (value === null) delete parent[keys.at(-1)]; else parent[keys.at(-1)] = structuredClone(value);
  }
  function validate(path, proposed) {
    let node = rules; const variables = {}; const parts = path.split('/').filter(Boolean); let allowed = false;
    const applyRule = (definition, nodePath) => {
      const evaluate = (expression) => new Function('auth', 'root', 'data', 'newData', 'now', ...Object.keys(variables), `return (${expression});`)(
        { uid: 'user' }, snapshot(state), snapshot(state, nodePath), snapshot(proposed, nodePath), Date.now(), ...Object.values(variables));
      if (definition['.write'] !== undefined && (definition['.write'] === true || evaluate(String(definition['.write'])))) allowed = true;
      if (definition['.validate'] !== undefined && read(proposed, nodePath) !== null) assert.ok(evaluate(String(definition['.validate'])), `Rule validation: ${nodePath}`);
    };
    applyRule(node, '');
    for (let index = 0; index < parts.length; index += 1) {
      const segment = parts[index]; const variable = node[segment] ? undefined : Object.keys(node).find((key) => key.startsWith('$'));
      if (!node[segment] && !variable) break;
      if (variable) variables[variable] = segment;
      node = node[segment] ?? node[variable]; applyRule(node, parts.slice(0, index + 1).join('/'));
    }
    assert.ok(allowed, `Write denied: ${path}`);
  }
  function applyWrites(entries) {
    const proposed = structuredClone(state);
    entries.forEach(([path, value]) => { assert.notEqual(value, undefined, `Undefined write at ${path}`); write(proposed, path, value); });
    const visit = (path, value) => {
      validate(path, proposed);
      if (value && typeof value === 'object' && value.__increment === undefined) Object.entries(value).forEach(([key, child]) => visit([path, key].filter(Boolean).join('/'), child));
    };
    entries.forEach(([path, value]) => visit(path, value));
    entries.forEach(([path, value]) => write(state, path, value));
  }
  const database = {
    ref: (_db, path = '') => ({ path }), query: (reference, ...clauses) => ({ ...reference, clauses }),
    get: async (reference) => {
      let value = read(state, reference.path);
      if (reference.clauses && value) {
        const order = reference.clauses.find((item) => item.type === 'order')?.field;
        value = Object.fromEntries(Object.entries(value).filter(([, item]) => reference.clauses.every((clause) => clause.type === 'equal' ? item[order] === clause.value : true)));
      }
      return { val: () => structuredClone(value), exists: () => value !== null, child: (path) => snapshot({ value }, 'value/' + path) };
    },
    onValue: (reference, callback) => {
      warmed.set(reference.path, (warmed.get(reference.path) ?? 0) + 1); callback(snapshot(state, reference.path));
      return () => warmed.set(reference.path, Math.max(0, (warmed.get(reference.path) ?? 1) - 1));
    },
    runTransaction: async (reference, transform) => {
      // The real SDK first invokes the callback with null when no complete cache exists.
      if (!warmed.get(reference.path) && transform(null) === undefined) return { committed: false, snapshot: snapshot(state, reference.path) };
      const value = transform(structuredClone(read(state, reference.path)));
      if (value === undefined) return { committed: false, snapshot: snapshot(state, reference.path) };
      applyWrites([[reference.path, value]]); return { committed: true, snapshot: snapshot(state, reference.path) };
    },
    set: async (reference, value) => {
      if (failSaleWrite && reference.path.includes('/operations/sales/')) { failSaleWrite = false; throw new Error('Simulated sale write failure'); }
      applyWrites([[reference.path, value]]);
    },
    remove: async (reference) => applyWrites([[reference.path, null]]),
    update: async (reference, changes) => applyWrites(Object.entries(changes).map(([path, value]) => [[reference.path, path].filter(Boolean).join('/'), value])),
    increment: (quantity) => ({ __increment: quantity }), orderByChild: (field) => ({ type: 'order', field }), equalTo: (value) => ({ type: 'equal', value }),
    startAt: (value) => ({ type: 'start', value }), endAt: (value) => ({ type: 'end', value }),
  };
  function load(file) {
    const filename = resolve(rootDirectory, file);
    if (filename.endsWith('/config/firebase.ts')) return { db: {} };
    if (filename.endsWith('/types/audit.ts')) return { buildAuditEvents: () => ({}) };
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
    const require = (name) => {
      if (name === 'firebase/database') return database;
      if (name === 'react') return { useEffect: () => {}, useRef: (value) => ({ current: value }) };
      assert.ok(name.startsWith('.'), `Unexpected import ${name}`);
      return load(resolve(dirname(filename), name + '.ts'));
    };
    new Function('module', 'exports', 'require', compiled)(module, module.exports, require); return module.exports;
  }
  return { state, load, database, failNextSaleWrite: () => { failSaleWrite = true; } };
}
const saleInput = (id, quantity) => ({ id, items: [{ productId: 'water', quantity }], settlement: 'pago_na_recepcao', paymentMethod: 'pix', roomNumber: '', guestName: '', actor: 'Equipe', catalog: {} });
const movementInput = (id, type, quantity, fromLocation, toLocation = '') => ({ id, productId: 'water', type, quantity, fromLocation, toLocation, unitPrice: 2, reference: '', note: '', actor: 'Gerência', createdAt: new Date().toISOString(), entryPayment: 'pendente' });

test('product registration preserves current balances and rejects duplicate SKU, invalid keys and NaN', async () => {
  const db = offlineStore(); const inventory = db.load('src/services/inventoryStore.ts'); const operations = db.load('src/services/inventoryOperations.ts');
  const edited = { ...db.state.erp_geral.estoque.products.soap, name: 'Sabonete editado', supplierId: undefined };
  db.state.erp_geral.estoque.products.soap.locationQuantities['Almoxarifado central'] = 8;
  await inventory.updateInventory((current) => operations.mergeProductRegistration(current, edited));
  assert.equal(db.state.erp_geral.estoque.products.soap.locationQuantities['Almoxarifado central'], 8);
  assert.equal('supplierId' in db.state.erp_geral.estoque.products.soap, false);
  assert.equal(db.state.erp_geral.estoque.revision, 1);
  await assert.rejects(() => inventory.updateInventory((current) => operations.mergeProductRegistration(current, { ...edited, id: 'new' })), /código/);
  assert.throws(() => inventory.cleanInventoryPayload({ quantity: NaN }), /numérico/);
  assert.throws(() => inventory.cleanInventoryPayload({ 'Quarto/1': 2 }), /caracteres/);
});

test('catalog synchronization applies each change once and never replays an older snapshot', async () => {
  const db = offlineStore(); const service = db.load('src/services/frigobarStore.ts');
  await service.syncFrigobarCatalog(structuredClone(db.state.erp_geral.estoque));
  await service.createFrigobarSale(saleInput('s1', 3)); assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 7);
  const old = structuredClone(db.state.erp_geral.estoque);
  db.state.erp_geral.estoque.products.water.locationQuantities['Geladeira - Recepção'] = 12; db.state.erp_geral.estoque.revision = 1;
  const latest = structuredClone(db.state.erp_geral.estoque);
  await service.syncFrigobarCatalog(latest); await service.syncFrigobarCatalog(latest); await service.syncFrigobarCatalog(old);
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 9);
  assert.equal(db.state.erp_geral.frigobar.catalog.water.baseQuantity, 12);
});

test('cold-cache sales aggregate duplicate lines, reject invalid payments and never debit twice', async () => {
  const db = offlineStore(); const service = db.load('src/services/frigobarStore.ts'); await service.syncFrigobarCatalog(db.state.erp_geral.estoque);
  db.state.roles.user.role = 'viewer';
  const input = { ...saleInput('sale', 1), items: [{ productId: 'water', quantity: 1 }, { productId: 'water', quantity: 1 }] };
  const attempts = await Promise.allSettled([service.createFrigobarSale(input), service.createFrigobarSale(input)]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  await service.createFrigobarSale(input);
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 8);
  assert.equal(db.state.erp_geral.frigobar.operations.sales.sale.amount, 10);
  assert.equal(db.state.erp_geral.frigobar.operations.sales.sale.items.length, 1);
  await assert.rejects(() => service.createFrigobarSale({ ...saleInput('invalid', 1), paymentMethod: 'unknown' }), /pagamento/);
  await assert.rejects(() => service.createFrigobarSale(saleInput('oversold', 9)), /insuficiente/);
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 8);
});

test('failed sale creation rolls back its debit and retry succeeds once', async () => {
  const db = offlineStore(); const service = db.load('src/services/frigobarStore.ts'); await service.syncFrigobarCatalog(db.state.erp_geral.estoque);
  db.failNextSaleWrite(); await assert.rejects(() => service.createFrigobarSale(saleInput('retry', 2)), /Simulated/);
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 10);
  await service.createFrigobarSale(saleInput('retry', 2)); await service.createFrigobarSale(saleInput('retry', 2));
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 8);
});

test('entry, transfer, loss and inventory count use the live reception balance after sales', async () => {
  const db = offlineStore(); const service = db.load('src/services/frigobarStore.ts'); const operations = db.load('src/services/inventoryOperations.ts');
  await service.syncFrigobarCatalog(db.state.erp_geral.estoque); await service.createFrigobarSale(saleInput('s1', 2));
  await operations.recordInventoryMovement(movementInput('transfer', 'transferencia', 3, 'Geladeira - Recepção', 'Almoxarifado central'));
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 5); assert.equal(db.state.erp_geral.estoque.products.water.locationQuantities['Almoxarifado central'], 8);
  await operations.recordInventoryMovement(movementInput('entry', 'entrada', 2, '', 'Geladeira - Recepção'));
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 7); assert.equal(db.state.erp_geral.estoque.movements.entry.financeSynced, false);
  await operations.recordInventoryMovement(movementInput('loss', 'perda', 1, 'Geladeira - Recepção'));
  await operations.recordInventoryMovement(movementInput('count', 'ajuste', 2, 'Geladeira - Recepção'));
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 2);
  await operations.recordInventoryMovement(movementInput('count', 'ajuste', 2, 'Geladeira - Recepção'));
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 2);
  await assert.rejects(() => operations.recordInventoryMovement(movementInput('too-much', 'transferencia', 3, 'Geladeira - Recepção', 'Lavanderia')), /insuficiente/);
});

test('internal outputs reserve complete quantities, prevent oversubscription and reconcile idempotently', async () => {
  const db = offlineStore(); const service = db.load('src/services/internalOutputs.ts'); const inventory = db.load('src/services/inventoryStore.ts');
  await service.syncOutputsCatalog(db.state.erp_geral.estoque); db.state.roles.user.role = 'viewer';
  const record = { id: 'out1', items: [{ productId: 'soap', productName: 'Sabonete', unit: 'un.', quantity: 3 }], destination: 'Camareiras', note: '', actor: 'Equipe', createdAt: new Date().toISOString() };
  await service.createOutput(record); await service.createOutput(record);
  await assert.rejects(() => service.createOutput({ ...record, id: 'out2', items: [{ ...record.items[0], quantity: 8 }] }), /insuficiente/);
  db.state.roles.user.role = 'admin';
  await inventory.updateInventory((current) => service.applyOutput(current, record));
  await inventory.updateInventory((current) => service.applyOutput(current, record));
  assert.equal(db.state.erp_geral.estoque.products.soap.locationQuantities['Almoxarifado central'], 7);
  assert.equal(Object.values(db.state.erp_geral.estoque.movements).length, 1);
  assert.throws(() => service.applyOutput(db.state.erp_geral.estoque, { ...record, id: 'too-much', items: [{ ...record.items[0], quantity: 8 }] }), /insuficiente/);
  await service.deleteOutput(record); await service.deleteOutput(record);
  assert.equal(db.state.erp_geral.estoque.products.soap.locationQuantities['Almoxarifado central'], 10);
});

test('viewer settlement validates one receipt and deletion returns sale stock once', async () => {
  const db = offlineStore(); const service = db.load('src/services/frigobarStore.ts'); await service.syncFrigobarCatalog(db.state.erp_geral.estoque);
  db.state.roles.user.role = 'viewer'; await service.createFrigobarSale({ ...saleInput('pending', 2), settlement: 'cobrar_no_checkout', paymentMethod: '', roomNumber: '101' });
  await service.settleFrigobarSale('pending', 'pix', 'Equipe'); await assert.rejects(() => service.settleFrigobarSale('pending', 'dinheiro', 'Equipe'), /pendente/);
  db.state.roles.user.role = 'admin'; const sale = db.state.erp_geral.frigobar.operations.sales.pending;
  db.state.erp_geral.frigobar.operations.stock._saleDebits.pending.state='pending';
  await service.deleteFrigobarSale(sale); await service.deleteFrigobarSale(sale);
  await service.syncFrigobarCatalog(db.state.erp_geral.estoque);
  assert.equal(db.state.erp_geral.frigobar.operations.sales.pending,undefined);
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water, 10);
  assert.equal(db.state.erp_geral.financeiro.suppressed['frigobar-pending'], true);
});

test('purchase removal rejects consumed stock and the rules reject negative balances', async () => {
  const db = offlineStore(); const operations = db.load('src/services/inventoryOperations.ts'); const deletion = db.load('src/services/inventoryDeletion.ts');
  await operations.recordInventoryMovement(movementInput('entry', 'entrada', 2, '', 'Geladeira - Recepção'));
  const sales = db.load('src/services/frigobarStore.ts'); await sales.createFrigobarSale(saleInput('sale', 11));
  await assert.rejects(() => deletion.deleteStockMovement('entry'), /consumida/);
  assert.ok(db.state.erp_geral.estoque.movements.entry);
  await assert.rejects(() => db.database.set({ path: 'erp_geral/estoque/products/soap/locationQuantities/Almoxarifado central' }, -1), /Rule validation/);
});


test('fractional stock quantities do not fail because of floating point rounding', async () => {
  const db = offlineStore(); db.state.erp_geral.estoque.products.water.locationQuantities['Geladeira - Recepção'] = .3;
  const service = db.load('src/services/frigobarStore.ts'); await service.syncFrigobarCatalog(db.state.erp_geral.estoque);
  await service.createFrigobarSale(saleInput('fraction1',.1)); await service.createFrigobarSale(saleInput('fraction2',.1)); await service.createFrigobarSale(saleInput('fraction3',.1));
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water,0);
});

test('room beverage charges use the same stock locks and reject stale lodging sources', async () => {
  const db = offlineStore(); const stock = db.load('src/services/frigobarStore.ts'); await stock.syncFrigobarCatalog(db.state.erp_geral.estoque);
  db.state.erp_geral.recepcao = { stays: { stay1: { id:'stay1',roomNumber:'101',guestName:'Ana',status:'hospedado' } }, roomCharges:{} };
  const service = db.load('src/services/receptionStore.ts');
  const charge = { id:'charge1',kind:'bebida',productId:'water',productName:'Água',quantity:2,roomNumber:'101',sourceType:'stay',sourceId:'stay1',guestName:'Ana',amount:10,days:1,date:'2026-10-14',attendant:'Equipe',createdAt:new Date().toISOString(),payments:{part1:{method:'pix',amount:10}} };
  db.state.roles.user.role='viewer';
  const results=await Promise.allSettled([service.saveRoomCharge(charge),service.saveRoomCharge(charge)]);
  assert.equal(results.filter((result)=>result.status==='fulfilled').length,1);
  await service.saveRoomCharge(charge); assert.equal(db.state.erp_geral.frigobar.operations.stock.water,8);
  const extra={...charge,id:'extra1',kind:'hospede_extra',guestName:'Maria',validFrom:'2026-10-14',validThrough:'2026-10-15'};
  await service.saveRoomCharge(extra); assert.equal(db.state.erp_geral.recepcao.roomCharges.extra1.guestName,'Maria');
  db.state.erp_geral.recepcao.stays.stay1.status='encerrado';
  await assert.rejects(()=>service.saveRoomCharge({...charge,id:'charge2'}),/alterada ou encerrada/);
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water,8);
});

test('a persisted pending sale recovers after interruption without another stock debit', async () => {
  const db = offlineStore(); const service = db.load('src/services/frigobarStore.ts'); await service.syncFrigobarCatalog(db.state.erp_geral.estoque);
  const stamp = new Date().toISOString();
  const sale = { id:'recovered',items:[{productId:'water',productName:'Água',quantity:3,unit:'un.',unitPrice:5}],amount:15,settlement:'pago_na_recepcao',paymentMethod:'pix',roomNumber:'',guestName:'',actor:'Equipe',createdAt:stamp,settledAt:stamp,settledBy:'Equipe' };
  db.state.erp_geral.frigobar.operations.stock.water=7;
  db.state.erp_geral.frigobar.operations.stock._saleDebits={recovered:{sale,state:'pending'}};
  await service.syncFrigobarCatalog(db.state.erp_geral.estoque);
  assert.equal(db.state.erp_geral.frigobar.operations.sales.recovered.amount,15);
  assert.equal(db.state.erp_geral.frigobar.operations.stock.water,7);
  assert.equal(db.state.erp_geral.frigobar.operations.stock._saleDebits.recovered.state,'recorded');
  await service.createFrigobarSale(saleInput('recovered',3)); assert.equal(db.state.erp_geral.frigobar.operations.stock.water,7);
});
