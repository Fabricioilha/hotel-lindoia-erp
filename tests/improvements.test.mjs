import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import postcss from 'postcss';
import ts from 'typescript';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = new Map();
function load(file) {
  const path = resolve(root, file);
  if (modules.has(path)) return modules.get(path).exports;
  const module = { exports: {} }; modules.set(path, module);
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('module', 'exports', 'require', js)(module, module.exports, (name) => {
    assert.ok(name.startsWith('.'), 'Pure domain test must not access external services');
    return load(resolve(dirname(path), name + '.ts'));
  });
  return module.exports;
}
const { withCardFees } = load('src/services/cardFees.ts');
const { balancesAt } = load('src/services/financeAnalytics.ts');
const { availablePayrollAdvances, validatePayrollAdvances, payrollAdvanceDetails, pendingAdvancesByEmployee, payrollLaunchTotals, payrollLaunchIssue } = load('src/services/payrollAdvances.ts');
const { payrollNet, payrollRegistered } = load('src/types/finance.ts');
const { normalizeBaseSalary, staffBaseSalary } = load('src/types/staff.ts');
const { formatBRL, moneyFromDigits, parseMoneyText } = load('src/services/money.ts');
const managerTheme = load('src/services/managerTheme.ts');
const { initializeStayReceipts, addStayReceipt, existingStayReceipts } = load('src/services/stayReceipts.ts');
const { stayAmountDue } = load('src/types/reception.ts');
const { stayFinanceEntries, stayOyoFeeExpense } = load('src/services/operationalLedger.ts');
const { checkoutPending, applyCheckout } = load('src/services/checkoutPolicy.ts');
const { weightedInventoryCost, effectiveStockQuantity } = load('src/services/inventoryCost.ts');
const { buildMonthlyAccountingReport } = load('src/services/accounting/monthlyAccounting.ts');
const { outstandingAccounts } = load('src/services/outstandingAccounts.ts');
const base = () => ({ incomes: {}, expenses: {}, payroll: {}, transfers: {}, openingBalances: { cash: 0, bank: 0, oyo: 0 }, suppressed: {}, incomeCategories: [], expenseCategories: [], auditLog: {} });
const income = (id, method, amount, createdAt = '2026-10-25T15:00:00Z') => ({ id, amount, date: '2026-10-25', category: 'Diária', wallet: 'bank', items: [{ id, amount, paymentMethod: method, description: 'Hospedagem' }], note: '', createdAt, updatedAt: createdAt });
const schedule = { v1: { effectiveAt: '2026-10-25T10:00:00Z', credit: 3, debit: 1.5 } };

test('accounts payable retains older debt and excludes payments after the selected position date', () => {
  const expense = { id: 'old', dueDate: '2026-09-15', category: 'Energia', plannedAmount: 100, paidCash: 100, paidBank: 0, paidDate: '2026-11-01', note: '', createdAt: '2026-09-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z', payments: { p: { id: 'p', date: '2026-11-01', wallet: 'cash', amount: 100, dateSource: 'informed' } } };
  assert.equal(outstandingAccounts({ ...base(), expenses: { old: expense } }, '2026-10-25')[0].pending, 100);
  assert.equal(outstandingAccounts({ ...base(), expenses: { old: expense } }, '2026-11-01').length, 0);
});

