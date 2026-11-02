import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('PocketBase client loads under the Netlify runtime restriction', () => {
  const result = spawnSync(process.execPath, ['--no-experimental-require-module', '-e', `
    const assert = require('node:assert/strict');
    (async () => {
      const { default: PocketBase } = await import('pocketbase');
      const client = new PocketBase('http://127.0.0.1:8090');
      assert.equal(typeof client.collection, 'function');
      assert.equal(client.authStore.isValid, false);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
