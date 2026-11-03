import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import PocketBase from 'pocketbase';

const root = new URL('../', import.meta.url).pathname;
function loadWorker() {
  const cache = new Map();
  function load(file) {
    const filename = resolve(root, file);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Function('module', 'exports', 'require', output)(module, module.exports, (name) => {
      if (name === 'pocketbase') return { __esModule: true, default: PocketBase };
      assert.ok(name.startsWith('.'), `Unexpected dependency ${name}`);
      return load(resolve(dirname(filename), `${name}.ts`));
    });
    return module.exports;
  }
  return { worker: load('cloudflare/worker.ts').default, automatic: load('cloudflare/functions/checkout-noon.ts').default };
}
const { worker, automatic } = loadWorker();
const env = {
  POCKETBASE_URL: 'https://pb.test', POCKETBASE_SUPERUSER_EMAIL: 'technical@test.invalid',
  POCKETBASE_SUPERUSER_PASSWORD: 'test-only', ASSETS: { fetch: async () => new Response('SPA') },
};
const url = 'https://hotel.workers.dev/api/checkout';
const headers = { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' };
const target = { sourceType: 'reservation', sourceId: 'r1' };
const noon = new Date('2026-11-02T15:00:00Z');
function fixture(paid = 200) {
  return {
    quartos: {
      reservations: { r1: { id: 'r1', roomId: 'room1', roomNumber: '101', guestName: 'Teste', checkInDate: '2026-11-01', checkOutDate: '2026-11-02', status: 'hospedado', channel: 'balcao', reservationAmount: 200, tax: 0, extras: [], adults: 1, children: 0 } },
      reservationIndex: {}, reservationSlots: { room1: { '2026-11-01': 'r1' } },
      rooms: { room1: { id: 'room1', number: '101', cleaningStatus: 'limpo', maintenanceStatus: 'normal' } },
    },
    financeiro: { incomes: { 'reservation-r1-initial': { id: 'reservation-r1-initial', amount: paid } }, suppressed: {} },
    recepcao: { stays: {}, roomCharges: {} }, frigobar: { operations: { sales: {} } },
  };
}
function backend(t, { state = fixture(), role = 'admin', conflicts = 0, failure = false } = {}) {
  const calls = []; let commits = 0; let revision = 1;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input); const method = init?.method ?? 'GET';
    assert.equal(url.origin, env.POCKETBASE_URL, 'All server traffic must go directly to PocketBase');
    calls.push({ path: url.pathname, method, headers: new Headers(init?.headers) });
    if (url.pathname === '/api/hotel/me') {
      if (role === 'invalid') return Response.json({ message: 'Unauthorized' }, { status: 401 });
      assert.equal(new Headers(init.headers).get('Authorization'), 'user-token');
      return Response.json({ id: 'employee', role });
    }
    if (url.pathname === '/api/collections/_superusers/auth-with-password') {
      assert.deepEqual(JSON.parse(init.body), { identity: env.POCKETBASE_SUPERUSER_EMAIL, password: env.POCKETBASE_SUPERUSER_PASSWORD });
      return Response.json({ token: 'super-token', record: { id: 'technical' } });
    }
    assert.equal(new Headers(init.headers).get('Authorization'), 'super-token');
    if (failure) return Response.json({ message: 'Unavailable' }, { status: 503 });
    if (url.pathname === '/api/hotel/state') return Response.json({ value: structuredClone(state), versions: { erp_geral: revision } });
    if (url.pathname === '/api/hotel/state/commit') {
      commits++;
      if (conflicts-- > 0) { revision++; return Response.json({ message: 'Conflict' }, { status: 409 }); }
      const body = JSON.parse(init.body);
      assert.equal(body.expected.erp_geral, revision, 'Retry must reread current revision');
      for (const [path, value] of Object.entries(body.updates)) state[path.split('/')[1]] = value;
      revision++;
      return Response.json({ committed: true });
    }
    assert.fail(`Unexpected request ${url}`);
  });
  return { calls, state, get commits() { return commits; } };
}
function post(body = target) { return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }); }

