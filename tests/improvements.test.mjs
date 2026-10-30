import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = new Map();
function load(file) {
  const path = resolve(root, file);
  if (modules.has(path)) return modules.get(path).exports;
  const module = { exports: {} }; modules.set(path, module);
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('module', 'exports', 'require', js)(module, module.exports, (name) => {
    assert.ok(name.startsWith('.'), 'Pure domain test must not access Firebase');
    return load(resolve(dirname(path), name + '.ts'));
  });
  return module.exports;
}
const { withCardFees } = load('src/services/cardFees.ts');
const { balancesAt } = load('src/services/financeAnalytics.ts');
const { availablePayrollAdvances, validatePayrollAdvances } = load('src/services/payrollAdvances.ts');
const { payrollNet } = load('src/types/finance.ts');
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
