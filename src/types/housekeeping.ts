export type RoomCleaningStatus = 'sujo' | 'limpo' | 'em_limpeza';
export type RoomMaintenanceStatus = 'normal' | 'manutencao_necessaria' | 'em_manutencao';
export type RoomCategory = string;
export const roomCategoryLabels: Record<string, string> = {
  solteiro: 'Solteiro · 1 cama de solteiro',
  casal: 'Casal · 1 cama de casal',
  triplo: 'Triplo · 3 camas (configuração não informada)',
};

export interface RoomCategoryRecord {
  id: RoomCategory;
  name: string;
  bedCount: number;
  bedComposition: string;
}

export function roomCategoryGuestCounts(category: Pick<RoomCategoryRecord, 'name' | 'bedCount' | 'bedComposition'>): number[] {
  const normalize = (value: string) => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const composition = normalize(category.bedComposition);
  const bedPattern = /(\d+)?\s*(?:camas?\s*)?(?:de\s*)?(casal|queen|king|matrimonial|solteir[oa]|individual|beliche)/g;
  let capacity = 0;
  for (const match of composition.matchAll(bedPattern)) {
    const count = Number(match[1] ?? 1);
    const type = match[2];
    capacity += count * (['casal', 'queen', 'king', 'matrimonial'].includes(type) ? 2 : 1);
  }
  if (capacity === 0) {
    const name = normalize(category.name);
    if (/\bsolteir[oa]\b|\bindividual\b/.test(name)) capacity = 1;
    else if (/\bcasal\b|\bqueen\b|\bking\b|\bmatrimonial\b/.test(name)) capacity = 2;
    else if (/\btripl[oa]\b/.test(name)) capacity = 3;
    else capacity = Number.isFinite(category.bedCount) ? category.bedCount : 1;
  }
  const maxGuests = Math.min(10, Math.max(1, Math.floor(capacity)));
  return Array.from({ length: maxGuests }, (_, index) => index + 1);
}

export const DEFAULT_ROOM_CATEGORIES: RoomCategoryRecord[] = [
  { id: 'solteiro', name: 'Solteiro', bedCount: 1, bedComposition: '1 cama de solteiro' },
  { id: 'casal', name: 'Casal', bedCount: 1, bedComposition: '1 cama de casal' },
  { id: 'triplo', name: 'Triplo', bedCount: 3, bedComposition: '3 camas (configuração não informada)' },
];

export function roomCategoriesOf(data: Pick<HousekeepingData, 'categories' | 'categoriesConfigured'>): RoomCategoryRecord[] {
  const categories = data.categoriesConfigured ? Object.values(data.categories ?? {}) : DEFAULT_ROOM_CATEGORIES;
  return [...categories].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.bedComposition.localeCompare(b.bedComposition, 'pt-BR'));
}

export function roomCategoryName(room: Pick<HousekeepingRoom, 'category' | 'categoryName'>): string {
  return room.categoryName?.trim()
    || (room.category ? roomCategoryLabels[room.category]?.split(' · ')[0] ?? room.category : '');
}

export function roomCategoryDescription(room: Pick<HousekeepingRoom, 'category' | 'categoryName' | 'bedComposition' | 'bedCount'>): string {
  const name = roomCategoryName(room);
  const composition = room.bedComposition?.trim()
    || (room.bedCount ? `${room.bedCount} ${room.bedCount === 1 ? 'cama' : 'camas'}` : '')
    || (room.category ? roomCategoryLabels[room.category]?.split(' · ').slice(1).join(' · ') : '');
  return [name, composition].filter(Boolean).join(' · ') || 'Tipo e camas não informados';
}
export type DailyCleaningRequest = 'pendente' | 'solicitada' | 'dispensada';
export type ReservationStatus = 'confirmada' | 'hospedado' | 'encerrada' | 'cancelada';
export type ReservationChannel = 'oyo' | 'balcao' | 'rotativo';

import type { AuditEvent } from './audit';
import type { FinancePaymentMethod } from './finance';

export interface ReservationCollection {
  id: string;
  reservationId: string;
  date: string;
  amount: number;
  paymentMethod: FinancePaymentMethod;
  actor: string;
  createdAt: string;
}

export type ReservationExtraType = 'cafe_manha' | 'colchao_extra' | 'pessoa_adicional' | 'checkin_antecipado' | 'checkout_tardio' | 'consumo';

export interface ReservationGuest {
  name: string;
  cpf: string;
  birthDate: string;
  phone: string;
  cnpj?: string;
  email?: string;
}

export interface ReservationAddress {
  street?: string;
  number?: string;
  district?: string;
  city?: string;
  zip?: string;
}

export interface ReservationExtra {
  id: string;
  reservationId: string;
  type: ReservationExtraType;
  description: string;
  amount: number;
  date: string;
  actor: string;
  createdAt: string;
}

export interface HousekeepingAttendant {
  id: string;
  name: string;
}

export interface HousekeepingRoom {
  id: string;
  number: string;
  category?: RoomCategory;
  categoryName?: string;
  bedComposition?: string;
  bedCount?: number;
  cleaningStatus: RoomCleaningStatus;
  maintenanceStatus: RoomMaintenanceStatus;
  note: string;
}

export interface RoomDayPlan {
  cleaningRequest: DailyCleaningRequest;
}

export interface RoomCleaningLog {
  employeeId?: string;
  id: string;
  roomId: string;
  roomNumber: string;
  attendant: string;
  date: string;
  completedAt: string;
  doorsAndWindows: boolean;
  note: string;
}

export interface Reservation {
  id: string;
  guestName: string;
  channel?: ReservationChannel;
  phone: string;
  roomId: string;
  roomNumber: string;
  checkInDate: string;
  checkOutDate: string;
  checkInTime?: string;
  checkOutTime?: string;
  adults: number;
  children: number;
  reservationAmount?: number;
  tax?: number;
  balanceDue?: number;
  breakfastIncluded?: boolean;
  oyoReservationNumber?: string;
  oyoFee?: number;
  oyoFeePaidToOyo?: boolean;
  guests?: ReservationGuest[];
  address?: ReservationAddress;
  invoiceRequested?: boolean;
  invoiceNumber?: string;
  nightlyRate?: number;
  extras?: ReservationExtra[];
  status: ReservationStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationDirectoryEntry {
  id: string;
  roomId: string;
  roomNumber: string;
  guestName?: string;
  adults?: number;
  children?: number;
  breakfastIncluded?: boolean;
  checkInDate?: string;
  checkOutDate?: string;
  checkInTime?: string;
  checkOutTime?: string;
  channel?: ReservationChannel;
  status?: ReservationStatus;
}

export interface HousekeepingData {
  attendants?: Record<string, HousekeepingAttendant>;
  attendantsConfigured?: boolean;
  categories?: Record<string, RoomCategoryRecord>;
  categoriesConfigured?: boolean;
  rooms: Record<string, HousekeepingRoom>;
  dailyPlans: Record<string, Record<string, RoomDayPlan>>;
  cleaningLogs: Record<string, RoomCleaningLog>;
  reservations: Record<string, Reservation>;
  settings: {
    doorsAndWindowsIntervalDays: number;
  };
  auditLog?: Record<string, AuditEvent>;
}