test('SPA uses assets; unknown APIs and automatic checkout have no public handler', async (t) => {
  const api = backend(t);
  assert.equal(await (await worker.fetch(new Request('https://hotel.workers.dev/reservas'), env)).text(), 'SPA');
  assert.equal((await worker.fetch(new Request(url + '/automatic'), env)).status, 404);
  assert.equal(api.calls.length, 0);
});
test('missing token, invalid session and forbidden role cannot read privileged state', async (t) => {
  const api = backend(t, { role: 'invalid' });
  assert.equal((await worker.fetch(new Request(url), env)).status, 401);
  assert.equal(api.calls.length, 0);
  assert.equal((await worker.fetch(new Request(url, { headers }), env)).status, 401);
  assert.deepEqual(api.calls.map(c => c.path), ['/api/hotel/me']);
});
test('unknown role returns 403 before superuser authentication', async (t) => {
  const api = backend(t, { role: 'other' });
  assert.equal((await worker.fetch(post(), env)).status, 403);
  assert.equal(api.calls.length, 1);
});
test('history works directly against PocketBase and is never cached', async (t) => {
  backend(t, { role: 'viewer' });
  const response = await worker.fetch(new Request(url + '?action=history&date=2026-11-02', { headers }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).reservations.r1.guestName, 'Teste');
});
test('manual checkout preserves receipts, marks dirty and retries conflicts safely', async (t) => {
  const api = backend(t, { conflicts: 1 });
  const original = structuredClone(api.state.financeiro);
  const response = await worker.fetch(post(), env);
  assert.equal(response.status, 200, await response.text());
  assert.equal(api.commits, 2);
  assert.equal(api.state.quartos.reservations.r1.status, 'encerrada');
  assert.equal(api.state.quartos.rooms.room1.cleaningStatus, 'sujo');
  assert.deepEqual(api.state.financeiro, original);
  assert.equal((await worker.fetch(post(), env)).status, 200);
  assert.equal(api.commits, 2, 'Repeated checkout must not commit again');
});
test('unpaid checkout never writes, and malformed input returns 400', async (t) => {
  const api = backend(t, { state: fixture(150) });
  assert.equal((await worker.fetch(post(), env)).status, 409);
  for (const value of [null, {}, { sourceType: 'stay', sourceId: '../secret' }]) {
    assert.equal((await worker.fetch(post(value), env)).status, 400);
  }
  assert.equal((await worker.fetch(new Request(url, { method: 'POST', headers, body: '{' }), env)).status, 400);
  assert.equal(api.commits, 0);
});
test('automatic job closes paid departures only, is idempotent and propagates failure', async (t) => {
  const api = backend(t, { conflicts: 1 });
  await automatic(env, noon);
  assert.equal(api.state.quartos.reservations.r1.status, 'encerrada');
  assert.equal(api.commits, 2);
  await automatic(env, noon);
  assert.equal(api.commits, 2);
});
test('automatic job waits for payment and hotel noon', async (t) => {
  const api = backend(t, { state: fixture(150) });
  await automatic(env, noon);
  assert.equal(api.commits, 0);
  api.state.financeiro.incomes['reservation-r1-initial'].amount = 200;
  await automatic(env, new Date('2026-11-02T14:59:59Z'));
  assert.equal(api.commits, 0);
  await automatic(env, noon);
  assert.equal(api.commits, 1);
});
test('scheduled handler reports backend failure instead of a successful run', async (t) => {
  backend(t, { failure: true });
  await assert.rejects(worker.scheduled({ scheduledTime: noon.getTime() }, env));
});
test('configuration routes only API through compute and installs the UTC cron', () => {
  const config = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.main, 'cloudflare/worker.ts');
  assert.deepEqual(config.assets.run_worker_first, ['/api/*']);
  assert.equal(config.assets.not_found_handling, 'single-page-application');
  assert.deepEqual(config.triggers.crons, ['*/5 0-2,15-23 * * *']);
});
