import { buildAuditEvents } from '../types/audit';
import { incomePaymentWallet, type FinanceExpense, type FinanceIncome, type FinancePaymentMethod } from '../types/finance';
import type { FrigobarSale } from '../types/frigobar';
import type { MinibarPaymentMethod } from '../types/inventory';
import { CASH_OUT_REASONS, MANAGEMENT_COLLECTION_REASON, stayPayments, type CashOut, type GuestStay, type RoomCharge, type StayReceipt } from '../types/reception';
import { frigobarFinanceEntry, roomChargeFinanceEntries, stayFinanceEntries, stayOyoFeeExpense, cashOutFinanceEntry } from './operationalLedger';
import { financeDateKeyFromTimestamp, isFinanceDateKey } from './financePayments';
import { db, get, ref, update } from './pocketbaseRealtime';
import { existingStayReceipts, withReceiptPaymentMethod } from './stayReceipts';
import { snapshotStayCardFees } from './cardFeeStore';
import { staffReference } from './staffStore';

const FINANCE = 'erp_geral/financeiro';
const RECEPTION = 'erp_geral/recepcao';
const FRIGOBAR_SALES = 'erp_geral/frigobar/operations/sales';
const cents = (value: number) => Math.round(value * 100);

export interface ReceiptEdit { method: FinancePaymentMethod; amount: number; date: string }

export const MINIBAR_METHOD_BY_FINANCE: Partial<Record<FinancePaymentMethod, MinibarPaymentMethod>> = {
  cash: 'dinheiro', pix: 'pix', debit: 'cartao_debito', credit: 'cartao_credito',
};

function assertMethod(method: FinancePaymentMethod) {
  if (!incomePaymentWallet(method)) throw new Error('Selecione uma forma de pagamento válida.');
}

function assertAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Informe um valor maior que zero.');
}

// Grava a alteração do lançamento, o histórico de auditoria e o Financeiro no mesmo update.
function withAudit(updates: Record<string, unknown>, timestamp: string,
  incomes: { before: Record<string, FinanceIncome>; after: Record<string, FinanceIncome> },
  expenses?: { before: Record<string, FinanceExpense>; after: Record<string, FinanceExpense> }) {
  const events = buildAuditEvents(crypto.randomUUID(), timestamp, [
    { entity: 'finance-income', before: incomes.before, after: incomes.after },
    ...(expenses ? [{ entity: 'finance-expense', before: expenses.before, after: expenses.after }] : []),
  ]);
  Object.entries(events).forEach(([id, event]) => { updates[`${FINANCE}/auditLog/${id}`] = event; });
}

async function readSuppressed(): Promise<Record<string, boolean>> {
  return ((await get(ref(db, `${FINANCE}/suppressed`))).val() ?? {}) as Record<string, boolean>;
}

