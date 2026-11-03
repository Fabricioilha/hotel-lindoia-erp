import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import worker from '../cloudflare/_worker.js';
const url = 'https://hotel.pages.dev/.netlify/functions/checkout';
const env = { CHECKOUT_ORIGIN: 'https://hotel-test.netlify.app' };
const headers = { Authorization: 'Bearer test-token' };

test('static assets bypass checkout and route list only invokes checkout', async () => {
  const response = await worker.fetch(new Request('https://hotel.pages.dev/reservas'), {
    ASSETS: { fetch: () => new Response('SPA') },
  });
  assert.equal(await response.text(), 'SPA');
  const routes = JSON.parse(await readFile(new URL('../cloudflare/_routes.json', import.meta.url)));
  assert.deepEqual(routes.include, ['/.netlify/functions/checkout']);
});

test('rejects unsupported methods, absent auth and unsafe configuration', async () => {
  assert.equal((await worker.fetch(new Request(url, { method: 'DELETE' }), env)).status, 405);
  assert.equal((await worker.fetch(new Request(url), env)).status, 401);
  for (const origin of [undefined, 'http://hotel.netlify.app', 'https://user:pass@hotel.netlify.app', 'https://hotel.pages.dev', 'https://hotel.netlify.app/wrong']) {
    assert.equal((await worker.fetch(new Request(url, { headers }), { CHECKOUT_ORIGIN: origin })).status, 503);
  }
});

test('forwards query, token and POST body; preserves auth errors and disables cache', async (t) => {
  let seen;
  t.mock.method(globalThis, 'fetch', async (destination, options) => {
    seen = { destination: String(destination), options };
    return Response.json({ error: 'Sem permissão' }, { status: 403 });
  });
  const result = await worker.fetch(new Request(url + '?action=history&date=2026-11-02', { headers: { ...headers, Cookie: 'private-cookie' } }), env);
  assert.equal(seen.destination, env.CHECKOUT_ORIGIN + '/.netlify/functions/checkout?action=history&date=2026-11-02');
  assert.equal(seen.options.headers.get('Authorization'), headers.Authorization);
  assert.equal(seen.options.headers.get('Cookie'), null);
  assert.equal(seen.options.redirect, 'manual');
  assert.equal(result.status, 403);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const body = JSON.stringify({ sourceType: 'stay', sourceId: 'abc' });
  await worker.fetch(new Request(url, { method: 'POST', headers, body }), env);
  assert.equal(await new Response(seen.options.body).text(), body);
});

test('does not redirect tokens, serve upstream HTML, or expose connection errors', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }));
  assert.equal((await worker.fetch(new Request(url, { headers }), env)).status, 502);
  mock.mock.mockImplementation(async () => new Response('<html>fallback</html>', { headers: { 'Content-Type': 'text/html' } }));
  assert.equal((await worker.fetch(new Request(url, { headers }), env)).status, 502);
  mock.mock.mockImplementation(async () => { throw new Error('secret internal error'); });
  const response = await worker.fetch(new Request(url, { headers }), env);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('secret internal error'));
});
