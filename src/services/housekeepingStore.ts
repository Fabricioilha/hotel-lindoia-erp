import { get, limitToLast, onValue, orderByChild, query, ref, runTransaction, set, startAt, update } from 'firebase/database';
import { db } from '../config/firebase';
import { buildAuditEvents } from '../types/audit';
import { recordOperationalIncome } from './operationalIncome';
import type { HousekeepingData, Reservation, ReservationCollection, ReservationDirectoryEntry, ReservationExtra, ReservationStatus } from '../types/housekeeping';
import { reservationOverlaps } from './reservationAnalytics';

const USE_LOCAL_STORAGE = import.meta.env.VITE_USE_LOCAL_STORAGE === 'true';
const STORAGE_KEY = 'hotel-lindoia:housekeeping:v1';
const LOCAL_UPDATE_EVENT = 'hotel-lindoia:housekeeping-updated';

function currentLocalDateKey(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

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

  const keys = ['rooms', 'dailyPlans', 'cleaningLogs', 'reservations', 'attendants', 'attendantsConfigured', 'settings', 'auditLog'] as const;
  const loaded = new Set<string>();
  const values: Record<string, unknown> = {};
  const stops = keys.map((key) => {
    const path = ref(db, `erp_geral/quartos/${key}`);
    const listener = key === 'auditLog' ? query(path, orderByChild('occurredAt'), limitToLast(100)) : path;
    return onValue(listener, (snapshot) => {
      values[key] = snapshot.val() ?? (key === 'attendantsConfigured' ? false : {});
      loaded.add(key);
      if (loaded.size === keys.length) onChange(normalizeHousekeeping(values));
    }, onError);
  });
  return () => stops.forEach((stop) => stop());
}

export function subscribeRoomDirectory(
  onChange: (rooms: HousekeepingData['rooms']) => void,
  onError: (error: Error) => void,
): () => void {
  return onValue(ref(db, 'erp_geral/quartos/rooms'), (snapshot) => {
    onChange(snapshot.val() ?? {});
  }, onError);
}

export function subscribeReservationDirectory(
  onChange: (reservations: Record<string, ReservationDirectoryEntry>) => void,
  onError: (error: Error) => void,
): () => void {
  return onValue(ref(db, 'erp_geral/quartos/reservationIndex'), (snapshot) => {
    onChange(snapshot.val() ?? {});
  }, onError);
}

export function subscribeCurrentReservationDirectory(
  onChange: (reservations: Record<string, ReservationDirectoryEntry>) => void,
  onError: (error: Error) => void,
): () => void {
  const currentReservations = query(
    ref(db, 'erp_geral/quartos/reservationIndex'),
    orderByChild('checkOutDate'),
    startAt(currentLocalDateKey()),
  );
  return onValue(currentReservations, (snapshot) => {
    onChange(snapshot.val() ?? {});
  }, onError);
}

let lastReservationDirectoryFingerprint = '';

