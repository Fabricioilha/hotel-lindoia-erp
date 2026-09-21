// src/types/index.ts
export type UserRole = 'admin' | 'viewer' | null;

export type ShiftType = 'normal' | 'folga' | 'feriado' | 'ferias' | 'atestado' | 'falta';
export type RoomStatus = 'livre' | 'ocupado' | 'limpeza' | 'manutencao';

export interface Shift {
    id: number;
    name: string;
    type: ShiftType;
    time: string;
}

export interface ScheduleData {
    [dateKey: string]: Shift[];
}

export interface Room {
    number: string;
    status: RoomStatus;
    guestName?: string;
}