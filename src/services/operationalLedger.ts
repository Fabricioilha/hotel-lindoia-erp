import { incomePaymentWallet, type FinanceData, type FinanceExpense, type FinanceIncome, type FinancePaymentMethod } from '../types/finance';
import { extraTotal, stayBreakfastDays, stayBreakfastTotal, stayDailyAmount, stayTaxPayments, type CashOut, type GuestStay, type RoomCharge, type StayExtra } from '../types/reception';
import type { FrigobarSale } from '../types/frigobar';
import type { ReservationCollection } from '../types/housekeeping';

export interface OperationalFinanceSources {
  stays: Record<string, GuestStay>;
  roomCharges: Record<string, RoomCharge>;
  cashOuts: Record<string, CashOut>;
  sales: Record<string, FrigobarSale>;
  reservationCollections?: Record<string, Record<string, ReservationCollection>>;
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
  stayTaxPayments(stay).forEach((payment, index) => {
    add(payment.id, 'Taxas', index === 0 ? 'Taxa' : 'Taxa (2ª forma)', payment.amount, payment.method);
  });
  (stay.extras ?? []).forEach((extra) => add(`extra-${extra.id}`, extraCategories[extra.type] ?? 'Extras', extra.label, extraTotal(extra, stay.nights), extra.method ?? stay.dailyMethod));
  return entries;
}

export function stayOyoFeeExpense(stay: GuestStay): FinanceExpense | undefined {
  const amount = cents(stayTaxPayments(stay).filter((payment) => payment.method !== 'prepaid').reduce((total, payment) => total + payment.amount, 0));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const id = `recepcao-${stay.id}-oyo-fee`;
  return {
    id,
    dueDate: stay.checkInDate,
    category: 'OYO',
    plannedAmount: amount,
    paidCash: 0,
    paidBank: 0,
    note: [`Taxa da OYO recebida do hóspede`, `Quarto ${stay.roomNumber}`, stay.guestName].filter(Boolean).join(' · '),
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
    note: ['Saída de caixa', cashOut.reason, cashOut.note, `Plantão ${cashOut.attendant}`].filter(Boolean).join(' · '),
    createdAt: cashOut.createdAt, updatedAt: cashOut.createdAt };
}

export function frigobarFinanceEntry(sale: FrigobarSale): FinanceIncome | undefined {
  if (sale.settlement === 'cobrar_no_checkout' || !sale.paymentMethod) return undefined;
  const methods = { dinheiro: 'cash', pix: 'pix', cartao_debito: 'debit', cartao_credito: 'credit' } as const;
  const at = new Date(sale.settledAt ?? sale.createdAt);
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  return income(`frigobar-${sale.id}`, date, 'Consumo', sale.items.map((item) => `${item.productName} × ${item.quantity}`).join(', '), sale.amount, methods[sale.paymentMethod], ['Geladeira - Recepção', sale.roomNumber ? `Quarto ${sale.roomNumber}` : '', sale.guestName].filter(Boolean).join(' · '), sale.settledAt ?? sale.createdAt);
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
    else if (!saved.operationalOverride && saved.category === 'Diária' && entry.category !== 'Diária') {
      incomes[entry.id] = { ...saved, category: entry.category };
    }
  };
  const addExpense = (entry: FinanceExpense) => {
    if (data.suppressed[entry.id]) return;
    if (!expenses[entry.id]) expenses[entry.id] = entry;
  };
  Object.values(sources.stays).forEach((stay) => {
    Object.values(stayFinanceEntries(stay)).forEach(addIncome);
    const oyoFee = stayOyoFeeExpense(stay);
    if (oyoFee) addExpense(oyoFee);
  });
  Object.values(sources.roomCharges).forEach((charge) => Object.values(roomChargeFinanceEntries(charge)).forEach(addIncome));
  Object.values(sources.sales).forEach((sale) => { const entry = frigobarFinanceEntry(sale); if (entry) addIncome(entry); });
  Object.values(sources.reservationCollections ?? {}).forEach((collections) => Object.values(collections).forEach((collection) => {
    addIncome(income(`reservation-${collection.reservationId}-checkout-${collection.id}`, collection.date, 'Diária', 'Recebimento de hospedagem no checkout', collection.amount, collection.paymentMethod, `Reserva ${collection.reservationId} · ${collection.actor}`, collection.createdAt));
  }));
  Object.values(sources.cashOuts).forEach((cashOut) => {
    const entry = cashOutFinanceEntry(cashOut);
    if (data.suppressed[entry.id]) return;
    const saved = expenses[entry.id];
    if (!saved) expenses[entry.id] = entry;
    else if (!saved.operationalOverride && saved.category === 'Saída de caixa') expenses[entry.id] = { ...saved, category: entry.category };
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
