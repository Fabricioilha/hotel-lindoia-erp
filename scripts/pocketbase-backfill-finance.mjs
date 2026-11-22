import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(scriptDir, '..');

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function resolveCredentials(envFilePath) {
  const fileEnv = parseEnvFile(envFilePath || resolve(repoRoot, '.env.development.local'));
  const email = process.env.POCKETBASE_SUPERUSER_EMAIL || fileEnv.POCKETBASE_SUPERUSER_EMAIL;
  const password = process.env.POCKETBASE_SUPERUSER_PASSWORD || fileEnv.POCKETBASE_SUPERUSER_PASSWORD;
  if (!email || !password) {
    throw new Error('Defina POCKETBASE_SUPERUSER_EMAIL e POCKETBASE_SUPERUSER_PASSWORD no ambiente ou em .env.development.local.');
  }
  return { email, password };
}

export function validateBaseUrl(rawUrl, allowRemote) {
  const url = new URL(rawUrl);
  const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!isLocal && !allowRemote) {
    throw new Error(`URL remota (${url.origin}) bloqueada sem --allow-remote.`);
  }
  return url.origin;
}

export async function requestJson(baseUrl, path, options = {}, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          'X-ERP-Schema-Version': '2',
          ...(options.headers || {}),
        },
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`PocketBase retornou resposta não-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
      }
      if (!response.ok) {
        const details = Object.values(payload.data ?? {})
          .map((item) => item?.message)
          .filter(Boolean)
          .join('; ');
        const err = new Error(details || payload.message || `HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      return payload;
    } catch (error) {
      lastError = error;
      const retryable = !error.status || error.status >= 500 || error.status === 429;
      if (!retryable || attempt === retries) throw error;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastError;
}

export async function authSuperuser(baseUrl, email, password) {
  const auth = await requestJson(baseUrl, '/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password }),
  });
  return auth.token;
}

function chunkEntries(recordMap, batchSize) {
  const entries = Object.entries(recordMap && typeof recordMap === 'object' ? recordMap : {});
  const batches = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    batches.push(Object.fromEntries(entries.slice(i, i + batchSize)));
  }
  return batches;
}

function parseFinanceRecordValue(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}

export async function fetchRawLegacyFinance(baseUrl, token) {
  const query = new URLSearchParams({
    filter: 'path = "erp_geral/financeiro"',
    perPage: '1',
  });
  const list = await requestJson(baseUrl, `/api/collections/hotel_state/records?${query}`, {
    headers: { Authorization: token },
  });
  const record = list.items?.[0];
  if (!record) {
    throw new Error('Registro legado erp_geral/financeiro não encontrado na coleção hotel_state.');
  }
  const value = parseFinanceRecordValue(record.value);
  const serialized = JSON.stringify(value);
  return {
    recordId: record.id,
    revision: record.revision ?? 0,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    data: value,
  };
}

