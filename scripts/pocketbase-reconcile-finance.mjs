import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authSuperuser,
  requestJson,
  resolveCredentials,
  validateBaseUrl,
} from './pocketbase-backfill-finance.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const nativeRequire = createRequire(resolve(repoRoot, 'package.json'));
const FIXED_TIMESTAMP = '2026-11-22T00:00:00.000Z';

let cachedTsModules = null;

function loadDomainModules() {
  if (cachedTsModules) return cachedTsModules;
  const ts = nativeRequire('typescript');
  const ExcelJS = nativeRequire('exceljs');
  const cache = new Map();
  const loadTs = (relOrAbs) => {
    const filename = resolve(repoRoot, relOrAbs);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const src = readFileSync(filename, 'utf8');
    const transpiled = ts.transpileModule(src, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    const localRequire = (spec) => {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(filename), spec.endsWith('.ts') ? spec : `${spec}.ts`);
        return loadTs(target);
      }
      return nativeRequire(spec);
    };
    new Function('module', 'exports', 'require', transpiled)(mod, mod.exports, localRequire);
    return mod.exports;
  };
  cachedTsModules = {
    ExcelJS,
    financeTypes: loadTs('src/types/finance.ts'),
    receptionTypes: loadTs('src/types/reception.ts'),
    financePayments: loadTs('src/services/financePayments.ts'),
    cardStatements: loadTs('src/services/cardStatements.ts'),
    cardFees: loadTs('src/services/cardFees.ts'),
    operationalLedger: loadTs('src/services/operationalLedger.ts'),
    financeAnalytics: loadTs('src/services/financeAnalytics.ts'),
    financeValidation: loadTs('src/services/financeValidation.ts'),
    payrollAdvances: loadTs('src/services/payrollAdvances.ts'),
    monthlyAccounting: loadTs('src/services/accounting/monthlyAccounting.ts'),
    financeWorkbook: loadTs('src/services/accounting/financeWorkbook.ts'),
  };
  return cachedTsModules;
}

function cents(value) {
  return Math.round((Number(value) || 0) * 100);
}

function canonicalize(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function hashXlsxZipEntries(xlsxBuffer) {
  const py = `
import sys, zipfile, hashlib, json, io
zf = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
h = hashlib.sha256()
for name in sorted(zf.namelist()):
    data = zf.read(name)
    h.update(name.encode("utf-8"))
    h.update(b"\\0")
    h.update(data)
    h.update(b"\\0")
print(json.dumps({"ooxml_sha256": h.hexdigest()}))
`;
  const out = execFileSync('python3', ['-c', py], {
    input: Buffer.from(xlsxBuffer),
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  });
  return JSON.parse(out).ooxml_sha256;
}

function extractWorkbookCanonical(workbook) {
  return workbook.worksheets.map((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        let val = cell.value;
        if (val instanceof Date) val = val.toISOString();
        else if (val && typeof val === 'object' && 'formula' in val) {
          val = { formula: val.formula, result: val.result ?? null };
        }
        cells.push({ col: colNumber, addr: cell.address, type: cell.type, value: val, numFmt: cell.numFmt ?? null });
      });
      rows.push({ row: rowNumber, cells });
    });
    return {
      name: sheet.name,
      autoFilter: sheet.autoFilter ?? null,
      views: sheet.views ?? null,
      rowCount: rows.length,
      rows,
    };
  });
}