export async function syncReservationDirectory(reservations: Record<string, Reservation>): Promise<void> {
  const entries: [string, ReservationDirectoryEntry][] = Object.values(reservations)
    .filter((reservation) => reservation.status === 'confirmada' || reservation.status === 'hospedado')
    .map((reservation): [string, ReservationDirectoryEntry] => [reservation.id, {
      id: reservation.id,
      roomId: reservation.roomId,
      roomNumber: reservation.roomNumber,
      guestName: reservation.guestName,
      adults: reservation.adults,
      children: reservation.children,
      breakfastIncluded: Boolean(reservation.breakfastIncluded),
      checkInDate: reservation.checkInDate,
      checkOutDate: reservation.checkOutDate,
      checkInTime: reservation.checkInTime,
      checkOutTime: reservation.checkOutTime,
      channel: reservation.channel,
      status: reservation.status,
    }]);
  const index = Object.fromEntries(entries);
  const fingerprint = JSON.stringify(index);
  if (fingerprint === lastReservationDirectoryFingerprint) return;
  await set(ref(db, 'erp_geral/quartos/reservationIndex'), index);
  lastReservationDirectoryFingerprint = fingerprint;
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

  const slotPaths = reservationSlotPaths(reservation);
  const roomSlotsRef = ref(db, `erp_geral/quartos/reservationSlots/${reservation.roomId}`);
  let conflictingSlot = false;
  const slotResult = await runTransaction(roomSlotsRef, (value) => {
    conflictingSlot = false;
    const roomSlots = structuredClone(value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    conflictingSlot = slotPaths.some((slotPath) => {
      const parts = slotPath.split('/');
      const rotativoSlots = roomSlots.rotativo as Record<string, Record<string, unknown>> | undefined;
      if (parts[0] === 'rotativo') return Boolean(roomSlots[parts[1]]) || Boolean(rotativoSlots?.[parts[1]]?.[parts[2]]);
      return Boolean(roomSlots[slotPath]) || Object.keys(rotativoSlots?.[slotPath] ?? {}).length > 0;
    });
    if (conflictingSlot) return;

    slotPaths.forEach((slotPath) => {
      const parts = slotPath.split('/');
      let parent = roomSlots;
      parts.slice(0, -1).forEach((part) => {
        const child = parent[part];
        if (!child || typeof child !== 'object') parent[part] = {};
        parent = parent[part] as Record<string, unknown>;
      });
      parent[parts.at(-1)!] = reservation.id;
    });
    return roomSlots;
  });
  if (!slotResult.committed) {
    if (conflictingSlot) throw new Error(`O quarto ${reservation.roomNumber} já está reservado neste horário.`);
    throw new Error('Não foi possível bloquear o período. Atualize a lista e tente novamente.');
  }

  const operationId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const auditEvents = buildAuditEvents(operationId, occurredAt, [
    { entity: 'reservation', before: {}, after: { [reservation.id]: reservationsForAudit({ [reservation.id]: reservation })[reservation.id] } },
  ]);
  const updates: Record<string, unknown> = {
    [`erp_geral/quartos/reservations/${reservation.id}`]: reservation,
    [`erp_geral/quartos/reservationIndex/${reservation.id}`]: {
      id: reservation.id,
      roomId: reservation.roomId,
      roomNumber: reservation.roomNumber,
      guestName: reservation.guestName,
      adults: reservation.adults,
      children: reservation.children,
      breakfastIncluded: Boolean(reservation.breakfastIncluded),
      checkInDate: reservation.checkInDate,
      checkOutDate: reservation.checkOutDate,
      checkInTime: reservation.checkInTime,
      checkOutTime: reservation.checkOutTime,
      channel: reservation.channel,
      status: reservation.status,
    } satisfies ReservationDirectoryEntry,
    ...Object.fromEntries(Object.entries(auditEvents).map(([id, event]) => [`erp_geral/quartos/auditLog/${id}`, event])),
  };
  try {
    await update(ref(db), updates);
  } catch {
    await releaseReservationSlots(reservation).catch(() => undefined);
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
    updates[`erp_geral/quartos/reservationIndex/${reservation.id}`] = null;
    reservationSlotPaths(reservation).forEach((slotPath) => {
      updates[`erp_geral/quartos/reservationSlots/${reservation.roomId}/${slotPath}`] = null;
    });
  } else if (nextStatus === 'hospedado') {
    updates[`erp_geral/quartos/reservationIndex/${reservation.id}`] = {
      id: reservation.id,
      roomId: reservation.roomId,
      roomNumber: reservation.roomNumber,
      guestName: reservation.guestName,
      adults: reservation.adults,
      children: reservation.children,
      breakfastIncluded: Boolean(reservation.breakfastIncluded),
      checkInDate: reservation.checkInDate,
      checkOutDate: reservation.checkOutDate,
      checkInTime: reservation.checkInTime,
      checkOutTime: reservation.checkOutTime,
      channel: reservation.channel,
      status: nextStatus,
    } satisfies ReservationDirectoryEntry;
  }
  await update(ref(db), updates);
}

export async function syncReservationCollections(): Promise<void> {
  if (USE_LOCAL_STORAGE) return;
  const collectionsSnapshot = await get(ref(db, 'erp_geral/reservationCollections'));
  const collectionsByReservation = collectionsSnapshot.val() as Record<string, Record<string, ReservationCollection>> | null;

  for (const collection of Object.values(collectionsByReservation ?? {}).flatMap((group) => Object.values(group))) {
    const reservationSnapshot = await get(ref(db, `erp_geral/quartos/reservations/${collection.reservationId}`));
    const reservation = reservationSnapshot.val() as Reservation | null;
    if (!reservation) throw new Error(`A reserva vinculada ao recebimento ${collection.id} não foi encontrada.`);
    const incomeId = `reservation-${collection.reservationId}-checkout-${collection.id}`;
    await recordOperationalIncome({
      id: incomeId,
      date: collection.date,
      category: 'Diária',
      description: `Hospedagem · quarto ${reservation.roomNumber}`,
      amount: collection.amount,
      paymentMethod: collection.paymentMethod,
      note: `Recebimento no checkout · ${collection.actor}`,
    });
    const updates: Record<string, unknown> = {
      [`erp_geral/reservationCollections/${collection.reservationId}/${collection.id}`]: null,
      [`erp_geral/quartos/reservations/${collection.reservationId}/balanceDue`]: Math.max(
        0,
        Number(reservation.balanceDue ?? reservationFinancialTotal(reservation)) - collection.amount,
      ),
    };
    await update(ref(db), updates);
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