test('card fees produce net bank cash, distinct expenses and no double deduction', () => {
  const data = withCardFees({ ...base(), cardFeeSchedule: schedule, incomes: { c: income('c', 'credit', 100), d: income('d', 'debit', 100), p: income('p', 'pix', 50) } });
  assert.equal(balancesAt(data, '2026-10').bank, 245.5);
  assert.equal(data.expenses['card-fee-c'].paidBank, 3);
  assert.equal(data.incomes.c.items[0].netAmount, 97);
  assert.deepEqual(withCardFees(data), data);
});
test('new rates preserve old receipts, mixed methods and cent rounding', () => {
  const original = withCardFees({ ...base(), cardFeeSchedule: schedule, incomes: { c: income('c', 'credit', 10.01), old: income('old', 'credit', 100, '2026-10-24T10:00:00Z') } });
  const updated = withCardFees({ ...original, cardFeeSchedule: { ...schedule, v2: { effectiveAt: '2026-10-26T10:00:00Z', credit: 5, debit: 2 } }, incomes: { ...original.incomes, next: income('next', 'credit', 100, '2026-10-26T11:00:00Z') } });
  assert.equal(updated.expenses['card-fee-c'].plannedAmount, .3);
  assert.equal(updated.expenses['card-fee-next'].plannedAmount, 5);
  assert.equal(updated.expenses['card-fee-old'], undefined);
  const suppressed = withCardFees({ ...updated, suppressed: { c: true } });
  assert.equal(suppressed.expenses['card-fee-c'], undefined);
});
const stay = () => ({ id: 's', kind: 'hospede', checkInDate: '2026-10-20', checkOutDate: '2026-10-22', nights: 2, dailyRate: 100, dailyMethod: 'cash', roomNumber: '101', guestName: 'Teste', attendant: 'Equipe', status: 'hospedado', hasBreakfast: false, breakfastRate: 0, taxAmount: 0, taxMethod: 'cash', extras: [], note: '', createdAt: '2026-10-25T15:00:00Z' });
test('receipts use their own date and survive changes to check-in and number of nights', () => {
  const paid = initializeStayReceipts(stay(), '2026-10-25', true);
  assert.equal(Object.values(stayFinanceEntries(paid))[0].date, '2026-10-25');
  const extended = { ...paid, checkInDate: '2026-10-19', nights: 3 };
  assert.equal(stayAmountDue(extended), 100);
  assert.equal(Object.values(stayFinanceEntries(extended))[0].amount, 200);
  const overnight = initializeStayReceipts({ ...stay(), createdAt: '2026-10-26T06:15:00Z' }, '2026-10-25', true);
  assert.equal(Object.values(overnight.receipts)[0].receivedAt, '2026-10-26T06:15:00Z');
  assert.equal(Object.values(stayFinanceEntries(overnight))[0].date, '2026-10-25');
});
test('unpaid stay supports partial payments, retries and a later settlement', () => {
  let value = initializeStayReceipts(stay(), '2026-10-25', false);
  assert.equal(stayAmountDue(value), 200);
  assert.deepEqual(stayFinanceEntries(value), {});
  const input = { id: 'recepcao-s-part1', amount: 80, method: 'pix', date: '2026-10-25', attendant: 'Equipe' };
  value = addStayReceipt(value, input, '2026-10-25T17:00:00Z');
  assert.equal(stayAmountDue(value), 120);
  assert.deepEqual(addStayReceipt(value, input), value);
  value = addStayReceipt(value, { ...input, id: 'recepcao-s-part2', amount: 120, date: '2026-10-26' }, '2026-10-26T17:00:00Z');
  assert.equal(stayAmountDue(value), 0);
  assert.equal(stayFinanceEntries(value)['recepcao-s-part2'].date, '2026-10-26');
  assert.throws(() => addStayReceipt(value, { ...input, id: 'extra', amount: 1 }), /saldo pendente/);
});
test('split pix and cash payments create separate dated cash-flow entries', () => {
  const split = { ...stay(), dailyMethod: 'pix', dailySplit: { method: 'cash', amount: 80 } };
  const paid = initializeStayReceipts(split, '2026-10-25', true);
  const entries = Object.values(stayFinanceEntries(paid));
  assert.deepEqual(entries.map((entry) => [entry.amount, entry.items[0].paymentMethod, entry.date]), [
    [120, 'pix', '2026-10-25'],
    [80, 'cash', '2026-10-25'],
  ]);
});
test('OYO compensation follows the tax receipt date and is absent while unpaid', () => {
  let value = initializeStayReceipts({ ...stay(), taxAmount: 20 }, '2026-10-25', false);
  assert.equal(stayOyoFeeExpense(value), undefined);
  value = addStayReceipt(value, { id: 'recepcao-s-p', amount: 220, method: 'cash', date: '2026-10-26', attendant: 'Equipe' }, '2026-10-26T17:00:00Z');
  assert.equal(stayOyoFeeExpense(value).paidOyo, 20);
  assert.equal(Object.values(stayOyoFeeExpense(value).payments)[0].date, '2026-10-26');
});
test('legacy payment migration preserves IDs, dates and voids', () => {
  const old = { ...stay(), voidedPayments: { 'recepcao-s-diaria': true } };
  const migrated = { ...old, receiptsInitialized: true, receipts: existingStayReceipts(old) };
  assert.equal(stayAmountDue(migrated), 200);
  assert.deepEqual(stayFinanceEntries(migrated), {});
});
test('checkout alerts for outstanding receipts, then dirties the room after payment', () => {
  let value = initializeStayReceipts(stay(), '2026-10-25', false);
  const state = { recepcao: { stays: { s: value } }, quartos: { rooms: { r: { id: 'r', number: '101', cleaningStatus: 'limpo' } } } };
  const target = { sourceType: 'stay', sourceId: 's' };
  assert.equal(checkoutPending(state, target), 200);
  assert.throws(() => applyCheckout(state, target, new Date('2026-10-25T16:00:00Z'), 'Equipe'), /pendências/);
  value = addStayReceipt(value, { id: 'recepcao-s-p', amount: 200, method: 'cash', date: '2026-10-25', attendant: 'Equipe' }, '2026-10-25T17:00:00Z');
  state.recepcao.stays.s = value;
  assert.equal(applyCheckout(state, target, new Date('2026-10-25T18:00:00Z'), 'Equipe'), true);
  assert.equal(state.quartos.rooms.r.cleaningStatus, 'sujo');
});
test('salary advance reduces payroll due without generating a second cash outflow', () => {
  const data = base();
  data.expenses.a = { id: 'a', category: 'Adiantamento de salário', employeeId: 'e', employee: 'Nome antigo', advanceMonth: '2026-10', dueDate: '2026-10-10', plannedAmount: 300, paidCash: 300, paidBank: 0, paidDate: '2026-10-10' };
  const payroll = { id: 'p', month: '2026-10', employeeId: 'e', employee: 'Nome atual', basePay: 2000, additions: 0, deductions: 100, paidCash: 0, paidBank: 1600, dueDate: '2026-10-30', paidDate: '2026-10-30' };
  payroll.advances = availablePayrollAdvances(data, payroll); data.payroll.p = payroll;
  assert.deepEqual(payroll.advances, { a: 300 });
  assert.equal(payrollNet(payroll), 1600);
  assert.doesNotThrow(() => validatePayrollAdvances(data));
  const balances = balancesAt(data, '2026-10');
  assert.equal(balances.cash + balances.bank, -1900);
  assert.deepEqual(availablePayrollAdvances(data, { ...payroll, id: 'other' }), {});
  delete data.expenses.a;
  assert.throws(() => validatePayrollAdvances(data), /adiantamento/);
});
test('weighted inventory cost respects current stock, fractional quantities and reversal', () => {
  assert.equal(weightedInventoryCost(10, 5, 10, 7), 6);
  assert.equal(weightedInventoryCost(20, 6, -10, 7), 5);
  assert.equal(weightedInventoryCost(0, 5, 10, 7), 7);
  assert.equal(weightedInventoryCost(.5, 10, .5, 20), 15);
  assert.equal(effectiveStockQuantity({ category: 'frigobar', locationQuantities: { 'Geladeira - Recepção': 10, estoque: 5 } }, 2), 7);
  assert.throws(() => weightedInventoryCost(10, 2, -5, 9), /inconsistente/);
});
test('card fee accounting export reconciles the same net bank balance', () => {
  const data = withCardFees({ ...base(), cardFeeSchedule: schedule, incomes: { c: income('c', 'credit', 100) } });
  const report = buildMonthlyAccountingReport(data, '2026-10');
  assert.equal(report.wallets.find((wallet) => wallet.wallet === 'bank').closing, 97);
  assert.ok(report.wallets.every((wallet) => wallet.difference === 0));
});

