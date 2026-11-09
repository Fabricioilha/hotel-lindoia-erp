export const HOTEL_CHECK_IN_TIME = '14:00';
export const HOTEL_CHECKOUT_TIME = '12:00';
export const HOTEL_BREAKFAST_END_TIME = '11:00';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function hotelClock(now: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function hotelDate(now: Date) {
  return hotelClock(now).date;
}

/** Scheduled departures use hotel time, regardless of the device timezone. */
export function departureDue(checkOutDate: string, now: number): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(`${checkOutDate}T00:00:00Z`))) return false;
  const { date, time } = hotelClock(new Date(now));
  return checkOutDate < date || (checkOutDate === date && time >= HOTEL_CHECKOUT_TIME);
}
