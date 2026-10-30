import { guestStayOccupiesToday, reservationOccupiesToday, stayCheckOutDate } from './reservationAnalytics';
import type { GuestStay } from '../types/reception';
import type { ReservationDirectoryEntry } from '../types/housekeeping';

/** One current occupant per room, chosen by arrival instead of collection order. */
export function currentOccupants(stays: Record<string, GuestStay>, reservations: Record<string, ReservationDirectoryEntry>, date: string, now: number) {
  const candidates = [
    ...Object.values(stays).filter((stay) => guestStayOccupiesToday(stay, date, now)).map((stay) => ({
      id: `stay-${stay.id}`, sourceId: stay.id, sourceType: 'stay' as const, roomNumber: stay.roomNumber.trim(), guestName: stay.guestName,
      start: stay.checkInDate, checkOutDate: stayCheckOutDate(stay),
    })),
    ...Object.values(reservations).filter((reservation) => reservationOccupiesToday(reservation, date, now)).map((reservation) => ({
      id: reservation.id, sourceId: reservation.id, sourceType: 'reservation' as const, roomNumber: reservation.roomNumber.trim(), guestName: reservation.guestName,
      start: reservation.checkInDate ?? '', checkOutDate: reservation.checkOutDate ?? '',
    })),
  ].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return [...new Map(candidates.map((candidate) => [candidate.roomNumber, candidate])).values()]
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, 'pt-BR', { numeric: true }));
}

export function stayOccupiesDate(stay: GuestStay, date: string, today: string, now: number): boolean {
  if (date === today) return guestStayOccupiesToday(stay, date, now);
  if (date > today && stay.status !== 'hospedado') return false;
  return stay.checkInDate <= date && date <= stayCheckOutDate(stay);
}

export function reservationOccupiesDate(reservation: ReservationDirectoryEntry, date: string, today: string, now: number): boolean {
  if (date === today) return reservationOccupiesToday(reservation, date, now);
  if ((date < today && reservation.status === 'confirmada') || reservation.status === 'cancelada' || (date > today && reservation.status === 'encerrada')) return false;
  return Boolean(reservation.checkInDate && reservation.checkOutDate && reservation.checkInDate <= date && date <= reservation.checkOutDate);
}
