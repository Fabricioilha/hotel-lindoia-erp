import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const defaultBackup = resolve(scriptDir, '../backup_banco_dados.json');
const manifestPath = '__migration/backup_manifest';

export function buildBackupNodes(data) {
  const branches = data?.erp_geral;
  if (!branches || typeof branches !== 'object' || Array.isArray(branches)) {
    throw new Error('O backup precisa conter o objeto erp_geral na raiz.');
  }

  return Object.entries(branches).map(([branch, value]) => {
    if (!branch || branch.includes('/') || branch.length > 240) {
      throw new Error('O backup contém um nome de ramo inválido.');
    }
    return { path: `erp_geral/${branch}`, value };
  });
}

function parseArgs(args) {
  let backupPath = defaultBackup;
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') apply = true;
    else if (args[index] === '--file' && args[index + 1]) backupPath = resolve(args[++index]);
    else throw new Error(`Argumento inválido: ${args[index]}`);
  }
  return { backupPath, apply };
}

function ensureLocalPocketBase(baseUrl) {
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') {
    throw new Error('Por segurança, este importador só aceita PocketBase local em HTTP.');
  }
  return url.origin;
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.text();
  let result;
  try {
    result = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`PocketBase retornou uma resposta inesperada (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const details = Object.values(result.data ?? {})
      .map((item) => item?.message)
      .filter(Boolean)
      .join('; ');
    throw new Error(details || result.message || `PocketBase respondeu HTTP ${response.status}.`);
  }
  return result;
}

async function readAllPaths(baseUrl, token) {
  const paths = new Map();
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const query = new URLSearchParams({ page: String(page), perPage: '500', fields: 'id,path,source_hash' });
    const result = await requestJson(baseUrl, `/api/collections/hotel_state/records?${query}`, {
      headers: { Authorization: token },
    });
    totalPages = result.totalPages;
    for (const record of result.items) paths.set(record.path, { id: record.id, sourceHash: record.source_hash });
    page++;
  }
  return paths;
}

async function confirmImport() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question('Digite IMPORTAR para gravar a cópia local: ');
    return answer === 'IMPORTAR';
  } finally {
    terminal.close();
  }
}

async function saveRecord(baseUrl, token, record, existing) {
  const path = existing
    ? `/api/collections/hotel_state/records/${encodeURIComponent(existing.id)}`
    : '/api/collections/hotel_state/records';
  return requestJson(baseUrl, path, {
    method: existing ? 'PATCH' : 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
}

async function importNodes(baseUrl, token, nodes, hash) {
  const existing = await readAllPaths(baseUrl, token);
  const existingManifest = existing.get(manifestPath);

  if (existingManifest && existingManifest.sourceHash !== hash) {
    throw new Error('Já existe uma importação com outro hash de backup; não vou sobrescrever os dados.');
  }
  for (const node of nodes) {
    const record = existing.get(node.path);
    if (record && record.sourceHash !== hash) {
      throw new Error(`Já existem dados em ${node.path} que não vieram deste backup; não vou sobrescrevê-los.`);
    }
  }

  let created = 0;
  let skipped = 0;
  for (const node of nodes) {
    const record = existing.get(node.path);
    if (record) {
      skipped++;
      continue;
    }
    await saveRecord(baseUrl, token, {
      path: node.path,
      value: node.value,
      source_hash: hash,
      revision: 0,
    });
    created++;
  }

  const manifest = {
    path: manifestPath,
    value: {
      format: 1,
      sha256: hash,
      importedNodes: nodes.length,
      completedAt: new Date().toISOString(),
    },
    source_hash: hash,
    revision: 0,
  };
  await saveRecord(baseUrl, token, manifest, existingManifest);
  return { created, skipped };
}

async function main() {
  const { backupPath, apply } = parseArgs(process.argv.slice(2));
  const bytes = await readFile(backupPath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Backup JSON inválido: ${error.message}`);
  }
  const nodes = buildBackupNodes(data);
  if (nodes.length === 0) throw new Error('O ramo erp_geral do backup está vazio.');
  console.info(`Backup JSON válido; ${nodes.length} ramos; ${bytes.length} bytes; SHA-256 ${hash}.`);
  if (!apply) {
    console.info('Prévia apenas. Nenhum dado foi enviado. Use --apply para importar no PocketBase local.');
    return;
  }

  const baseUrl = ensureLocalPocketBase(process.env.POCKETBASE_URL ?? 'http://127.0.0.1:8090');
  const email = process.env.POCKETBASE_SUPERUSER_EMAIL;
  const password = process.env.POCKETBASE_SUPERUSER_PASSWORD;
  if (!email || !password) {
    throw new Error('Defina POCKETBASE_SUPERUSER_EMAIL e POCKETBASE_SUPERUSER_PASSWORD no ambiente local.');
  }
  if (!await confirmImport()) {
    console.info('Importação cancelada. Nenhum dado foi enviado.');
    return;
  }

  const auth = await requestJson(baseUrl, '/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password }),
  });
  const result = await importNodes(baseUrl, auth.token, nodes, hash);
  console.info(`Importação local concluída: ${result.created} criados, ${result.skipped} já existentes.`);
  console.info('Somente os dados operacionais em erp_geral foram importados; contas e permissões devem ser configuradas separadamente.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Falha na importação: ${error.message}`);
    process.exitCode = 1;
  });
}
