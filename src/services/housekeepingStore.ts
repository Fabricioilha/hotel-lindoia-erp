import { get, onValue, ref, runTransaction, set, update } from 'firebase/database';
import { db } from '../config/firebase';
import { buildAuditEvents } from '../types/audit';
import { recordOperationalIncome } from './operationalIncome';
import type { FinancePaymentMethod } from '../types/finance';
import type { HousekeepingData, Reservation, ReservationCollection, ReservationExtra, ReservationStatus } from '../types/housekeeping';
import { reservationOverlaps } from './reservationAnalytics';

const USE_LOCAL_STORAGE = false;
const STORAGE_KEY = 'hotel-lindoia:housekeeping:v1';
const LOCAL_UPDATE_EVENT = 'hotel-lindoia:housekeeping-updated';

export function emptyHousekeeping(): HousekeepingData {
  return {
    rooms: {},
    dailyPlans: {},
    cleaningLogs: {},
    reservations: {},
    settings: { doorsAndWindowsIntervalDays: 5 },
    auditLog: {},
  };
}

function normalizeHousekeeping(value: unknown): HousekeepingData {
  const data = value && typeof value === 'object' ? value as Partial<HousekeepingData> : {};
  return {
    rooms: data.rooms ?? {},
    dailyPlans: data.dailyPlans ?? {},
    cleaningLogs: data.cleaningLogs ?? {},
    reservations: data.reservations ?? {},
    attendants: data.attendants ?? {},
    attendantsConfigured: Boolean(data.attendantsConfigured),
    settings: {
      doorsAndWindowsIntervalDays: Math.max(1, Number(data.settings?.doorsAndWindowsIntervalDays) || 5),
    },
    auditLog: data.auditLog ?? {},
  };
}

function reservationsForAudit(reservations: Record<string, Reservation>) {
  return Object.fromEntries(Object.entries(reservations).map(([id, reservation]) => {
    const auditRecord = { ...reservation } as Reservation & { payments?: unknown };
    delete auditRecord.payments;
    return [id, auditRecord];
  }));
}

function reservationFinancialTotal(reservation: Reservation): number {
  const nights = Math.max(0, Math.round((Date.parse(`${reservation.checkOutDate}T00:00:00Z`) - Date.parse(`${reservation.checkInDate}T00:00:00Z`)) / 86_400_000));
  const extras = (reservation.extras ?? []).reduce((total, extra) => total + extra.amount, 0);
  return (reservation.reservationAmount ?? nights * (reservation.nightlyRate ?? 0)) + (reservation.tax ?? 0) + extras;
}

function isQuarterHour(time: string | undefined): boolean {
  if (!time || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) return false;
  return Number(time.slice(3)) % 15 === 0;
}

function readLocalHousekeeping(): HousekeepingData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeHousekeeping(JSON.parse(saved)) : emptyHousekeeping();
  } catch {
    return emptyHousekeeping();
  }
}

export const housekeepingStorageMode = USE_LOCAL_STORAGE ? 'neste navegador' : 'Firebase';

export function subscribeHousekeeping(
  onChange: (data: HousekeepingData) => void,
  onError: (error: Error) => void,
): () => void {
  if (USE_LOCAL_STORAGE) {
    const refresh = () => onChange(readLocalHousekeeping());
    refresh();
    window.addEventListener('storage', refresh);
    window.addEventListener(LOCAL_UPDATE_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(LOCAL_UPDATE_EVENT, refresh);
    };
  }

  return onValue(
    ref(db, 'erp_geral/quartos'),
    (snapshot) => onChange(normalizeHousekeeping(snapshot.val())),
    onError,
  );
}

