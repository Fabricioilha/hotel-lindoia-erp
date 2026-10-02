export type RoomCleaningStatus = 'sujo' | 'limpo' | 'em_limpeza';
export type RoomMaintenanceStatus = 'normal' | 'manutencao_necessaria' | 'em_manutencao';
export type RoomCategory = 'solteiro' | 'casal' | 'triplo';
export const roomCategoryLabels: Record<RoomCategory, string> = { solteiro: 'Solteiro', casal: 'Casal', triplo: 'Triplo' };
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
  cleaningStatus: RoomCleaningStatus;
  maintenanceStatus: RoomMaintenanceStatus;
  note: string;
}

export interface RoomDayPlan {
  cleaningRequest: DailyCleaningRequest;
}

export interface RoomCleaningLog {
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

export interface HousekeepingData {
  attendants?: Record<string, HousekeepingAttendant>;
  attendantsConfigured?: boolean;
  rooms: Record<string, HousekeepingRoom>;
  dailyPlans: Record<string, Record<string, RoomDayPlan>>;
  cleaningLogs: Record<string, RoomCleaningLog>;
  reservations: Record<string, Reservation>;
  settings: {
    doorsAndWindowsIntervalDays: number;
  };
  auditLog?: Record<string, AuditEvent>;
}