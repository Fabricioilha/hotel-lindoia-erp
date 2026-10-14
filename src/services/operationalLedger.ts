import { incomePaymentWallet, type FinanceData, type FinanceExpense, type FinanceIncome, type FinancePaymentMethod } from '../types/finance';
import { extraTotal, stayBreakfastDays, stayBreakfastTotal, stayDailyAmount, stayTaxPayments, type CashOut, type GuestStay, type RoomCharge, type StayExtra } from '../types/reception';
import type { FrigobarSale } from '../types/frigobar';
import type { ReservationCollection } from '../types/housekeeping';
import type { Reservation } from '../types/housekeeping';
import type { StockMovement } from '../types/inventory';
import { financeDateKeyFromTimestamp, withExpensePaymentTotals } from './financePayments';

export interface OperationalFinanceSources {
  stays: Record<string, GuestStay>;
  roomCharges: Record<string, RoomCharge>;
  cashOuts: Record<string, CashOut>;
  sales: Record<string, FrigobarSale>;
  reservationCollections?: Record<string, Record<string, ReservationCollection>>;
  movements?: Record<string, StockMovement>;
  reservations?: Record<string, Reservation>;
}

const cents = (value: number) => Math.round(value * 100) / 100;
const extraCategories: Record<StayExtra['type'], string> = {
  cama_extra: 'Cama extra',
  checkin_antecipado: 'Check-in antecipado',
  checkout_tardio: 'Checkout tardio',
  hospede_extra: 'Adicional de hóspede',
  outros: 'Extras',
};

function income(id: string, date: string, category: string, description: string, amount: number, paymentMethod: FinancePaymentMethod, note: string, createdAt: string): FinanceIncome {
  return { id, date, category, amount: cents(amount), wallet: incomePaymentWallet(paymentMethod)!,
    items: [{ id, description, amount: cents(amount), paymentMethod }], note, createdAt, updatedAt: createdAt };
}

export function stayFinanceEntries(stay: GuestStay): Record<string, FinanceIncome> {
  const entries: Record<string, FinanceIncome> = {};
  const prefix = `recepcao-${stay.id}-`;
  const category = stay.kind === 'periodo' ? 'Rotativo' : 'Diária';
  const dailyTotal = cents(Math.max(0, stayDailyAmount(stay) - (stay.creditApplied ?? 0)));
  const dailySplit = stay.dailySplit && stay.dailySplit.amount > 0 && stay.dailySplit.amount < dailyTotal ? stay.dailySplit : undefined;
  const note = [stay.kind === 'periodo' ? `Rotativo ${stay.hours ?? 4}h` : '', stay.creditApplied ? `Crédito do rotativo: R$ ${stay.creditApplied.toFixed(2)}` : '', `Quarto ${stay.roomNumber}`, stay.guestName, `Plantão ${stay.attendant}`, stay.note].filter(Boolean).join(' · ');
  const add = (suffix: string, entryCategory: string, description: string, amount: number, method: FinancePaymentMethod) => {
    if (!Number.isFinite(amount) || amount <= 0 || stay.voidedPayments?.[`${prefix}${suffix}`]) return;
    const entry = income(`${prefix}${suffix}`, stay.checkInDate, entryCategory, description, amount, method, note, stay.createdAt);
    entries[entry.id] = entry;
  };
  const description = stay.kind === 'periodo' ? `Rotativo (${stay.hours ?? 4}h)` : `Diária × ${stay.nights}`;
  add('diaria', category, description, dailyTotal - (dailySplit?.amount ?? 0), stay.dailyMethod);
  if (dailySplit) add('diaria-2', category, `${description} (2ª forma)`, dailySplit.amount, dailySplit.method);
  if (stay.hasBreakfast) {
    const total = cents(stayBreakfastTotal(stay));
    const split = stay.breakfastSplit && stay.breakfastSplit.amount > 0 && stay.breakfastSplit.amount < total ? stay.breakfastSplit : undefined;
    const breakfastDescription = `${stay.breakfastCount ?? 1} café(s) por dia × ${stayBreakfastDays(stay)} dia(s)`;
    // Registros antigos mantêm o pagamento original; novos cadastros informam o método do café.
    add('cafe', 'Café', breakfastDescription, total - (split?.amount ?? 0), stay.breakfastMethod ?? stay.dailyMethod);
    if (split) add('cafe-2', 'Café', `${breakfastDescription} (2ª forma)`, split.amount, split.method);
  }
  stayTaxPayments(stay).filter((payment) => payment.method !== 'prepaid').forEach((payment) => {
    add(payment.id, 'Taxas', payment.id === 'taxa' ? 'Taxa' : 'Taxa (2ª forma)', payment.amount, payment.method);
  });
  (stay.extras ?? []).forEach((extra) => add(`extra-${extra.id}`, extraCategories[extra.type] ?? 'Extras', extra.label, extraTotal(extra, stay.nights), extra.method ?? stay.dailyMethod));
  return entries;
}

