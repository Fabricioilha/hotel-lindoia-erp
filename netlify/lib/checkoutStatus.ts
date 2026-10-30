import type { Database } from 'firebase-admin/database';
import { checkoutPending, hotelDate, type CheckoutState, type CheckoutTarget } from '../../src/services/checkoutPolicy';
import { currentOccupants } from '../../src/services/occupantDirectory';
import type { GuestStay, RoomCharge } from '../../src/types/reception';
import type { Reservation } from '../../src/types/housekeeping';

export async function checkoutStatus(db: Database, now: Date) {
  const [reservationsSnapshot, staysSnapshot, salesSnapshot] = await Promise.all([
    db.ref('erp_geral/quartos/reservations').orderByChild('status').equalTo('hospedado').get(),
    db.ref('erp_geral/recepcao/stays').orderByChild('status').equalTo('hospedado').get(),
    db.ref('erp_geral/frigobar/operations/sales').orderByChild('settlement').equalTo('cobrar_no_checkout').get(),
  ]);
  const date = hotelDate(now);
  const reservations = (reservationsSnapshot.val() ?? {}) as Record<string, Reservation>;
  const stays = (staysSnapshot.val() ?? {}) as Record<string, GuestStay>;
  // Resolve the same current occupant as the room board before filtering departures.
  // Old unpaid records must not appear as another guest's operational checkout alert.
  const targets: CheckoutTarget[] = currentOccupants(stays, reservations, date, now.getTime())
    .filter((occupant) => occupant.checkOutDate === date && (occupant.sourceType === 'stay'
      ? stays[occupant.sourceId].kind !== 'periodo'
      : reservations[occupant.sourceId].channel !== 'rotativo'))
    .map(({ sourceType, sourceId }) => ({ sourceType, sourceId }));
  const result = await Promise.all(targets.map(async (target) => {
    const source = target.sourceType === 'stay' ? stays[target.sourceId] : reservations[target.sourceId];
    const state: CheckoutState = { quartos: { reservations }, recepcao: { stays }, frigobar: { operations: { sales: salesSnapshot.val() ?? {} } } };
    const charges = await db.ref('erp_geral/recepcao/roomCharges').orderByChild('sourceId').equalTo(source.id).get();
    state.recepcao!.roomCharges = charges.val() as Record<string, RoomCharge> ?? {};
    if (target.sourceType === 'reservation') {
      const prefix = `reservation-${source.id}-`;
      const [incomes, suppressed, extras, collections] = await Promise.all([
        db.ref('erp_geral/financeiro/incomes').orderByKey().startAt(prefix).endAt(prefix + '\uf8ff').get(),
        db.ref('erp_geral/financeiro/suppressed').orderByKey().startAt(prefix).endAt(prefix + '\uf8ff').get(),
        db.ref(`erp_geral/reservationExtras/${source.id}`).get(), db.ref(`erp_geral/reservationCollections/${source.id}`).get(),
      ]);
      state.financeiro = { incomes: incomes.val() ?? {}, suppressed: suppressed.val() ?? {} };
      state.reservationExtras = { [source.id]: extras.val() ?? {} };
      state.reservationCollections = { [source.id]: collections.val() ?? {} };
    }
    return { ...target, roomNumber: source.roomNumber, guestName: source.guestName, pending: checkoutPending(state, target) };
  }));
  return result.filter((item) => item.pending > 0);
}
