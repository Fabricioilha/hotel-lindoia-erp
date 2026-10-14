import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import ExcelJS from 'exceljs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeRequire = createRequire(import.meta.url);
const modules = new Map();
function domainModule(path) {
  const filename = resolve(root, path);
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const require = (name) => name.startsWith('.') ? domainModule(resolve(dirname(filename), `${name}.ts`)) : nativeRequire(name);
  new Function('module', 'exports', 'require', output)(module, module.exports, require);
  return module.exports;
}
const { buildMonthlyAccountingReport, accountingMonthRange } = domainModule('src/services/accounting/monthlyAccounting.ts');
const { createAccountingWorkbook } = domainModule('src/services/accounting/financeWorkbook.ts');
const { withOperationalFinance } = domainModule('src/services/operationalLedger.ts');
const timestamp = '2026-10-14T12:00:00Z';
const income = (id, date, items, note = '') => ({ id, date, category: 'Diária', items: items.map(([amount, method], index) => ({ id: `${id}-${index}`, amount, paymentMethod: method, description: `Hospedagem ${index + 1}` })), amount: items.reduce((sum, [amount]) => sum + amount, 0), wallet: 'cash', note, createdAt: timestamp, updatedAt: timestamp });
const event = (id, date, wallet, amount) => ({ id, date, wallet, amount, dateSource: 'informed' });
const expense = (id, dueDate, plannedAmount, paidCash, paidBank, paidOyo = 0, events) => ({ id, dueDate, plannedAmount, paidCash, paidBank, paidOyo, category: 'Manutenção', note: '', createdAt: timestamp, updatedAt: timestamp, ...(events ? { payments: Object.fromEntries(events.map((payment) => [payment.id, payment])) } : {}) });
const payroll = (id, month, dueDate, basePay, paidBank, events = []) => ({ id, month, dueDate, basePay, additions: 0, deductions: 0, paidCash: 0, paidBank, employee: 'Maria', position: 'Camareira', note: '', createdAt: timestamp, updatedAt: timestamp, payments: Object.fromEntries(events.map((payment) => [payment.id, payment])) });
const empty = () => ({ incomes: {}, expenses: {}, payroll: {}, transfers: {}, openingBalances: { cash: 0, bank: 0, oyo: 0 }, incomeCategories: [], expenseCategories: [], auditLog: {}, suppressed: {} });
function fixture() {
  const data = empty();
  data.openingBalances = { cash: 100, bank: 200, oyo: 50 };
  data.incomes = {
    before: income('before', '2026-09-20', [[50, 'cash']]),
    mixed: income('mixed', '2026-10-02', [[100, 'cash'], [200, 'pix'], [300, 'prepaid']], '=HYPERLINK("https://example.invalid")'),
    after: income('after', '2026-11-01', [[999, 'pix']]),
    removed: income('removed', '2026-10-14', [[999, 'cash']]),
  };
  data.suppressed = { removed: true };
  data.expenses = {
    earlier: expense('earlier', '2026-09-25', 100, 60, 30, 0, [event('e-sep', '2026-09-25', 'cash', 40), event('e-oct-cash', '2026-10-03', 'cash', 20), event('e-oct-bank', '2026-10-04', 'bank', 30)]),
    legacy: expense('legacy', '2026-10-05', 40, 40, 0),
    pending: expense('pending', '2026-10-10', 75, 0, 0, 0, []),
    future: expense('future', '2026-11-01', 70, 0, 70, 0, [event('future-paid', '2026-10-08', 'bank', 70)]),
    correction: expense('correction', '2026-10-11', 100, 30, 0, 0, [event('original', '2026-10-09', 'cash', 40), event('reversal', '2026-10-10', 'cash', -10)]),
    oyo: expense('oyo', '2026-10-12', 25, 0, 0, 25),
  };
  data.payroll = {
    prior: payroll('prior', '2026-09', '2026-09-30', 110, 70, [event('salary-sep', '2026-09-30', 'bank', 50), event('salary-oct', '2026-10-10', 'bank', 20)]),
    current: payroll('current', '2026-10', '2026-11-05', 100, 0),
  };
  data.transfers = {
    internal: { id: 'internal', date: '2026-10-10', from: 'cash', to: 'bank', amount: 30, note: '', createdAt: timestamp },
    repasse: { id: 'repasse', date: '2026-10-11', from: 'oyo', to: 'bank', amount: 50, note: '', createdAt: timestamp },
    toOyo: { id: 'toOyo', date: '2026-10-12', from: 'bank', to: 'oyo', amount: 15, note: '', createdAt: timestamp },
  };
  return data;
}

test('month export reconciles individual receipts, split payments, OYO, cash, bank and prior balances', () => {
  const report = buildMonthlyAccountingReport(fixture(), '2026-10', timestamp);
  assert.deepEqual(report.totals, { direct: 300, prepaid: 300, repasses: 50, sentToOyo: 15, paidHotel: 210, paidOyo: 25, cashResult: 125, pendingMonth: 245, pendingOverdue: 50 });
  assert.equal(report.receipts.length, 2);
  assert.equal(report.prepaid.length, 1);
  assert.ok(report.payments.some((payment) => payment.reference === 'future/future-paid'), 'Payment for a later due date belongs to its actual payment month');
  assert.ok(!report.payments.some((payment) => payment.reference.endsWith('e-sep')), 'September installment stays outside October');
  assert.equal(report.payments.find((payment) => payment.reference === 'correction/reversal').amount, -10);
  assert.equal(report.legacyPaymentCount, 2);
  assert.deepEqual(report.wallets.map((wallet) => [wallet.wallet, wallet.opening, wallet.closing, wallet.difference]), [['cash', 110, 90, 0], ['bank', 150, 295, 0], ['oyo', 50, 275, 0]]);
  assert.equal(report.transfers.find((transfer) => transfer.reference === 'internal').hotelEffect, 0);
  assert.equal(report.transfers.find((transfer) => transfer.reference === 'toOyo').hotelEffect, -15);
});