/** Corrige forma, valor e data de recebimentos de uma hospedagem e propaga a mudança ao Financeiro. */
export async function updateStayReceipts(stayId: string, changes: Record<string, ReceiptEdit>, today = financeDateKeyFromTimestamp(new Date().toISOString())): Promise<void> {
  const stayRef = ref(db, `${RECEPTION}/stays/${stayId}`);
  const snapshot = await get(stayRef);
  if (!snapshot.exists()) throw new Error('Esta hospedagem já foi excluída. Atualize a lista antes de editar.');
  const stay = snapshot.val() as GuestStay;
  const initialized = Boolean(stay.receiptsInitialized || stay.receipts);
  const receipts: Record<string, StayReceipt> = existingStayReceipts(stay);
  let updatedMethods = stay;
  const timestamp = new Date().toISOString();

  for (const [id, change] of Object.entries(changes)) {
    const receipt = receipts[id];
    if (!receipt || receipt.method === 'courtesy' || stay.voidedPayments?.[id]) throw new Error('O recebimento não existe mais. Atualize a tela e tente novamente.');
    assertMethod(change.method);
    assertAmount(change.amount);
    if (!isFinanceDateKey(change.date) || change.date > today) throw new Error('Informe uma data válida, que não seja futura.');
    const { cardFeeRate, cardFeeAmount: _fee, netAmount: _net, ...rest } = receipt;
    void _fee; void _net;
    receipts[id] = { ...rest, method: change.method, amount: cents(change.amount) / 100, date: change.date,
      ...(change.method === receipt.method && cardFeeRate !== undefined ? { cardFeeRate } : {}),
      receivedAt: change.date === receipt.date ? receipt.receivedAt : new Date(`${change.date}T12:00:00-03:00`).toISOString() };
    if (change.method !== receipt.method) updatedMethods = withReceiptPaymentMethod(updatedMethods, id, change.method);
  }

  const expected = stayPayments({ ...stay, receiptsInitialized: false, receipts: undefined, voidedPayments: undefined }).reduce((sum, payment) => sum + cents(payment.amount), 0);
  const paid = stayPayments({ ...stay, receipts }).reduce((sum, receipt) => sum + cents(receipt.amount), 0);
  if (paid > expected) throw new Error('O valor recebido não pode ultrapassar o total da hospedagem.');

  const next = await snapshotStayCardFees({ ...updatedMethods, receiptsInitialized: true, receipts });
  const entries = stayFinanceEntries(next);
  const suppressed = await readSuppressed();
  const updates: Record<string, unknown> = {};
  const incomeBefore: Record<string, FinanceIncome> = {};
  const incomeAfter: Record<string, FinanceIncome> = {};
  const writtenIds = initialized ? Object.keys(changes) : Object.keys(receipts);

  for (const id of writtenIds) updates[`${RECEPTION}/stays/${stayId}/receipts/${id}`] = next.receipts![id];
  for (const key of ['dailyMethod', 'dailySplit', 'breakfastMethod', 'breakfastSplit', 'taxMethod', 'taxSplit', 'extras'] as const) {
    if (JSON.stringify(stay[key]) !== JSON.stringify(next[key])) updates[`${RECEPTION}/stays/${stayId}/${key}`] = next[key] ?? null;
  }
  updates[`${RECEPTION}/stays/${stayId}/receiptsInitialized`] = true;
  const lastReceiptAt = Object.values(next.receipts!).map((receipt) => receipt.receivedAt).sort().at(-1);
  if (lastReceiptAt && (stay.lastReceiptAt ?? '') < lastReceiptAt) updates[`${RECEPTION}/stays/${stayId}/lastReceiptAt`] = lastReceiptAt;

  for (const id of Object.keys(changes)) {
    const entry = entries[id];
    if (!entry || suppressed[id]) continue;
    const saved = (await get(ref(db, `${FINANCE}/incomes/${id}`))).val() as FinanceIncome | null;
    const income = { ...entry, createdAt: saved?.createdAt ?? entry.createdAt, updatedAt: timestamp };
    updates[`${FINANCE}/incomes/${id}`] = income;
    if (saved) incomeBefore[id] = saved;
    incomeAfter[id] = income;
  }

  const feeId = `recepcao-${stayId}-oyo-fee`;
  const expenseBefore: Record<string, FinanceExpense> = {};
  const expenseAfter: Record<string, FinanceExpense> = {};
  if (Object.keys(changes).some((id) => receipts[id].category === 'Taxas') && !suppressed[feeId]) {
    const saved = (await get(ref(db, `${FINANCE}/expenses/${feeId}`))).val() as FinanceExpense | null;
    if (!saved?.operationalOverride) {
      const fee = stayOyoFeeExpense(next);
      updates[`${FINANCE}/expenses/${feeId}`] = fee ? { ...fee, updatedAt: timestamp } : null;
      if (saved) expenseBefore[feeId] = saved;
      if (fee) expenseAfter[feeId] = fee;
    }
  }
  withAudit(updates, timestamp, { before: incomeBefore, after: incomeAfter }, { before: expenseBefore, after: expenseAfter });
  await update(ref(db), updates, snapshot.versions);
}

/** Troca a forma de pagamento de uma linha de adicional do quarto. */
export async function updateRoomChargePayment(chargeId: string, paymentId: string, method: FinancePaymentMethod): Promise<void> {
  assertMethod(method);
  const chargeRef = ref(db, `${RECEPTION}/roomCharges/${chargeId}`);
  const snapshot = await get(chargeRef);
  if (!snapshot.exists()) throw new Error('Este adicional já foi excluído. Atualize a lista antes de editar.');
  const charge = snapshot.val() as RoomCharge;
  const payment = charge.payments?.[paymentId];
  if (!payment) throw new Error('A forma de pagamento deste adicional não existe mais.');
  const next: RoomCharge = { ...charge, payments: { ...charge.payments, [paymentId]: { ...payment, method } } };
  const incomeId = `room-charge-${chargeId}-${paymentId}`;
  const updates: Record<string, unknown> = { [`${RECEPTION}/roomCharges/${chargeId}/payments/${paymentId}`]: next.payments[paymentId] };
  const timestamp = new Date().toISOString();
  const before: Record<string, FinanceIncome> = {};
  const after: Record<string, FinanceIncome> = {};
  const entry = roomChargeFinanceEntries(next)[incomeId];
  if (entry && !(await readSuppressed())[incomeId]) {
    const saved = (await get(ref(db, `${FINANCE}/incomes/${incomeId}`))).val() as FinanceIncome | null;
    const income = { ...entry, createdAt: saved?.createdAt ?? entry.createdAt, updatedAt: timestamp };
    updates[`${FINANCE}/incomes/${incomeId}`] = income;
    if (saved) before[incomeId] = saved;
    after[incomeId] = income;
  }
  withAudit(updates, timestamp, { before, after });
  await update(ref(db), updates);
}

