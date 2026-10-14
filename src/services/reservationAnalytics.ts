import type { HousekeepingData, HousekeepingRoom, Reservation, ReservationDirectoryEntry } from '../types/housekeeping';
import type { GuestStay, ReceptionRoom } from '../types/reception';

export interface ReservationDayCounts {
  reservations: number;
  rooms: number;
  guests: number;
}

export interface HotelOccupancySummary {
  occupiedRooms: number;
  usableRooms: number;
  occupancyRate: number | null;
  arrivalsToday: ReservationDayCounts;
  arrivalsTomorrow: ReservationDayCounts;
  departuresToday: ReservationDayCounts;
  departuresTomorrow: ReservationDayCounts;
}

export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dateKeyAfterDays(days: number, date = new Date()): string {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return localDateKey(target);
}

export function stayCheckOutDate(stay: GuestStay): string {
  if (stay.kind === 'periodo') {
    const end = rotativoStart(stay) + (stay.hours ?? 4) * 3_600_000;
    return Number.isFinite(end) ? localDateKey(new Date(end)) : '';
  }
  if (stay.checkOutDate) return stay.checkOutDate;
  const date = new Date(`${stay.checkInDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(stay.nights)) return '';
  date.setUTCDate(date.getUTCDate() + stay.nights);
  return date.toISOString().slice(0, 10);
}

function rotativoStart(stay: GuestStay): number {
  const createdAt = Date.parse(stay.createdAt);
  return Number.isFinite(createdAt) ? createdAt : Date.parse(`${stay.checkInDate}T12:00:00`);
}

export function guestStayOccupiesToday(stay: GuestStay, today: string, now: number): boolean {
  if (stay.status !== 'hospedado') return false;
  if (stay.kind === 'periodo') {
    if (stay.checkInDate > today) return false;
    const start = rotativoStart(stay);
    return Number.isFinite(start) && now >= start && now < start + (stay.hours ?? 4) * 3_600_000;
  }
  return stay.checkInDate <= today && today <= stayCheckOutDate(stay);
}

export function reservationOccupiesToday(reservation: ReservationDirectoryEntry, today: string, now: number): boolean {
  if (reservation.status !== 'hospedado' || !reservation.checkInDate || !reservation.checkOutDate) return false;
  if (reservation.channel === 'rotativo' && reservation.checkInTime && reservation.checkOutTime) {
    const start = Date.parse(`${reservation.checkInDate}T${reservation.checkInTime}:00`);
    const end = Date.parse(`${reservation.checkOutDate}T${reservation.checkOutTime}:00`);
    return Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
  }
  return reservation.checkInDate <= today && today <= reservation.checkOutDate;
}

export function reservationGuestCount(reservation: Pick<Reservation, 'adults' | 'children'> | Pick<ReservationDirectoryEntry, 'adults' | 'children'>): number {
  return Math.max(0, Number(reservation.adults) || 0) + Math.max(0, Number(reservation.children) || 0);
}

export function activeReservationForRoom(data: HousekeepingData, roomId: string): Reservation | undefined {
  return Object.values(data.reservations).find((reservation) =>
    reservation.roomId === roomId && reservation.status === 'hospedado',
  );
}

export function reservationOverlaps(
  data: HousekeepingData,
  reservation: Pick<Reservation, 'id' | 'roomId' | 'checkInDate' | 'checkOutDate' | 'channel' | 'checkInTime' | 'checkOutTime'>,
): boolean {
  const startOf = (value: Pick<Reservation, 'checkInDate' | 'checkInTime' | 'channel'>) => Date.parse(`${value.checkInDate}T${value.channel === 'rotativo' && value.checkInTime ? value.checkInTime : '00:00'}:00`);
  const endOf = (value: Pick<Reservation, 'checkOutDate' | 'checkOutTime' | 'channel'>) => Date.parse(`${value.checkOutDate}T${value.channel === 'rotativo' && value.checkOutTime ? value.checkOutTime : '00:00'}:00`);
  const start = startOf(reservation);
  const end = endOf(reservation);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return true;
  return Object.values(data.reservations).some((existing) => {
    if (existing.id === reservation.id || existing.roomId !== reservation.roomId) return false;
    if (existing.status === 'cancelada' || existing.status === 'encerrada') return false;
    return start < endOf(existing) && end > startOf(existing);
  });
}

export function reservationOverlapsStay(
  reservation: Pick<Reservation, 'roomNumber' | 'checkInDate' | 'checkOutDate' | 'channel' | 'checkInTime' | 'checkOutTime'>,
  stay: GuestStay,
): boolean {
  if (stay.status !== 'hospedado' || stay.roomNumber.trim() !== reservation.roomNumber.trim()) return false;
  const start = Date.parse(`${reservation.checkInDate}T${reservation.channel === 'rotativo' ? reservation.checkInTime : '00:00'}:00`);
  const end = Date.parse(`${reservation.checkOutDate}T${reservation.channel === 'rotativo' ? reservation.checkOutTime : '00:00'}:00`);
  const stayStart = stay.kind === 'periodo' ? rotativoStart(stay) : Date.parse(`${stay.checkInDate}T00:00:00`);
  const stayEnd = stay.kind === 'periodo' ? stayStart + (stay.hours ?? 4) * 3_600_000 : Date.parse(`${stayCheckOutDate(stay)}T00:00:00`);
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(stayStart) && Number.isFinite(stayEnd)
    && start < stayEnd && end > stayStart;
}

function countGuests(entries: { roomNumber: string; guests: number }[]): ReservationDayCounts {
  return {
    reservations: entries.length,
    rooms: new Set(entries.map((entry) => entry.roomNumber.trim())).size,
    guests: entries.reduce((total, entry) => total + entry.guests, 0),
  };
}

export interface ReceptionOccupancyData {
  stays: Record<string, GuestStay>;
  rooms: Record<string, ReceptionRoom>;
}

export type ReservationOccupancyData = Pick<HousekeepingData, 'rooms'> & {
  reservations: Record<string, ReservationDirectoryEntry | Reservation>;
};

export function occupiedRoomNumbers(data: ReservationOccupancyData, stays: Record<string, GuestStay>, date = new Date()): Set<string> {
  const today = localDateKey(date);
  return new Set([
    ...Object.values(data.reservations).filter((reservation) => reservationOccupiesToday(reservation, today, date.getTime())).map((reservation) => reservation.roomNumber.trim()),
    ...Object.values(stays).filter((stay) => guestStayOccupiesToday(stay, today, date.getTime())).map((stay) => stay.roomNumber.trim()),
  ]);
}

export function hotelOccupancySummary(data: ReservationOccupancyData, date = new Date(), reception: ReceptionOccupancyData = { stays: {}, rooms: {} }): HotelOccupancySummary {
  const reservations = Object.values(data.reservations);
  const stays = Object.values(reception.stays);
  const allRoomNumbers = new Set([...Object.values(data.rooms), ...Object.values(reception.rooms)].map((room) => room.number.trim()));
  const maintenanceRooms = new Set(Object.values(data.rooms).filter((room) => room.maintenanceStatus === 'em_manutencao').map((room) => room.number.trim()));
  const usableRoomNumbers = new Set([...allRoomNumbers].filter((number) => number && !maintenanceRooms.has(number)));
  const usableRooms = usableRoomNumbers.size;
  const occupiedRooms = [...occupiedRoomNumbers(data, reception.stays, date)].filter((number) => usableRoomNumbers.has(number)).length;
  const today = localDateKey(date);
  const tomorrow = dateKeyAfterDays(1, date);
  const convertedStayIds = new Set(stays.map((stay) => stay.convertedFromStayId).filter(Boolean));
  const arrivals = (day: string) => countGuests([
    ...reservations.filter((reservation) => reservation.status !== 'cancelada' && reservation.checkInDate === day)
      .map((reservation) => ({ roomNumber: reservation.roomNumber, guests: reservationGuestCount(reservation) })),
    ...stays.filter((stay) => stay.checkInDate === day)
      .map((stay) => ({ roomNumber: stay.roomNumber, guests: Math.max(1, stay.guestCount ?? (stay.hasAdditionalGuests ? 2 : 1)) })),
  ]);
  const departures = (day: string) => countGuests([
    ...reservations.filter((reservation) => reservation.status !== 'cancelada' && reservation.checkOutDate === day)
      .map((reservation) => ({ roomNumber: reservation.roomNumber, guests: reservationGuestCount(reservation) })),
    ...stays.filter((stay) => !convertedStayIds.has(stay.id) && stayCheckOutDate(stay) === day)
      .map((stay) => ({ roomNumber: stay.roomNumber, guests: Math.max(1, stay.guestCount ?? (stay.hasAdditionalGuests ? 2 : 1)) })),
  ]);

  return {
    occupiedRooms,
    usableRooms,
    occupancyRate: usableRooms ? Math.round((occupiedRooms / usableRooms) * 100) : null,
    arrivalsToday: arrivals(today),
    arrivalsTomorrow: arrivals(tomorrow),
    departuresToday: departures(today),
    departuresTomorrow: departures(tomorrow),
  };
}

export function occupiedByReservation(data: HousekeepingData, room: HousekeepingRoom): boolean {
  return Boolean(activeReservationForRoom(data, room.id));
}