export async function updateHousekeeping(
  update: (current: HousekeepingData) => HousekeepingData,
): Promise<void> {
  const operationId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  if (USE_LOCAL_STORAGE) {
    const current = readLocalHousekeeping();
    const next = update(current);
    const auditLog = buildAuditEvents(operationId, occurredAt, [
      { entity: 'room', before: current.rooms, after: next.rooms },
      { entity: 'reservation', before: reservationsForAudit(current.reservations), after: reservationsForAudit(next.reservations) },
      { entity: 'room-plan', before: current.dailyPlans, after: next.dailyPlans },
      { entity: 'cleaning-log', before: current.cleaningLogs, after: next.cleaningLogs },
      { entity: 'housekeeping-settings', before: { hotel: current.settings }, after: { hotel: next.settings } },
    ]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, auditLog: { ...next.auditLog, ...auditLog } }));
    window.dispatchEvent(new Event(LOCAL_UPDATE_EVENT));
    return;
  }

  const result = await runTransaction(ref(db, 'erp_geral/quartos'), (value) => {
    const current = normalizeHousekeeping(value);
    const next = update(current);
    const auditLog = buildAuditEvents(operationId, occurredAt, [
      { entity: 'room', before: current.rooms, after: next.rooms },
      { entity: 'reservation', before: reservationsForAudit(current.reservations), after: reservationsForAudit(next.reservations) },
      { entity: 'room-plan', before: current.dailyPlans, after: next.dailyPlans },
      { entity: 'cleaning-log', before: current.cleaningLogs, after: next.cleaningLogs },
      { entity: 'housekeeping-settings', before: { hotel: current.settings }, after: { hotel: next.settings } },
    ]);
    return { ...next, auditLog: { ...next.auditLog, ...auditLog } };
  });
  if (!result.committed) throw new Error('A gravação do serviço de quarto não foi confirmada.');
}