function makeFinanceView(rawFinance, operationalSources, mods) {
  const { EXPENSE_CATEGORIES, INCOME_CATEGORIES } = mods.financeTypes;
  const { BREAKFAST_EXPENSE_CATEGORY, LEGACY_BREAKFAST_CATEGORIES } = mods.receptionTypes;
  const { withOperationalFinance } = mods.operationalLedger;
  const { withCardFees } = mods.cardFees;

  const DEPRECATED_INCOME_CATEGORIES = [
    'Rotativo cartão', 'Consumo Cartão', 'Diária Cartão',
    'Café da manhã', 'Café da manhã cartão', 'Outros',
  ];
  const LEGACY_EXPENSE_ALIASES = Object.fromEntries(
    LEGACY_BREAKFAST_CATEGORIES.map((c) => [c, BREAKFAST_EXPENSE_CATEGORY]),
  );

  function normalizeCategories(value, defaults) {
    if (!Array.isArray(value)) return [...defaults];
    const seen = new Set();
    return value
      .filter((c) => {
        if (typeof c !== 'string') return false;
        const normalized = c.trim();
        const key = normalized.toLocaleLowerCase('pt-BR');
        if (!normalized || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((c) => c.trim());
  }

  const data = rawFinance && typeof rawFinance === 'object' ? rawFinance : {};
  const incomes = { ...(data.incomes ?? {}) };
  const expenses = { ...(data.expenses ?? {}) };
  Object.entries(data.suppressed ?? {}).forEach(([id, suppressed]) => {
    if (suppressed) {
      delete incomes[id];
      delete expenses[id];
    }
  });
  const categoryAliases = {
    income: data.categoryAliases?.income ?? {},
    expense: { ...LEGACY_EXPENSE_ALIASES, ...(data.categoryAliases?.expense ?? {}) },
  };
  Object.values(expenses).forEach((entry) => {
    if (categoryAliases.expense[entry.category]) {
      expenses[entry.id] = { ...entry, category: categoryAliases.expense[entry.category] };
    }
  });
  Object.values(incomes).forEach((income) => {
    if (typeof income.category === 'string' && income.category.trim().toLocaleLowerCase('pt-BR') === 'oyo') {
      incomes[income.id] = { ...income, category: 'OYO (histórico)' };
    }
    const entry = incomes[income.id];
    if (categoryAliases.income[entry.category]) {
      incomes[income.id] = { ...entry, category: categoryAliases.income[entry.category] };
    }
  });

  const normalized = {
    cardStatements: data.cardStatements ?? {},
    incomes,
    expenses,
    cardFeeSchedule: data.cardFeeSchedule ?? {},
    transfers: data.transfers ?? {},
    payroll: data.payroll ?? {},
    cashAdjustments: data.cashAdjustments ?? {},
    openingBalances: { cash: 0, bank: 0, oyo: 0, ...(data.openingBalances ?? {}) },
    incomeCategories: [...new Set([...INCOME_CATEGORIES, ...normalizeCategories(data.incomeCategories, INCOME_CATEGORIES)])]
      .filter((c) => !categoryAliases.income[c]
        && c.toLocaleLowerCase('pt-BR') !== 'oyo'
        && !DEPRECATED_INCOME_CATEGORIES.some((d) => d.toLocaleLowerCase('pt-BR') === c.toLocaleLowerCase('pt-BR'))),
    expenseCategories: [...new Set([
      ...normalizeCategories(data.expenseCategories, EXPENSE_CATEGORIES).filter((c) => !LEGACY_BREAKFAST_CATEGORIES.includes(c)),
      'Adiantamento de salário',
      BREAKFAST_EXPENSE_CATEGORY,
    ])].filter((c) => !categoryAliases.expense[c]),
    auditLog: data.auditLog ?? {},
    suppressed: data.suppressed ?? {},
    deletions: data.deletions ?? {},
    categoryAliases,
  };

  const view = withCardFees(withOperationalFinance(normalized, operationalSources));
  return {
    ...view,
    stays: operationalSources.stays ?? {},
    reservations: operationalSources.reservations ?? {},
  };
}

async function fetchAllRecords(baseUrl, token, collection, fields) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const query = new URLSearchParams({ page: String(page), perPage: '500' });
    if (fields) query.set('fields', fields);
    const res = await requestJson(baseUrl, `/api/collections/${collection}/records?${query}`, {
      headers: { Authorization: token },
    });
    items.push(...(res.items ?? []));
    totalPages = res.totalPages || 1;
    page++;
  }
  return items;
}

function discoverAllMonths(view, oyoRecons, mods) {
  const monthSet = new Set();
  const add = (d) => { if (typeof d === 'string' && /^\d{4}-\d{2}/.test(d)) monthSet.add(d.slice(0, 7)); };
  for (const inc of Object.values(view.incomes)) if (!view.suppressed[inc.id]) add(inc.date);
  for (const exp of Object.values(view.expenses)) {
    if (view.suppressed[exp.id]) continue;
    add(exp.dueDate); add(exp.purchaseDate); add(exp.paidDate);
    for (const ev of mods.financePayments.expensePaymentEvents(exp)) add(ev.date);
  }
  for (const pr of Object.values(view.payroll)) {
    add(pr.month); add(pr.dueDate); add(pr.paidDate);
    for (const ev of mods.financePayments.payrollPaymentEvents(pr)) add(ev.date);
  }
  for (const tr of Object.values(view.transfers)) { add(tr.date); add(tr.oyoRecomMonth); }
  for (const adj of Object.values(view.cashAdjustments)) add(adj.date);
  for (const st of Object.values(view.cardStatements)) { add(st.dueDate); add(st.payment?.date); }
  for (const m of Object.keys(oyoRecons ?? {})) add(m);
  const sorted = [...monthSet].sort();
  if (!sorted.length) return [];
  const all = [];
  let [y, m] = sorted[0].split('-').map(Number);
  const [ey, em] = sorted[sorted.length - 1].split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    all.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return all;
}

function computeTotalsSummary(view, rawOyo, mods) {
  const activeIncomes = Object.values(view.incomes).filter((e) => !view.suppressed[e.id]);
  const activeExpenses = Object.values(view.expenses).filter((e) => !view.suppressed[e.id]);
  const activePayroll = Object.values(view.payroll);
  const activeTransfers = Object.values(view.transfers);
  const activeStatements = Object.values(view.cardStatements ?? {});
  const activeAdjustments = Object.values(view.cashAdjustments ?? {});

  const incomesByCategory = {};
  for (const inc of activeIncomes) {
    const cat = inc.category;
    incomesByCategory[cat] ??= { count: 0, gross_cents: 0, direct_cents: 0, prepaid_cents: 0, card_fee_cents: 0 };
    incomesByCategory[cat].count += 1;
    incomesByCategory[cat].gross_cents += cents(inc.amount);
    for (const item of mods.financeTypes.financeReceiptItems(inc)) {
      const amt = cents(item.amount);
      if (item.paymentMethod === 'prepaid') incomesByCategory[cat].prepaid_cents += amt;
      else incomesByCategory[cat].direct_cents += amt;
      incomesByCategory[cat].card_fee_cents += cents(item.cardFeeAmount ?? 0);
    }
  }

  const expensesByCategory = {};
  for (const exp of activeExpenses) {
    const cat = exp.category;
    expensesByCategory[cat] ??= { count: 0, planned_cents: 0, paid_cash_cents: 0, paid_bank_cents: 0, paid_oyo_cents: 0, pending_cents: 0 };
    const ev = mods.financePayments.paymentEventTotals(mods.financePayments.expensePaymentEvents(exp));
    const planned = cents(exp.plannedAmount);
    const pCash = cents(ev.cash);
    const pBank = cents(ev.bank);
    const pOyo = cents(ev.oyo);
    expensesByCategory[cat].count += 1;
    expensesByCategory[cat].planned_cents += planned;
    expensesByCategory[cat].paid_cash_cents += pCash;
    expensesByCategory[cat].paid_bank_cents += pBank;
    expensesByCategory[cat].paid_oyo_cents += pOyo;
    expensesByCategory[cat].pending_cents += Math.max(0, planned - (pCash + pBank + pOyo));
  }

  const finalBalances = mods.financeAnalytics.balancesAtDate(view, '9999-12-31');
  return {
    counts: {
      incomes: activeIncomes.length,
      expenses: activeExpenses.length,
      payroll: activePayroll.length,
      transfers: activeTransfers.length,
      cardStatements: activeStatements.length,
      cashAdjustments: activeAdjustments.length,
      oyoReconciliations: Object.keys(rawOyo ?? {}).length,
      expensePaymentEvents: activeExpenses.reduce((s, e) => s + mods.financePayments.expensePaymentEvents(e).length, 0),
      payrollPaymentEvents: activePayroll.reduce((s, p) => s + mods.financePayments.payrollPaymentEvents(p).length, 0),
    },
    finalBalancesCents: {
      cash: cents(finalBalances.cash),
      bank: cents(finalBalances.bank),
      oyo: cents(finalBalances.oyo),
    },
    incomesByCategory,
    expensesByCategory,
  };
}

// Compute expected monthly summaries strictly from persisted finance data (same scope as finance_monthly_summaries)
function computePersistedMonthlySummariesFromLegacy(rawFinance, mods) {
  const suppressed = rawFinance.suppressed ?? {};
  const opening = {
    cash: cents(rawFinance.openingBalances?.cash ?? 0),
    bank: cents(rawFinance.openingBalances?.bank ?? 0),
    oyo: cents(rawFinance.openingBalances?.oyo ?? 0),
  };
  const months = new Map();
  const ensure = (m) => {
    if (!/^\d{4}-\d{2}$/.test(m)) return null;
    if (!months.has(m)) {
      months.set(m, {
        incoming: { cash: 0, bank: 0, oyo: 0 },
        outgoing: { cash: 0, bank: 0, oyo: 0 },
        incomeDirectCents: 0,
        incomePrepaidCents: 0,
        expensePaidCents: 0,
        payrollPaidCents: 0,
        transfersInCents: 0,
        transfersOutCents: 0,
        adjustmentsNetCents: 0,
      });
    }
    return months.get(m);
  };

  for (const inc of Object.values(rawFinance.incomes ?? {})) {
    if (!inc || suppressed[inc.id]) continue;
    const b = ensure(String(inc.date || '').slice(0, 7));
    if (!b) continue;
    for (const item of mods.financeTypes.financeReceiptItems(inc)) {
      const w = mods.financeTypes.incomePaymentWallet(item.paymentMethod);
      if (!w) continue;
      const c = cents(item.amount);
      b.incoming[w] += c;
      if (w === 'oyo') b.incomePrepaidCents += c;
      else b.incomeDirectCents += c;
    }
  }
  for (const exp of Object.values(rawFinance.expenses ?? {})) {
    if (!exp || suppressed[exp.id]) continue;
    ensure(String(exp.dueDate || '').slice(0, 7));
    for (const ev of mods.financePayments.expensePaymentEvents(exp)) {
      const b = ensure(String(ev.date || '').slice(0, 7));
      if (!b) continue;
      const c = cents(ev.amount);
      b.outgoing[ev.wallet] += c;
      b.expensePaidCents += c;
    }
  }
  for (const pr of Object.values(rawFinance.payroll ?? {})) {
    if (!pr) continue;
    ensure(String(pr.month || ''));
    for (const ev of mods.financePayments.payrollPaymentEvents(pr)) {
      const b = ensure(String(ev.date || '').slice(0, 7));
      if (!b) continue;
      const c = cents(ev.amount);
      b.outgoing[ev.wallet] += c;
      b.payrollPaidCents += c;
    }
  }
  for (const tr of Object.values(rawFinance.transfers ?? {})) {
    if (!tr) continue;
    const b = ensure(String(tr.date || '').slice(0, 7));
    if (!b) continue;
    const c = cents(tr.amount);
    if (tr.from in b.outgoing) { b.outgoing[tr.from] += c; b.transfersOutCents += c; }
    if (tr.to !== 'oyo' && tr.to in b.incoming) { b.incoming[tr.to] += c; b.transfersInCents += c; }
  }
  for (const adj of Object.values(rawFinance.cashAdjustments ?? {})) {
    if (!adj) continue;
    const b = ensure(String(adj.date || '').slice(0, 7));
    if (!b) continue;
    const c = cents(adj.amount);
    b.adjustmentsNetCents += c;
    if (c > 0) b.incoming.cash += c;
    else b.outgoing.cash -= c;
  }

  const running = { ...opening };
  const result = {};
  for (const m of [...months.keys()].sort()) {
    const b = months.get(m);
    const openSnap = { ...running };
    running.cash += b.incoming.cash - b.outgoing.cash;
    running.bank += b.incoming.bank - b.outgoing.bank;
    running.oyo += b.incoming.oyo - b.outgoing.oyo;
    const closeSnap = { ...running };
    result[m] = {
      incomeDirectCents: b.incomeDirectCents,
      incomePrepaidCents: b.incomePrepaidCents,
      expensePaidCents: b.expensePaidCents,
      payrollPaidCents: b.payrollPaidCents,
      transfersInCents: b.transfersInCents,
      transfersOutCents: b.transfersOutCents,
      adjustmentsNetCents: b.adjustmentsNetCents,
      netChangeCents: (closeSnap.cash + closeSnap.bank) - (openSnap.cash + openSnap.bank),
      closingCashCents: closeSnap.cash,
      closingBankCents: closeSnap.bank,
      closingOyoCents: closeSnap.oyo,
    };
  }
  return result;
}

export async function runReconciliation(options = {}) {
  const mods = loadDomainModules();
  const baseUrl = validateBaseUrl(
    options.url || process.env.POCKETBASE_URL || 'http://127.0.0.1:8090',
    Boolean(options.allowRemote),
  );
  const { email, password } = options.credentials || resolveCredentials(options.envFile);
  const skipWorkbooks = Boolean(options.skipWorkbooks);
  const baselinePath = options.baseline ? resolve(options.baseline) : null;
  const quiet = Boolean(options.quiet);
  const log = (...args) => { if (!quiet) console.info(...args); };

  const startedAt = Date.now();
  const token = await authSuperuser(baseUrl, email, password);

  // 1. Fetch all raw hotel_state records directly (never via /api/hotel/state)
  const hsRecords = await fetchAllRecords(baseUrl, token, 'hotel_state', 'id,path,revision,value');
  const branches = {};
  for (const r of hsRecords) {
    branches[r.path] = typeof r.value === 'string' ? JSON.parse(r.value) : (r.value ?? {});
  }
  const legacyRaw = branches['erp_geral/financeiro'] ?? {};
  const operationalSources = {
    stays: branches['erp_geral/recepcao']?.stays ?? {},
    roomCharges: branches['erp_geral/recepcao']?.roomCharges ?? {},
    cashOuts: branches['erp_geral/recepcao']?.cashOuts ?? {},
    sales: branches['erp_geral/frigobar']?.operations?.sales ?? {},
    reservationCollections: branches['erp_geral/reservationCollections'] ?? {},
    movements: branches['erp_geral/estoque']?.movements ?? {},
    reservations: branches['erp_geral/quartos']?.reservations ?? {},
  };

  // 2. Fetch full normalized snapshot + direct table audits
  const snapshot = await requestJson(
    baseUrl,
    '/api/hotel/finance/snapshot?includeAudit=1&auditLimit=0&includeSummaries=1',
    { headers: { Authorization: token } },
  );
  const normalizedRaw = snapshot.data ?? {};
  const persistedSummaries = snapshot.summaries ?? {};

  const [
    entryRows,
    paymentRows,
    stmtRows,
    payrollRows,
    taRows,
    auditRows,
    summaryRows,
  ] = await Promise.all([
    fetchAllRecords(baseUrl, token, 'finance_entries', 'id,entry_id,type,source_ref,generated_from_income,operational_override,suppressed'),
    fetchAllRecords(baseUrl, token, 'finance_payments', 'id,payment_id,parent_type,entry_id,statement_id,wallet,amount_cents'),
    fetchAllRecords(baseUrl, token, 'finance_card_statements', 'id,statement_id'),
    fetchAllRecords(baseUrl, token, 'finance_payroll_records', 'id,payroll_id'),
    fetchAllRecords(baseUrl, token, 'finance_transfers_adjustments', 'id,record_id,kind'),
    fetchAllRecords(baseUrl, token, 'finance_audit_logs', 'id,event_id'),
    fetchAllRecords(baseUrl, token, 'finance_monthly_summaries', 'id,month,summary_key'),
  ]);

  const discrepancies = [];
  const fail = (category, detail) => discrepancies.push({ category, detail });

  // 3. Direct collection counts & referential integrity (0 orphans!)
  const expenseIdsInDb = new Set(entryRows.filter((r) => r.type === 'expense').map((r) => r.entry_id));
  const incomeIdsInDb = new Set(entryRows.filter((r) => r.type === 'income').map((r) => r.entry_id));
  const payrollIdsInDb = new Set(payrollRows.map((r) => r.payroll_id));
  const stmtIdsInDb = new Set(stmtRows.map((r) => r.statement_id));

  const orphanPayments = [];
  for (const p of paymentRows) {
    if (p.parent_type === 'expense' && !expenseIdsInDb.has(p.entry_id)) {
      orphanPayments.push({ id: p.id, parent_type: p.parent_type, entry_id: p.entry_id, reason: 'missing_expense' });
    }
    if (p.parent_type === 'payroll' && !payrollIdsInDb.has(p.entry_id)) {
      orphanPayments.push({ id: p.id, parent_type: p.parent_type, entry_id: p.entry_id, reason: 'missing_payroll' });
    }
    if (p.statement_id && !stmtIdsInDb.has(p.statement_id)) {
      orphanPayments.push({ id: p.id, statement_id: p.statement_id, reason: 'missing_statement' });
    }
  }
  if (orphanPayments.length > 0) {
    fail('orphan_payments', `${orphanPayments.length} pagamentos órfãos encontrados: ${JSON.stringify(orphanPayments.slice(0, 5))}`);
  }

  // Exact entity counts in normalized tables vs legacy JSON
  const expectedCounts = {
    incomes: Object.keys(legacyRaw.incomes ?? {}).length,
    expenses: Object.keys(legacyRaw.expenses ?? {}).length,
    cardStatements: Object.keys(legacyRaw.cardStatements ?? {}).length,
    payroll: Object.keys(legacyRaw.payroll ?? {}).length,
    transfers: Object.keys(legacyRaw.transfers ?? {}).length,
    cashAdjustments: Object.keys(legacyRaw.cashAdjustments ?? {}).length,
    oyoReconciliations: Object.keys(legacyRaw.oyoReconciliations ?? {}).length,
    auditLog: Object.keys(legacyRaw.auditLog ?? {}).length,
  };
  const actualCounts = {
    incomes: incomeIdsInDb.size,
    expenses: expenseIdsInDb.size,
    cardStatements: stmtIdsInDb.size,
    payroll: payrollIdsInDb.size,
    transfers: taRows.filter((r) => r.kind === 'transfer').length,
    cashAdjustments: taRows.filter((r) => r.kind === 'cash_adjustment').length,
    oyoReconciliations: taRows.filter((r) => r.kind === 'oyo_reconciliation').length,
    auditLog: auditRows.length,
  };
  for (const key of Object.keys(expectedCounts)) {
    if (expectedCounts[key] !== actualCounts[key]) {
      fail('entity_count', `Contagem divergente em ${key}: legado=${expectedCounts[key]} vs normalizado=${actualCounts[key]}`);
    }
  }

  // 4. Deep record-by-record canonical parity across EVERY raw persisted section
  const mapSections = [
    'incomes', 'expenses', 'cardStatements', 'payroll', 'transfers',
    'cashAdjustments', 'oyoReconciliations', 'suppressed', 'deletions',
    'cashCollectionAcks', 'cleaningConcernAcks', 'cardFeeSchedule', 'auditLog',
  ];
  for (const section of mapSections) {
    const legMap = legacyRaw[section] ?? {};
    const normMap = normalizedRaw[section] ?? {};
    const allIds = new Set([...Object.keys(legMap), ...Object.keys(normMap)]);
    let sectionDiffs = 0;
    for (const id of allIds) {
      const a = canonicalize(legMap[id] ?? null);
      const b = canonicalize(normMap[id] ?? null);
      // Normalize benign default empty note / absent optional fields only where strictly equivalent
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        // Check if difference is only paidOyo: 0 vs undefined on expenses or empty string vs undefined
        const normA = canonicalize(stripBenignDefaults(section, legMap[id]));
        const normB = canonicalize(stripBenignDefaults(section, normMap[id]));
        if (JSON.stringify(normA) !== JSON.stringify(normB)) {
          sectionDiffs++;
          if (sectionDiffs <= 3) {
            fail(`record_parity:${section}`, `ID ${id} diverge: legado=${JSON.stringify(normA)} vs normalizado=${JSON.stringify(normB)}`);
          }
        }
      }
    }
    if (sectionDiffs > 3) {
      fail(`record_parity:${section}`, `Total de ${sectionDiffs} registros divergentes na seção ${section}`);
    }
  }

  // Config scalars parity
  for (const cfgKey of ['openingBalances', 'incomeCategories', 'expenseCategories', 'categoryAliases']) {
    const legVal = normalizeConfigForParity(cfgKey, legacyRaw[cfgKey]);
    const normVal = normalizeConfigForParity(cfgKey, normalizedRaw[cfgKey]);
    if (sha256Json(legVal) !== sha256Json(normVal)) {
      fail(`config_parity:${cfgKey}`, `Config ${cfgKey} diverge: legado=${JSON.stringify(legVal)} vs normalizado=${JSON.stringify(normVal)}`);
    }
  }

  // 5. Verify finance_monthly_summaries vs persisted legacy monthly recomputation (0 cents diff!)
  const expectedSummaries = computePersistedMonthlySummariesFromLegacy(legacyRaw, mods);
  const summaryMonths = new Set([...Object.keys(expectedSummaries), ...Object.keys(persistedSummaries)]);
  for (const m of [...summaryMonths].sort()) {
    const exp = expectedSummaries[m];
    const act = persistedSummaries[m];
    if (!exp || !act) {
      fail('monthly_summaries', `Mês ${m} ausente em ${!exp ? 'legado' : 'finance_monthly_summaries'}`);
      continue;
    }
    for (const field of [
      'incomeDirectCents', 'incomePrepaidCents', 'expensePaidCents', 'payrollPaidCents',
      'transfersInCents', 'transfersOutCents', 'adjustmentsNetCents', 'netChangeCents',
      'closingCashCents', 'closingBankCents', 'closingOyoCents',
    ]) {
      if ((exp[field] ?? 0) !== (act[field] ?? 0)) {
        fail('monthly_summaries', `Mês ${m} campo ${field}: legado=${exp[field]}c vs summary=${act[field]}c`);
      }
    }
  }

  // 6. Full reconciled financeView comparison (including operational ledger + card fees + accounting + ExcelJS!)
  const legacyView = makeFinanceView(legacyRaw, operationalSources, mods);
  const normalizedView = makeFinanceView(normalizedRaw, operationalSources, mods);

  const legacyTotals = computeTotalsSummary(legacyView, legacyRaw.oyoReconciliations, mods);
  const normalizedTotals = computeTotalsSummary(normalizedView, normalizedRaw.oyoReconciliations, mods);

  if (sha256Json(legacyTotals) !== sha256Json(normalizedTotals)) {
    fail('reconciled_totals', `Totais consolidados divergem!\nLegado: ${JSON.stringify(legacyTotals)}\nNormalizado: ${JSON.stringify(normalizedTotals)}`);
  }

  const allMonths = discoverAllMonths(legacyView, legacyRaw.oyoReconciliations, mods);
  const normMonths = discoverAllMonths(normalizedView, normalizedRaw.oyoReconciliations, mods);
  if (JSON.stringify(allMonths) !== JSON.stringify(normMonths)) {
    fail('months_range', `Meses observados divergem: legado=${JSON.stringify(allMonths)} vs normalizado=${JSON.stringify(normMonths)}`);
  }

  const accountingByMonth = {};
  let maxWalletDiffCents = 0;

  for (const month of allMonths) {
    const legReport = mods.monthlyAccounting.buildMonthlyAccountingReport(legacyView, month, FIXED_TIMESTAMP);
    const normReport = mods.monthlyAccounting.buildMonthlyAccountingReport(normalizedView, month, FIXED_TIMESTAMP);
    const legHash = sha256Json(legReport);
    const normHash = sha256Json(normReport);
    if (legHash !== normHash) {
      fail('monthly_accounting', `Relatório contábil do mês ${month} diverge (legado=${legHash} vs normalizado=${normHash})`);
    }
    for (const w of normReport.wallets) {
      const diff = Math.abs(cents(w.difference));
      if (diff > maxWalletDiffCents) maxWalletDiffCents = diff;
      if (diff > 0) {
        fail('wallet_internal_balance', `Carteira ${w.wallet} no mês ${month} não fecha: diff=${diff}c`);
      }
    }

    let legLogicalHash = null;
    let normLogicalHash = null;
    let legOoxmlHash = null;
    let normOoxmlHash = null;
    if (!skipWorkbooks) {
      const legWb = await mods.financeWorkbook.createAccountingWorkbook(legReport);
      const legBuf = await legWb.xlsx.writeBuffer();
      const legLoaded = new mods.ExcelJS.Workbook();
      await legLoaded.xlsx.load(legBuf);
      legLogicalHash = sha256Json(extractWorkbookCanonical(legLoaded));
      legOoxmlHash = hashXlsxZipEntries(legBuf);

      const normWb = await mods.financeWorkbook.createAccountingWorkbook(normReport);
      const normBuf = await normWb.xlsx.writeBuffer();
      const normLoaded = new mods.ExcelJS.Workbook();
      await normLoaded.xlsx.load(normBuf);
      normLogicalHash = sha256Json(extractWorkbookCanonical(normLoaded));
      normOoxmlHash = hashXlsxZipEntries(normBuf);

      if (legLogicalHash !== normLogicalHash) {
        fail('workbook_logical', `Planilha lógica do mês ${month} diverge (${legLogicalHash} vs ${normLogicalHash})`);
      }
      if (legOoxmlHash !== normOoxmlHash) {
        fail('workbook_ooxml', `OOXML da planilha do mês ${month} diverge (${legOoxmlHash} vs ${normOoxmlHash})`);
      }
    }

    accountingByMonth[month] = {
      monthly_accounting_sha256: normHash,
      ...(skipWorkbooks ? {} : {
        workbook_logical_sha256: normLogicalHash,
        workbook_ooxml_sha256: normOoxmlHash,
      }),
    };
  }

  const aggregateChecksums = {
    all_months_monthly_accounting_sha256: sha256Json(
      Object.fromEntries(allMonths.map((m) => [m, accountingByMonth[m].monthly_accounting_sha256])),
    ),
    ...(skipWorkbooks ? {} : {
      all_months_workbook_logical_sha256: sha256Json(
        Object.fromEntries(allMonths.map((m) => [m, accountingByMonth[m].workbook_logical_sha256])),
      ),
      all_months_workbook_ooxml_sha256: sha256Json(
        Object.fromEntries(allMonths.map((m) => [m, accountingByMonth[m].workbook_ooxml_sha256])),
      ),
    }),
  };

  // 7. Optional baseline verification against Phase 0 immutable JSON
  let baselineMatch = null;
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const baseAgg = baseline.accounting_checksums?.aggregate;
    baselineMatch = {
      monthly_accounting_exact: baseAgg?.all_months_monthly_accounting_sha256 === aggregateChecksums.all_months_monthly_accounting_sha256,
      workbook_logical_exact: skipWorkbooks ? null : baseAgg?.all_months_workbook_logical_sha256 === aggregateChecksums.all_months_workbook_logical_sha256,
      workbook_ooxml_exact: skipWorkbooks ? null : baseAgg?.all_months_workbook_ooxml_sha256 === aggregateChecksums.all_months_workbook_ooxml_sha256,
      final_balances_exact:
        baseline.totals_by_wallet_cents?.cash?.balances_at_closing_cents === normalizedTotals.finalBalancesCents.cash
        && baseline.totals_by_wallet_cents?.bank?.balances_at_closing_cents === normalizedTotals.finalBalancesCents.bank
        && baseline.totals_by_wallet_cents?.oyo?.balances_at_closing_cents === normalizedTotals.finalBalancesCents.oyo,
    };
    if (!baselineMatch.monthly_accounting_exact || baselineMatch.workbook_logical_exact === false || baselineMatch.workbook_ooxml_exact === false || !baselineMatch.final_balances_exact) {
      fail('phase0_baseline_mismatch', `Divergência com baseline imutável: ${JSON.stringify(baselineMatch)}`);
    }
  }

  const report = {
    ok: discrepancies.length === 0,
    baseUrl,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    entityCounts: { expected: expectedCounts, actual: actualCounts },
    tableCounts: {
      finance_entries: entryRows.length,
      finance_payments: paymentRows.length,
      finance_card_statements: stmtRows.length,
      finance_payroll_records: payrollRows.length,
      finance_transfers_adjustments: taRows.length,
      finance_audit_logs: auditRows.length,
      finance_monthly_summaries: summaryRows.length,
    },
    orphanPaymentsCount: orphanPayments.length,
    maxWalletDiffCents,
    evaluatedMonths: allMonths,
    reconciledTotals: normalizedTotals,
    aggregateChecksums,
    baselineMatch,
    discrepancyCount: discrepancies.length,
    discrepancies,
  };

  if (options.jsonOut) {
    writeFileSync(resolve(options.jsonOut), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }

  log(`[reconcile] Status: ${report.ok ? 'APROVADO (0 centavos / 0 divergências)' : `REPROVADO (${discrepancies.length} divergências)`} em ${report.durationMs}ms.`);
  log(`[reconcile] Tabelas normalizadas:`, JSON.stringify(report.tableCounts));
  log(`[reconcile] Pagamentos órfãos: ${report.orphanPaymentsCount} | Max diff carteiras: ${report.maxWalletDiffCents}c`);
  log(`[reconcile] Saldos finais (centavos):`, JSON.stringify(report.reconciledTotals.finalBalancesCents));
  log(`[reconcile] Checksums agregados:`, JSON.stringify(report.aggregateChecksums));
  if (baselineMatch) log(`[reconcile] Paridade com Baseline Fase 0:`, JSON.stringify(baselineMatch));

  if (!report.ok) {
    for (const d of discrepancies.slice(0, 20)) {
      console.error(`  [DIVERGÊNCIA][${d.category}] ${d.detail}`);
    }
    const err = new Error(`Reconciliação falhou com ${discrepancies.length} divergência(s). Tolerância zero violada.`);
    err.report = report;
    throw err;
  }

  return report;
}

