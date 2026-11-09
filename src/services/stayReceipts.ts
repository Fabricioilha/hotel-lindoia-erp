import { incomeItems, incomePaymentWallet, type FinancePaymentMethod } from '../types/finance';
import { stayAmountDue, stayBillingLines, type GuestStay, type StayReceipt } from '../types/reception';
import { financeDateKeyFromTimestamp, isFinanceDateKey } from './financePayments';
import { cashShiftDate } from './cashShiftDate';
import { stayFinanceEntries } from './operationalLedger';

export function existingStayReceipts(stay: GuestStay): Record<string, StayReceipt> {
  if (stay.receiptsInitialized || stay.receipts) return { ...stay.receipts };
  return Object.fromEntries(Object.values(stayFinanceEntries(stay)).map((entry) => [entry.id, {
    id: entry.id, date: entry.date, receivedAt: stay.createdAt, createdAt: stay.createdAt, attendant: stay.attendant,
    amount: entry.amount, method: incomeItems(entry)[0].paymentMethod, label: incomeItems(entry)[0].description, category: entry.category,
  }]));
}

export function initializeStayReceipts(stay: GuestStay, date: string, paid: boolean): GuestStay {
  if (!isFinanceDateKey(date)) throw new Error('Informe uma data válida para o recebimento.');
  const receivedAt = receiptTimestamp(date, stay.createdAt);
  const receipts = paid ? Object.fromEntries(Object.entries(existingStayReceipts(stay)).map(([id, receipt]) => [id, { ...receipt, date, receivedAt }])) : {};
  return { ...stay, receiptsInitialized: true, receipts, ...(paid ? { lastReceiptAt: new Date(receivedAt).toISOString() } : {}) };
}

function receiptTimestamp(date: string, now: string): string {
  return date === financeDateKeyFromTimestamp(now) || date === cashShiftDate(now)
    ? now : new Date(`${date}T12:00:00-03:00`).toISOString();
}

export function withReceiptPaymentMethod(stay: GuestStay, id: string, method: FinancePaymentMethod): GuestStay {
  const suffix = id.startsWith(`recepcao-${stay.id}-`) ? id.slice(`recepcao-${stay.id}-`.length) : '';
  if (suffix === 'diaria') return { ...stay, dailyMethod: method };
  if (suffix === 'diaria-2' && stay.dailySplit) return { ...stay, dailySplit: { ...stay.dailySplit, method } };
  if (suffix === 'cafe') return { ...stay, breakfastMethod: method };
  if (suffix === 'cafe-2' && stay.breakfastSplit) return { ...stay, breakfastSplit: { ...stay.breakfastSplit, method } };
  if (suffix === 'taxa') return { ...stay, taxMethod: method };
  if (suffix === 'taxa-2' && stay.taxSplit) return { ...stay, taxSplit: { ...stay.taxSplit, method } };
  if (suffix.startsWith('extra-') && stay.extras?.some((extra) => extra.id === suffix.slice(6))) {
    return { ...stay, extras: stay.extras.map((extra) => extra.id === suffix.slice(6) ? { ...extra, method } : extra) };
  }
  return stay;
}

export function addStayReceipt(stay: GuestStay, input: { id: string; amount: number; method: FinancePaymentMethod; date: string; attendant: string }, now = new Date().toISOString()): GuestStay {
  if (stay.receipts?.[input.id]) return stay;
  const amount = Math.round(input.amount * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > stayAmountDue(stay) || !incomePaymentWallet(input.method) || !isFinanceDateKey(input.date) || input.date > financeDateKeyFromTimestamp(now)) throw new Error('Confira o valor, a forma e a data do recebimento. O valor não pode superar o saldo pendente.');
  const receivedAt = receiptTimestamp(input.date, now);
  const receipts = existingStayReceipts(stay);
  const targets = receiptBillingLineIds(stay, receipts);
  const paidByLine: Record<string, number> = {};
  for (const receipt of Object.values(receipts)) {
    const target = targets[receipt.id];
    if (target && receipt.method !== 'courtesy' && !stay.voidedPayments?.[receipt.id]) {
      paidByLine[target] = (paidByLine[target] ?? 0) + Math.round(receipt.amount * 100);
    }
  }
  let remaining = Math.round(amount * 100);
  let index = 0;
  for (const line of stayBillingLines(stay)) {
    if (line.method === 'courtesy') continue;
    const available = Math.max(0, Math.round(line.amount * 100) - (paidByLine[line.id] ?? 0));
    const allocated = Math.min(remaining, available);
    if (!allocated) continue;
    const id = index++ === 0 ? input.id : `${input.id}-${index}`;
    receipts[id] = { ...input, id, billingLineId: line.id, amount: allocated / 100, receivedAt, createdAt: now, label: line.description, category: line.category };
    remaining -= allocated;
  }
  if (remaining) throw new Error('Não foi possível distribuir o recebimento. Revise a conta da hospedagem.');
  return { ...stay, receiptsInitialized: true, receipts, lastReceiptAt: [stay.lastReceiptAt ?? '', receivedAt].sort().at(-1)! };
}

function receiptBillingLineIds(stay: GuestStay, receipts: Record<string, StayReceipt>): Record<string, string> {
  const lines = stayBillingLines(stay);
  const ids: Record<string, string> = {};
  const remaining = new Map(lines.map((line) => [line.id, Math.round(line.amount * 100)]));
  const ordered = Object.values(receipts).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  for (const receipt of ordered) {
    const category = lines.filter((line) => line.category === receipt.category);
    const matchingLabel = category.filter((line) => line.description === receipt.label || line.label === receipt.label);
    const line = receipt.billingLineId ?? lines.find((item) => item.id === receipt.id)?.id
      ?? (matchingLabel.find((item) => (remaining.get(item.id) ?? 0) > 0) ?? matchingLabel[0])?.id
      ?? (category.find((item) => (remaining.get(item.id) ?? 0) > 0) ?? category[0])?.id;
    if (!line) continue;
    ids[receipt.id] = line;
    if (!stay.voidedPayments?.[receipt.id]) remaining.set(line, (remaining.get(line) ?? 0) - Math.round(receipt.amount * 100));
  }
  return ids;
}

// Recebimentos já gravados continuam valendo na hospedagem; sem isto a troca da forma no formulário não chega ao Financeiro.
export function withSyncedReceiptMethods(previous: GuestStay, next: GuestStay): GuestStay {
  const before = new Map(stayBillingLines(previous).map((line) => [line.id, line.method]));
  const after = new Map(stayBillingLines(next).map((line) => [line.id, line.method]));
  const receipts = existingStayReceipts(previous);
  const targets = receiptBillingLineIds(previous, receipts);
  for (const [id, receipt] of Object.entries(receipts)) {
    const target = targets[id];
    const prior = before.get(target);
    const primary = /-(diaria|cafe|taxa)-2$/.test(target ?? '') ? target.slice(0, -2) : undefined;
    const mergedCourtesy = primary && !after.has(target) && after.get(primary) === 'courtesy';
    const method = mergedCourtesy ? 'courtesy' : after.get(target);
    if (!method || (!mergedCourtesy && prior === method) || (id !== target && method !== 'courtesy' && receipt.method !== 'courtesy')) continue;
    const { cardFeeRate: _rate, cardFeeAmount: _fee, netAmount: _net, ...rest } = receipt;
    void _rate; void _fee; void _net;
    receipts[id] = { ...rest, billingLineId: mergedCourtesy ? primary : target, method };
  }
  return { ...next, receiptsInitialized: true, receipts, ...(previous.lastReceiptAt ? { lastReceiptAt: previous.lastReceiptAt } : {}) };
}
