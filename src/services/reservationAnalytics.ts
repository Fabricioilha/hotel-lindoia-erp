import type { HousekeepingData, HousekeepingRoom, Reservation } from '../types/housekeeping';

export interface ReservationDayCounts {
  reservations: number;
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

export function reservationGuestCount(reservation: Reservation): number {
  return Math.max(0, Number(reservation.adults) || 0) + Math.max(0, Number(reservation.children) || 0);
}

export function activeReservationForRoom(data: HousekeepingData, roomId: string): Reservation | undefined {
  return Object.values(data.reservations).find((reservation) =>
    reservation.roomId === roomId && reservation.status === 'hospedado',
  );
}

export function reservationOverlaps(
  data: HousekeepingData,
  reservation: Pick<Reservation, 'id' | 'roomId' | 'checkInDate' | 'checkOutDate'>,
): boolean {
  return Object.values(data.reservations).some((existing) => {
    if (existing.id === reservation.id || existing.roomId !== reservation.roomId) return false;
    if (existing.status === 'cancelada' || existing.status === 'encerrada') return false;
    return reservation.checkInDate < existing.checkOutDate
      && reservation.checkOutDate > existing.checkInDate;
  });
}

function countGuests(reservations: Reservation[]): ReservationDayCounts {
  return {
    reservations: reservations.length,
    guests: reservations.reduce((total, reservation) => total + reservationGuestCount(reservation), 0),
  };
}

export function hotelOccupancySummary(data: HousekeepingData, date = new Date()): HotelOccupancySummary {
  const reservations = Object.values(data.reservations);
  const usableRooms = Object.values(data.rooms).filter((room) => room.maintenanceStatus !== 'em_manutencao').length;
  const occupiedRoomIds = new Set(reservations
    .filter((reservation) => reservation.status === 'hospedado')
    .map((reservation) => reservation.roomId));
  const occupiedRooms = [...occupiedRoomIds].filter((roomId) =>
    data.rooms[roomId] && data.rooms[roomId].maintenanceStatus !== 'em_manutencao',
  ).length;
  const today = localDateKey(date);
  const tomorrow = dateKeyAfterDays(1, date);

  return {
    occupiedRooms,
    usableRooms,
    occupancyRate: usableRooms ? Math.round((occupiedRooms / usableRooms) * 100) : null,
    arrivalsToday: countGuests(reservations.filter((reservation) => reservation.status === 'confirmada' && reservation.checkInDate === today)),
    arrivalsTomorrow: countGuests(reservations.filter((reservation) => reservation.status === 'confirmada' && reservation.checkInDate === tomorrow)),
    departuresToday: countGuests(reservations.filter((reservation) => reservation.status === 'hospedado' && reservation.checkOutDate === today)),
    departuresTomorrow: countGuests(reservations.filter((reservation) => reservation.status === 'hospedado' && reservation.checkOutDate === tomorrow)),
  };
}

export function occupiedByReservation(data: HousekeepingData, room: HousekeepingRoom): boolean {
  return Boolean(activeReservationForRoom(data, room.id));
}