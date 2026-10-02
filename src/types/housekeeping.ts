export type RoomCleaningStatus = 'sujo' | 'limpo' | 'em_limpeza';
export type RoomMaintenanceStatus = 'normal' | 'manutencao_necessaria' | 'em_manutencao';
export type DailyCleaningRequest = 'pendente' | 'solicitada' | 'dispensada';
export type ReservationStatus = 'confirmada' | 'hospedado' | 'encerrada' | 'cancelada';

export interface HousekeepingRoom {
  id: string;
  number: string;
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
  phone: string;
  roomId: string;
  roomNumber: string;
  checkInDate: string;
  checkOutDate: string;
  adults: number;
  children: number;
  status: ReservationStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface HousekeepingData {
  rooms: Record<string, HousekeepingRoom>;
  dailyPlans: Record<string, Record<string, RoomDayPlan>>;
  cleaningLogs: Record<string, RoomCleaningLog>;
  reservations: Record<string, Reservation>;
  settings: {
    doorsAndWindowsIntervalDays: number;
  };
}