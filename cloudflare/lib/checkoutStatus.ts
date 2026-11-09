import { checkoutPending, hotelDate, type CheckoutAlert, type CheckoutState } from '../../src/services/checkoutPolicy';
import { currentOccupants } from '../../src/services/occupantDirectory';

export function checkoutStatus(state: CheckoutState, now: Date): CheckoutAlert[] {
  const date = hotelDate(now);
  const reservations = state.quartos?.reservations ?? {};
  const stays = state.recepcao?.stays ?? {};
  // Match the accounts opened from today's room grid, including balances before checkout time.
  return currentOccupants(stays, reservations, date, now.getTime()).flatMap(({ sourceType, sourceId, roomNumber }) => {
    const source = sourceType === 'stay' ? stays[sourceId] : reservations[sourceId];
    if (!roomNumber || source.checkedOutAt) return [];
    const pending = checkoutPending(state, { sourceType, sourceId });
    return pending > 0 ? [{ sourceType, sourceId, roomNumber, guestName: source.guestName, pending }] : [];
  });
}