/** Troca a forma de pagamento de uma venda da geladeira já recebida. */
export async function updateFrigobarSaleMethod(saleId: string, method: FinancePaymentMethod): Promise<void> {
  const paymentMethod = MINIBAR_METHOD_BY_FINANCE[method];
  if (!paymentMethod) throw new Error('A geladeira aceita dinheiro, Pix, débito ou crédito.');
  const saleRef = ref(db, `${FRIGOBAR_SALES}/${saleId}`);
  const snapshot = await get(saleRef);
  if (!snapshot.exists()) throw new Error('Esta venda já foi excluída. Atualize a lista antes de editar.');
  const sale = snapshot.val() as FrigobarSale;
  if (sale.settlement === 'cobrar_no_checkout' || !sale.paymentMethod) throw new Error('Esta venda ainda não foi recebida.');
  const next = { ...sale, paymentMethod };
  const updates: Record<string, unknown> = { [`${FRIGOBAR_SALES}/${saleId}/paymentMethod`]: paymentMethod };
  const timestamp = new Date().toISOString();
  const incomeId = `frigobar-${saleId}`;
  const before: Record<string, FinanceIncome> = {};
  const after: Record<string, FinanceIncome> = {};
  const entry = frigobarFinanceEntry(next);
  if (entry && !(await readSuppressed())[incomeId]) {
    const saved = (await get(ref(db, `${FINANCE}/incomes/${incomeId}`))).val() as FinanceIncome | null;
    const income = { ...entry, createdAt: saved?.createdAt ?? entry.createdAt, updatedAt: timestamp };
    updates[`${FINANCE}/incomes/${incomeId}`] = income;
    if (saved) before[incomeId] = saved;
    after[incomeId] = income;
  }
  withAudit(updates, timestamp, { before, after });
  await update(ref(db), updates);
}

/** Corrige valor, motivo e observação de uma saída de caixa e a despesa correspondente. */
export async function updateCashOut(id: string, changes: Pick<CashOut, 'amount' | 'reason' | 'note'> & Partial<Pick<CashOut, 'date' | 'attendant'>>, expected?: CashOut): Promise<void> {
  assertAmount(changes.amount);
  if (!CASH_OUT_REASONS.includes(changes.reason)) throw new Error('Escolha o motivo da saída.');
  const snapshot = await get(ref(db, `${RECEPTION}/cashOuts/${id}`));
  if (!snapshot.exists()) throw new Error('Esta saída já foi excluída. Atualize a lista antes de editar.');
  const cashOut = snapshot.val() as CashOut;
  if (expected && JSON.stringify(cashOut) !== JSON.stringify(expected)) throw new Error('Esta saída mudou em outra sessão. Feche e reabra o formulário.');
  const date = changes.date ?? cashOut.date;
  const attendant = (changes.attendant ?? cashOut.attendant).trim();
  if (!isFinanceDateKey(date) || !attendant) throw new Error('Informe uma data válida e o plantonista responsável.');
  const { employeeId: _employeeId, ...withoutEmployeeId } = cashOut;
  void _employeeId;
  const staff = staffReference(attendant);
  const next: CashOut = { ...withoutEmployeeId, ...(attendant === cashOut.attendant && cashOut.employeeId ? { employeeId: cashOut.employeeId } : {}), ...staff, amount: cents(changes.amount) / 100, reason: changes.reason, note: changes.note.trim(), date, attendant };
  const timestamp = new Date().toISOString();
  const expenseId = `caixa-${id}`;
  const updates: Record<string, unknown> = { [`${RECEPTION}/cashOuts/${id}`]: next };
  const before: Record<string, FinanceExpense> = {};
  const after: Record<string, FinanceExpense> = {};
  if (next.reason === MANAGEMENT_COLLECTION_REASON) {
    const saved = (await get(ref(db, `${FINANCE}/expenses/${expenseId}`))).val() as FinanceExpense | null;
    if (saved) {
      before[expenseId] = saved;
      updates[`${FINANCE}/expenses/${expenseId}`] = null;
    }
  } else if (!(await readSuppressed())[expenseId]) {
    const saved = (await get(ref(db, `${FINANCE}/expenses/${expenseId}`))).val() as FinanceExpense | null;
    const expense = { ...cashOutFinanceEntry(next), createdAt: saved?.createdAt ?? cashOut.createdAt, updatedAt: timestamp };
    updates[`${FINANCE}/expenses/${expenseId}`] = expense;
    if (saved) before[expenseId] = saved;
    after[expenseId] = expense;
  }
  withAudit(updates, timestamp, { before: {}, after: {} }, { before, after });
  await update(ref(db), updates);
}
