import type { FinancePaymentMethod } from './finance';

export interface Attendant {
  id: string;
  name: string;
}

export type StayKind = 'hospede' | 'periodo';
export type ExtraMode = 'fixo' | 'por_diaria';
export type ExtraType = 'cama_extra' | 'checkin_antecipado' | 'checkout_tardio' | 'hospede_extra' | 'outros';

export const EXTRA_LABELS: Record<ExtraType, string> = {
  cama_extra: 'Cama extra',
  checkin_antecipado: 'Check-in antecipado',
  checkout_tardio: 'Check-out tardio',
  hospede_extra: 'Hóspede extra',
  outros: 'Outros',
};

export interface StayExtra {
  id: string;
  type: ExtraType;
  label: string;
  amount: number;
  mode?: ExtraMode;
  method?: FinancePaymentMethod;
}

export const SELECTABLE_EXTRAS: ExtraType[] = ['checkin_antecipado', 'checkout_tardio', 'outros'];

export interface GuestStay {
  employeeId?: string;
  voidedPayments?: Record<string, boolean>;
  id: string;
  kind: StayKind;
  checkInDate: string;
  nights: number;
  hours?: number;
  roomNumber: string;
  guestName: string;
  hasAdditionalGuests?: boolean;
  guestCount?: number;
  dailyRate: number;
  creditApplied?: number;
  convertedFromStayId?: string;
  dailyMethod: FinancePaymentMethod;
  dailySplit?: { method: FinancePaymentMethod; amount: number };
  hasBreakfast: boolean;
  breakfastCount?: number;
  breakfastRate: number;
  breakfastMethod?: FinancePaymentMethod;
  breakfastSplit?: { method: FinancePaymentMethod; amount: number };
  taxAmount: number;
  taxMethod: FinancePaymentMethod;
  extras: StayExtra[];
  note: string;
  attendant: string;
  status: 'hospedado' | 'encerrado';
  checkOutDate?: string;
  createdAt: string;
}

export type RoomChargeKind = 'hospede_extra' | 'cafe_avulso' | 'cama_extra' | 'bebida';

export interface RoomChargePayment {
  method: FinancePaymentMethod;
  amount: number;
}

export interface RoomCharge {
  employeeId?: string;
  voidedPayments?: Record<string, boolean>;
  id: string;
  roomNumber: string;
  sourceType: 'stay' | 'reservation';
  sourceId: string;
  kind: RoomChargeKind;
  guestName: string;
  amount: number;
  days?: number;
  dailyRate?: number;
  quantity?: number;
  productId?: string;
  productName?: string;
  date: string;
  payments: Record<string, RoomChargePayment>;
  attendant: string;
  createdAt: string;
  validFrom?: string;
  validThrough?: string;
}

export interface CashOut {
  employeeId?: string;
  id: string;
  amount: number;
  reason: string;
  note: string;
  attendant: string;
  date: string;
  createdAt: string;
}

export const CASH_OUT_REASONS = ['Mercado', 'Padaria', 'Farmácia', 'Material de limpeza', 'Manutenção', 'Outros'];

export const FLOAT_AMOUNT = 300;

export interface FloatCheck {
  employeeId?: string;
  id: string;
  attendant: string;
  previousAttendant: string;
  expected: number;
  counted: number;
  justification: string;
  createdAt: string;
}

export interface ShiftHandoff {
  id: string;
  fromAttendant: string;
  toAttendant: string;
  expectedCash: number;
  cashLeft: number;
  justification: string;
  createdAt: string;
  endsAt: string;
}

export interface ReceptionData {
  attendants: Record<string, Attendant>;
  stays: Record<string, GuestStay>;
  roomCharges: Record<string, RoomCharge>;
  rooms: Record<string, ReceptionRoom>;
  cashOuts: Record<string, CashOut>;
  floatChecks: Record<string, FloatCheck>;
}

export type RoomType = 'casal' | 'casal_twin' | 'solteiro' | 'triplo_casal_solteiro' | 'triplo_solteiros' | 'triplo';

