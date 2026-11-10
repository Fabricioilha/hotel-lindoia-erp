import { reservationBalanceDue } from './reservationFinance';
import { roomChargePayments, stayAmountDue, type GuestStay, type RoomCharge, type ReceptionRoom } from '../types/reception';
import type { Reservation, ReservationCollection, ReservationExtra, HousekeepingRoom } from '../types/housekeeping';
import type { FinanceIncome } from '../types/finance';
import type { FrigobarSale } from '../types/frigobar';
import type { CleaningTask } from '../types/cleaning';
import { stayCheckOutDate } from './reservationAnalytics';
import { hotelClock, hotelDate, HOTEL_CHECKOUT_TIME } from './hotelSchedule';
import { currentOccupants } from './occupantDirectory';

export { hotelDate } from './hotelSchedule';

export interface CheckoutState {
  quartos?: { reservations?: Record<string, Reservation>; reservationIndex?: Record<string, unknown>; rooms?: Record<string, HousekeepingRoom>; reservationSlots?: Record<string, unknown> };
  recepcao?: { stays?: Record<string, GuestStay>; roomCharges?: Record<string, RoomCharge>; rooms?: Record<string, ReceptionRoom> };
  financeiro?: { incomes?: Record<string, FinanceIncome>; suppressed?: Record<string, boolean>; managerWriteLock?: { startedAt: number } };
  reservationCollectionReconciliations?: Record<string, { writeLock?: { startedAt: number } }>;
  reservationExtras?: Record<string, Record<string, ReservationExtra>>;
  reservationCollections?: Record<string, Record<string, ReservationCollection>>;
  frigobar?: { operations?: { sales?: Record<string, FrigobarSale> } };
  limpeza?: { tasks?: Record<string, CleaningTask>; activeRooms?: Record<string, unknown> };
  checkoutAudit?: Record<string, unknown>;
}
export interface CheckoutTarget { sourceType: 'stay' | 'reservation'; sourceId: string }
export interface CheckoutAlert extends CheckoutTarget {
  roomNumber: string;
  guestName: string;
  pending: number;
}

export function checkoutPending(state: CheckoutState, target: CheckoutTarget): number {
  const source = target.sourceType === 'stay' ? state.recepcao?.stays?.[target.sourceId] : state.quartos?.reservations?.[target.sourceId];
  if (!source) throw new Error('Hospedagem não encontrada.');
  let due = target.sourceType === 'reservation'
    ? reservationBalanceDue(source as Reservation, state.financeiro?.incomes ?? {}, state.reservationExtras?.[source.id], state.reservationCollections?.[source.id], state.financeiro?.suppressed)
    : stayAmountDue(source as GuestStay);
  for (const charge of Object.values(state.recepcao?.roomCharges ?? {})) {
    if (charge.sourceType === target.sourceType && charge.sourceId === source.id) due += Math.max(0, charge.amount - roomChargePayments(charge).reduce((sum, item) => sum + item.amount, 0));
  }
  for (const sale of Object.values(state.frigobar?.operations?.sales ?? {})) {
    if (sale.settlement !== 'cobrar_no_checkout') continue;
    // Legacy unlinked charges conservatively block the room until reviewed.
    if (sale.sourceId ? sale.sourceId === source.id && sale.sourceType === target.sourceType : sale.roomNumber.trim() === source.roomNumber.trim()) due += sale.amount;
  }
  return Math.round(due * 100) / 100;
}

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

export function dueCheckouts(state: CheckoutState, now: Date): CheckoutTarget[] {
  const { date, time } = hotelClock(now);
  if (time < HOTEL_CHECKOUT_TIME) return [];
  // Do not retroactively close legacy records or dirty their former rooms.
  return [
    ...Object.values(state.quartos?.reservations ?? {}).filter((r) => r.status === 'hospedado' && r.channel !== 'rotativo' && !r.checkedOutAt && r.checkOutDate === date).map((r) => ({ sourceType: 'reservation' as const, sourceId: r.id })),
    ...Object.values(state.recepcao?.stays ?? {}).filter((s) => s.status === 'hospedado' && s.kind !== 'periodo' && !s.awaitingArrival && !s.checkedOutAt && stayCheckOutDate(s) === date).map((s) => ({ sourceType: 'stay' as const, sourceId: s.id })),
  ];
}