export function stayFinanceEntryIds(stay: GuestStay): string[] {
  const prefix = `recepcao-${stay.id}-`;
  return [...new Set([
    ...Object.keys(stayFinanceEntries(stay)),
    ...stayTaxPayments(stay).map((payment) => `${prefix}${payment.id}`),
  ])];
}

export function stayOyoFeeExpense(stay: GuestStay): FinanceExpense | undefined {
  const amount = cents(stayTaxPayments(stay).filter((payment) => payment.method !== 'prepaid'
    && !stay.voidedPayments?.[`recepcao-${stay.id}-${payment.id}`]).reduce((total, payment) => total + payment.amount, 0));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const id = `recepcao-${stay.id}-oyo-fee`;
  return {
    id,
    dueDate: stay.checkInDate,
    category: 'OYO',
    plannedAmount: amount,
    paidCash: 0,
    paidBank: 0,
    paidOyo: amount,
    paidDate: stay.checkInDate,
    payments: { [`${id}-oyo`]: { id: `${id}-oyo`, date: stay.checkInDate, wallet: 'oyo', amount, dateSource: 'informed' } },
    note: [`Taxa cobrada no balcão e compensada com valores retidos pela OYO`, `Quarto ${stay.roomNumber}`, stay.guestName].filter(Boolean).join(' · '),
    createdAt: stay.createdAt,
    updatedAt: stay.createdAt,
  };
}

export function roomChargeFinanceEntries(charge: RoomCharge): Record<string, FinanceIncome> {
  const category = charge.kind === 'cafe_avulso' ? 'Café' : charge.kind === 'cama_extra' ? 'Cama extra' : charge.kind === 'bebida' ? 'Consumo' : 'Adicional de hóspede';
  const description = charge.kind === 'bebida' ? `${charge.productName ?? 'Bebida'} × ${charge.quantity ?? 1}` : `${category} × ${charge.days ?? 1} dia(s) · ${charge.guestName}`;
  return Object.fromEntries(Object.entries(charge.payments ?? {}).filter(([id]) => !charge.voidedPayments?.[`room-charge-${charge.id}-${id}`]).map(([paymentId, payment]) => {
    const entry = income(`room-charge-${charge.id}-${paymentId}`, charge.date, category, description, payment.amount, payment.method, `Quarto ${charge.roomNumber} · ${charge.guestName} · Plantão ${charge.attendant}`, charge.createdAt);
    return [entry.id, entry];
  }));
}