export async function createReservation(reservation: Reservation, current: HousekeepingData): Promise<void> {
  const room = current.rooms[reservation.roomId];
  if (!room) throw new Error('O quarto selecionado não existe.');
  if (room.maintenanceStatus === 'em_manutencao') throw new Error('Este quarto está indisponível para manutenção.');
  const start = Date.parse(`${reservation.checkInDate}T${reservation.checkInTime ?? '00:00'}:00`);
  const end = Date.parse(`${reservation.checkOutDate}T${reservation.checkOutTime ?? '00:00'}:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('O horário de checkout deve ser posterior ao check-in.');
  if (reservation.channel === 'rotativo' && !isQuarterHour(reservation.checkInTime)) throw new Error('O horário do Rotativo deve iniciar em intervalos de 15 minutos.');
  if (reservation.channel === 'rotativo' && end - start !== 4 * 60 * 60 * 1000) throw new Error('Reservas Rotativo devem ter exatamente quatro horas.');
  const nights = Math.round((Date.parse(`${reservation.checkOutDate}T00:00:00Z`) - Date.parse(`${reservation.checkInDate}T00:00:00Z`)) / 86_400_000);
  if (reservation.channel !== 'rotativo' && (nights < 1 || nights > 365)) throw new Error('A hospedagem deve ter entre 1 e 365 noites.');
  if (reservationOverlaps(current, reservation)) throw new Error(`O quarto ${reservation.roomNumber} já está reservado neste horário.`);
  if (USE_LOCAL_STORAGE) {
    await updateHousekeeping((latest) => {
      if (reservationOverlaps(latest, reservation)) throw new Error('Este quarto já foi reservado para as datas escolhidas.');
      return { ...latest, reservations: { ...latest.reservations, [reservation.id]: reservation } };
    });
    return;
  }

  const roomSlotsSnapshot = await get(ref(db, `erp_geral/quartos/reservationSlots/${reservation.roomId}`));
  const roomSlots = roomSlotsSnapshot.val() as Record<string, unknown> | null ?? {};
  const slotPaths = reservationSlotPaths(reservation);
  const conflictingSlot = slotPaths.some((slotPath) => {
    const parts = slotPath.split('/');
    if (parts[0] === 'rotativo') {
      const rotativoSlots = roomSlots.rotativo as Record<string, Record<string, unknown>> | undefined;
      return Boolean(roomSlots[parts[1]]) || Boolean(rotativoSlots?.[parts[1]]?.[parts[2]]);
    }
    return Boolean(roomSlots[slotPath]) || Object.keys(((roomSlots.rotativo as Record<string, Record<string, unknown>> | undefined)?.[slotPath]) ?? {}).length > 0;
  });
  if (conflictingSlot) throw new Error(`O quarto ${reservation.roomNumber} já está reservado neste horário.`);

  const operationId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const auditEvents = buildAuditEvents(operationId, occurredAt, [
    { entity: 'reservation', before: {}, after: { [reservation.id]: reservationsForAudit({ [reservation.id]: reservation })[reservation.id] } },
  ]);
  const updates: Record<string, unknown> = {
    [`erp_geral/quartos/reservations/${reservation.id}`]: reservation,
    ...Object.fromEntries(Object.entries(auditEvents).map(([id, event]) => [`erp_geral/quartos/auditLog/${id}`, event])),
  };
  slotPaths.forEach((slotPath) => { updates[`erp_geral/quartos/reservationSlots/${reservation.roomId}/${slotPath}`] = reservation.id; });

  try {
    await update(ref(db), updates);
  } catch {
    throw new Error('O período acabou de ser reservado ou não foi salvo. Atualize a lista e tente novamente.');
  }
}

function reservationSlotPaths(reservation: Reservation): string[] {
  if (reservation.channel === 'rotativo') {
    const start = Date.parse(`${reservation.checkInDate}T${reservation.checkInTime}:00`);
    const end = Date.parse(`${reservation.checkOutDate}T${reservation.checkOutTime}:00`);
    const paths: string[] = [];
    for (let timestamp = start; timestamp < end; timestamp += 15 * 60 * 1000) {
      const date = new Date(timestamp);
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const timeKey = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
      paths.push(`rotativo/${dateKey}/${timeKey}`);
    }
    return paths;
  }

  const firstDate = Date.parse(`${reservation.checkInDate}T00:00:00Z`);
  const nights = Math.round((Date.parse(`${reservation.checkOutDate}T00:00:00Z`) - firstDate) / 86_400_000);
  return Array.from({ length: nights }, (_, offset) => new Date(firstDate + offset * 86_400_000).toISOString().slice(0, 10));
}

export function subscribeReservationCollections(
  onChange: (collections: Record<string, ReservationCollection>) => void,
  onError: (error: Error) => void,
): () => void {
  const storageKey = 'hotel-lindoia:reservation-collections:v1';
  if (USE_LOCAL_STORAGE) {
    const refresh = () => {
      try {
        onChange(JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, ReservationCollection>);
      } catch {
        onChange({});
      }
    };
    refresh();
    window.addEventListener('storage', refresh);
    window.addEventListener('hotel-lindoia:reservation-collections-updated', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('hotel-lindoia:reservation-collections-updated', refresh);
    };
  }

  return onValue(ref(db, 'erp_geral/reservationCollections'), (snapshot) => {
    const byReservation = snapshot.val() as Record<string, Record<string, ReservationCollection>> | null;
    onChange(Object.values(byReservation ?? {}).reduce<Record<string, ReservationCollection>>((all, collection) => ({ ...all, ...collection }), {}));
  }, onError);
}

export async function recordReservationCollection(collection: ReservationCollection): Promise<void> {
  if (USE_LOCAL_STORAGE) {
    const storageKey = 'hotel-lindoia:reservation-collections:v1';
    const collections = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, ReservationCollection>;
    localStorage.setItem(storageKey, JSON.stringify({ ...collections, [collection.id]: collection }));
    window.dispatchEvent(new Event('hotel-lindoia:reservation-collections-updated'));
    return;
  }
  const collectionRef = ref(db, `erp_geral/reservationCollections/${collection.reservationId}/${collection.id}`);
  const existing = await get(collectionRef);
  if (existing.exists()) {
    const previous = existing.val() as ReservationCollection;
    if (previous.amount === collection.amount && previous.reservationId === collection.reservationId) return;
    throw new Error('Este recebimento já foi registrado com outros dados.');
  }
  await set(collectionRef, collection);
}

export function subscribeReservationExtras(
  onChange: (extras: Record<string, ReservationExtra>) => void,
  onError: (error: Error) => void,
): () => void {
  const storageKey = 'hotel-lindoia:reservation-extras:v1';
  if (USE_LOCAL_STORAGE) {
    const refresh = () => {
      try {
        onChange(JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, ReservationExtra>);
      } catch {
        onChange({});
      }
    };
    refresh();
    window.addEventListener('storage', refresh);
    window.addEventListener('hotel-lindoia:reservation-extras-updated', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('hotel-lindoia:reservation-extras-updated', refresh);
    };
  }

  return onValue(ref(db, 'erp_geral/reservationExtras'), (snapshot) => {
    const byReservation = snapshot.val() as Record<string, Record<string, ReservationExtra>> | null;
    onChange(Object.values(byReservation ?? {}).reduce<Record<string, ReservationExtra>>((all, extras) => ({ ...all, ...extras }), {}));
  }, onError);
}

export async function recordReservationExtra(extra: ReservationExtra): Promise<void> {
  if (USE_LOCAL_STORAGE) {
    const storageKey = 'hotel-lindoia:reservation-extras:v1';
    const extras = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, ReservationExtra>;
    localStorage.setItem(storageKey, JSON.stringify({ ...extras, [extra.id]: extra }));
    window.dispatchEvent(new Event('hotel-lindoia:reservation-extras-updated'));
    return;
  }
  const extraRef = ref(db, `erp_geral/reservationExtras/${extra.reservationId}/${extra.id}`);
  const existing = await get(extraRef);
  if (existing.exists()) {
    const previous = existing.val() as ReservationExtra;
    if (previous.amount === extra.amount && previous.reservationId === extra.reservationId && previous.type === extra.type) return;
    throw new Error('Este adicional já foi lançado com outros dados.');
  }
  await set(extraRef, extra);
}

export async function transitionReservation(
  reservation: Reservation,
  nextStatus: ReservationStatus,
): Promise<void> {
  if (USE_LOCAL_STORAGE) {
    await updateHousekeeping((current) => {
      const existing = current.reservations[reservation.id];
      if (!existing || existing.status !== reservation.status) throw new Error('O status da reserva mudou; atualize a tela.');
      return {
        ...current,
        reservations: {
          ...current.reservations,
          [reservation.id]: { ...existing, status: nextStatus, updatedAt: new Date().toISOString() },
        },
        rooms: nextStatus === 'encerrada' && current.rooms[reservation.roomId]
          ? { ...current.rooms, [reservation.roomId]: { ...current.rooms[reservation.roomId], cleaningStatus: 'sujo' } }
          : current.rooms,
      };
    });
    return;
  }

  const allowedTransition = (reservation.status === 'confirmada' && nextStatus === 'hospedado')
    || (reservation.status === 'hospedado' && nextStatus === 'encerrada');
  if (!allowedTransition) throw new Error('Esta transição de reserva não é permitida.');
  const timestamp = new Date().toISOString();
  const nextReservation = { ...reservation, status: nextStatus, updatedAt: timestamp };
  const auditLog = buildAuditEvents(crypto.randomUUID(), timestamp, [
    { entity: 'reservation', before: { [reservation.id]: reservationsForAudit({ [reservation.id]: reservation })[reservation.id] }, after: { [reservation.id]: reservationsForAudit({ [reservation.id]: nextReservation })[reservation.id] } },
  ]);
  const updates: Record<string, unknown> = {
    [`erp_geral/quartos/reservations/${reservation.id}/status`]: nextStatus,
    [`erp_geral/quartos/reservations/${reservation.id}/updatedAt`]: timestamp,
    ...Object.fromEntries(Object.entries(auditLog).map(([id, event]) => [`erp_geral/quartos/auditLog/${id}`, event])),
  };
  if (nextStatus === 'encerrada') {
    updates[`erp_geral/quartos/rooms/${reservation.roomId}/cleaningStatus`] = 'sujo';
    reservationSlotPaths(reservation).forEach((slotPath) => {
      updates[`erp_geral/quartos/reservationSlots/${reservation.roomId}/${slotPath}`] = null;
    });
  }
  await update(ref(db), updates);
}

export async function syncReservationCollections(): Promise<void> {
  if (USE_LOCAL_STORAGE) return;
  const [collectionsSnapshot, reconciledSnapshot, reservationsSnapshot, financeSnapshot] = await Promise.all([
    get(ref(db, 'erp_geral/reservationCollections')),
    get(ref(db, 'erp_geral/reservationCollectionReconciliations')),
    get(ref(db, 'erp_geral/quartos/reservations')),
    get(ref(db, 'erp_geral/financeiro/incomes')),
  ]);
  const collectionsByReservation = collectionsSnapshot.val() as Record<string, Record<string, ReservationCollection>> | null;
  const reconciled = reconciledSnapshot.val() as Record<string, boolean> | null ?? {};
  const reservations = reservationsSnapshot.val() as Record<string, Reservation> | null ?? {};
  const incomes = financeSnapshot.val() as Record<string, { id: string; amount: number }> | null ?? {};

  for (const collection of Object.values(collectionsByReservation ?? {}).flatMap((group) => Object.values(group))) {
    if (reconciled[collection.id]) continue;
    const incomeId = `reservation-${collection.reservationId}-checkout-${collection.id}`;
    await recordOperationalIncome({
      id: incomeId,
      date: collection.date,
      category: 'Diária',
      description: `Hospedagem · quarto ${reservations[collection.reservationId]?.roomNumber ?? ''}`,
      amount: collection.amount,
      paymentMethod: collection.paymentMethod,
      note: `Recebimento no checkout · ${collection.actor}`,
    });
    const reservation = reservations[collection.reservationId];
    const total = reservation ? reservationFinancialTotal(reservation) : collection.amount;
    const existingReceived = Object.values(incomes).filter((income) => income.id.startsWith(`reservation-${collection.reservationId}-`)).reduce((sum, income) => sum + income.amount, 0);
    const nextBalance = Math.max(0, total - existingReceived);
    const updates: Record<string, unknown> = {
      [`erp_geral/reservationCollectionReconciliations/${collection.id}`]: true,
      [`erp_geral/reservationCollections/${collection.reservationId}/${collection.id}`]: null,
    };
    if (reservation) {
      updates[`erp_geral/quartos/reservations/${collection.reservationId}/balanceDue`] = nextBalance;
      reservations[collection.reservationId] = { ...reservation, balanceDue: nextBalance };
    }
    await update(ref(db), updates);
    incomes[incomeId] = { id: incomeId, amount: collection.amount };
  }
}

export async function syncReservationSlots(previous: Reservation, next: Reservation): Promise<void> {
  if (USE_LOCAL_STORAGE) return;
  const updates: Record<string, string | null> = {};
  reservationSlotPaths(previous).forEach((slotPath) => { updates[`erp_geral/quartos/reservationSlots/${previous.roomId}/${slotPath}`] = null; });
  reservationSlotPaths(next).forEach((slotPath) => { updates[`erp_geral/quartos/reservationSlots/${next.roomId}/${slotPath}`] = next.id; });
  if (Object.keys(updates).length > 0) await update(ref(db), updates);
}

export async function releaseReservationSlots(reservation: Reservation): Promise<void> {
  if (USE_LOCAL_STORAGE) return;
  const updates = Object.fromEntries(reservationSlotPaths(reservation).map((slotPath) => [`erp_geral/quartos/reservationSlots/${reservation.roomId}/${slotPath}`, null]));
  if (Object.keys(updates).length > 0) await update(ref(db), updates);
}

export async function migrateReservationPayments(): Promise<void> {
  if (USE_LOCAL_STORAGE) {
    await updateHousekeeping((current) => {
      const reservations = Object.fromEntries(Object.entries(current.reservations).map(([id, reservation]) => {
        const cleanReservation = { ...reservation } as Reservation & { payments?: unknown };
        delete cleanReservation.payments;
        return [id, cleanReservation];
      }));
      return { ...current, reservations };
    });
    return;
  }

  const [snapshot, financeSnapshot] = await Promise.all([
    get(ref(db, 'erp_geral/quartos/reservations')),
    get(ref(db, 'erp_geral/financeiro/incomes')),
  ]);
  const legacyReservations = snapshot.val() as Record<string, (Reservation & { payments?: unknown })> | null;
  if (!legacyReservations) return;
  const incomes = financeSnapshot.val() as Record<string, { id: string; amount: number }> | null ?? {};

  const paymentMethods: FinancePaymentMethod[] = ['credit', 'debit', 'cash', 'pix', 'bank_transfer', 'prepaid'];
  for (const reservation of Object.values(legacyReservations)) {
    const payments = reservation.payments;
    if (!payments || typeof payments !== 'object') continue;
    for (const [index, value] of Object.values(payments as Record<string, unknown>).entries()) {
      if (!value || typeof value !== 'object') throw new Error('Há um recebimento legado inválido; os dados da reserva foram preservados.');
      const payment = value as { id?: string; date?: string; amount?: number; paymentMethod?: FinancePaymentMethod };
      if (!payment.date || !Number.isFinite(payment.amount) || !payment.amount || !payment.paymentMethod || !paymentMethods.includes(payment.paymentMethod)) {
        throw new Error('Há um recebimento legado incompleto; os dados da reserva foram preservados.');
      }
      await recordOperationalIncome({
        id: `reservation-${reservation.id}-${payment.id ?? `legacy-${index}`}`,
        date: payment.date,
        category: 'Diária',
        description: `Hospedagem · quarto ${reservation.roomNumber}`,
        amount: payment.amount,
        paymentMethod: payment.paymentMethod,
        note: `Recebimento da reserva de ${reservation.guestName}`,
      });
      const incomeId = `reservation-${reservation.id}-${payment.id ?? `legacy-${index}`}`;
      incomes[incomeId] = { id: incomeId, amount: payment.amount };
    }
  }

  await updateHousekeeping((current) => {
    const reservations = Object.fromEntries(Object.entries(current.reservations).map(([id, reservation]) => {
      const cleanReservation = { ...reservation } as Reservation & { payments?: unknown };
      delete cleanReservation.payments;
      const total = reservationFinancialTotal(cleanReservation);
      const received = Object.values(incomes).filter((income) => income.id.startsWith(`reservation-${id}-`)).reduce((sum, income) => sum + income.amount, 0);
      return [id, { ...cleanReservation, balanceDue: Math.max(0, total - received) }];
    }));
    return { ...current, reservations };
  });
}