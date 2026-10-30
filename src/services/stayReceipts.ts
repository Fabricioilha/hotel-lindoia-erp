import { incomeItems, incomePaymentWallet, type FinancePaymentMethod } from '../types/finance';
import { stayAmountDue, type GuestStay, type StayReceipt } from '../types/reception';
import { financeDateKeyFromTimestamp, isFinanceDateKey } from './financePayments';
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
  const receivedAt = date === financeDateKeyFromTimestamp(stay.createdAt) ? stay.createdAt : `${date}T12:00:00-03:00`;
  const receipts = paid ? Object.fromEntries(Object.entries(existingStayReceipts(stay)).map(([id, receipt]) => [id, { ...receipt, date, receivedAt }])) : {};
  return { ...stay, receiptsInitialized: true, receipts, ...(paid ? { lastReceiptAt: new Date(receivedAt).toISOString() } : {}) };
}

export function addStayReceipt(stay: GuestStay, input: { id: string; amount: number; method: FinancePaymentMethod; date: string; attendant: string }, now = new Date().toISOString()): GuestStay {
  if (stay.receipts?.[input.id]) return stay;
  const amount = Math.round(input.amount * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > stayAmountDue(stay) || !incomePaymentWallet(input.method) || !isFinanceDateKey(input.date) || input.date > financeDateKeyFromTimestamp(now)) throw new Error('Confira o valor, a forma e a data do recebimento. O valor não pode superar o saldo pendente.');
  const receivedAt = input.date === financeDateKeyFromTimestamp(now) ? now : new Date(`${input.date}T12:00:00-03:00`).toISOString();
  const receipts = existingStayReceipts(stay);
  const paidByCategory: Record<string, number> = {};
  for (const receipt of Object.values(receipts)) if (!stay.voidedPayments?.[receipt.id]) paidByCategory[receipt.category] = (paidByCategory[receipt.category] ?? 0) + Math.round(receipt.amount * 100);
  let remaining = Math.round(amount * 100);
  let index = 0;
  for (const expected of Object.values(stayFinanceEntries({ ...stay, receiptsInitialized: false, receipts: undefined, voidedPayments: undefined }))) {
    const expectedCents = Math.round(expected.amount * 100);
    const paid = Math.min(expectedCents, paidByCategory[expected.category] ?? 0);
    paidByCategory[expected.category] = (paidByCategory[expected.category] ?? 0) - paid;
    const allocated = Math.min(remaining, expectedCents - paid);
    if (!allocated) continue;
    const id = index++ === 0 ? input.id : `${input.id}-${index}`;
    receipts[id] = { ...input, id, amount: allocated / 100, receivedAt, createdAt: now, label: incomeItems(expected)[0].description, category: expected.category };
    remaining -= allocated;
  }
  if (remaining) throw new Error('Não foi possível distribuir o recebimento. Revise a conta da hospedagem.');
  return { ...stay, receiptsInitialized: true, receipts, lastReceiptAt: [stay.lastReceiptAt ?? '', receivedAt].sort().at(-1)! };
}