export function cashOutFinanceEntry(cashOut: CashOut): FinanceExpense {
  return { id: `caixa-${cashOut.id}`, dueDate: cashOut.date, category: cashOut.reason,
    plannedAmount: cashOut.amount, paidCash: cashOut.amount, paidBank: 0,
    paidDate: cashOut.date,
    payments: { [`caixa-${cashOut.id}-cash`]: { id: `caixa-${cashOut.id}-cash`, date: cashOut.date, wallet: 'cash', amount: cents(cashOut.amount), dateSource: 'informed' } },
    note: ['Saída de caixa', cashOut.reason, cashOut.note, `Plantão ${cashOut.attendant}`].filter(Boolean).join(' · '),
    createdAt: cashOut.createdAt, updatedAt: cashOut.createdAt };
}

export function frigobarFinanceEntry(sale: FrigobarSale): FinanceIncome | undefined {
  if (sale.settlement === 'cobrar_no_checkout' || !sale.paymentMethod) return undefined;
  const methods = { dinheiro: 'cash', pix: 'pix', cartao_debito: 'debit', cartao_credito: 'credit' } as const;
  const date = financeDateKeyFromTimestamp(sale.settledAt ?? sale.createdAt);
  if (!date || !methods[sale.paymentMethod]) return undefined;
  return income(`frigobar-${sale.id}`, date, 'Consumo', sale.items.map((item) => `${item.productName} × ${item.quantity}`).join(', '), sale.amount, methods[sale.paymentMethod], ['Geladeira - Recepção', sale.roomNumber ? `Quarto ${sale.roomNumber}` : '', sale.guestName].filter(Boolean).join(' · '), sale.settledAt ?? sale.createdAt);
}

export function minibarMovementFinanceEntry(movement: StockMovement): FinanceIncome | undefined {
  if (movement.type !== 'consumo_frigobar' || !movement.paymentMethod
    || !['pago_na_recepcao', 'pago_no_checkout'].includes(movement.settlement ?? '')) return undefined;
  const methods = { dinheiro: 'cash', pix: 'pix', cartao_debito: 'debit', cartao_credito: 'credit' } as const;
  const date = financeDateKeyFromTimestamp(movement.settledAt ?? movement.createdAt);
  const amount = cents(movement.quantity * movement.unitPrice);
  if (!date || !methods[movement.paymentMethod] || !Number.isFinite(amount) || amount <= 0) return undefined;
  return income(`minibar-${movement.id}`, date, 'Consumo', `${movement.productName} · ${movement.quantity} ${movement.unit}`,
    amount, methods[movement.paymentMethod], ['Frigobar', movement.roomNumber ? `Quarto ${movement.roomNumber}` : '', movement.guestName].filter(Boolean).join(' · '), movement.settledAt ?? movement.createdAt);
}

export function stockPurchaseExpense(movement: StockMovement): FinanceExpense | undefined {
  if (movement.type !== 'entrada') return undefined;
  const amount = cents(movement.quantity * movement.unitPrice);
  const dueDate = financeDateKeyFromTimestamp(movement.createdAt);
  if (!dueDate || !Number.isFinite(amount) || amount <= 0) return undefined;
  const id = `stock-entry-${movement.id}`;
  const base: FinanceExpense = {
    id, dueDate, category: 'Estoque', plannedAmount: amount,
    paidCash: movement.entryPayment === 'caixa' ? amount : 0,
    paidBank: movement.entryPayment === 'banco' ? amount : 0,
    note: [`Entrada de estoque: ${movement.quantity} ${movement.unit} de ${movement.productName}`, movement.reference, movement.note,
      movement.entryPayment ? '' : 'Pagamento não informado no movimento histórico; confira a compra.'].filter(Boolean).join(' · '),
    createdAt: movement.createdAt, updatedAt: movement.createdAt,
  };
  return withExpensePaymentTotals(undefined, base, movement.paidDate || dueDate, id);
}

