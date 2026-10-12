import { equalTo, get, limitToLast, onValue, orderByChild, orderByKey, query, ref, runTransaction, set, startAt, update } from 'firebase/database';
import { db } from '../config/firebase';
import { buildAuditEvents } from '../types/audit';
import { recordOperationalIncome } from './operationalIncome';
import { DEFAULT_ROOM_CATEGORIES, type HousekeepingData, type HousekeepingRoom, type Reservation, type ReservationCollection, type ReservationDirectoryEntry, type ReservationExtra, type ReservationStatus, type RoomCategoryRecord, type RoomCleaningLog, type RoomDayPlan } from '../types/housekeeping';
import { reservationOverlaps } from './reservationAnalytics';

function currentLocalDateKey(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dateKeyYearsAgo(years: number, date = new Date()): string {
  const target = new Date(date);
  target.setFullYear(target.getFullYear() - years);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}

export interface DashboardHousekeepingData {
  rooms: Record<string, HousekeepingRoom>;
  reservations: Record<string, ReservationDirectoryEntry>;
  cleaningLogs: Record<string, RoomCleaningLog>;
}

export function emptyHousekeeping(): HousekeepingData {
  return {
    rooms: {},
    categories: Object.fromEntries(DEFAULT_ROOM_CATEGORIES.map((category) => [category.id, category])),
    categoriesConfigured: false,
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
    categories: data.categories ?? Object.fromEntries(DEFAULT_ROOM_CATEGORIES.map((category) => [category.id, category])),
    categoriesConfigured: Boolean(data.categoriesConfigured),
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

export const housekeepingStorageMode = 'Firebase';

export function subscribeHousekeeping(
  onChange: (data: HousekeepingData) => void,
  onError: (error: Error) => void,
): () => void {
  const keys = ['rooms', 'categories', 'categoriesConfigured', 'dailyPlans', 'cleaningLogs', 'reservations', 'attendants', 'attendantsConfigured', 'settings', 'auditLog'] as const;
  const loaded = new Set<string>();
  const values: Record<string, unknown> = {};
  const stops = keys.map((key) => {
    const path = ref(db, `erp_geral/quartos/${key}`);
    const cutoff = dateKeyYearsAgo(5);
    const listener = key === 'auditLog'
      ? query(path, orderByChild('occurredAt'), limitToLast(100))
      : key === 'reservations'
        ? query(path, orderByChild('checkInDate'), startAt(cutoff))
        : key === 'cleaningLogs'
          ? query(path, orderByChild('date'), startAt(cutoff))
          : key === 'dailyPlans'
            ? query(path, orderByKey(), startAt(cutoff))
            : path;
    return onValue(listener, (snapshot) => {
      values[key] = snapshot.val() ?? (key === 'attendantsConfigured' || key === 'categoriesConfigured' ? false : {});
      loaded.add(key);
      if (loaded.size === keys.length) onChange(normalizeHousekeeping(values));
    }, onError);
  });
  return () => stops.forEach((stop) => stop());
}

export function subscribeDashboardHousekeeping(
  date: string,
  onChange: (data: DashboardHousekeepingData) => void,
  onError: (error: Error) => void,
): () => void {
  const data: DashboardHousekeepingData = { rooms: {}, reservations: {}, cleaningLogs: {} };
  const loaded = new Set<keyof DashboardHousekeepingData>();
  const publish = (key: keyof DashboardHousekeepingData) => {
    loaded.add(key);
    if (loaded.size === 3) onChange(data);
  };
  const reservationsQuery = query(
    ref(db, 'erp_geral/quartos/reservationIndex'),
    orderByChild('checkOutDate'),
    startAt(date),
  );
  const logsQuery = query(
    ref(db, 'erp_geral/quartos/cleaningLogs'),
    orderByChild('date'),
    equalTo(date),
  );
  const stopRooms = onValue(ref(db, 'erp_geral/quartos/rooms'), (snapshot) => {
    data.rooms = snapshot.val() ?? {};
    publish('rooms');
  }, onError);
  const stopReservations = onValue(reservationsQuery, (snapshot) => {
    data.reservations = snapshot.val() ?? {};
    publish('reservations');
  }, onError);
  const stopLogs = onValue(logsQuery, (snapshot) => {
    data.cleaningLogs = snapshot.val() ?? {};
    publish('cleaningLogs');
  }, onError);
  return () => { stopRooms(); stopReservations(); stopLogs(); };
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

function reservationDirectoryEntry(reservation: Reservation): ReservationDirectoryEntry {
  return {
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
  };
}

function activeReservationIndexValue(reservation: Reservation): ReservationDirectoryEntry | null {
  return reservation.status === 'confirmada' || reservation.status === 'hospedado'
    ? reservationDirectoryEntry(reservation)
    : null;
}

async function writeHousekeepingUpdates(
  updates: Record<string, unknown>,
  buckets: Parameters<typeof buildAuditEvents>[2],
): Promise<void> {
  const auditEvents = buildAuditEvents(crypto.randomUUID(), new Date().toISOString(), buckets);
  Object.entries(auditEvents).forEach(([id, event]) => {
    updates[`erp_geral/quartos/auditLog/${id}`] = event;
  });
  await update(ref(db), updates);
}

export async function saveHousekeepingRoom(room: HousekeepingRoom): Promise<void> {
  const roomsSnapshot = await get(ref(db, 'erp_geral/quartos/rooms'));
  const rooms = roomsSnapshot.val() as Record<string, HousekeepingRoom> | null ?? {};
  const previous = rooms[room.id];
  const duplicate = Object.values(rooms).some((existing) => existing.id !== room.id
    && existing.number.trim().toLocaleLowerCase('pt-BR') === room.number.trim().toLocaleLowerCase('pt-BR'));
  if (duplicate) throw new Error(`O quarto ${room.number} já está cadastrado.`);
  if (room.maintenanceStatus === 'em_manutencao') {
    const indexSnapshot = await get(ref(db, 'erp_geral/quartos/reservationIndex'));
    const index = (indexSnapshot.val() ?? {}) as Record<string, ReservationDirectoryEntry>;
    const hasCurrentReservation = Object.values(index).some((entry) =>
      entry.roomId === room.id && entry.status === 'hospedado');
    if (hasCurrentReservation) throw new Error('Faça o checkout do hóspede antes de bloquear o quarto para manutenção.');
  }
  await writeHousekeepingUpdates({ [`erp_geral/quartos/rooms/${room.id}`]: room }, [
    { entity: 'room', before: previous ? { [room.id]: previous } : {}, after: { [room.id]: room } },
  ]);
}

export async function saveRoomCategory(category: RoomCategoryRecord, categories: RoomCategoryRecord[]): Promise<void> {
  const name = category.name.trim();
  const bedComposition = category.bedComposition.trim();
  if (!name || name.length > 60) throw new Error('Informe um nome de categoria com até 60 caracteres.');
  if (!bedComposition || bedComposition.length > 120) throw new Error('Informe a composição das camas com até 120 caracteres.');
  if (!Number.isInteger(category.bedCount) || category.bedCount < 1 || category.bedCount > 10) {
    throw new Error('A quantidade de camas deve estar entre 1 e 10.');
  }

  const nextCategory = { ...category, name, bedComposition };
  const duplicate = categories.some((item) => item.id !== category.id
    && item.name.trim().toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR')
    && item.bedComposition.trim().toLocaleLowerCase('pt-BR') === bedComposition.toLocaleLowerCase('pt-BR'));
  if (duplicate) throw new Error('Já existe uma categoria com esse nome e essa composição de camas.');

  const [roomsSnapshot, categoriesSnapshot, configuredSnapshot] = await Promise.all([
    get(ref(db, 'erp_geral/quartos/rooms')),
    get(ref(db, 'erp_geral/quartos/categories')),
    get(ref(db, 'erp_geral/quartos/categoriesConfigured')),
  ]);
  const rooms = roomsSnapshot.val() as Record<string, HousekeepingRoom> | null ?? {};
  const previousCategories = categoriesSnapshot.val() as Record<string, RoomCategoryRecord> | null ?? {};
  const wasConfigured = Boolean(configuredSnapshot.val());
  const previousCategory = previousCategories[category.id] ?? categories.find((item) => item.id === category.id);
  const nextCategories = Object.fromEntries(categories.map((item) => [item.id, item]));
  nextCategories[category.id] = nextCategory;
  const roomBefore: Record<string, HousekeepingRoom> = {};
  const roomAfter: Record<string, HousekeepingRoom> = {};
  const updates: Record<string, unknown> = {
    [`erp_geral/quartos/categoriesConfigured`]: true,
  };

  (wasConfigured ? [nextCategory] : Object.values(nextCategories)).forEach((item) => {
    updates[`erp_geral/quartos/categories/${item.id}`] = item;
  });
  Object.values(rooms).forEach((room) => {
    if (room.category !== category.id) return;
    const nextRoom = { ...room, categoryName: name, bedComposition, bedCount: category.bedCount };
    roomBefore[room.id] = room;
    roomAfter[room.id] = nextRoom;
    updates[`erp_geral/quartos/rooms/${room.id}`] = nextRoom;
  });

  await writeHousekeepingUpdates(updates, [
    { entity: 'room-category', before: previousCategory ? { [category.id]: previousCategory } : {}, after: { [category.id]: nextCategory } },
    { entity: 'room', before: roomBefore, after: roomAfter },
  ]);
}

export async function deleteRoomCategory(categoryId: string, categories: RoomCategoryRecord[]): Promise<void> {
  const [roomsSnapshot, configuredSnapshot] = await Promise.all([
    get(ref(db, 'erp_geral/quartos/rooms')),
    get(ref(db, 'erp_geral/quartos/categoriesConfigured')),
  ]);
  const rooms = roomsSnapshot.val() as Record<string, HousekeepingRoom> | null ?? {};
  const wasConfigured = Boolean(configuredSnapshot.val());
  const assignedRoom = Object.values(rooms).find((room) => room.category === categoryId);
  if (assignedRoom) throw new Error(`A categoria ainda está vinculada ao quarto ${assignedRoom.number}.`);
  const previous = categories.find((category) => category.id === categoryId);
  if (!previous) return;

  const nextCategories = categories.filter((category) => category.id !== categoryId);
  const updates: Record<string, unknown> = {
    [`erp_geral/quartos/categoriesConfigured`]: true,
    [`erp_geral/quartos/categories/${categoryId}`]: null,
  };
  if (!wasConfigured) nextCategories.forEach((category) => {
    updates[`erp_geral/quartos/categories/${category.id}`] = category;
  });
  await writeHousekeepingUpdates(updates, [
    { entity: 'room-category', before: { [categoryId]: previous }, after: {} },
  ]);
}

export async function updateRoomCleaningStatus(roomId: string, status: HousekeepingRoom['cleaningStatus']): Promise<void> {
  const roomSnapshot = await get(ref(db, `erp_geral/quartos/rooms/${roomId}`));
  const room = roomSnapshot.val() as HousekeepingRoom | null;
  if (!room) throw new Error('Este quarto foi excluído. Atualize a tela.');
  const nextRoom = { ...room, cleaningStatus: status };
  await writeHousekeepingUpdates({ [`erp_geral/quartos/rooms/${roomId}/cleaningStatus`]: status }, [
    { entity: 'room', before: { [roomId]: room }, after: { [roomId]: nextRoom } },
  ]);
}

export async function saveRoomDayPlan(roomId: string, date: string, patch: Partial<RoomDayPlan>): Promise<void> {
  const [roomSnapshot, planSnapshot] = await Promise.all([
    get(ref(db, `erp_geral/quartos/rooms/${roomId}`)),
    get(ref(db, `erp_geral/quartos/dailyPlans/${date}/${roomId}`)),
  ]);
  if (!roomSnapshot.exists()) throw new Error('Este quarto foi excluído. Atualize a tela.');
  const previous = planSnapshot.val() as RoomDayPlan | null ?? { cleaningRequest: 'pendente' };
  const next = { ...previous, ...patch };
  await writeHousekeepingUpdates({ [`erp_geral/quartos/dailyPlans/${date}/${roomId}`]: next }, [
    { entity: 'room-plan', before: { [`${date}/${roomId}`]: previous }, after: { [`${date}/${roomId}`]: next } },
  ]);
}

export async function completeRoomCleaning(roomId: string, log: RoomCleaningLog): Promise<void> {
  const roomSnapshot = await get(ref(db, `erp_geral/quartos/rooms/${roomId}`));
  const currentRoom = roomSnapshot.val() as HousekeepingRoom | null;
  if (!currentRoom) throw new Error('Este quarto foi excluído. Atualize a tela.');
  const nextRoom = { ...currentRoom, cleaningStatus: 'limpo' as const };
  await writeHousekeepingUpdates({
    [`erp_geral/quartos/rooms/${roomId}/cleaningStatus`]: 'limpo',
    [`erp_geral/quartos/cleaningLogs/${log.id}`]: log,
  }, [
    { entity: 'room', before: { [roomId]: currentRoom }, after: { [roomId]: nextRoom } },
    { entity: 'cleaning-log', before: {}, after: { [log.id]: log } },
  ]);
}

export async function deleteRoomCleaningLog(log: RoomCleaningLog): Promise<void> {
  const [logsSnapshot, roomSnapshot] = await Promise.all([
    get(query(ref(db, 'erp_geral/quartos/cleaningLogs'), orderByChild('roomId'), equalTo(log.roomId))),
    get(ref(db, `erp_geral/quartos/rooms/${log.roomId}`)),
  ]);
  const currentLogs = logsSnapshot.val() as Record<string, RoomCleaningLog> | null ?? {};
  const remainingLogs = Object.values(currentLogs).filter((item) => item.id !== log.id);
  const room = roomSnapshot.val() as HousekeepingRoom | null;
  const updates: Record<string, unknown> = { [`erp_geral/quartos/cleaningLogs/${log.id}`]: null };
  const buckets: Parameters<typeof buildAuditEvents>[2] = [
    { entity: 'cleaning-log', before: { [log.id]: log }, after: {} },
  ];
  if (room?.cleaningStatus === 'limpo' && remainingLogs.length === 0) {
    const nextRoom = { ...room, cleaningStatus: 'sujo' as const };
    updates[`erp_geral/quartos/rooms/${log.roomId}/cleaningStatus`] = 'sujo';
    buckets.push({ entity: 'room', before: { [log.roomId]: room }, after: { [log.roomId]: nextRoom } });
  }
  await writeHousekeepingUpdates(updates, buckets);
}

export async function updateHousekeepingSettings(patch: Partial<HousekeepingData['settings']>): Promise<void> {
  const settingsRef = ref(db, 'erp_geral/quartos/settings');
  const snapshot = await get(settingsRef);
  const previous = { doorsAndWindowsIntervalDays: 5, ...(snapshot.val() ?? {}) } as HousekeepingData['settings'];
  const next = { ...previous, ...patch };
  await writeHousekeepingUpdates({ 'erp_geral/quartos/settings': next }, [
    { entity: 'housekeeping-settings', before: { hotel: previous }, after: { hotel: next } },
  ]);
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

function stableDirectoryJson(index: Record<string, ReservationDirectoryEntry>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(index).sort(([left], [right]) => left.localeCompare(right))));
}

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
  const fingerprint = stableDirectoryJson(index);
  if (fingerprint === lastReservationDirectoryFingerprint) return;
  const existing = await get(ref(db, 'erp_geral/quartos/reservationIndex'));
  if (stableDirectoryJson(existing.val() ?? {}) === fingerprint) {
    lastReservationDirectoryFingerprint = fingerprint;
    return;
  }
  await set(ref(db, 'erp_geral/quartos/reservationIndex'), index);
  lastReservationDirectoryFingerprint = fingerprint;
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
    [`erp_geral/quartos/reservationIndex/${reservation.id}`]: reservationDirectoryEntry(reservation),
    ...Object.fromEntries(Object.entries(auditEvents).map(([id, event]) => [`erp_geral/quartos/auditLog/${id}`, event])),
  };
  try {
    await update(ref(db), updates);
  } catch {
    await releaseReservationSlots(reservation).catch(() => undefined);
    throw new Error('O período acabou de ser reservado ou não foi salvo. Atualize a lista e tente novamente.');
  }
}

export async function saveReservationRecord(reservation: Reservation, expected: Pick<Reservation, 'status' | 'updatedAt'>): Promise<void> {
  let previous: Reservation | undefined;
  const reservationRef = ref(db, `erp_geral/quartos/reservations/${reservation.id}`);
  const result = await runTransaction(reservationRef, (value) => {
    if (!value) return;
    const current = value as Reservation;
    if (current.status !== expected.status || current.updatedAt !== expected.updatedAt || current.status === 'hospedado') return;
    previous = current;
    return reservation;
  });
  if (!result.committed || !previous) throw new Error('A reserva mudou enquanto você editava. Atualize os dados e tente novamente.');
  const saved = result.snapshot.val() as Reservation;
  const auditEvents = buildAuditEvents(crypto.randomUUID(), new Date().toISOString(), [
    { entity: 'reservation', before: reservationsForAudit({ [reservation.id]: previous }), after: reservationsForAudit({ [reservation.id]: saved }) },
  ]);
  const updates: Record<string, unknown> = {
    [`erp_geral/quartos/reservationIndex/${reservation.id}`]: activeReservationIndexValue(saved),
    ...Object.fromEntries(Object.entries(auditEvents).map(([id, event]) => [`erp_geral/quartos/auditLog/${id}`, event])),
  };
  await update(ref(db), updates);
}

export async function saveReservationBalanceDue(reservationId: string, balanceDue: number): Promise<void> {
  const reservationRef = ref(db, `erp_geral/quartos/reservations/${reservationId}`);
  let previous: Reservation | undefined;
  const result = await runTransaction(reservationRef, (value) => {
    if (!value) return;
    previous = value as Reservation;
    return { ...previous, balanceDue };
  });
  if (!result.committed || !previous) throw new Error('A reserva não foi encontrada para atualizar o saldo.');
  const saved = result.snapshot.val() as Reservation;
  const auditEvents = buildAuditEvents(crypto.randomUUID(), new Date().toISOString(), [
    { entity: 'reservation', before: reservationsForAudit({ [reservationId]: previous }), after: reservationsForAudit({ [reservationId]: saved }) },
  ]);
  await update(ref(db), Object.fromEntries(Object.entries(auditEvents).map(([id, event]) => [`erp_geral/quartos/auditLog/${id}`, event])));
}

export async function cancelConfirmedReservation(reservationId: string): Promise<void> {
  const reservationRef = ref(db, `erp_geral/quartos/reservations/${reservationId}`);
  let previous: Reservation | undefined;
  const timestamp = new Date().toISOString();
  const result = await runTransaction(reservationRef, (value) => {
    if (!value) return;
    const current = value as Reservation;
    if (current.status !== 'confirmada') return;
    previous = current;
    return { ...current, status: 'cancelada', updatedAt: timestamp } satisfies Reservation;
  });
  if (!result.committed || !previous) throw new Error('Somente reservas confirmadas podem ser canceladas. Atualize a lista.');
  const saved = result.snapshot.val() as Reservation;
  const auditEvents = buildAuditEvents(crypto.randomUUID(), timestamp, [
    { entity: 'reservation', before: reservationsForAudit({ [reservationId]: previous }), after: reservationsForAudit({ [reservationId]: saved }) },
  ]);
  await update(ref(db), {
    [`erp_geral/quartos/reservationIndex/${reservationId}`]: null,
    ...Object.fromEntries(Object.entries(auditEvents).map(([id, event]) => [`erp_geral/quartos/auditLog/${id}`, event])),
  });
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
  return onValue(ref(db, 'erp_geral/reservationCollections'), (snapshot) => {
    const byReservation = snapshot.val() as Record<string, Record<string, ReservationCollection>> | null;
    onChange(Object.values(byReservation ?? {}).reduce<Record<string, ReservationCollection>>((all, collection) => ({ ...all, ...collection }), {}));
  }, onError);
}

export async function recordReservationCollection(collection: ReservationCollection): Promise<void> {
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
  return onValue(ref(db, 'erp_geral/reservationExtras'), (snapshot) => {
    const byReservation = snapshot.val() as Record<string, Record<string, ReservationExtra>> | null;
    onChange(Object.values(byReservation ?? {}).reduce<Record<string, ReservationExtra>>((all, extras) => ({ ...all, ...extras }), {}));
  }, onError);
}

export async function recordReservationExtra(extra: ReservationExtra): Promise<void> {
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

function hasReservationSlots(reservation: Reservation): boolean {
  return reservation.status === 'confirmada' || reservation.status === 'hospedado';
}

export async function reserveReservationSlots(reservation: Reservation): Promise<void> {
  if (!hasReservationSlots(reservation)) return;
  const roomReservations = await get(query(
    ref(db, 'erp_geral/quartos/reservationIndex'),
    orderByChild('roomId'),
    equalTo(reservation.roomId),
  ));
  if (reservationOverlapsIndex(roomReservations.val() ?? {}, reservation)) {
    throw new Error(`O quarto ${reservation.roomNumber} já tem uma reserva ativa nesse período.`);
  }
  const nextPaths = reservationSlotPaths(reservation);
  let conflict = false;
  const result = await runTransaction(ref(db, `erp_geral/quartos/reservationSlots/${reservation.roomId}`), (value) => {
    conflict = false;
    const roomSlots = structuredClone(value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    conflict = nextPaths.some((slotPath) => reservationSlotOwner(roomSlots, slotPath).some((owner) => owner !== reservation.id));
    if (conflict) return;
    nextPaths.forEach((slotPath) => setReservationSlotPath(roomSlots, slotPath, reservation.id));
    return roomSlots;
  });
  if (!result.committed) throw new Error(conflict ? `O quarto ${reservation.roomNumber} já está reservado neste horário.` : 'Não foi possível bloquear o novo período. Atualize a lista e tente novamente.');
}

function reservationOverlapsIndex(index: Record<string, ReservationDirectoryEntry>, candidate: Reservation): boolean {
  const startOf = (reservation: Pick<ReservationDirectoryEntry, 'checkInDate' | 'checkInTime' | 'channel'>) =>
    Date.parse(`${reservation.checkInDate}T${reservation.channel === 'rotativo' && reservation.checkInTime ? reservation.checkInTime : '00:00'}:00`);
  const endOf = (reservation: Pick<ReservationDirectoryEntry, 'checkOutDate' | 'checkOutTime' | 'channel'>) =>
    Date.parse(`${reservation.checkOutDate}T${reservation.channel === 'rotativo' && reservation.checkOutTime ? reservation.checkOutTime : '00:00'}:00`);
  const start = startOf(candidate);
  const end = endOf(candidate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return true;
  return Object.values(index).some((existing) => {
    if (existing.id === candidate.id || existing.roomId !== candidate.roomId
      || (existing.status !== 'confirmada' && existing.status !== 'hospedado')) return false;
    const existingStart = startOf(existing);
    const existingEnd = endOf(existing);
    return Number.isFinite(existingStart) && Number.isFinite(existingEnd)
      && start < existingEnd && end > existingStart;
  });
}

export async function releaseObsoleteReservationSlots(previous: Reservation, next: Reservation): Promise<void> {
  const previousPaths = hasReservationSlots(previous) ? reservationSlotPaths(previous) : [];
  const nextPaths = hasReservationSlots(next) ? reservationSlotPaths(next) : [];
  if (previous.roomId !== next.roomId) {
    if (previousPaths.length > 0) await releaseReservationSlots(previous);
    return;
  }
  const nextPathSet = new Set(nextPaths);
  const obsoletePaths = previousPaths.filter((slotPath) => !nextPathSet.has(slotPath));
  if (obsoletePaths.length === 0) return;
  await runTransaction(ref(db, `erp_geral/quartos/reservationSlots/${previous.roomId}`), (value) => {
    const roomSlots = structuredClone(value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    removeReservationSlotPaths(roomSlots, previous, obsoletePaths);
    return roomSlots;
  });
}

export async function rollbackReservationSlots(previous: Reservation, next: Reservation): Promise<void> {
  const previousPaths = hasReservationSlots(previous) ? reservationSlotPaths(previous) : [];
  const nextPaths = hasReservationSlots(next) ? reservationSlotPaths(next) : [];
  if (previous.roomId !== next.roomId) {
    if (nextPaths.length > 0) await releaseReservationSlots(next);
    return;
  }
  const previousPathSet = new Set(previousPaths);
  const addedPaths = nextPaths.filter((slotPath) => !previousPathSet.has(slotPath));
  if (addedPaths.length === 0) return;
  await runTransaction(ref(db, `erp_geral/quartos/reservationSlots/${next.roomId}`), (value) => {
    const roomSlots = structuredClone(value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    removeReservationSlotPaths(roomSlots, next, addedPaths);
    return roomSlots;
  });
}

export async function syncReservationSlots(previous: Reservation, next: Reservation): Promise<void> {
  await reserveReservationSlots(next);
  await releaseObsoleteReservationSlots(previous, next);
}

function reservationSlotOwner(roomSlots: Record<string, unknown>, slotPath: string): string[] {
  const parts = slotPath.split('/');
  if (parts[0] === 'rotativo') {
    const dayOwner = roomSlots[parts[1]];
    const rotativo = roomSlots.rotativo as Record<string, Record<string, unknown>> | undefined;
    const owner = rotativo?.[parts[1]]?.[parts[2]];
    return [dayOwner, owner].filter((value): value is string => typeof value === 'string');
  }
  const rotativo = roomSlots.rotativo as Record<string, Record<string, unknown>> | undefined;
  const rotatingOwners = Object.values(rotativo?.[slotPath] ?? {}).filter((value): value is string => typeof value === 'string');
  const dayOwner = roomSlots[slotPath];
  return [...(typeof dayOwner === 'string' ? [dayOwner] : []), ...rotatingOwners];
}

function setReservationSlotPath(roomSlots: Record<string, unknown>, slotPath: string, reservationId: string): void {
  const parts = slotPath.split('/');
  let parent = roomSlots;
  parts.slice(0, -1).forEach((part) => {
    if (!parent[part] || typeof parent[part] !== 'object') parent[part] = {};
    parent = parent[part] as Record<string, unknown>;
  });
  parent[parts.at(-1)!] = reservationId;
}

function removeReservationSlotPaths(roomSlots: Record<string, unknown>, reservation: Reservation, paths = reservationSlotPaths(reservation)): void {
  paths.forEach((slotPath) => {
    const parts = slotPath.split('/');
    let parent = roomSlots;
    const parents: { value: Record<string, unknown>; key: string }[] = [];
    for (const part of parts.slice(0, -1)) {
      const child = parent[part];
      if (!child || typeof child !== 'object') return;
      parents.push({ value: parent, key: part });
      parent = child as Record<string, unknown>;
    }
    const leaf = parts.at(-1)!;
    if (parent[leaf] === reservation.id) delete parent[leaf];
    for (let index = parents.length - 1; index >= 0; index -= 1) {
      const { value, key } = parents[index];
      const child = value[key] as Record<string, unknown>;
      if (Object.keys(child).length === 0) delete value[key];
      else break;
    }
  });
}

export async function releaseReservationSlots(reservation: Reservation): Promise<void> {
  const updates = Object.fromEntries(reservationSlotPaths(reservation).map((slotPath) => [`erp_geral/quartos/reservationSlots/${reservation.roomId}/${slotPath}`, null]));
  if (Object.keys(updates).length > 0) await update(ref(db), updates);
}

