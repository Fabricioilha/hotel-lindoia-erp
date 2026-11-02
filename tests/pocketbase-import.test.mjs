import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBackupNodes } from '../scripts/pocketbase-import-backup.mjs';

test('backup import includes only operational branches and never account roles', () => {
  const nodes = buildBackupNodes({
    erp_geral: { recepcao: { stays: {} }, quartos: { rooms: {} } },
    roles: { oldUser: { role: 'admin' } },
    users: { oldUser: { email: 'private@example.test' } },
  });

  assert.deepEqual(nodes, [
    { path: 'erp_geral/recepcao', value: { stays: {} } },
    { path: 'erp_geral/quartos', value: { rooms: {} } },
  ]);
});

test('backup import rejects missing and malformed operational roots', () => {
  assert.throws(() => buildBackupNodes({}), /objeto erp_geral/);
  assert.throws(() => buildBackupNodes({ erp_geral: [] }), /objeto erp_geral/);
  assert.throws(() => buildBackupNodes({ erp_geral: { 'invalid/path': {} } }), /nome de ramo inválido/);
});
