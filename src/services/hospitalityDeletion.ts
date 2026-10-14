import { get, increment, ref } from 'firebase/database';
import { db } from '../config/firebase';
import type { FinanceIncome } from '../types/finance';
import type { HousekeepingData, HousekeepingRoom, Reservation, ReservationCollection, ReservationExtra } from '../types/housekeeping';
import type { GuestStay, ReceptionRoom, RoomCharge } from '../types/reception';
import type { CleaningTask } from '../types/cleaning';
import { commitDeletion, removeChargeUpdates, removeFinanceEntries } from './deletionStore';
import { stayFinanceEntryIds, stayOyoFeeExpense } from './operationalLedger';

// Removes only slots owned by these reservations, including historical reservations
// whose dates may now be occupied by a different guest.
function ownedSlots(value: unknown, path: string, ids: Set<string>, updates: Record<string, unknown>) {
  if (typeof value === 'string') { if (ids.has(value)) updates[path] = null; return; }
  if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => ownedSlots(child, `${path}/${key}`, ids, updates));
}

async function removeHospitality(target: { reservationId: string } | { room: HousekeepingRoom }): Promise<void> {
  const paths = ['erp_geral/quartos', 'erp_geral/financeiro/incomes', 'erp_geral/recepcao/roomCharges', 'erp_geral/reservationCollections', 'erp_geral/reservationExtras', 'erp_geral/recepcao/stays', 'erp_geral/recepcao/rooms', 'erp_geral/limpeza/tasks'];
  const snapshots = await Promise.all(paths.map((path) => get(ref(db, path))));
  const housekeeping = (snapshots[0].val() ?? {}) as HousekeepingData & { reservationSlots?: Record<string, unknown> };
  const room = 'room' in target ? target.room : null;
  const reservationId = 'reservationId' in target ? target.reservationId : '';
  const reservations = Object.values(housekeeping.reservations ?? {}).filter((item) => room ? item.roomId === room.id : item.id === reservationId);
  if (!room && !reservations.length) return;
  const ids = new Set(reservations.map((item) => item.id));
  const incomes = Object.values(snapshots[1].val() ?? {}) as FinanceIncome[];
  const stays = (Object.values(snapshots[5].val() ?? {}) as GuestStay[]).filter((item) => room && item.roomNumber === room.number);
  const stayIds = new Set(stays.map((item) => item.id));
  const charges = (Object.values(snapshots[2].val() ?? {}) as RoomCharge[]).filter((item) => (room && item.roomNumber === room.number) || (item.sourceType === 'reservation' && ids.has(item.sourceId)) || (item.sourceType === 'stay' && stayIds.has(item.sourceId)));
  const collections = (snapshots[3].val() ?? {}) as Record<string, Record<string, ReservationCollection>>;
  const extras = (snapshots[4].val() ?? {}) as Record<string, Record<string, ReservationExtra>>;
  const updates: Record<string, unknown> = {};
  const stock: Record<string, number> = {};
  const locks: string[] = [];
  reservations.forEach((reservation) => {
    locks.push(`reservation-${reservation.id}`);
    updates[`erp_geral/quartos/reservations/${reservation.id}`] = null;
    updates[`erp_geral/quartos/reservationIndex/${reservation.id}`] = null;
    Object.keys(collections[reservation.id] ?? {}).forEach((id) => {
      updates[`erp_geral/reservationCollections/${reservation.id}/${id}`] = null;
      removeFinanceEntries(updates, [`reservation-${reservation.id}-checkout-${id}`]);
    });
    Object.keys(extras[reservation.id] ?? {}).forEach((id) => { updates[`erp_geral/reservationExtras/${reservation.id}/${id}`] = null; });
    removeFinanceEntries(updates, incomes.filter((entry) => entry.id.startsWith(`reservation-${reservation.id}-`)).map((entry) => entry.id));
  });
  ownedSlots(housekeeping.reservationSlots, 'erp_geral/quartos/reservationSlots', ids, updates);
  stays.forEach((stay) => {
    locks.push(`stay-${stay.id}`);
    updates[`erp_geral/recepcao/stays/${stay.id}`] = null;
    removeFinanceEntries(updates, stayFinanceEntryIds({ ...stay, voidedPayments: undefined }));
    const oyoFee = stayOyoFeeExpense(stay);
    if (oyoFee) removeFinanceEntries(updates, [oyoFee.id], 'expenses');
  });
  charges.forEach((charge) => {
    locks.push(`charge-${charge.id}`); removeChargeUpdates(updates, charge);
    if (charge.kind === 'bebida' && charge.productId) stock[charge.productId] = (stock[charge.productId] ?? 0) + (charge.quantity ?? 0);
  });
  Object.entries(stock).forEach(([id, quantity]) => { updates[`erp_geral/frigobar/operations/stock/${id}`] = increment(quantity); });
  if (room) {
    locks.push(`room-${room.id}`);
    updates[`erp_geral/quartos/rooms/${room.id}`] = null;
    updates[`erp_geral/limpeza/activeRooms/${room.id}`] = null;
    (Object.values(snapshots[6].val() ?? {}) as ReceptionRoom[]).filter((item) => item.number === room.number).forEach((item) => { updates[`erp_geral/recepcao/rooms/${item.id}`] = null; });
    (Object.values(snapshots[7].val() ?? {}) as CleaningTask[]).filter((item) => item.roomId === room.id || item.roomNumber === room.number).forEach((item) => { updates[`erp_geral/limpeza/tasks/${item.id}`] = null; });
    Object.values(housekeeping.cleaningLogs ?? {}).filter((item) => item.roomId === room.id).forEach((item) => { updates[`erp_geral/quartos/cleaningLogs/${item.id}`] = null; });
    Object.entries(housekeeping.dailyPlans ?? {}).forEach(([date, plans]) => { if (plans[room.id]) updates[`erp_geral/quartos/dailyPlans/${date}/${room.id}`] = null; });
  }
  await commitDeletion([...new Set(locks)], updates);
}

export function deleteReservation(reservation: Reservation): Promise<void> { return removeHospitality({ reservationId: reservation.id }); }
export function deleteHotelRoom(room: HousekeepingRoom): Promise<void> { return removeHospitality({ room }); }
