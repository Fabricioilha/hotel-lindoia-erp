import { incomeItems, incomePaymentWallet, type FinanceIncome } from '../types/finance';
import type { Reservation, ReservationCollection, ReservationExtra } from '../types/housekeeping';

const cents = (amount: number) => Math.round(amount * 100) / 100;

export function reservationFinancialTotal(reservation: Reservation, extraRecords: Record<string, ReservationExtra> = {}): number {
  const nights = Math.max(0, Math.round((Date.parse(`${reservation.checkOutDate}T00:00:00Z`) - Date.parse(`${reservation.checkInDate}T00:00:00Z`)) / 86_400_000));
  const extras = new Map((reservation.extras ?? []).map((extra) => [extra.id, extra]));
  Object.values(extraRecords).filter((extra) => extra.reservationId === reservation.id).forEach((extra) => extras.set(extra.id, extra));
  return cents((reservation.reservationAmount ?? nights * (reservation.nightlyRate ?? 0))
    + (reservation.tax ?? 0) + [...extras.values()].reduce((total, extra) => total + extra.amount, 0));
}

export function reservationBalanceDue(
  reservation: Reservation,
  incomes: Record<string, FinanceIncome>,
  extraRecords: Record<string, ReservationExtra> = {},
  collections: Record<string, ReservationCollection> = {},
  suppressed: Record<string, boolean> = {},
): number {
  const prefix = `reservation-${reservation.id}-`;
  const paid = Object.values(incomes).filter((entry) => entry.id.startsWith(prefix) && !suppressed[entry.id])
    .reduce((total, entry) => total + entry.amount, 0);
  const pending = Object.values(collections).filter((collection) => collection.reservationId === reservation.id
    && !incomes[`${prefix}checkout-${collection.id}`] && !suppressed[`${prefix}checkout-${collection.id}`])
    .reduce((total, collection) => total + collection.amount, 0);
  return cents(Math.max(0, reservationFinancialTotal(reservation, extraRecords) - paid - pending));
}

export function reservationIncomeContext(
  entry: FinanceIncome,
  previous: Pick<Reservation, 'roomNumber' | 'guestName'>,
  next: Pick<Reservation, 'roomNumber' | 'guestName' | 'channel'>,
): FinanceIncome {
  const replaceContext = (text: string) => {
    const withRoom = text.replace(new RegExp(`(quarto\\s+)${escapeRegExp(previous.roomNumber)}(?=\\s|$|[·,;])`, 'gi'), (_match, label: string) => `${label}${next.roomNumber}`);
    return previous.guestName && previous.guestName !== next.guestName
      ? withRoom.split(previous.guestName).join(next.guestName) : withRoom;
  };
  const items = incomeItems(entry).map((item) => ({ ...item, description: replaceContext(item.description) }));
  const category = items.some((item) => /^Hospedagem\b/i.test(item.description)) && ['Diária', 'Rotativo'].includes(entry.category)
    ? next.channel === 'rotativo' ? 'Rotativo' : 'Diária' : entry.category;
  return { ...entry, category, items, note: replaceContext(entry.note) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateReservationPayments(reservationId: string, entries: FinanceIncome[]): void {
  const ids = new Set<string>();
  entries.forEach((entry) => {
    const items = incomeItems(entry);
    const parsedDate = Date.parse(`${entry.date}T00:00:00Z`);
    if (!entry.id.startsWith(`reservation-${reservationId}-`) || ids.has(entry.id)
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== entry.date
      || !Number.isFinite(entry.amount) || entry.amount <= 0
      || items.length === 0 || items.some((item) => !incomePaymentWallet(item.paymentMethod) || !Number.isFinite(item.amount) || item.amount <= 0)
      || new Set(items.map((item) => item.id)).size !== items.length
      || cents(items.reduce((total, item) => total + item.amount, 0)) !== cents(entry.amount)) {
      throw new Error('Confira os valores, as datas e as formas de pagamento da reserva.');
    }
    ids.add(entry.id);
  });
}
