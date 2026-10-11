import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const emulatorProjectId = 'demo-hotel-lindoia-erp';
const databaseNamespace = `${emulatorProjectId}-default-rtdb`;
const emulatorUrl = new URL('http://127.0.0.1:9000/.json');
const confirmationFlag = '--confirm-local-overwrite';
const args = process.argv.slice(2);
const hasConfirmation = args.includes(confirmationFlag);
const inputPaths = args.filter((arg) => arg !== confirmationFlag);

if (!hasConfirmation) {
  console.error(`Importar substitui os dados do emulador local. Confirme com ${confirmationFlag}.`);
  process.exit(1);
}

if (inputPaths.length > 1) {
  console.error('Informe no máximo um arquivo JSON.');
  process.exit(1);
}

const inputPath = resolve(inputPaths[0] ?? 'firebase-local-data/production-rtdb.json');
let databaseSnapshot;

try {
  databaseSnapshot = JSON.parse(await readFile(inputPath, 'utf8'));
} catch (error) {
  console.error(`Não foi possível ler o JSON de ${inputPath}: ${error.message}`);
  process.exit(1);
}

if (
  databaseSnapshot === null ||
  typeof databaseSnapshot !== 'object' ||
  Array.isArray(databaseSnapshot) ||
  !Object.hasOwn(databaseSnapshot, 'erp_geral')
) {
  console.error('O arquivo deve ser a exportação JSON da raiz do Realtime Database e conter o nó erp_geral.');
  process.exit(1);
}

const schedule = databaseSnapshot.erp_geral?.escala;
if (
  schedule === null ||
  typeof schedule !== 'object' ||
  Array.isArray(schedule) ||
  !schedule.days ||
  typeof schedule.days !== 'object' ||
  Array.isArray(schedule.days) ||
  !Array.isArray(schedule.employees) ||
  schedule.employees.length === 0
) {
  console.error('A cópia precisa incluir erp_geral/escala com days e employees. Nada foi importado.');
  process.exit(1);
}

emulatorUrl.searchParams.set('ns', databaseNamespace);
emulatorUrl.searchParams.set('auth', 'owner');

let probe;
try {
  probe = await fetch(emulatorUrl, { signal: AbortSignal.timeout(3000), redirect: 'error' });
} catch {
  console.error('Emulador RTDB não encontrado em 127.0.0.1:9000. Inicie-o antes da importação.');
  process.exit(1);
}

const emulatorIdentity = probe.headers.get('x-firebase-project-id') ?? '';
if (!probe.ok || !emulatorIdentity.startsWith(emulatorProjectId)) {
  console.error('O serviço em 127.0.0.1:9000 não foi identificado como o emulador do projeto demo esperado. Nada foi importado.');
  process.exit(1);
}

const importResponse = await fetch(emulatorUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(databaseSnapshot),
  signal: AbortSignal.timeout(120_000),
  redirect: 'error',
});

if (!importResponse.ok) {
  console.error(`A importação local falhou (HTTP ${importResponse.status}).`);
  process.exit(1);
}

console.log(`Snapshot importado no emulador local (${databaseNamespace}).`);
console.log('O arquivo original foi mantido e nenhum endpoint de produção foi acessado.');