function normalizeConfigForParity(cfgKey, value) {
  if (cfgKey === 'openingBalances') {
    return {
      cash: cents(value?.cash ?? 0),
      bank: cents(value?.bank ?? 0),
      oyo: cents(value?.oyo ?? 0),
    };
  }
  if (cfgKey === 'categoryAliases') {
    return {
      income: value?.income ?? {},
      expense: value?.expense ?? {},
    };
  }
  if (cfgKey.endsWith('Categories')) return Array.isArray(value) ? value : [];
  return value ?? {};
}

function stripBenignDefaults(section, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  const copy = { ...value };
  if (section === 'expenses') {
    copy.plannedAmount = cents(copy.plannedAmount);
    copy.paidCash = cents(copy.paidCash);
    copy.paidBank = cents(copy.paidBank);
    if (copy.paidOyo !== undefined) {
      const oyoC = cents(copy.paidOyo);
      if (oyoC === 0) delete copy.paidOyo;
      else copy.paidOyo = oyoC;
    }
    if (copy.paidDate === '') delete copy.paidDate;
    if (copy.purchaseDate === '') delete copy.purchaseDate;
    if (copy.note === undefined) copy.note = '';
    if (copy.createdAt === undefined) copy.createdAt = '';
    if (copy.updatedAt === undefined) copy.updatedAt = '';
    if (copy.operationalOverride === false) delete copy.operationalOverride;
  } else if (section === 'incomes') {
    copy.amount = cents(copy.amount);
    if (copy.note === undefined) copy.note = '';
    if (copy.createdAt === undefined) copy.createdAt = '';
    if (copy.updatedAt === undefined) copy.updatedAt = '';
    if (copy.operationalOverride === false) delete copy.operationalOverride;
  } else if (section === 'payroll') {
    copy.basePay = cents(copy.basePay);
    copy.additions = cents(copy.additions);
    copy.deductions = cents(copy.deductions);
    copy.paidCash = cents(copy.paidCash);
    copy.paidBank = cents(copy.paidBank);
    if (copy.note === undefined) copy.note = '';
    if (copy.paidDate === '') delete copy.paidDate;
    if (copy.advances && Object.keys(copy.advances).length === 0) delete copy.advances;
  } else if (section === 'transfers' || section === 'cashAdjustments') {
    copy.amount = cents(copy.amount);
    if (copy.note === undefined) copy.note = '';
  } else if (section === 'auditLog') {
    if (copy.operationId === '') delete copy.operationId;
    if (copy.actorUid === undefined) copy.actorUid = '';
  }
  return copy;
}

function parseCliArgs(argv) {
  const opts = { allowRemote: false, skipWorkbooks: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-remote') opts.allowRemote = true;
    else if (arg === '--skip-workbooks') opts.skipWorkbooks = true;
    else if (arg === '--url' && argv[i + 1]) opts.url = argv[++i];
    else if (arg === '--env-file' && argv[i + 1]) opts.envFile = resolve(argv[++i]);
    else if (arg === '--baseline' && argv[i + 1]) opts.baseline = argv[++i];
    else if (arg === '--json-out' && argv[i + 1]) opts.jsonOut = argv[++i];
    else throw new Error(`Argumento inválido: ${arg}`);
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReconciliation(parseCliArgs(process.argv.slice(2))).catch((err) => {
    console.error(`[reconcile] ERRO: ${err.message}`);
    process.exitCode = 1;
  });
}
