import { checkoutPending, hotelDate, type CheckoutState, type CheckoutTarget } from '../../src/services/checkoutPolicy';
import { currentOccupants } from '../../src/services/occupantDirectory';
import type { GuestStay } from '../../src/types/reception';
import type { Reservation } from '../../src/types/housekeeping';

export function checkoutStatus(state: CheckoutState, now: Date) {
  const date = hotelDate(now);
  const reservations = state.quartos?.reservations ?? {} as Record<string, Reservation>;
  const stays = state.recepcao?.stays ?? {} as Record<string, GuestStay>;
  // Resolve the same current occupant as the room board before filtering departures.
  // Old unpaid records must not appear as another guest's operational checkout alert.
  const targets: CheckoutTarget[] = currentOccupants(stays, reservations, date, now.getTime())
    .filter((occupant) => occupant.checkOutDate === date && (occupant.sourceType === 'stay'
      ? stays[occupant.sourceId].kind !== 'periodo'
      : reservations[occupant.sourceId].channel !== 'rotativo'))
    .map(({ sourceType, sourceId }) => ({ sourceType, sourceId }));
  const result = targets.map((target) => {
    const source = target.sourceType === 'stay' ? stays[target.sourceId] : reservations[target.sourceId];
    return { ...target, roomNumber: source.roomNumber, guestName: source.guestName, pending: checkoutPending(state, target) };
  });
  return result.filter((item) => item.pending > 0);
}