const vale = (id, amount, extra = {}) => ({ id, category: 'Adiantamento de salário', employeeId: 'e', employee: 'Maria', advanceMonth: '2026-10', dueDate: '2026-10-10', plannedAmount: amount, paidCash: amount, paidBank: 0, paidDate: '2026-10-10', note: '', createdAt: '2026-10-10T12:00:00Z', updatedAt: '2026-10-10T12:00:00Z', ...extra });

test('payroll launch closes at the amount paid: payslip + vales = remuneration and the difference becomes an adjustment', () => {
  const advances = { a: 200, b: 100 };
  const discounted = payrollLaunchTotals({ baseSalary: 2000, advances, paidCash: 0, paidBank: 1500 });
  assert.deepEqual([discounted.basePay, discounted.additions, discounted.deductions, discounted.advancesTotal, discounted.net, discounted.registered, discounted.difference, discounted.pending, discounted.closing], [2000, 0, 200, 300, 1500, 1800, -200, 0, true]);
  const overtime = payrollLaunchTotals({ baseSalary: 2000, advances, paidCash: 500, paidBank: 1800 });
  assert.deepEqual([overtime.additions, overtime.deductions, overtime.net, overtime.registered], [600, 0, 2300, 2600]);
  // Without a registered base salary the registered total becomes the base, with no invented adjustment.
  const noReference = payrollLaunchTotals({ baseSalary: 0, advances, paidCash: 1500, paidBank: 0 });
  assert.deepEqual([noReference.basePay, noReference.additions, noReference.deductions, noReference.net, noReference.registered, noReference.difference], [1800, 0, 0, 1500, 1800, 0]);
  // The net of the record is always the cash that left: base + additions - deductions - vales.
  for (const totals of [discounted, overtime, noReference]) assert.equal(payrollNet({ basePay: totals.basePay, additions: totals.additions, deductions: totals.deductions, advances }), totals.net);
  assert.equal(payrollRegistered({ basePay: 2000, additions: 0, deductions: 200 }), 1800);
  assert.equal(payrollLaunchIssue(discounted), '');
});