export const ROOM_TYPE_LABELS: Record<RoomType, string> = {
  casal: 'Casal · 1 cama de casal',
  casal_twin: 'Casal (Twin) · 2 camas de solteiro',
  solteiro: 'Solteiro · 1 cama de solteiro',
  triplo_casal_solteiro: 'Triplo · 2 camas: 1 de casal e 1 de solteiro',
  triplo_solteiros: 'Triplo · 3 camas de solteiro',
  triplo: 'Triplo · 3 camas (configuração não informada)',
};

export const SELECTABLE_ROOM_TYPES: RoomType[] = ['casal', 'casal_twin', 'solteiro', 'triplo_casal_solteiro', 'triplo_solteiros'];

// 'd' = cama de casal, 's' = cama de solteiro
export const ROOM_BEDS: Record<RoomType, ('d' | 's')[]> = {
  casal: ['d'],
  casal_twin: ['s', 's'],
  solteiro: ['s'],
  triplo_casal_solteiro: ['d', 's'],
  triplo_solteiros: ['s', 's', 's'],
  triplo: ['s', 's', 's'],
};

export interface ReceptionRoom {
  id: string;
  number: string;
  type: RoomType;
}

export const ATTENDANT_STORAGE_KEY = 'hotel-lindoia:plantonista';

export const DEFAULT_ATTENDANTS = ['Luana', 'Tatiana', 'Cevani', 'Paulo'];

export const FOLIO_PAYMENT_METHODS: FinancePaymentMethod[] = ['cash', 'pix', 'bank_transfer', 'debit', 'credit', 'prepaid'];

export const extraTotal = (extra: StayExtra, nights: number) => extra.mode === 'por_diaria' ? extra.amount * nights : extra.amount;

export function stayPayments(stay: GuestStay): { id: string; method: FinancePaymentMethod; amount: number; label: string }[] {
  const list: { id: string; method: FinancePaymentMethod; amount: number; label: string }[] = [];
  const add = (suffix: string, method: FinancePaymentMethod, amount: number, label: string) => {
    const id = `recepcao-${stay.id}-${suffix}`;
    if (amount > 0 && !stay.voidedPayments?.[id]) list.push({ id, method, amount: Math.round(amount * 100) / 100, label });
  };
  const dailyTotal = Math.max(0, stay.dailyRate * stay.nights - (stay.creditApplied ?? 0));
  const split = stay.dailySplit && stay.dailySplit.amount > 0 && stay.dailySplit.amount < dailyTotal ? stay.dailySplit : undefined;
  const dailyLabel = stay.kind === 'periodo' ? 'Rotativo' : 'Diária';
  add('diaria', stay.dailyMethod, dailyTotal - (split?.amount ?? 0), dailyLabel);
  if (split) add('diaria-2', split.method, split.amount, `${dailyLabel} (2ª forma)`);
  if (stay.hasBreakfast) {
    const total = Math.round(stay.breakfastRate * (stay.breakfastCount ?? 1) * stay.nights * 100) / 100;
    const split = stay.breakfastSplit && stay.breakfastSplit.amount > 0 && stay.breakfastSplit.amount < total ? stay.breakfastSplit : undefined;
    add('cafe', stay.breakfastMethod ?? stay.dailyMethod, total - (split?.amount ?? 0), 'Café');
    if (split) add('cafe-2', split.method, split.amount, 'Café (2ª forma)');
  }
  add('taxa', stay.taxMethod, stay.taxAmount, 'Taxa');
  (stay.extras ?? []).forEach((extra) => add(`extra-${extra.id}`, extra.method ?? stay.dailyMethod, extraTotal(extra, stay.nights), extra.label));
  return list;
}

export function roomChargePayments(charge: RoomCharge): RoomChargePayment[] {
  return Object.entries(charge.payments ?? {}).filter(([id]) => !charge.voidedPayments?.[`room-charge-${charge.id}-${id}`]).map(([, payment]) => payment);
}

export function stayTotals(stay: GuestStay) {
  const daily = Math.max(0, stay.dailyRate * stay.nights - (stay.creditApplied ?? 0));
  const breakfast = stay.hasBreakfast ? stay.breakfastRate * (stay.breakfastCount ?? 1) * stay.nights : 0;
  const extras = (stay.extras ?? []).reduce((total, extra) => total + extraTotal(extra, stay.nights), 0);
  return { daily, breakfast, extras, total: stayPayments(stay).reduce((sum, payment) => sum + payment.amount, 0) };
}
