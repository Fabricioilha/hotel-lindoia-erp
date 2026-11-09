import type { ReservationDirectoryEntry } from '../types/housekeeping';
import { stayBreakfastDays, type GuestStay, type RoomCharge } from '../types/reception';
import { reservationGuestCount, stayCheckOutDate } from './reservationAnalytics';
import { hotelClock, HOTEL_BREAKFAST_END_TIME } from './hotelSchedule';

export function breakfastForecastDay(now: Date) {
  const { date, time } = hotelClock(now);
  if (time < HOTEL_BREAKFAST_END_TIME) return { date, isTomorrow: false };
  const tomorrow = new Date(`${date}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return { date: tomorrow.toISOString().slice(0, 10), isTomorrow: true };
}

export function breakfastsOnDate(
  date: string,
  stays: Record<string, GuestStay>,
  reservations: Record<string, ReservationDirectoryEntry>,
  charges: Record<string, RoomCharge>,
): number {
  const rooms = new Map<string, { start: string; source: string; included: number }>();
  const add = (roomNumber: string, start: string, end: string, source: string, included: number) => {
    const room = roomNumber.trim();
    // O café pertence à noite anterior, inclusive na manhã da saída.
    if (!room || start >= date || date > end) return;
    const current = rooms.get(room);
    if (!current || current.start <= start) rooms.set(room, { start, source, included });
  };

  for (const reservation of Object.values(reservations)) {
    if ((reservation.status !== 'confirmada' && reservation.status !== 'hospedado')
      || reservation.channel === 'rotativo' || !reservation.checkInDate || !reservation.checkOutDate) continue;
    add(reservation.roomNumber, reservation.checkInDate, reservation.checkOutDate, 'reservation:' + reservation.id,
      reservation.breakfastIncluded ? Math.max(1, reservationGuestCount(reservation)) : 0);
  }
  for (const stay of Object.values(stays)) {
    if (stay.kind !== 'hospede' || stay.status !== 'hospedado') continue;
    const daysSinceArrival = (Date.parse(date) - Date.parse(stay.checkInDate)) / 86_400_000;
    add(stay.roomNumber, stay.checkInDate, stayCheckOutDate(stay), 'stay:' + stay.id,
      daysSinceArrival > 0 && daysSinceArrival <= stayBreakfastDays(stay) ? Math.max(1, Math.floor(stay.breakfastCount ?? 1)) : 0);
  }

  const eligibleSources = new Set([...rooms.values()].map((room) => room.source));
  const extras = Object.values(charges).filter((charge) => charge.kind === 'cafe_avulso'
    && eligibleSources.has(charge.sourceType + ':' + charge.sourceId)
    && (charge.validFrom ?? charge.date) <= date && date <= (charge.validThrough ?? charge.date));
  return [...rooms.values()].reduce((total, room) => total + room.included, extras.length);
}