test('payroll launch without payment stays pending and partial payments keep the planned net', () => {
  const advances = { a: 300 };
  const pending = payrollLaunchTotals({ baseSalary: 2000, advances, paidCash: 0, paidBank: 0 });
  assert.deepEqual([pending.closing, pending.net, pending.registered, pending.pending], [false, 1700, 2000, 1700]);
  const partial = payrollLaunchTotals({ baseSalary: 2000, advances, paidCash: 1000, paidBank: 0, keepBalance: true });
  assert.deepEqual([partial.closing, partial.net, partial.paidTotal, partial.pending, partial.deductions], [false, 1700, 1000, 700, 0]);
  const closed = payrollLaunchTotals({ baseSalary: 2000, advances, paidCash: 1000, paidBank: 0 });
  assert.deepEqual([closed.closing, closed.net, closed.pending, closed.deductions], [true, 1000, 0, 700], 'without "partial", the amount paid closes the payroll');
  assert.equal(payrollLaunchIssue(payrollLaunchTotals({ baseSalary: 0, advances: {}, paidCash: 0, paidBank: 0 })), 'Informe o valor pago no contracheque ou cadastre o salário base do funcionário.');
  assert.match(payrollLaunchIssue(payrollLaunchTotals({ baseSalary: 200, advances, paidCash: 0, paidBank: 0 })), /vales superam/);
  assert.match(payrollLaunchIssue(payrollLaunchTotals({ baseSalary: 2000, advances, paidCash: 1800, paidBank: 0, keepBalance: true })), /supera o líquido previsto/);
});

test('editing a payroll keeps legacy adjustments unless the registered total changes', () => {
  const previous = { basePay: 2000, additions: 100, deductions: 0 };
  const same = payrollLaunchTotals({ previous, baseSalary: 2000, advances: { a: 300 }, paidCash: 1800, paidBank: 0 });
  assert.deepEqual([same.basePay, same.additions, same.deductions, same.net, same.registered], [2000, 100, 0, 1800, 2100]);
  const changed = payrollLaunchTotals({ previous, baseSalary: 2000, advances: { a: 300 }, paidCash: 1500, paidBank: 0 });
  assert.deepEqual([changed.additions, changed.deductions, changed.net, changed.registered], [0, 200, 1500, 1800]);
});

