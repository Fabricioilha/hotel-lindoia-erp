import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('checkout dependencies load and verify signing keys under the Netlify runtime restriction', () => {
  const result = spawnSync(process.execPath, ['--no-experimental-require-module', '-e', `
    const assert = require('node:assert/strict');
    const { generateKeyPairSync, sign, verify } = require('node:crypto');
    require('firebase-admin/app');
    require('firebase-admin/auth');
    require('firebase-admin/database');
    const jwks = require('jwks-rsa');
    (async () => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'local-test', alg: 'RS256', use: 'sig' };
      const client = jwks({ jwksUri: 'https://example.invalid', cache: false, fetcher: async () => ({ keys: [jwk] }) });
      const key = await client.getSigningKey('local-test');
      const payload = Buffer.from('local-checkout-runtime-test');
      const signature = sign('RSA-SHA256', payload, privateKey);
      assert.equal(verify('RSA-SHA256', payload, key.getPublicKey(), signature), true);
      assert.equal(verify('RSA-SHA256', Buffer.from('changed'), key.getPublicKey(), signature), false);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
