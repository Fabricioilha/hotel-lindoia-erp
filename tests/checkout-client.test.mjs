import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/checkoutClient.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function client(response, signedIn = true) {
  const exports = {}, calls = [];
  runInNewContext(compiled, {
    exports,
    require: () => ({ auth: { currentUser: signedIn ? { getIdToken: async () => 'test-token' } : null } }),
    fetch: async (...args) => { calls.push(args); return response; },
  });
  return { ...exports, calls };
}
const target = { sourceType: 'stay', sourceId: 'stay-1' };

test('a static-site HTML response never counts as successful checkout', async () => {
  const api = client(new Response('<html>App shell</html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(api.requestCheckout(target), /Nenhuma hospedagem foi encerrada/);
  assert.equal(api.calls.length, 1);
});

test('checkout sends the authenticated immutable lodging identity', async () => {
  const api = client(Response.json({ ok: true }));
  await api.requestCheckout(target);
  assert.equal(api.calls[0][0], '/.netlify/functions/checkout');
  assert.equal(api.calls[0][1].method, 'POST');
  assert.equal(api.calls[0][1].headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(api.calls[0][1].body), target);
});

test('financial refusal is shown and does not trigger a fallback write', async () => {
  const api = client(Response.json({ error: 'Há pendências no checkout: R$ 20,00.' }, { status: 409 }));
  await assert.rejects(api.requestCheckout(target), /pendências/);
  assert.equal(api.calls.length, 1);
});

test('a signed-out user cannot submit checkout', async () => {
  const api = client(null, false);
  await assert.rejects(api.requestCheckout(target), /Entre novamente/);
  assert.equal(api.calls.length, 0);
});