test('payroll with a linked vale leaves cash and bank by the payslip only, never by the vale twice', () => {
  const data = base();
  data.openingBalances = { cash: 1000, bank: 5000, oyo: 0 };
  data.expenses.v = vale('v', 300, { payments: { vc: { id: 'vc', date: '2026-10-10', wallet: 'cash', amount: 300, dateSource: 'informed' } } });
  const advances = availablePayrollAdvances(data, { id: 'p', employee: 'Maria', employeeId: 'e', month: '2026-10' });
  const totals = payrollLaunchTotals({ baseSalary: 2000, advances, paidCash: 0, paidBank: 1500 });
  data.payroll.p = { id: 'p', month: '2026-10', employeeId: 'e', employee: 'Maria', position: '', dueDate: '2026-10-31', basePay: totals.basePay, additions: totals.additions, deductions: totals.deductions, advances,
    paidCash: 0, paidBank: 1500, paidDate: '2026-10-30', note: '', createdAt: '2026-10-30T12:00:00Z', updatedAt: '2026-10-30T12:00:00Z',
    payments: { pb: { id: 'pb', date: '2026-10-30', wallet: 'bank', amount: 1500, dateSource: 'informed' } } };
  assert.doesNotThrow(() => validatePayrollAdvances(data));
  assert.deepEqual(balancesAt(data, '2026-10'), { cash: 700, bank: 3500, oyo: 0 });
  assert.equal(payrollRegistered(data.payroll.p), 1800);
  assert.deepEqual(availablePayrollAdvances(data, { id: 'other', employee: 'Maria', employeeId: 'e', month: '2026-10' }), {}, 'a linked vale cannot be compensated in a second payroll');
  const report = buildMonthlyAccountingReport(data, '2026-10');
  assert.equal(report.totals.paidHotel, 1800);
  assert.ok(report.wallets.every((wallet) => wallet.difference === 0));
  assert.match(report.payments.find((payment) => payment.type === 'Folha').note, /Vales compensados nesta folha/);
});

test('vales are listed with their payment date and summarized as pending per employee until linked', () => {
  const data = base();
  data.expenses.a = vale('a', 200, { payments: { x: { id: 'x', date: '2026-10-03', wallet: 'cash', amount: 200, dateSource: 'informed' } }, note: 'Quinzena' });
  data.expenses.b = vale('b', 100, { dueDate: '2026-10-20', paidDate: undefined, payments: { y: { id: 'y', date: '2026-10-21', wallet: 'bank', amount: 100, dateSource: 'informed' } }, paidCash: 0, paidBank: 100 });
  data.expenses.other = vale('other', 50, { employeeId: 'z', employee: 'Zé' });
  data.expenses.nextMonth = vale('nextMonth', 70, { advanceMonth: '2026-11' });
  const members = [{ id: 'e', name: 'Maria', categoryId: 'c', active: true }, { id: 'z', name: 'Zé', categoryId: 'c', active: true }, { id: 'n', name: 'Nova', categoryId: 'c', active: true }];
  assert.deepEqual(pendingAdvancesByEmployee(data, members, '2026-10'), { e: { count: 2, total: 300 }, z: { count: 1, total: 50 } });
  const details = payrollAdvanceDetails(data, availablePayrollAdvances(data, { id: 'p', employee: 'Maria', employeeId: 'e', month: '2026-10' }));
  assert.deepEqual(details.map((item) => [item.id, item.amount, item.date, item.note]), [['a', 200, '2026-10-03', 'Quinzena'], ['b', 100, '2026-10-21', '']]);
  data.payroll.p = { id: 'p', month: '2026-10', employeeId: 'e', employee: 'Maria', basePay: 2000, additions: 0, deductions: 0, advances: { a: 200 }, paidCash: 0, paidBank: 0, dueDate: '2026-10-31' };
  assert.deepEqual(pendingAdvancesByEmployee(data, members, '2026-10').e, { count: 1, total: 100 });
});

test('staff base salary helpers tolerate legacy members and money helpers format and parse reais', () => {
  assert.equal(staffBaseSalary({ id: 'x' }), 0);
  assert.equal(staffBaseSalary(undefined), 0);
  assert.equal(staffBaseSalary({ baseSalary: 2150.5 }), 2150.5);
  assert.equal(normalizeBaseSalary('2.150,50'), 0, 'ambiguous text is not guessed');
  assert.equal(normalizeBaseSalary('2150,5'), 2150.5);
  assert.equal(formatBRL(2150.5).replace(/\s/g, ' '), 'R$ 2.150,50');
  assert.equal(formatBRL(Number.NaN).replace(/\s/g, ' '), 'R$ 0,00');
  assert.equal(moneyFromDigits('R$ 2.150,50'), 2150.5);
  assert.equal(moneyFromDigits('R$ 0,0'), 0);
  assert.equal(moneyFromDigits('99999999999999'), 99999999.99, 'capped to avoid absurd amounts');
  assert.deepEqual(['1.234,56', '1234,56', '1234.56', '1,234.56', '12.345', 'R$ 800', 'abc', ''].map(parseMoneyText), [1234.56, 1234.56, 1234.56, 1234.56, 12345, 800, null, null]);
});

