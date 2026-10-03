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
  mode: ExtraMode;
}

export interface GuestStay {
  id: string;
  kind: StayKind;
  checkInDate: string;
  nights: number;
  roomNumber: string;
  guestName: string;
  dailyRate: number;
  dailyMethod: FinancePaymentMethod;
  hasBreakfast: boolean;
  breakfastRate: number;
  taxAmount: number;
  taxMethod: FinancePaymentMethod;
  extras: StayExtra[];
  note: string;
  attendant: string;
  status: 'hospedado' | 'encerrado';
  checkOutDate?: string;
  createdAt: string;
}

export interface ReceptionData {
  attendants: Record<string, Attendant>;
  stays: Record<string, GuestStay>;
  rooms: Record<string, ReceptionRoom>;
}

export type RoomType = 'casal' | 'casal_twin' | 'solteiro' | 'triplo_casal_solteiro' | 'triplo_solteiros' | 'triplo';

export const ROOM_TYPE_LABELS: Record<RoomType, string> = {
  casal: 'Casal · 1 cama de casal',
  casal_twin: 'Casal (Twin) · 2 camas de solteiro',
  solteiro: 'Solteiro · 1 cama de solteiro',
  triplo_casal_solteiro: 'Triplo · 1 cama de casal e 1 de solteiro',
  triplo_solteiros: 'Triplo · 3 camas de solteiro',
  triplo: 'Triplo',
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

export const FOLIO_PAYMENT_METHODS: FinancePaymentMethod[] = ['cash', 'pix', 'debit', 'credit', 'prepaid'];

export const extraTotal = (extra: StayExtra, nights: number) => extra.mode === 'por_diaria' ? extra.amount * nights : extra.amount;

export function stayTotals(stay: GuestStay) {
  const daily = stay.dailyRate * stay.nights;
  const breakfast = stay.hasBreakfast ? stay.breakfastRate * stay.nights : 0;
  const extras = (stay.extras ?? []).reduce((total, extra) => total + extraTotal(extra, stay.nights), 0);
  return { daily, breakfast, extras, total: daily + breakfast + stay.taxAmount + extras };
}