export async function runBackfill(options = {}) {
  const batchSize = Math.min(250, Math.max(50, Number(options.batchSize || 150)));
  const apply = Boolean(options.apply);
  const baseUrl = validateBaseUrl(
    options.url || process.env.POCKETBASE_URL || 'http://127.0.0.1:8090',
    Boolean(options.allowRemote),
  );
  const { email, password } = options.credentials || resolveCredentials(options.envFile);
  const resumeStatePath = options.resumeState ? resolve(options.resumeState) : null;
  const quiet = Boolean(options.quiet);
  const log = (...args) => { if (!quiet) console.info(...args); };

  const startedAt = Date.now();
  const token = await authSuperuser(baseUrl, email, password);
  const legacy = await fetchRawLegacyFinance(baseUrl, token);
  const raw = legacy.data;

  const sections = [
    { key: 'incomes', label: 'Entradas (incomes)', map: raw.incomes ?? {} },
    { key: 'expenses', label: 'Despesas (expenses + payments)', map: raw.expenses ?? {} },
    { key: 'cardStatements', label: 'Faturas de cartão (cardStatements)', map: raw.cardStatements ?? {} },
    { key: 'payroll', label: 'Folha de pagamento (payroll + payments)', map: raw.payroll ?? {} },
    { key: 'transfers', label: 'Transferências (transfers)', map: raw.transfers ?? {} },
    { key: 'cashAdjustments', label: 'Ajustes de caixa (cashAdjustments)', map: raw.cashAdjustments ?? {} },
    { key: 'oyoReconciliations', label: 'Conciliações OYO (oyoReconciliations)', map: raw.oyoReconciliations ?? {} },
    { key: 'auditLog', label: 'Auditoria (auditLog)', map: raw.auditLog ?? {} },
  ];

  const counts = {
    incomes: Object.keys(raw.incomes ?? {}).length,
    expenses: Object.keys(raw.expenses ?? {}).length,
    cardStatements: Object.keys(raw.cardStatements ?? {}).length,
    payroll: Object.keys(raw.payroll ?? {}).length,
    transfers: Object.keys(raw.transfers ?? {}).length,
    cashAdjustments: Object.keys(raw.cashAdjustments ?? {}).length,
    oyoReconciliations: Object.keys(raw.oyoReconciliations ?? {}).length,
    auditLog: Object.keys(raw.auditLog ?? {}).length,
    suppressed: Object.keys(raw.suppressed ?? {}).length,
    deletions: Object.keys(raw.deletions ?? {}).length,
    cashCollectionAcks: Object.keys(raw.cashCollectionAcks ?? {}).length,
    cleaningConcernAcks: Object.keys(raw.cleaningConcernAcks ?? {}).length,
    cardFeeSchedule: Object.keys(raw.cardFeeSchedule ?? {}).length,
    incomeCategories: Array.isArray(raw.incomeCategories) ? raw.incomeCategories.length : 0,
    expenseCategories: Array.isArray(raw.expenseCategories) ? raw.expenseCategories.length : 0,
  };

  log(`[backfill] Origem: ${baseUrl} | erp_geral/financeiro rev=${legacy.revision} (${legacy.bytes} B, sha256=${legacy.sha256.slice(0, 12)}...)`);
  log(`[backfill] Contagens origem:`, JSON.stringify(counts));

  if (!apply) {
    const totalBatches = 1 + sections.reduce((sum, s) => sum + chunkEntries(s.map, batchSize).length, 0);
    log(`[backfill] MODO DRY-RUN (nenhum dado gravado). Lotes previstos: ${totalBatches} (batchSize=${batchSize}). Use --apply para executar.`);
    return { applied: false, baseUrl, legacyRevision: legacy.revision, legacySha256: legacy.sha256, counts, batchesExecuted: 0 };
  }

  let checkpoint = { completedSteps: [] };
  if (resumeStatePath && existsSync(resumeStatePath)) {
    try {
      const loaded = JSON.parse(readFileSync(resumeStatePath, 'utf8'));
      if (loaded.legacySha256 === legacy.sha256 && Array.isArray(loaded.completedSteps)) {
        checkpoint = loaded;
        log(`[backfill] Retomando checkpoint de ${resumeStatePath} (${checkpoint.completedSteps.length} lotes já concluídos).`);
      }
    } catch {
      // Ignore corrupt checkpoint and run idempotently from scratch
    }
  }
  const doneSet = new Set(checkpoint.completedSteps);
  const saveCheckpoint = (stepId) => {
    doneSet.add(stepId);
    if (!resumeStatePath) return;
    writeFileSync(resumeStatePath, JSON.stringify({
      legacySha256: legacy.sha256,
      legacyRevision: legacy.revision,
      updatedAt: new Date().toISOString(),
      completedSteps: [...doneSet],
    }, null, 2));
  };

  let batchesExecuted = 0;
  let totalChanged = 0;

  // Step 1: Config & auxiliary maps
  const configStepId = 'config:all';
  if (!doneSet.has(configStepId)) {
    const configMutation = {
      skipSummaryRebuild: true,
      suppressed: raw.suppressed ?? {},
      deletions: raw.deletions ?? {},
      cashCollectionAcks: raw.cashCollectionAcks ?? {},
      cleaningConcernAcks: raw.cleaningConcernAcks ?? {},
      cardFeeSchedule: raw.cardFeeSchedule ?? {},
      config: {
        openingBalances: raw.openingBalances ?? { cash: 0, bank: 0, oyo: 0 },
        incomeCategories: Array.isArray(raw.incomeCategories) ? raw.incomeCategories : [],
        expenseCategories: Array.isArray(raw.expenseCategories) ? raw.expenseCategories : [],
        categoryAliases: raw.categoryAliases ?? { income: {}, expense: {} },
      },
    };
    const res = await requestJson(baseUrl, '/api/hotel/finance/mutate', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutation: configMutation }),
    });
    batchesExecuted++;
    totalChanged += Number(res.changed || 0);
    saveCheckpoint(configStepId);
    log(`[backfill] Config & mapas aplicados (changed=${res.changed}).`);
  }

  // Step 2: Batched entities
  for (const section of sections) {
    const batches = chunkEntries(section.map, batchSize);
    for (let i = 0; i < batches.length; i++) {
      const stepId = `${section.key}:${i}/${batches.length}`;
      if (doneSet.has(stepId)) continue;
      const t0 = Date.now();
      const res = await requestJson(baseUrl, '/api/hotel/finance/mutate', {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mutation: {
            skipSummaryRebuild: true,
            [section.key]: batches[i],
          },
        }),
      });
      batchesExecuted++;
      totalChanged += Number(res.changed || 0);
      saveCheckpoint(stepId);
      log(`[backfill] ${section.label} lote ${i + 1}/${batches.length} (${Object.keys(batches[i]).length} registros, ${Date.now() - t0}ms)`);
    }
  }

  // Step 2b: Prune any stale IDs left over from an earlier --prewarm if legacy deleted records in the meantime
  const currentSnap = await requestJson(
    baseUrl,
    '/api/hotel/finance/snapshot?includeAudit=1&auditLimit=0&includeSummaries=0',
    { headers: { Authorization: token } },
  );
  const currentNorm = currentSnap.data ?? {};
  const pruneMutation = { skipSummaryRebuild: true };
  let prunedCount = 0;
  const pruneSections = [
    'incomes', 'expenses', 'cardStatements', 'payroll', 'transfers',
    'cashAdjustments', 'oyoReconciliations', 'auditLog',
    'suppressed', 'deletions', 'cashCollectionAcks', 'cleaningConcernAcks', 'cardFeeSchedule',
  ];
  for (const key of pruneSections) {
    const legMap = raw[key] && typeof raw[key] === 'object' ? raw[key] : {};
    const normMap = currentNorm[key] && typeof currentNorm[key] === 'object' ? currentNorm[key] : {};
    for (const existingId of Object.keys(normMap)) {
      if (!Object.hasOwn(legMap, existingId)) {
        pruneMutation[key] ??= {};
        pruneMutation[key][existingId] = null;
        prunedCount++;
      }
    }
  }
  if (prunedCount > 0) {
    const res = await requestJson(baseUrl, '/api/hotel/finance/mutate', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutation: pruneMutation }),
    });
    batchesExecuted++;
    totalChanged += Number(res.changed || 0);
    log(`[backfill] Removidos ${prunedCount} registros excluídos no legado desde o pré-aquecimento.`);
  }

  // Step 3: Rebuild monthly summaries deterministically
  const tSummary = Date.now();
  const summaryRes = await requestJson(baseUrl, '/api/hotel/finance/summaries/rebuild', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  log(`[backfill] finance_monthly_summaries reconstruído: ${summaryRes.months} meses em ${Date.now() - tSummary}ms.`);

  // Step 4: Record lastBackfillAt without altering financeMode or legacy freeze
  const completedAt = new Date().toISOString();
  await requestJson(baseUrl, '/api/hotel/finance/system-meta', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastBackfillAt: completedAt }),
  });

  const durationMs = Date.now() - startedAt;
  log(`[backfill] Concluído com sucesso em ${durationMs}ms (lotes=${batchesExecuted}, registros processados=${totalChanged}, meses=${summaryRes.months}).`);
  return {
    applied: true,
    baseUrl,
    legacyRevision: legacy.revision,
    legacySha256: legacy.sha256,
    counts,
    batchesExecuted,
    totalChanged,
    summaryMonths: summaryRes.months,
    completedAt,
    durationMs,
  };
}

function parseCliArgs(argv) {
  const opts = { apply: false, allowRemote: false, batchSize: 150 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--allow-remote') opts.allowRemote = true;
    else if (arg === '--batch-size' && argv[i + 1]) opts.batchSize = Number(argv[++i]);
    else if (arg === '--url' && argv[i + 1]) opts.url = argv[++i];
    else if (arg === '--env-file' && argv[i + 1]) opts.envFile = resolve(argv[++i]);
    else if (arg === '--resume-state' && argv[i + 1]) opts.resumeState = argv[++i];
    else throw new Error(`Argumento inválido: ${arg}`);
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBackfill(parseCliArgs(process.argv.slice(2))).catch((err) => {
    console.error(`[backfill] ERRO: ${err.message}`);
    process.exitCode = 1;
  });
}