function fakeDocument() {
  const attributes = { html: new Map(), body: new Map() };
  const element = (name) => ({ setAttribute: (key, value) => attributes[name].set(key, value), removeAttribute: (key) => attributes[name].delete(key), get: (key) => attributes[name].get(key) ?? null });
  return { documentElement: element('html'), body: element('body') };
}

test('dark-glass theme applies to the manager only and is removed for employees, no session and logout', () => {
  const doc = fakeDocument();
  assert.equal(managerTheme.applyManagerTheme('admin', true, doc), true);
  assert.equal(doc.documentElement.get('data-manager-theme'), 'dark-glass');
  assert.equal(doc.body.get('data-manager-theme'), null);
  // Switching to an employee session (or to no session) must remove it immediately, whatever the stored preference is.
  assert.equal(managerTheme.applyManagerTheme('viewer', true, doc), false);
  assert.equal(doc.documentElement.get('data-manager-theme'), null);
  managerTheme.applyManagerTheme('admin', true, doc);
  assert.equal(managerTheme.applyManagerTheme(null, true, doc), false);
  assert.equal(doc.documentElement.get('data-manager-theme'), null);
  managerTheme.applyManagerTheme('admin', true, doc);
  assert.equal(managerTheme.applyManagerTheme('admin', false, doc), false, 'the manager can switch it off');
  assert.equal(doc.documentElement.get('data-manager-theme'), null);
  // Logout cleanup also removes a stale attribute from the body.
  doc.documentElement.setAttribute('data-manager-theme', 'dark-glass'); doc.body.setAttribute('data-manager-theme', 'dark-glass');
  managerTheme.clearManagerTheme(doc);
  assert.deepEqual([doc.documentElement.get('data-manager-theme'), doc.body.get('data-manager-theme')], [null, null]);
  for (const role of ['viewer', null, undefined]) assert.equal(managerTheme.managerThemeApplies(role, true), false);
});

test('manager theme preference is stored under its own key and tolerates unavailable storage', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(managerTheme.readManagerThemePreference(storage), false);
  managerTheme.writeManagerThemePreference(true, storage);
  assert.equal(values.get('lindoia_manager_dark_glass'), 'true');
  assert.equal(managerTheme.readManagerThemePreference(storage), true);
  managerTheme.writeManagerThemePreference(false, storage);
  assert.equal(managerTheme.readManagerThemePreference(storage), false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(managerTheme.readManagerThemePreference(broken), false);
  assert.doesNotThrow(() => managerTheme.writeManagerThemePreference(true, broken));
  assert.equal(managerTheme.readManagerThemePreference(null), false);
});

const sourceText = (path) => readFileSync(resolve(root, path), 'utf8');
const DARK_SCOPES = [':where(html[data-manager-theme="dark-glass"])', 'html[data-manager-theme="dark-glass"]'];
const THEMED_STYLESHEETS = ['src/index.css', 'src/experience.css', 'src/modal-theme.css', 'src/components/layout/sidebar.css', 'src/components/ui/actionCard.css', 'src/pages/dashboard.css', 'src/pages/financeiro/financeiro.css',
  'src/pages/funcionarios.css', 'src/pages/reservas/reservas.css', 'src/pages/estoque/estoque.css', 'src/pages/caixa/caixa.css', 'src/pages/caixa/recepcao.css', 'src/pages/escala/escala.css', 'src/pages/limpeza/limpeza.css',
  'src/pages/camareiras/quartos.css', 'src/pages/tarifas.css', 'src/pages/venda-geladeira.css', 'src/pages/saidas/saidas.css'];

