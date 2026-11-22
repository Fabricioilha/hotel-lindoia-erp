import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authSuperuser,
  requestJson,
  resolveCredentials,
  runBackfill,
  validateBaseUrl,
} from './pocketbase-backfill-finance.mjs';
import { runReconciliation } from './pocketbase-reconcile-finance.mjs';

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function setSystemMeta(baseUrl, token, patch) {
  return requestJson(baseUrl, '/api/hotel/finance/system-meta', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function getSystemMeta(baseUrl, token) {
  return requestJson(baseUrl, '/api/hotel/finance/meta', {
    headers: { Authorization: token },
  });
}

async function createOfficialBackup(baseUrl, token, name) {
  const res = await fetch(`${baseUrl}/api/backups`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'X-ERP-Schema-Version': '2',
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao gerar backup oficial (${res.status}): ${text}`);
  }
  return name;
}

async function runPostCutoverSmokeTests(baseUrl, token) {
  const health = await requestJson(baseUrl, '/api/health');
  if (health.code !== 200) throw new Error(`Smoke test /api/health falhou: ${JSON.stringify(health)}`);

  const meta = await getSystemMeta(baseUrl, token);
  if (meta.financeMode !== 'normalized' || !meta.financeLegacyFrozen || meta.maintenanceReadonly || meta.minSchemaVersion < 2) {
    throw new Error(`Smoke test systemMeta inesperado: ${JSON.stringify(meta)}`);
  }

  const snap = await requestJson(baseUrl, '/api/hotel/finance/snapshot?includeAudit=1&auditLimit=10&includeSummaries=1', {
    headers: { Authorization: token },
  });
  if (!snap.data || !snap.summaries) throw new Error('Smoke test /api/hotel/finance/snapshot retornou payload incompleto.');

  const summaries = await requestJson(baseUrl, '/api/hotel/finance/summaries', {
    headers: { Authorization: token },
  });
  if (!Array.isArray(summaries.items)) throw new Error('Smoke test /api/hotel/finance/summaries falhou.');

  // Verify legacy erp_geral/financeiro write is strictly frozen (HTTP 426)
  const freezeProbe = await fetch(`${baseUrl}/api/hotel/state/commit`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'X-ERP-Schema-Version': '2',
    },
    body: JSON.stringify({
      expected: { 'erp_geral/financeiro': 0 },
      updates: { 'erp_geral/financeiro/incomes/__smoke_probe': { id: '__smoke_probe' } },
    }),
  });
  if (freezeProbe.status !== 426) {
    throw new Error(`Smoke test de congelamento do ramo legado falhou: esperado HTTP 426, recebido HTTP ${freezeProbe.status}`);
  }

  // Verify /api/hotel/state?path=erp_geral still serves normalized finance for Cloudflare checkout compatibility
  const stateProbe = await requestJson(baseUrl, '/api/hotel/state?path=erp_geral/financeiro/openingBalances', {
    headers: { Authorization: token },
  });
  if (!stateProbe || typeof stateProbe.value !== 'object') {
    throw new Error('Smoke test de compatibilidade /api/hotel/state falhou.');
  }

  return {
    health: 'OK',
    meta,
    summariesMonths: summaries.items.length,
    incomesCount: Object.keys(snap.data.incomes ?? {}).length,
    expensesCount: Object.keys(snap.data.expenses ?? {}).length,
    legacyFreezeHttpStatus: freezeProbe.status,
  };
}

export async function runCutover(options = {}) {
  const mode = options.mode; // 'prewarm' | 'cutover' | 'finalize' | 'rollback'
  if (!['prewarm', 'cutover', 'finalize', 'rollback'].includes(mode)) {
    throw new Error('Informe um modo: --prewarm, --cutover, --finalize ou --rollback.');
  }
  const baseUrl = validateBaseUrl(
    options.url || process.env.POCKETBASE_URL || 'http://127.0.0.1:8090',
    Boolean(options.allowRemote),
  );
  const credentials = resolveCredentials(options.envFile);
  const token = await authSuperuser(baseUrl, credentials.email, credentials.password);
  const batchSize = options.batchSize || 150;

  if (mode === 'rollback') {
    console.warn('[cutover] Executando ROLLBACK imediato para modo legado...');
    const meta = await setSystemMeta(baseUrl, token, {
      financeMode: 'legacy',
      financeLegacyFrozen: false,
      minSchemaVersion: 1,
      maintenanceReadonly: false,
      maintenanceMessage: '',
    });
    console.info('[cutover] Rollback concluído:', JSON.stringify(meta));
    return { mode, meta };
  }

  if (mode === 'prewarm') {
    console.info('[cutover] Modo PREWARM: backfill idempotente + reconciliação (sem manutenção, sistema legado 100% ativo).');
    const backfill = await runBackfill({ url: baseUrl, allowRemote: options.allowRemote, credentials, apply: true, batchSize });
    const reconcile = await runReconciliation({
      url: baseUrl,
      allowRemote: options.allowRemote,
      credentials,
      skipWorkbooks: Boolean(options.skipWorkbooks),
      jsonOut: options.jsonOut,
    });
    console.info('[cutover] PREWARM aprovado com 0 centavos de diferença. Sistema legado permanece ativo até --finalize.');
    return { mode, backfill, reconcile };
  }

  // Full maintenance-protected window (--cutover or --finalize)
  let maintenanceActivated = false;
  const backupName = `pre_cutover_${timestampSlug()}.zip`;
  try {
    console.info('[cutover] 1/5 Ativando manutenção somente leitura (maintenanceReadonly=true)...');
    await setSystemMeta(baseUrl, token, {
      maintenanceReadonly: true,
      maintenanceMessage: 'Atualização programada do financeiro em andamento (somente leitura por poucos minutos). Nenhuma alteração foi descartada.',
    });
    maintenanceActivated = true;

    if (!options.skipBackup) {
      console.info(`[cutover] 2/5 Gerando backup oficial pré-cutover: ${backupName}...`);
      await createOfficialBackup(baseUrl, token, backupName);
      console.info(`[cutover] Backup oficial ${backupName} criado com sucesso.`);
    } else {
      console.info('[cutover] 2/5 Backup oficial ignorado por --skip-backup.');
    }

    console.info('[cutover] 3/5 Executando backfill idempotente...');
    const backfill = await runBackfill({ url: baseUrl, allowRemote: options.allowRemote, credentials, apply: true, batchSize });

    console.info('[cutover] 4/5 Executando reconciliador automático (tolerância ZERO centavos)...');
    const reconcile = await runReconciliation({
      url: baseUrl,
      allowRemote: options.allowRemote,
      credentials,
      skipWorkbooks: Boolean(options.skipWorkbooks),
      jsonOut: options.jsonOut,
    });

    if (mode === 'finalize') {
      console.info('[cutover] 5/5 Reconciliação 100% APROVADA! Congelando legado, ativando modo normalizado e encerrando manutenção...');
      await setSystemMeta(baseUrl, token, {
        financeMode: 'normalized',
        financeLegacyFrozen: true,
        minSchemaVersion: 2,
        maintenanceReadonly: false,
        maintenanceMessage: '',
      });
      maintenanceActivated = false;
      const smoke = await runPostCutoverSmokeTests(baseUrl, token);
      console.info('[cutover] CUTOVER FINALIZADO COM SUCESSO! Smoke tests:', JSON.stringify(smoke));
      return { mode, backupName, backfill, reconcile, smoke };
    }

    console.info('[cutover] Reconciliação 100% APROVADA (modo --cutover sem --finalize: manutenção mantida somente leitura até publicar frontend ou chame --finalize).');
    return { mode, backupName, backfill, reconcile };
  } catch (error) {
    console.error(`[cutover] FALHA DETECTADA: ${error.message}`);
    if (maintenanceActivated) {
      console.warn('[cutover] ABORTANDO AUTOMATICAMENTE: desativando maintenanceReadonly e preservando o legado 100% intocado...');
      try {
        await setSystemMeta(baseUrl, token, {
          financeMode: 'legacy',
          financeLegacyFrozen: false,
          minSchemaVersion: 1,
          maintenanceReadonly: false,
          maintenanceMessage: '',
        });
        console.info('[cutover] Modo legado restaurado e manutenção desativada com segurança.');
      } catch (restoreErr) {
        console.error(`[cutover] ERRO CRÍTICO ao reverter manutenção: ${restoreErr.message}`);
      }
    }
    throw error;
  }
}

function parseCliArgs(argv) {
  const opts = { allowRemote: false, skipBackup: false, skipWorkbooks: false, batchSize: 150 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--prewarm') opts.mode = 'prewarm';
    else if (arg === '--cutover') opts.mode = 'cutover';
    else if (arg === '--finalize') opts.mode = 'finalize';
    else if (arg === '--rollback') opts.mode = 'rollback';
    else if (arg === '--allow-remote') opts.allowRemote = true;
    else if (arg === '--skip-backup') opts.skipBackup = true;
    else if (arg === '--skip-workbooks') opts.skipWorkbooks = true;
    else if (arg === '--batch-size' && argv[i + 1]) opts.batchSize = Number(argv[++i]);
    else if (arg === '--url' && argv[i + 1]) opts.url = argv[++i];
    else if (arg === '--env-file' && argv[i + 1]) opts.envFile = resolve(argv[++i]);
    else if (arg === '--json-out' && argv[i + 1]) opts.jsonOut = argv[++i];
    else throw new Error(`Argumento inválido: ${arg}`);
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCutover(parseCliArgs(process.argv.slice(2))).catch((err) => {
    console.error(`[cutover] ERRO: ${err.message}`);
    process.exitCode = 1;
  });
}
