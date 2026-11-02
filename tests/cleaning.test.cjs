const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');
const projectRoot = path.resolve(__dirname, '..');
// Exercise the database rules against an isolated in-memory state.
let currentRole = 'viewer';
let data; let sequence = 0; let failUpdate = false;
const clone = (value) => value === undefined ? null : JSON.parse(JSON.stringify(value));
const at = (path) => path.split('/').filter(Boolean).reduce((value, key) => value?.[key], data);
function put(path, value) {
  const segments = path.split('/').filter(Boolean); let parent = data;
  for (const key of segments.slice(0, -1)) parent = parent[key] ??= {};
  if (value === null) delete parent[segments.at(-1)]; else parent[segments.at(-1)] = clone(value);
}
const snapshot = (value) => ({ val: () => clone(value), exists: () => value != null, child: (path) => snapshot(path.split('/').reduce((item, key) => item?.[key], value)) });

function checkRules(path, value) {
  const adminOnly = [
    'erp_geral/escala',
    'erp_geral/estoque',
    'erp_geral/quartos/reservations',
    'erp_geral/quartos/reservationIndex',
    'erp_geral/quartos/reservationSlots',
    'erp_geral/quartos/auditLog',
    'erp_geral/financeiro',
    'erp_geral/reservationCollections',
    'erp_geral/reservationExtras',
    'erp_geral/reservationCollectionReconciliations',
    'erp_geral/frigobar/catalog',
    'erp_geral/frigobar/operations/catalogSyncs',
    'erp_geral/recepcao/rates',
    'erp_geral/recepcao/attendants',
    'erp_geral/limpeza/camareiras',
    'erp_geral/limpeza/camareirasConfigured',
    'erp_geral/saidas/catalog',
  ];
  assert.ok(currentRole === 'admin' || !adminOnly.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
    `Write denied: ${path} role=${currentRole}`);
  const task = /^erp_geral\/limpeza\/tasks\/([^/]+)\//.exec(path);
  if (currentRole === 'viewer' && task) {
    assert.equal(at(`erp_geral/limpeza/tasks/${task[1]}/status`), 'em_limpeza', `Write denied: ${path} role=${currentRole}`);
  }
  if (currentRole === 'viewer') {
    const roomStatus = /^erp_geral\/quartos\/rooms\/([^/]+)\/(cleaningStatus|maintenanceStatus)$/.exec(path);
    if (roomStatus?.[2] === 'maintenanceStatus') assert.ok(value === 'normal' || value === 'em_manutencao', `Write denied: ${path}`);
    if (roomStatus?.[2] === 'cleaningStatus') {
      const lock = at(`erp_geral/limpeza/activeRooms/${roomStatus[1]}`);
      const allowed = value === 'sujo'
        || (value === 'em_limpeza' && lock?.phase === 'assigning')
        || (value === 'limpo' && lock?.phase === 'finishing');
      assert.ok(allowed, `Write denied: ${path}`);
    }
    if (path.startsWith('erp_geral/quartos/cleaningLogs/')) {
      const lock = value && at(`erp_geral/limpeza/activeRooms/${value.roomId}`);
      const taskValue = lock && at(`erp_geral/limpeza/tasks/${lock.taskId}`);
      assert.ok(lock?.phase === 'finishing' && taskValue?.status === 'em_limpeza', `Write denied: ${path}`);
    }
  }
}
const database = {
  ref: (_db, path = '') => ({ path }),
  query: (reference, ...filters) => ({ ...reference, filters }),
  orderByChild: (field) => ({ type: 'order', field }), equalTo: (value) => ({ type: 'equal', value }),
  startAt: (value) => ({ type: 'start', value }), endAt: (value) => ({ type: 'end', value }),
  onValue: () => () => {},
  get: async (reference) => {
    let value = clone(at(reference.path));
    if (reference.filters && value) {
      const order = reference.filters.find((filter) => filter.type === 'order')?.field;
      value = Object.fromEntries(Object.entries(value).filter(([, item]) => reference.filters.every((filter) =>
        filter.type === 'equal' ? item[order] === filter.value : filter.type === 'start' ? item[order] >= filter.value : filter.type === 'end' ? item[order] <= filter.value : true)));
    }
    return snapshot(value);
  },
  runTransaction: async (reference, callback) => {
    const result = callback(clone(at(reference.path)));
    if (result === undefined) return { committed: false, snapshot: snapshot(at(reference.path)) };
    checkRules(reference.path, result); put(reference.path, result); return { committed: true, snapshot: snapshot(result) };
  },
  update: async (reference, updates) => {
    if (failUpdate) { failUpdate = false; throw new Error('Simulated atomic failure'); }
    const entries=Object.entries(updates).map(([path,value])=>[[reference.path,path].filter(Boolean).join('/'),value]);
    for (const [path, value] of entries) checkRules(path, value);
    for (const [path, value] of Object.entries(updates)) {
      assert.ok(value !== undefined, 'No undefined database writes');
      const keys = Object.keys(updates); assert.ok(!keys.some((other) => other !== path && other.startsWith(path + '/')), 'No overlapping database writes');
      put([reference.path, path].filter(Boolean).join('/'), value);
    }
  },
};
const analytics = {};
const analyticsSource = ts.transpileModule(fs.readFileSync(path.join(projectRoot, 'src/services/reservationAnalytics.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(`(function(exports){${analyticsSource}\n})`, { Date, Map, Set })(analytics);

const exportsObject = {};
const source = ts.transpileModule(fs.readFileSync(path.join(projectRoot, 'src/services/cleaningStore.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(`(function(require,exports){${source}\n})`, { crypto: { randomUUID: () => `task-${++sequence}` }, Date, Map, Set, Promise })(
  (name) => name === './pocketbaseRealtime' ? database : name === '../config/pocketbase' ? { pb: { authStore: { record: null } } } : name === './reservationAnalytics' ? analytics : name === './pocketbaseTransactions' ? { withTransactionData: async (path, action) => action(database.ref({}, path)) } : (() => { throw new Error('Unexpected import '+name); })(), exportsObject);
const service = exportsObject;
function reset() {
  sequence = 0; failUpdate = false;
  data = { roles:{testuser:{role:currentRole}}, erp_geral: { quartos: { dailyPlans: {}, reservationIndex: {}, rooms: { r1: { id: 'r1', number: '101', cleaningStatus: 'sujo', maintenanceStatus: 'normal', note: '' }, r2: { id: 'r2', number: '102', cleaningStatus: 'sujo', maintenanceStatus: 'normal', note: '' }, r3: { id: 'r3', number: '103', cleaningStatus: 'sujo', maintenanceStatus: 'em_manutencao', note: '' } }, cleaningLogs: {} }, recepcao: { stays: {} }, limpeza: { tasks: {}, activeRooms: {} } } };
}
const tasks = () => Object.values(data.erp_geral.limpeza.tasks);
(async () => {
  reset();
  await service.assignRooms(['101', ' 101 '], 'Ana', 'Gerência', 'e1');
  assert.equal(tasks().length, 1); assert.equal(data.erp_geral.quartos.rooms.r1.cleaningStatus, 'em_limpeza');
  assert.equal(tasks()[0].roomId, 'r1');
  await assert.rejects(() => service.assignRooms(['101'], 'Bea', 'Gerência'), /já tem/);
  await service.completeTask(tasks()[0], 'Gerência');
  assert.equal(tasks()[0].status, 'concluido'); assert.equal(data.erp_geral.quartos.rooms.r1.cleaningStatus, 'limpo');
  const log = Object.values(data.erp_geral.quartos.cleaningLogs)[0];
  assert.equal(log.attendant, 'Ana'); assert.equal(log.employeeId, 'e1'); assert.equal(log.roomId, 'r1');
  assert.equal(tasks()[0].cleaningLogId, log.id); assert.equal(Object.keys(data.erp_geral.limpeza.activeRooms).length, 0);
  await assert.rejects(() => service.completeTask(tasks()[0], 'Gerência'), /já foi/);
  assert.equal(Object.keys(data.erp_geral.quartos.cleaningLogs).length, 1);
  currentRole='admin'; data.roles.testuser.role='admin'; await service.deleteCleaningTask(tasks()[0].id);
  assert.equal(tasks().length, 0); assert.equal(Object.keys(data.erp_geral.quartos.cleaningLogs).length, 0); assert.equal(data.erp_geral.quartos.rooms.r1.cleaningStatus, 'sujo');

  currentRole='viewer'; reset();
  const concurrent = await Promise.allSettled([service.assignRooms(['101'], 'Ana', 'Gerência'), service.assignRooms(['101'], 'Bea', 'Gerência')]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(tasks().length, 1); assert.equal(tasks()[0].status, 'em_limpeza');
  await service.cancelTask(tasks()[0], 'Gerência'); assert.equal(tasks()[0].status, 'cancelado'); assert.equal(data.erp_geral.quartos.rooms.r1.cleaningStatus, 'sujo');
  assert.equal(Object.keys(data.erp_geral.quartos.cleaningLogs).length, 0);

  reset();
  await assert.rejects(() => service.assignRooms(['101','103'], 'Ana', 'Gerência'), /bloqueado/);
  assert.equal(tasks().length, 0); assert.equal(Object.keys(data.erp_geral.limpeza.activeRooms).length, 0);
  await assert.rejects(() => service.assignRooms(['999'], 'Ana', 'Gerência'), /Cadastre/);
  failUpdate = true;
  await assert.rejects(() => service.assignRooms(['101','102'], 'Ana', 'Gerência'), /Simulated/);
  assert.equal(tasks().length, 0); assert.equal(Object.keys(data.erp_geral.limpeza.activeRooms).length, 0); assert.equal(data.erp_geral.quartos.rooms.r1.cleaningStatus, 'sujo');
  await service.assignRooms(['101','102'], 'Ana', 'Gerência'); assert.equal(tasks().length, 2);

  currentRole='admin'; reset();
  await service.assignRooms(['101'], 'Ana', 'Gerência');
  const customLog = { id: 'manual', roomId: 'r1', roomNumber: '101', attendant: 'Ana', date: '2026-10-14', completedAt: new Date().toISOString(), doorsAndWindows: true, note: 'Portas' };
  const updates = await service.roomCleaningTaskUpdates(data.erp_geral.quartos.rooms.r1, 'limpo', 'Gerência', customLog);
  await database.update({ path: '' }, { ...updates, 'erp_geral/quartos/rooms/r1/cleaningStatus':'limpo', 'erp_geral/quartos/cleaningLogs/manual':customLog });
  assert.equal(tasks()[0].status, 'concluido'); assert.equal(tasks()[0].cleaningLogId, 'manual'); assert.equal(Object.keys(data.erp_geral.quartos.cleaningLogs).length,1);
  const deletion = await service.deleteCleaningLogTaskUpdates(customLog); await database.update({ path: '' }, deletion); assert.equal(tasks().length,0);

  reset();
  await service.assignRooms(['101'], 'Ana', 'Gerência');
  const blocked = { ...data.erp_geral.quartos.rooms.r1, maintenanceStatus: 'em_manutencao' };
  await database.update({path:''}, await service.roomCleaningTaskUpdates(blocked,'limpo','Gerência'));
  assert.equal(tasks()[0].status,'cancelado'); assert.equal(Object.keys(data.erp_geral.quartos.cleaningLogs).length,0);
  currentRole = 'viewer'; reset();
  const legacy = { id: 'legacy', roomNumber: '101', camareira: 'Ana', status: 'em_limpeza', assignedBy: 'Equipe', assignedAt: new Date().toISOString(), date: '2026-10-14' };
  data.erp_geral.limpeza.tasks.legacy = legacy;
  await service.completeTask(legacy, 'Equipe');
  assert.equal(tasks()[0].roomId, 'r1'); assert.equal(tasks()[0].status, 'concluido');

  reset();
  data.erp_geral.limpeza.activeRooms.r1 = { taskId: 'abandoned', phase:'assigning', expiresAt:Date.now()-1000 };
  await service.assignRooms(['101'], 'Ana', 'Equipe'); assert.equal(tasks().length,1);

  currentRole = 'admin'; reset();
  await service.assignRooms(['101'], 'Ana', 'Gerência'); await service.completeTask(tasks()[0], 'Gerência');
  const previous = {...data.erp_geral.quartos.rooms.r1}; const next = {...previous,number:'201'};
  await database.update({path:''}, await service.renameRoomCleaningTasks(previous,next));
  assert.equal(tasks()[0].roomNumber,'201'); assert.equal(Object.values(data.erp_geral.quartos.cleaningLogs)[0].roomNumber,'201');

  currentRole = 'viewer'; reset();
  await service.assignRooms(['101'],'Ana','Equipe');
  const sameTask = tasks()[0];
  const finishes = await Promise.allSettled([service.completeTask(sameTask,'Equipe'),service.completeTask(sameTask,'Equipe')]);
  assert.equal(finishes.filter((result)=>result.status==='fulfilled').length,1);
  assert.equal(Object.keys(data.erp_geral.quartos.cleaningLogs).length,1);
  await assert.rejects(()=>database.update({path:''},{[`erp_geral/limpeza/tasks/${sameTask.id}/completedAt`]:'2026-01-01T00:00:00Z'}),/Write denied/);

  currentRole = 'viewer'; reset();
  const today = analytics.localDateKey();
  data.erp_geral.quartos.dailyPlans[today] = { r1: { cleaningRequest: 'dispensada' } };
  data.erp_geral.quartos.reservationIndex.res1 = { id:'res1',roomId:'r1',roomNumber:'101',guestName:'Hóspede',status:'hospedado',checkInDate:today,checkOutDate:analytics.dateKeyAfterDays(1) };
  await assert.rejects(()=>service.assignRooms(['101'],'Ana','Equipe'),/dispensou/);
  assert.equal(tasks().length,0);
  data.erp_geral.quartos.reservationIndex.res1.status = 'encerrada';
  await service.assignRooms(['101'],'Ana','Equipe'); assert.equal(tasks().length,1);

  reset();
  await assert.rejects(()=>database.update({path:''},{'erp_geral/quartos/rooms/r1/cleaningStatus':'limpo'}),/Write denied/);
  const unlinkedLog = { id:'fake',roomId:'r1',roomNumber:'101',attendant:'Ana',date:today,completedAt:new Date().toISOString(),doorsAndWindows:false,note:'' };
  await assert.rejects(()=>database.update({path:''},{'erp_geral/quartos/cleaningLogs/fake':unlinkedLog}),/Write denied/);

  console.log('PASS WITH LOCAL AUTHORIZATION SIMULATION: cleaning assignment, deduplication, concurrent designation, completion/log linkage, repeated completion rejection, cancellation, missing/blocked room rejection, atomic failure rollback, manager reconciliation, linked deletion, maintenance cancellation, legacy task migration, room rename, abandoned lock recovery, declined cleaning request and linked viewer permissions.');
})().catch((cause) => { console.error(cause); process.exit(1); });