test('every dark-glass rule is scoped to the manager attribute and the login stylesheet has none', () => {
  assert.ok(!sourceText('src/pages/login.css').includes('data-manager-theme'), 'the employee login screen is never themed');
  for (const file of THEMED_STYLESHEETS) {
    const css = sourceText(file);
    assert.ok(css.includes('data-manager-theme="dark-glass"'), `${file} defines its dark-glass section`);
    const darkBlock = css.includes('/* ===== DARK-GLASS') ? css.slice(css.indexOf('/* ===== DARK-GLASS')) : '';
    const stylesheet = postcss.parse(darkBlock || css);
    let scoped = 0;
    stylesheet.walkRules((rule) => {
      if (rule.parent?.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
      if (!darkBlock && !/data-manager-theme/.test(rule.selector)) return;
      scoped += 1;
      for (const selector of rule.selectors) assert.ok(DARK_SCOPES.some((scope) => selector.trim().startsWith(scope)), `${file}: "${selector.trim().slice(0, 80)}" must be scoped to data-manager-theme="dark-glass"`);
    });
    assert.ok(scoped > 0, `${file} has scoped dark rules`);
  }
  const tokens = sourceText('src/index.css');
  for (const token of ['--dg-surface: rgba(30, 41, 59, 0.55)', '--dg-border: rgba(255, 255, 255, 0.10)', '--dg-shadow: 0 8px 32px rgba(0, 0, 0, 0.35)', '--dg-text: #f8fafc', '--dg-text-muted: #94a3b8', '--dg-blur: blur(16px) saturate(140%)', '#0b0f19', '#111827']) assert.ok(tokens.includes(token), `index.css defines ${token}`);
  assert.match(sourceText('src/pages/dashboard.css'), /-webkit-backdrop-filter: var\(--dg-blur\)/);
});

test('the dark theme toggle is rendered for the manager only and logout clears it before the session ends', () => {
  assert.match(sourceText('src/services/useManagerTheme.ts'), /available: userRole === 'admin'/);
  const sidebar = sourceText('src/components/layout/Sidebar.tsx');
  assert.match(sidebar, /useManagerTheme\(userRole\)/);
  assert.match(sidebar, /\{managerTheme\.available && <button[^>]*role="switch"/);
  assert.equal((sidebar.match(/app-theme-toggle/g) ?? []).length, 1, 'a single toggle exists');
  const app = sourceText('src/App.tsx');
  assert.match(app, /async function handleLogout\(\) \{\s*clearManagerTheme\(\);\s*await signOutUser\(\);/);
  assert.match(app, /applyManagerTheme\(userRole, darkGlassPreferred\)/);
  assert.match(sourceText('src/pages/Login.tsx'), /clearManagerTheme\(\)/);
});

test('modal standard: wide forms, 42px controls, aligned label scale and 18px checkbox rows', () => {
  const css = sourceText('src/modal-theme.css');
  for (const rule of ['--modal-form-width: 820px', '--modal-label-size: .85rem', '--modal-input-size: .925rem', '--modal-field-height: 42px', '--modal-field-pad: .55rem .85rem', '--modal-field-radius: 10px']) assert.ok(css.includes(rule), `modal-theme.css defines ${rule}`);
  assert.ok(css.includes('width: min(var(--glass-dialog-width, var(--modal-form-width)), 94vw) !important'));
  assert.match(css, /\.modal-check-row[\s\S]*?display: flex;\s*align-items: center;\s*gap: \.65rem;\s*min-width: 0;\s*line-height: 1\.3;/);
  const checkbox = /:is\(input\[type="checkbox"\], input\[type="radio"\]\) \{([^}]*)\}/.exec(css)?.[1] ?? '';
  for (const declaration of ['width: 18px', 'height: 18px', 'margin: 0', 'flex: 0 0 18px', 'cursor: pointer']) assert.ok(checkbox.includes(declaration), `checkbox rule declares ${declaration}`);
  assert.match(css, /--glass-dialog-width: 900px/, 'complex multi-section dialogs keep their wider layout');
  assert.match(css, /\.float-gate > \.float-box, \.dashboard-room-choice\) \{\s*--glass-dialog-width: 460px/, 'confirmations stay compact');
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);\s*gap: var\(--modal-grid-gap\)/);
  assert.match(css, /@media \(max-width: 640px\) \{\s*html body :is\(\.stock-modal \.modal-body, \.modal-form-grid/);
  assert.match(css, /justify-content: flex-end;\s*flex-wrap: wrap;\s*gap: \.75rem;/);
});

test('the employee screen offers base salary, quick search and status filters with a wide edit modal', () => {
  const page = sourceText('src/pages/Funcionarios.tsx');
  for (const text of ['Salário Base (R$)', 'MoneyInput', 'Buscar por nome ou função', "{ value: 'active', label: 'Ativos' }", "{ value: 'inactive', label: 'Inativos' }", "{ value: 'all', label: 'Todos' }", 'pendingAdvancesByEmployee', 'formatBRL(salary)', 'data-guard-unsaved', 'finance-modal staff-modal']) assert.ok(page.includes(text), `Funcionarios.tsx contains ${text}`);
  assert.match(page, /\{member\.active \? 'Inativar' : 'Ativar'\}/);
  const payrollPage = sourceText('src/pages/financeiro/FolhaDePagamento.tsx');
  for (const text of ['Salário base (referência)', 'Vales adiantados no período', 'Consta na folha • Não debita do caixa novamente', 'Valor pago agora', 'Total remuneração registrada na folha']) assert.ok(payrollPage.includes(text), `FolhaDePagamento.tsx contains ${text}`);
});

test('monthly debt scopes separate future maturities without counting later payments', () => {
  const { accountsInScope } = load('src/services/outstandingAccounts.ts');
  const expense = (id, dueDate, amount, payments = {}) => ({ id, dueDate, category: 'Teste', plannedAmount: amount, paidCash: 0, paidBank: 0, payments, note: '' });
  const data = { ...base(), expenses: {
    old: expense('old', '2026-09-30', 125),
    end: expense('end', '2026-10-31', 29.60),
    future: expense('future', '2026-11-05', 29265.09),
    paidLater: expense('paidLater', '2026-10-20', 100, { p: { id: 'p', date: '2026-11-01', wallet: 'bank', amount: 100, dateSource: 'informed' } }),
    suppressed: expense('suppressed', '2026-10-15', 900),
  }, suppressed: { suppressed: true } };
  const rows = outstandingAccounts(data, '2026-10-31');
  const ids = (scope, asOf = '2026-10-31') => accountsInScope(rows, scope, asOf, '2026-10-31').map(r => r.id);
  assert.deepEqual(ids('throughMonth'), ['old', 'paidLater', 'end']);
  assert.deepEqual(ids('overdue'), ['old', 'paidLater']);
  assert.deepEqual(ids('upcoming'), ['end']);
  assert.deepEqual(ids('future'), ['future']);
  assert.deepEqual(ids('upcoming', '2026-10-20'), ['paidLater', 'end']);
  assert.equal(accountsInScope(rows, 'future', '2026-10-31', '2026-10-31')[0].pending, 29265.09);
  assert.equal(rows.find(r => r.id === 'paidLater').pending, 100);
  assert.equal(outstandingAccounts(data, '2026-11-01').some(r => r.id === 'paidLater'), false);
});

test('current October payables exclude November settlements and keep unpaid card purchases separate', () => {
  const { accountsInScope } = load('src/services/outstandingAccounts.ts');
  const expense = (id, dueDate, plannedAmount, date, wallet = 'bank') => ({
    id, dueDate, plannedAmount, category: 'Teste', paidCash: 0, paidBank: 0,
    payments: date ? { p: { id: 'p', date, wallet, amount: plannedAmount, dateSource: 'informed' } } : {}, note: '',
  });
  const data = { ...base(), expenses: {
    advance: expense('advance', '2026-10-01', 125, '2026-11-07'),
    oyo: expense('oyo', '2026-10-31', 29.60, '2026-11-01', 'oyo'),
    card: expense('card', '2026-11-06', 507.42),
  } };
  const rows = outstandingAccounts(data, '2026-11-08');
  for (const scope of ['throughMonth', 'overdue', 'upcoming']) {
    assert.deepEqual(accountsInScope(rows, scope, '2026-11-08', '2026-10-31'), []);
  }
  assert.equal(accountsInScope(rows, 'future', '2026-11-08', '2026-10-31')[0].pending, 507.42);
  assert.equal(accountsInScope(rows, 'throughMonth', '2026-11-08', '2026-11-30')[0].pending, 507.42);
  // Historical accounting still respects the actual dates of the payments.
  assert.equal(outstandingAccounts(data, '2026-10-31').filter(r => r.dueDate <= '2026-10-31').reduce((sum, r) => sum + Math.round(r.pending * 100), 0), 15460);
});