/** Mutates only a transaction's private snapshot; all checkout effects commit together. */
export function applyCheckout(state: CheckoutState, target: CheckoutTarget, now: Date, actor: string): boolean {
  const source = target.sourceType === 'stay' ? state.recepcao?.stays?.[target.sourceId] : state.quartos?.reservations?.[target.sourceId];
  if (!source || source.status !== 'hospedado') return false;
  const lockId = target.sourceType === 'stay' ? `stay-${source.id}` : source.id;
  const locks = [state.reservationCollectionReconciliations?.[lockId]?.writeLock, state.financeiro?.managerWriteLock];
  if (locks.some((lock) => lock && now.getTime() - lock.startedAt < 300_000)) throw new Error('A hospedagem ou o financeiro está sendo atualizado. Aguarde e tente novamente.');
  const due = checkoutPending(state, target);
  if (!Number.isFinite(due) || due > 0) throw new Error('Há pendências no checkout: ' + due.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) + '. Confira a conta da hospedagem e a geladeira antes de liberar o quarto para limpeza.');
  let room = Object.values(state.quartos?.rooms ?? {}).find((r) => r.number.trim() === source.roomNumber.trim());
  if (!room) {
    const legacy = Object.values(state.recepcao?.rooms ?? {}).find((r) => r.number.trim() === source.roomNumber.trim());
    if (!legacy) throw new Error('Cadastre o quarto no controle de quartos antes de liberá-lo.');
    state.quartos ??= {};
    state.quartos.rooms ??= {};
    room = { id: legacy.id, number: legacy.number, cleaningStatus: 'sujo', maintenanceStatus: 'normal', note: '' };
    state.quartos.rooms[room.id] = room;
  }
  const timestamp = now.toISOString();
  source.status = target.sourceType === 'stay' ? 'encerrado' : 'encerrada';
  Object.assign(source, { checkedOutAt: timestamp });
  if (target.sourceType === 'reservation') {
    Object.assign(source, { updatedAt: timestamp, balanceDue: 0 });
    if (state.quartos?.reservationIndex) delete state.quartos.reservationIndex[source.id];
    const clearSlots = (value: Record<string, unknown>) => {
      for (const [key, child] of Object.entries(value)) {
        if (child === source.id) delete value[key];
        else if (child && typeof child === 'object') clearSlots(child as Record<string, unknown>);
      }
    };
    if (state.quartos?.reservationSlots?.[room.id]) clearSlots(state.quartos.reservationSlots[room.id] as Record<string, unknown>);
  }
  const anotherOccupant = [...Object.values(state.quartos?.reservations ?? {}), ...Object.values(state.recepcao?.stays ?? {})]
    .some((other) => other.id !== source.id && other.status === 'hospedado' && other.roomNumber.trim() === room!.number.trim() && other.checkInDate <= hotelDate(now));
  if (!anotherOccupant) room.cleaningStatus = 'sujo';
  for (const task of Object.values(state.limpeza?.tasks ?? {})) {
    if (!anotherOccupant && task.status === 'em_limpeza' && (task.roomId === room.id || task.roomNumber.trim() === room.number.trim())) {
      Object.assign(task, { status: 'cancelado', completedAt: timestamp, completedBy: actor });
    }
  }
  if (!anotherOccupant && state.limpeza?.activeRooms) delete state.limpeza.activeRooms[room.id];
  state.checkoutAudit ??= {};
  state.checkoutAudit[`${target.sourceType}-${source.id}`] = { ...target, actor, at: timestamp, roomNumber: room.number };
  return true;
}
