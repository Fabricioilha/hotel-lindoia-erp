import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/checkoutClient.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function client(response, signedIn = true) {
  const exports = {}, calls = [];
  const pb = { authStore: { token: signedIn ? 'test-token' : '' } };
  runInNewContext(compiled, {
    exports,
    require: () => ({ pb }),
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

test('a missing checkout route explains that deletion is separate and never performs a fallback write', async () => {
  for (const response of [
    new Response('<html>Not found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }),
    Response.json({ error: 'Rota não encontrada.' }, { status: 404 }),
  ]) {
    const api = client(response);
    await assert.rejects(api.requestCheckout(target), /Nenhuma hospedagem foi encerrada.*Excluir hospedagem/);
    assert.equal(api.calls.length, 1);
  }
});

test('a specific backend 404 remains visible instead of being mistaken for a missing route', async () => {
  const api = client(Response.json({ error: 'Hospedagem não encontrada.' }, { status: 404 }));
  await assert.rejects(api.requestCheckout(target), /Hospedagem não encontrada/);
});

test('a plain-text checkout refusal is shown instead of being reported as unavailable', async () => {
  const api = client(new Response('Forbidden', { status: 403 }));
  await assert.rejects(api.requestCheckout(target), /perfil não tem permissão/);
});

test('checkout sends the authenticated immutable lodging identity', async () => {
  const api = client(Response.json({ ok: true }));
  await api.requestCheckout(target);
  assert.equal(api.calls[0][0], '/api/checkout');
  assert.equal(api.calls[0][1].method, 'POST');
  assert.match(api.calls[0][1].headers.Authorization, /^Bearer /);
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