// Uma única visão do financeiro: operações entram diretamente, sem cópias gravadas
// pela sessão da gerência. Os mesmos ids preservam ajustes e exclusões anteriores.
export function withOperationalFinance(data: FinanceData, sources: OperationalFinanceSources): FinanceData {
  const incomes = { ...data.incomes };
  const expenses = { ...data.expenses };
  const addIncome = (entry: FinanceIncome) => {
    if (data.suppressed[entry.id]) return;
    const saved = incomes[entry.id];
    if (!saved) incomes[entry.id] = entry;
    else if (!saved.operationalOverride) incomes[entry.id] = { ...entry, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
  };
  const addExpense = (entry: FinanceExpense, preserveSaved = false) => {
    if (data.suppressed[entry.id]) return;
    const saved = expenses[entry.id];
    if (!saved) expenses[entry.id] = entry;
    else if (!saved.operationalOverride && !preserveSaved) expenses[entry.id] = { ...entry, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
  };
  Object.values(sources.stays).forEach((stay) => {
    Object.entries(stay.voidedPayments ?? {}).forEach(([id, voided]) => { if (voided) delete incomes[id]; });
    Object.values(stayFinanceEntries(stay)).forEach(addIncome);
    stayTaxPayments(stay).filter((payment) => payment.method === 'prepaid').forEach((payment) => {
      delete incomes[`recepcao-${stay.id}-${payment.id}`];
    });
    const oyoFee = stayOyoFeeExpense(stay);
    if (oyoFee) addExpense(oyoFee);
    else if (!expenses[`recepcao-${stay.id}-oyo-fee`]?.operationalOverride) delete expenses[`recepcao-${stay.id}-oyo-fee`];
  });
  Object.values(sources.roomCharges).forEach((charge) => {
    Object.entries(charge.voidedPayments ?? {}).forEach(([id, voided]) => { if (voided) delete incomes[id]; });
    Object.values(roomChargeFinanceEntries(charge)).forEach(addIncome);
  });
  Object.values(sources.sales).forEach((sale) => { const entry = frigobarFinanceEntry(sale); if (entry) addIncome(entry); });
  Object.values(sources.movements ?? {}).forEach((movement) => {
    const sale = minibarMovementFinanceEntry(movement);
    if (sale) addIncome(sale);
    const purchase = stockPurchaseExpense(movement);
    if (purchase) addExpense(purchase, !movement.entryPayment);
  });
  Object.values(sources.reservationCollections ?? {}).forEach((collections) => Object.values(collections).forEach((collection) => {
    const reservation = sources.reservations?.[collection.reservationId];
    addIncome(income(`reservation-${collection.reservationId}-checkout-${collection.id}`, collection.date,
      reservation?.channel === 'rotativo' ? 'Rotativo' : 'Diária',
      reservation ? `Hospedagem · quarto ${reservation.roomNumber}` : 'Recebimento de hospedagem no checkout',
      collection.amount, collection.paymentMethod, [`Reserva ${collection.reservationId}`, collection.actor, reservation?.guestName].filter(Boolean).join(' · '), collection.createdAt));
  }));
  Object.values(sources.cashOuts).forEach((cashOut) => {
    const entry = cashOutFinanceEntry(cashOut);
    if (data.suppressed[entry.id]) return;
    const saved = expenses[entry.id];
    if (!saved) expenses[entry.id] = entry;
    else if (!saved.operationalOverride) expenses[entry.id] = { ...entry, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
  });
  Object.keys(data.suppressed).filter((id) => data.suppressed[id]).forEach((id) => { delete incomes[id]; delete expenses[id]; });
  Object.values(incomes).forEach((entry) => {
    const category = data.categoryAliases?.income[entry.category];
    if (category) incomes[entry.id] = { ...entry, category };
  });
  Object.values(expenses).forEach((entry) => {
    const category = data.categoryAliases?.expense[entry.category];
    if (category) expenses[entry.id] = { ...entry, category };
  });
  return { ...data, incomes, expenses,
    incomeCategories: [...new Set([...data.incomeCategories, ...Object.values(incomes).map((entry) => entry.category)])],
    expenseCategories: [...new Set([...data.expenseCategories, ...Object.values(expenses).map((entry) => entry.category)])] };
}