test('planned expense and payroll are obligations without generating unpaid cash outflows', () => {
  const data = empty();
  data.expenses.e = expense('e', '2026-10-14', 100, 0, 0, 0, []);
  data.payroll.p = payroll('p', '2026-10', '2026-11-05', 200, 0);
  const report = buildMonthlyAccountingReport(data, '2026-10', timestamp);
  assert.equal(report.payments.length, 0);
  assert.equal(report.totals.paidHotel, 0);
  assert.equal(report.totals.pendingMonth, 300);
  assert.equal(report.wallets.every((wallet) => wallet.difference === 0), true);
});

test('leap months, January opening and invalid input are handled without fake dates', () => {
  assert.equal(accountingMonthRange('2024-02').to, '2024-02-29');
  assert.equal(accountingMonthRange('2025-02').to, '2025-02-28');
  assert.equal(accountingMonthRange('2026-01').previousMonth, '2025-12');
  assert.throws(() => accountingMonthRange('2026-13'), /mês válido/);
  const data = empty();
  data.incomes.invalid = income('invalid', '2026-02-30', [[1, 'cash']]);
  assert.throws(() => buildMonthlyAccountingReport(data, '2026-02'), /Corrija o lançamento invalid/);
});

test('operational-only sources enter the export while voided operations stay suppressed', () => {
  const data = withOperationalFinance({ ...empty(), suppressed: { 'recepcao-voided-diaria': true } }, { stays: {
    current: { id: 'current', kind: 'hospede', status: 'hospedado', roomNumber: '101', guestName: 'Ana', checkInDate: '2026-10-01', nights: 1, dailyRate: 100, dailyMethod: 'cash', hasBreakfast: false, breakfastRate: 0, taxAmount: 0, taxMethod: 'cash', extras: [], attendant: '', note: '', createdAt: '2026-10-01T13:00:00Z' },
    voided: { id: 'voided', kind: 'hospede', status: 'hospedado', roomNumber: '102', guestName: 'Bruno', checkInDate: '2026-10-01', nights: 1, dailyRate: 100, dailyMethod: 'cash', hasBreakfast: false, breakfastRate: 0, taxAmount: 0, taxMethod: 'cash', extras: [], attendant: '', note: '', createdAt: '2026-10-01T13:00:00Z' },
  }, roomCharges: {}, cashOuts: {}, sales: {}, stockPurchases: {}, reservationCollections: {} });
  const report = buildMonthlyAccountingReport(data, '2026-10', timestamp);
  assert.equal(report.totals.direct, 100);
  assert.ok(report.receipts[0].reference.startsWith('recepcao-current-'));
});

test('native XLSX preserves numeric money, actual dates, item IDs, formulas, filters and safe text', async () => {
  const report = buildMonthlyAccountingReport(fixture(), '2026-10', timestamp);
  const workbook = await createAccountingWorkbook(report);
  const bytes = await workbook.xlsx.writeBuffer();
  writeFileSync('/tmp/hotel-finance-export-check.xlsx', Buffer.from(bytes));
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  assert.deepEqual(restored.worksheets.map((sheet) => sheet.name), ['Resumo', 'Entradas', 'Saídas', 'Pré-pagos OYO', 'Transferências', 'Contas e folha']);
  const entries = restored.getWorksheet('Entradas');
  assert.equal(entries.getCell('F6').type, ExcelJS.ValueType.Number);
  assert.equal(entries.getCell('F6').value, 100);
  assert.equal(entries.getCell('A6').type, ExcelJS.ValueType.Date);
  assert.equal(entries.getCell('A6').value.toISOString().slice(0, 10), '2026-10-02');
  assert.equal(entries.getCell('H6').type, ExcelJS.ValueType.String);
  assert.equal(entries.getCell('H6').value, '=HYPERLINK("https://example.invalid")');
  assert.equal(entries.getCell('G6').value, 'mixed/mixed-0');
  assert.ok(entries.autoFilter);
  assert.equal(entries.views[0].ySplit, 5);
  const summary = restored.getWorksheet('Resumo');
  assert.equal(summary.getCell('B6').value.result, 300);
  assert.equal(summary.getCell('B11').value.result, 125);
  assert.equal(summary.getCell('E23').value.result, 275);
  assert.equal(summary.getCell('G23').result, 0);
});

test('empty month still exports usable XLSX tabs, zero formulas and opening balances', async () => {
  const data = empty(); data.openingBalances.cash = 123.45;
  const workbook = await createAccountingWorkbook(buildMonthlyAccountingReport(data, '2026-10', timestamp));
  assert.equal(workbook.getWorksheet('Resumo').getCell('F21').value, 123.45);
  assert.equal(workbook.getWorksheet('Entradas').getCell('F7').result, 0);
  const bytes = await workbook.xlsx.writeBuffer();
  assert.ok(bytes.byteLength > 1000);
});
