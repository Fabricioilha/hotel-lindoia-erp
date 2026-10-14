import { endAt, equalTo, get, limitToLast, onValue, orderByChild, orderByKey, query, ref, runTransaction, set, startAt, update } from 'firebase/database';
import { db } from '../config/firebase';
import { buildAuditEvents } from '../types/audit';
import { incomePaymentWallet, type FinanceIncome } from '../types/finance';
import type { GuestStay, RoomCharge } from '../types/reception';
import { roomChargeFinanceEntries } from './operationalLedger';
import { reservationBalanceDue, reservationFinancialTotal, reservationIncomeContext, validateReservationPayments } from './reservationFinance';
import { deleteCleaningLogTaskUpdates, renameRoomCleaningTasks, roomCleaningTaskUpdates } from './cleaningStore';
import { DEFAULT_ROOM_CATEGORIES, roomCategoriesOf, type HousekeepingData, type HousekeepingRoom, type Reservation, type ReservationCollection, type ReservationDirectoryEntry, type ReservationExtra, type ReservationStatus, type RoomCategoryRecord, type RoomCleaningLog, type RoomDayPlan } from '../types/housekeeping';
import { guestStayOccupiesToday, reservationOverlaps, reservationOverlapsStay } from './reservationAnalytics';

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

function isQuarterHour(time: string | undefined): boolean {
  if (!time || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) return false;
  return Number(time.slice(3)) % 15 === 0;
}

function validateReservationPeriod(reservation: Reservation): void {
  const start = Date.parse(`${reservation.checkInDate}T${reservation.channel === 'rotativo' ? reservation.checkInTime : '00:00'}:00`);
  const end = Date.parse(`${reservation.checkOutDate}T${reservation.channel === 'rotativo' ? reservation.checkOutTime : '00:00'}:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('O horário de checkout deve ser posterior ao check-in.');
  if (reservation.channel === 'rotativo') {
    if (!isQuarterHour(reservation.checkInTime)) throw new Error('O horário do Rotativo deve iniciar em intervalos de 15 minutos.');
    if (end - start !== 4 * 60 * 60 * 1000) throw new Error('Reservas Rotativo devem ter exatamente quatro horas.');
  } else {
    const nights = Math.round((Date.parse(`${reservation.checkOutDate}T00:00:00Z`) - Date.parse(`${reservation.checkInDate}T00:00:00Z`)) / 86_400_000);
    if (nights < 1 || nights > 365) throw new Error('A hospedagem deve ter entre 1 e 365 noites.');
  }
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

export function subscribeReservationWorkspace(
  dateRange: { from: string; to: string },
  onChange: (data: HousekeepingData) => void,
  onError: (error: Error) => void,
  includeAudit = true,
): () => void {
  const keys = includeAudit ? ['rooms', 'reservations', 'auditLog'] as const : ['rooms', 'reservations'] as const;
  const loaded = new Set<string>();
  const values: Record<string, unknown> = {};
  const stops = keys.map((key) => {
    const path = ref(db, `erp_geral/quartos/${key}`);
    const listener = key === 'reservations'
      ? query(path, orderByChild('checkInDate'), startAt(dateRange.from), endAt(dateRange.to))
      : key === 'auditLog'
        ? query(path, orderByChild('occurredAt'), limitToLast(100))
        : path;
    return onValue(listener, (snapshot) => {
      values[key] = snapshot.val() ?? {};
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

export function subscribeRoomCategories(
  onChange: (categories: RoomCategoryRecord[]) => void,
  onError: (error: Error) => void,
): () => void {
  let categories: Record<string, RoomCategoryRecord> | undefined;
  let configured: boolean | undefined;
  const publish = () => {
    if (categories === undefined || configured === undefined) return;
    onChange(roomCategoriesOf({ categories, categoriesConfigured: configured }));
  };
  const stopCategories = onValue(ref(db, 'erp_geral/quartos/categories'), (snapshot) => {
    categories = snapshot.val() ?? {};
    publish();
  }, onError);
  const stopConfigured = onValue(ref(db, 'erp_geral/quartos/categoriesConfigured'), (snapshot) => {
    configured = Boolean(snapshot.val());
    publish();
  }, onError);
  return () => { stopCategories(); stopConfigured(); };
}

export function subscribeReservationDirectory(
  onChange: (reservations: Record<string, ReservationDirectoryEntry>) => void,
  onError: (error: Error) => void,
): () => void {
  return onValue(ref(db, 'erp_geral/quartos/reservationIndex'), (snapshot) => {
    onChange(snapshot.val() ?? {});
  }, onError);
}

export function subscribeReservationRecord(
  reservationId: string,
  onChange: (reservation: Reservation | null) => void,
  onError: (error: Error) => void,
): () => void {
  if (!reservationId || /[.#$[\]/]/.test(reservationId)) {
    onError(new Error('A reserva informada no link é inválida.'));
    return () => undefined;
  }
  return onValue(ref(db, `erp_geral/quartos/reservations/${reservationId}`), (snapshot) => {
    onChange(snapshot.val() as Reservation | null);
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
    ...(reservation.checkInTime ? { checkInTime: reservation.checkInTime } : {}),
    ...(reservation.checkOutTime ? { checkOutTime: reservation.checkOutTime } : {}),
    ...(reservation.channel ? { channel: reservation.channel } : {}),
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
  if (previous && previous.number !== room.number) {
    const [indexSnapshot, staysSnapshot] = await Promise.all([
      get(ref(db, 'erp_geral/quartos/reservationIndex')), get(ref(db, 'erp_geral/recepcao/stays')),
    ]);
    const linkedReservation = (Object.values(indexSnapshot.val() ?? {}) as ReservationDirectoryEntry[]).some((entry) =>
      (entry.roomId === room.id || entry.roomNumber === previous.number) && (entry.status === 'confirmada' || entry.status === 'hospedado'));
    const linkedStay = (Object.values(staysSnapshot.val() ?? {}) as GuestStay[]).some((stay) =>
      stay.roomNumber === previous.number && guestStayOccupiesToday(stay, currentLocalDateKey(), Date.now()));
    if (linkedReservation || linkedStay) throw new Error('Transfira ou finalize as reservas e hospedagens vinculadas antes de alterar o número do quarto.');
  }
  if (room.maintenanceStatus === 'em_manutencao') {
    const [indexSnapshot, staysSnapshot] = await Promise.all([
      get(ref(db, 'erp_geral/quartos/reservationIndex')),
      get(ref(db, 'erp_geral/recepcao/stays')),
    ]);
    const index = (indexSnapshot.val() ?? {}) as Record<string, ReservationDirectoryEntry>;
    const hasCurrentReservation = Object.values(index).some((entry) =>
      (entry.roomId === room.id || entry.roomNumber === room.number) && entry.status === 'hospedado');
    const hasCurrentStay = (Object.values(staysSnapshot.val() ?? {}) as GuestStay[]).some((stay) =>
      stay.roomNumber === room.number && guestStayOccupiesToday(stay, currentLocalDateKey(), Date.now()));
    if (hasCurrentReservation || hasCurrentStay) throw new Error('Faça o checkout do hóspede antes de bloquear o quarto para manutenção.');
    if (room.cleaningStatus === 'em_limpeza') room = { ...room, cleaningStatus: 'sujo' };
  }
  const cleaningUpdates = previous ? await roomCleaningTaskUpdates({ ...previous, maintenanceStatus: room.maintenanceStatus }, room.cleaningStatus, 'Gerência') : {};
  if (previous && previous.number !== room.number) Object.assign(cleaningUpdates, await renameRoomCleaningTasks(previous, room));
  await writeHousekeepingUpdates({ ...cleaningUpdates, [`erp_geral/quartos/rooms/${room.id}`]: room }, [
    { entity: 'room', before: previous ? { [room.id]: previous } : {}, after: { [room.id]: room } },
  ]);
}

export async function updateRoomMaintenanceStatus(roomId: string, status: HousekeepingRoom['maintenanceStatus']): Promise<void> {
  const snapshot = await get(ref(db, `erp_geral/quartos/rooms/${roomId}`));
  const room = snapshot.val() as HousekeepingRoom | null;
  if (!room) throw new Error('Este quarto foi excluído. Atualize a grade.');
  await saveHousekeepingRoom({ ...room, maintenanceStatus: status });
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
  const cleaningUpdates = await roomCleaningTaskUpdates(room, status, 'Gerência');
  await writeHousekeepingUpdates({ ...cleaningUpdates, [`erp_geral/quartos/rooms/${roomId}/cleaningStatus`]: status }, [
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
  const room = roomSnapshot.val() as HousekeepingRoom;
  const cleaningUpdates = next.cleaningRequest === 'dispensada' ? await roomCleaningTaskUpdates(room, 'sujo', 'Gerência') : {};
  if (next.cleaningRequest === 'dispensada' && room.cleaningStatus === 'em_limpeza') cleaningUpdates[`erp_geral/quartos/rooms/${roomId}/cleaningStatus`] = 'sujo';
  await writeHousekeepingUpdates({ ...cleaningUpdates, [`erp_geral/quartos/dailyPlans/${date}/${roomId}`]: next }, [
    { entity: 'room-plan', before: { [`${date}/${roomId}`]: previous }, after: { [`${date}/${roomId}`]: next } },
  ]);
}

export async function completeRoomCleaning(roomId: string, log: RoomCleaningLog): Promise<void> {
  const roomSnapshot = await get(ref(db, `erp_geral/quartos/rooms/${roomId}`));
  const currentRoom = roomSnapshot.val() as HousekeepingRoom | null;
  if (!currentRoom) throw new Error('Este quarto foi excluído. Atualize a tela.');
  const nextRoom = { ...currentRoom, cleaningStatus: 'limpo' as const };
  await writeHousekeepingUpdates({
    ...await roomCleaningTaskUpdates(currentRoom, 'limpo', log.attendant, log),
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
  const updates: Record<string, unknown> = { ...await deleteCleaningLogTaskUpdates(log), [`erp_geral/quartos/cleaningLogs/${log.id}`]: null };
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

const reservationDirectoryFingerprints = new Map<string, string>();

export async function syncReservationDirectory(reservations: Record<string, Reservation>): Promise<void> {
  const pending = Object.values(reservations).filter((reservation) =>
    reservationDirectoryFingerprints.get(reservation.id) !== JSON.stringify(activeReservationIndexValue(reservation)));
  if (!pending.length) return;
  const indexSnapshot = await get(ref(db, 'erp_geral/quartos/reservationIndex'));
  const index = (indexSnapshot.val() ?? {}) as Record<string, ReservationDirectoryEntry>;
  for (const reservation of pending) {
    const entry = activeReservationIndexValue(reservation);
    const fingerprint = JSON.stringify(entry);
    if (JSON.stringify(index[reservation.id] ?? null) === fingerprint) {
      reservationDirectoryFingerprints.set(reservation.id, fingerprint);
      continue;
    }
    // Backfill legacy indexes without restoring an older room, guest or status after an edit.
    await withReservationWriteLock(reservation.id, async () => {
      const snapshot = await get(ref(db, `erp_geral/quartos/reservations/${reservation.id}`));
      const current = snapshot.val() as Reservation | null;
      if (!current || current.updatedAt !== reservation.updatedAt || current.status !== reservation.status) return;
      await update(ref(db), { [`erp_geral/quartos/reservationIndex/${reservation.id}`]: activeReservationIndexValue(current) });
      reservationDirectoryFingerprints.set(reservation.id, fingerprint);
    });
  }
}

export async function createReservation(reservation: Reservation, current: HousekeepingData): Promise<void> {
  const room = current.rooms[reservation.roomId];
  if (!room) throw new Error('O quarto selecionado não existe.');
  if (room.maintenanceStatus === 'em_manutencao') throw new Error('Este quarto está indisponível para manutenção.');
  validateReservationPeriod(reservation);
  const staysSnapshot = await get(ref(db, 'erp_geral/recepcao/stays'));
  if ((Object.values(staysSnapshot.val() ?? {}) as GuestStay[]).some((stay) => reservationOverlapsStay(reservation, stay))) {
    throw new Error(`O quarto ${room.number} já tem uma hospedagem neste período.`);
  }
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

async function withReservationWriteLock<T>(reservationId: string, action: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const lockRef = ref(db, `erp_geral/reservationCollectionReconciliations/${reservationId}/writeLock`);
  let acquired = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await runTransaction(lockRef, (current: { token: string; startedAt: number } | null) => {
      if (current && Date.now() - current.startedAt < 5 * 60_000) return;
      return { token, startedAt: Date.now() };
    }, { applyLocally: false });
    if (result.committed) { acquired = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!acquired) throw new Error('Esta reserva está sendo atualizada. Aguarde e tente novamente.');
  try { return await action(); }
  finally {
    await runTransaction(lockRef, (current: { token: string } | null) => current?.token === token ? null : undefined,
      { applyLocally: false }).catch(() => undefined);
  }
}

async function readReservationFinance(reservationId: string) {
  const prefix = `reservation-${reservationId}-`;
  const [incomes, extras, collections, suppressed] = await Promise.all([
    get(query(ref(db, 'erp_geral/financeiro/incomes'), orderByKey(), startAt(prefix), endAt(`${prefix}\uf8ff`))),
    get(ref(db, `erp_geral/reservationExtras/${reservationId}`)),
    get(ref(db, `erp_geral/reservationCollections/${reservationId}`)),
    get(ref(db, 'erp_geral/financeiro/suppressed')),
  ]);
  return {
    incomes: (incomes.val() ?? {}) as Record<string, FinanceIncome>,
    extras: (extras.val() ?? {}) as Record<string, ReservationExtra>,
    collections: (collections.val() ?? {}) as Record<string, ReservationCollection>,
    suppressed: (suppressed.val() ?? {}) as Record<string, boolean>,
  };
}

export async function saveReservationRecord(
  reservation: Reservation,
  expected: Pick<Reservation, 'status' | 'updatedAt'>,
  paymentUpdates: FinanceIncome[] = [],
): Promise<void> {
  validateReservationPeriod(reservation);
  validateReservationPayments(reservation.id, paymentUpdates);
  await withReservationWriteLock(reservation.id, async () => {
    const [snapshot, finance, roomSnapshot, chargesSnapshot] = await Promise.all([
      get(ref(db, `erp_geral/quartos/reservations/${reservation.id}`)),
      readReservationFinance(reservation.id),
      get(ref(db, `erp_geral/quartos/rooms/${reservation.roomId}`)),
      get(ref(db, 'erp_geral/recepcao/roomCharges')),
    ]);
    const previous = snapshot.val() as Reservation | null;
    if (!previous || previous.status !== expected.status || previous.updatedAt !== expected.updatedAt) {
      throw new Error('A reserva mudou enquanto você editava. Atualize os dados e tente novamente.');
    }
    if (previous.status !== reservation.status) throw new Error('Use check-in, checkout ou cancelamento para alterar a situação da reserva.');
    const room = roomSnapshot.val() as HousekeepingRoom | null;
    if (!room) throw new Error('O quarto selecionado não existe mais.');
    if (hasReservationSlots(reservation) && room.maintenanceStatus === 'em_manutencao'
      && (previous.status !== 'hospedado' || previous.roomId !== reservation.roomId)) {
      throw new Error('Este quarto está indisponível para manutenção.');
    }
    if (previous.status === 'hospedado' && previous.roomId !== reservation.roomId && room.cleaningStatus !== 'limpo') {
      throw new Error('O quarto de destino precisa estar limpo para transferir a hospedagem.');
    }
    paymentUpdates.forEach((entry) => {
      if (finance.suppressed[entry.id]) throw new Error('Um recebimento foi anulado no Financeiro. Atualize a reserva antes de editar.');
      const currentIncome = finance.incomes[entry.id];
      if (currentIncome && currentIncome.updatedAt !== entry.updatedAt) {
        throw new Error('Um recebimento mudou no Fluxo de caixa enquanto você editava. Reabra a reserva para carregar os valores atualizados.');
      }
    });
    const timestamp = new Date().toISOString();
    const nextIncomes = { ...finance.incomes };
    paymentUpdates.forEach((entry) => { nextIncomes[entry.id] = entry; });
    const totalReceived = Object.values(nextIncomes).filter((entry) => !finance.suppressed[entry.id]).reduce((total, entry) => total + entry.amount, 0);
    const pendingReceived = Object.values(finance.collections).filter((collection) => {
      const incomeId = `reservation-${reservation.id}-checkout-${collection.id}`;
      return !nextIncomes[incomeId] && !finance.suppressed[incomeId];
    }).reduce((total, collection) => total + collection.amount, 0);
    if (totalReceived + pendingReceived > reservationFinancialTotal(reservation, finance.extras) + 0.001) {
      throw new Error('O valor recebido não pode ultrapassar o total da reserva e dos adicionais.');
    }
    const saved = { ...reservation, roomNumber: room.number,
      balanceDue: reservationBalanceDue(reservation, nextIncomes, finance.extras, {}, finance.suppressed),
      updatedAt: timestamp };
    const updates: Record<string, unknown> = {
      [`erp_geral/quartos/reservations/${reservation.id}`]: saved,
      [`erp_geral/quartos/reservationIndex/${reservation.id}`]: activeReservationIndexValue(saved),
    };
    const incomeAfter: Record<string, FinanceIncome> = {};
    Object.values(nextIncomes).filter((entry) => !finance.suppressed[entry.id]).forEach((entry) => {
      const contextual = { ...reservationIncomeContext(entry, previous, saved), updatedAt: timestamp };
      incomeAfter[entry.id] = contextual;
      updates[`erp_geral/financeiro/incomes/${entry.id}`] = contextual;
    });
    const charges = (Object.values(chargesSnapshot.val() ?? {}) as RoomCharge[]).filter((charge) => charge.sourceType === 'reservation' && charge.sourceId === reservation.id);
    for (const charge of charges) {
      const nextCharge = { ...charge, roomNumber: saved.roomNumber,
        guestName: charge.guestName === previous.guestName ? saved.guestName : charge.guestName };
      updates[`erp_geral/recepcao/roomCharges/${charge.id}`] = nextCharge;
      for (const entry of Object.values(roomChargeFinanceEntries(nextCharge))) {
        if (finance.suppressed[entry.id]) continue;
        const incomeSnapshot = await get(ref(db, `erp_geral/financeiro/incomes/${entry.id}`));
        const stored = incomeSnapshot.val() as FinanceIncome | null;
        updates[`erp_geral/financeiro/incomes/${entry.id}`] = stored?.operationalOverride
          ? { ...reservationIncomeContext(stored, previous, saved), updatedAt: timestamp }
          : { ...entry, updatedAt: timestamp };
      }
    }
    if (previous.status === 'hospedado' && previous.roomId !== saved.roomId) {
      const previousRoomSnapshot = await get(ref(db, `erp_geral/quartos/rooms/${previous.roomId}`));
      const previousRoom = previousRoomSnapshot.val() as HousekeepingRoom | null;
      if (previousRoom) {
        updates[`erp_geral/quartos/rooms/${previous.roomId}/cleaningStatus`] = 'sujo';
        Object.assign(updates, await roomCleaningTaskUpdates(previousRoom, 'sujo', 'Gerência'));
      }
    }
    const auditEvents = buildAuditEvents(crypto.randomUUID(), timestamp, [
      { entity: 'reservation', before: reservationsForAudit({ [reservation.id]: previous }), after: reservationsForAudit({ [reservation.id]: saved }) },
      { entity: 'finance-income', before: finance.incomes, after: incomeAfter },
    ]);
    Object.entries(auditEvents).forEach(([id, event]) => {
      updates[`erp_geral/${event.entity === 'finance-income' ? 'financeiro' : 'quartos'}/auditLog/${id}`] = event;
    });
    await update(ref(db), updates);
  });
}

export async function saveReservationBalanceDue(reservationId: string, balanceDue: number): Promise<void> {
  if (!Number.isFinite(balanceDue) || balanceDue < 0) throw new Error('O saldo da reserva precisa ser um valor válido.');
  await withReservationWriteLock(reservationId, async () => {
    const [snapshot, finance] = await Promise.all([
      get(ref(db, `erp_geral/quartos/reservations/${reservationId}`)), readReservationFinance(reservationId),
    ]);
    const previous = snapshot.val() as Reservation | null;
    if (!previous) throw new Error('A reserva não foi encontrada para atualizar o saldo.');
    const saved = { ...previous, balanceDue: reservationBalanceDue(previous, finance.incomes, finance.extras, {}, finance.suppressed) };
    await writeHousekeepingUpdates({ [`erp_geral/quartos/reservations/${reservationId}/balanceDue`]: saved.balanceDue }, [
      { entity: 'reservation', before: reservationsForAudit({ [reservationId]: previous }), after: reservationsForAudit({ [reservationId]: saved }) },
    ]);
  });
}

export async function cancelConfirmedReservation(reservationId: string): Promise<void> {
  await withReservationWriteLock(reservationId, async () => {
    const snapshot = await get(ref(db, `erp_geral/quartos/reservations/${reservationId}`));
    const previous = snapshot.val() as Reservation | null;
    if (!previous || previous.status !== 'confirmada') throw new Error('Somente reservas confirmadas podem ser canceladas. Atualize a lista.');
    const saved: Reservation = { ...previous, status: 'cancelada', updatedAt: new Date().toISOString() };
    await writeHousekeepingUpdates({
      [`erp_geral/quartos/reservations/${reservationId}`]: saved,
      [`erp_geral/quartos/reservationIndex/${reservationId}`]: null,
    }, [
      { entity: 'reservation', before: reservationsForAudit({ [reservationId]: previous }), after: reservationsForAudit({ [reservationId]: saved }) },
    ]);
    await releaseReservationSlots(previous);
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

function subscribeReservationScopedRecords<T>(
  collectionPath: string,
  reservationIds: string[],
  onChange: (records: Record<string, T>) => void,
  onError: (error: Error) => void,
): () => void {
  const ids = [...new Set(reservationIds)];
  onChange({});
  if (ids.length === 0) return () => undefined;
  const loaded = new Set<string>();
  const groups = new Map<string, Record<string, T>>();
  const publish = () => onChange(Object.assign({}, ...groups.values()));
  const stops = ids.map((reservationId) => onValue(ref(db, `${collectionPath}/${reservationId}`), (snapshot) => {
    groups.set(reservationId, (snapshot.val() ?? {}) as Record<string, T>);
    loaded.add(reservationId);
    if (loaded.size === ids.length) publish();
  }, onError));
  return () => stops.forEach((stop) => stop());
}

export function subscribeReservationCollections(
  onChange: (collections: Record<string, ReservationCollection>) => void,
  onError: (error: Error) => void,
  reservationIds?: string[],
): () => void {
  if (reservationIds) return subscribeReservationScopedRecords('erp_geral/reservationCollections', reservationIds, onChange, onError);
  return onValue(ref(db, 'erp_geral/reservationCollections'), (snapshot) => {
    const byReservation = snapshot.val() as Record<string, Record<string, ReservationCollection>> | null;
    onChange(Object.values(byReservation ?? {}).reduce<Record<string, ReservationCollection>>((all, collection) => ({ ...all, ...collection }), {}));
  }, onError);
}

export async function recordReservationCollection(collection: ReservationCollection): Promise<void> {
  const collectionRef = ref(db, `erp_geral/reservationCollections/${collection.reservationId}/${collection.id}`);
  const incomeId = `reservation-${collection.reservationId}-checkout-${collection.id}`;
  const [existing, incomeSnapshot, suppressedSnapshot] = await Promise.all([
    get(collectionRef), get(ref(db, `erp_geral/financeiro/incomes/${incomeId}`)),
    get(ref(db, `erp_geral/financeiro/suppressed/${incomeId}`)),
  ]);
  if (suppressedSnapshot.val()) throw new Error('Este recebimento foi anulado no Financeiro e não pode ser registrado novamente.');
  if (incomeSnapshot.exists()) {
    const income = incomeSnapshot.val() as FinanceIncome;
    if (income.amount === collection.amount) return;
    throw new Error('Este recebimento já foi conciliado com outro valor.');
  }
  if (existing.exists()) {
    const previous = existing.val() as ReservationCollection;
    if (previous.amount === collection.amount && previous.reservationId === collection.reservationId
      && previous.date === collection.date && previous.paymentMethod === collection.paymentMethod) return;
    throw new Error('Este recebimento já foi registrado com outros dados.');
  }
  await set(collectionRef, collection);
}

export function subscribeReservationExtras(
  onChange: (extras: Record<string, ReservationExtra>) => void,
  onError: (error: Error) => void,
  reservationIds?: string[],
): () => void {
  if (reservationIds) return subscribeReservationScopedRecords('erp_geral/reservationExtras', reservationIds, onChange, onError);
  return onValue(ref(db, 'erp_geral/reservationExtras'), (snapshot) => {
    const byReservation = snapshot.val() as Record<string, Record<string, ReservationExtra>> | null;
    onChange(Object.values(byReservation ?? {}).reduce<Record<string, ReservationExtra>>((all, extras) => ({ ...all, ...extras }), {}));
  }, onError);
}

export async function recordReservationExtra(extra: ReservationExtra): Promise<void> {
  await withReservationWriteLock(extra.reservationId, async () => {
    const [reservationSnapshot, finance] = await Promise.all([
      get(ref(db, `erp_geral/quartos/reservations/${extra.reservationId}`)), readReservationFinance(extra.reservationId),
    ]);
    const reservation = reservationSnapshot.val() as Reservation | null;
    if (!reservation || reservation.status !== 'hospedado') throw new Error('O adicional precisa estar vinculado a uma hospedagem ativa.');
    const previous = finance.extras[extra.id];
    if (previous) {
      if (previous.amount === extra.amount && previous.reservationId === extra.reservationId && previous.type === extra.type) return;
      throw new Error('Este adicional já foi lançado com outros dados.');
    }
    await update(ref(db), {
      [`erp_geral/reservationExtras/${extra.reservationId}/${extra.id}`]: extra,
      [`erp_geral/quartos/reservations/${extra.reservationId}/balanceDue`]: reservationBalanceDue(
        reservation, finance.incomes, { ...finance.extras, [extra.id]: extra }, {}, finance.suppressed,
      ),
    });
  });
}

export async function transitionReservation(
  reservation: Reservation,
  nextStatus: ReservationStatus,
): Promise<void> {
  const allowedTransition = (reservation.status === 'confirmada' && nextStatus === 'hospedado')
    || (reservation.status === 'hospedado' && nextStatus === 'encerrada');
  if (!allowedTransition) throw new Error('Esta transição de reserva não é permitida.');
  await withReservationWriteLock(reservation.id, async () => {
    const [snapshot, roomSnapshot, slotsSnapshot, finance] = await Promise.all([
      get(ref(db, `erp_geral/quartos/reservations/${reservation.id}`)),
      get(ref(db, `erp_geral/quartos/rooms/${reservation.roomId}`)),
      get(ref(db, `erp_geral/quartos/reservationSlots/${reservation.roomId}`)),
      readReservationFinance(reservation.id),
    ]);
    const current = snapshot.val() as Reservation | null;
    if (!current || current.status !== reservation.status || current.updatedAt !== reservation.updatedAt) {
      throw new Error('A reserva mudou. Atualize a tela antes de realizar o check-in ou checkout.');
    }
    const room = roomSnapshot.val() as HousekeepingRoom | null;
    if (!room) throw new Error('O quarto desta reserva não existe mais.');
    if (nextStatus === 'hospedado' && (room.cleaningStatus !== 'limpo' || room.maintenanceStatus === 'em_manutencao')) {
      throw new Error('O quarto precisa estar limpo e liberado para realizar o check-in.');
    }
    const timestamp = new Date().toISOString();
    const nextReservation: Reservation = { ...current, status: nextStatus, updatedAt: timestamp,
      balanceDue: reservationBalanceDue(current, finance.incomes, finance.extras, {}, finance.suppressed) };
    const updates: Record<string, unknown> = {
      [`erp_geral/quartos/reservations/${reservation.id}`]: nextReservation,
      [`erp_geral/quartos/reservationIndex/${reservation.id}`]: activeReservationIndexValue(nextReservation),
    };
    if (nextStatus === 'encerrada') {
      updates[`erp_geral/quartos/rooms/${current.roomId}/cleaningStatus`] = 'sujo';
      Object.assign(updates, await roomCleaningTaskUpdates(room, 'sujo', 'Gerência'));
      const slots = slotsSnapshot.val() as Record<string, unknown> | null ?? {};
      reservationSlotPaths(current).forEach((slotPath) => {
        const owner = slotPath.split('/').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, slots);
        if (owner === current.id) updates[`erp_geral/quartos/reservationSlots/${current.roomId}/${slotPath}`] = null;
      });
    }
    await writeHousekeepingUpdates(updates, [
      { entity: 'reservation', before: reservationsForAudit({ [current.id]: current }), after: reservationsForAudit({ [current.id]: nextReservation }) },
    ]);
  });
}

export async function releaseOccupiedRoom(input: { reservationId?: string; stayId?: string; roomId?: string }): Promise<void> {
  if (input.reservationId) {
    const [snapshot, finance] = await Promise.all([
      get(ref(db, `erp_geral/quartos/reservations/${input.reservationId}`)), readReservationFinance(input.reservationId),
    ]);
    const reservation = snapshot.val() as Reservation | null;
    if (!reservation || reservation.status !== 'hospedado') throw new Error('A hospedagem não está mais ativa. Atualize a grade.');
    if (reservationBalanceDue(reservation, finance.incomes, finance.extras, finance.collections, finance.suppressed) > 0) {
      throw new Error('Abra o checkout da reserva para conferir o saldo e registrar o recebimento antes de liberar o quarto.');
    }
    await transitionReservation(reservation, 'encerrada');
    return;
  }
  if (!input.stayId) throw new Error('Selecione uma hospedagem ativa para liberar o quarto.');
  await withReservationWriteLock(`stay-${input.stayId}`, async () => {
    const [snapshot, roomsSnapshot, receptionRoomsSnapshot] = await Promise.all([
      get(ref(db, `erp_geral/recepcao/stays/${input.stayId}`)),
      get(ref(db, 'erp_geral/quartos/rooms')),
      get(ref(db, 'erp_geral/recepcao/rooms')),
    ]);
    const stay = snapshot.val() as GuestStay | null;
    if (!stay || stay.status !== 'hospedado') throw new Error('A hospedagem não está mais ativa. Atualize a grade.');
    const rooms = (roomsSnapshot.val() ?? {}) as Record<string, HousekeepingRoom>;
    const existingRoom = input.roomId ? rooms[input.roomId] : Object.values(rooms).find((room) => room.number === stay.roomNumber);
    if (existingRoom && existingRoom.number !== stay.roomNumber) throw new Error('Esta hospedagem mudou de quarto. Atualize a grade.');
    const receptionRoom = (Object.values(receptionRoomsSnapshot.val() ?? {}) as { id: string; number: string }[])
      .find((room) => room.number === stay.roomNumber);
    const room: HousekeepingRoom = existingRoom ?? {
      id: receptionRoom?.id ?? `room-${stay.roomNumber.replace(/[.#$[\]/]/g, '-')}`,
      number: stay.roomNumber, cleaningStatus: 'sujo', maintenanceStatus: 'normal', note: '',
    };
    const nextStay: GuestStay = { ...stay, status: 'encerrado', checkOutDate: currentLocalDateKey() };
    await writeHousekeepingUpdates({
      ...await roomCleaningTaskUpdates(room, 'sujo', 'Gerência'),
      [`erp_geral/recepcao/stays/${stay.id}`]: nextStay,
      [`erp_geral/quartos/rooms/${room.id}`]: { ...room, cleaningStatus: 'sujo' },
    }, [
      { entity: 'stay', before: { [stay.id]: stay }, after: { [stay.id]: nextStay } },
      { entity: 'room', before: existingRoom ? { [room.id]: existingRoom } : {}, after: { [room.id]: { ...room, cleaningStatus: 'sujo' } } },
    ]);
  });
}

export async function syncReservationCollections(reservationIds?: string[]): Promise<void> {
  const collectionsByReservation = reservationIds
    ? Object.fromEntries(await Promise.all([...new Set(reservationIds)].map(async (reservationId) => {
      const snapshot = await get(ref(db, `erp_geral/reservationCollections/${reservationId}`));
      return [reservationId, snapshot.val() ?? {}];
    }))) as Record<string, Record<string, ReservationCollection>>
    : (await get(ref(db, 'erp_geral/reservationCollections'))).val() as Record<string, Record<string, ReservationCollection>> | null;

  for (const [reservationId, pending] of Object.entries(collectionsByReservation ?? {})) {
    if (!Object.keys(pending).length) continue;
    await withReservationWriteLock(reservationId, async () => {
      const [reservationSnapshot, finance] = await Promise.all([
        get(ref(db, `erp_geral/quartos/reservations/${reservationId}`)), readReservationFinance(reservationId),
      ]);
      const reservation = reservationSnapshot.val() as Reservation | null;
      if (!reservation) throw new Error('A reserva vinculada ao recebimento não foi encontrada.');
      const updates: Record<string, unknown> = {};
      const nextIncomes = { ...finance.incomes };
      const incomeAfter = { ...finance.incomes };
      Object.values(finance.collections).forEach((collection) => {
        const incomeId = `reservation-${reservationId}-checkout-${collection.id}`;
        updates[`erp_geral/reservationCollections/${reservationId}/${collection.id}`] = null;
        if (finance.suppressed[incomeId] || nextIncomes[incomeId]) return;
        const wallet = incomePaymentWallet(collection.paymentMethod);
        if (!wallet) throw new Error('O recebimento do checkout tem uma forma de pagamento inválida.');
        const income: FinanceIncome = {
          id: incomeId, date: collection.date, category: reservation.channel === 'rotativo' ? 'Rotativo' : 'Diária',
          amount: collection.amount, wallet,
          items: [{ id: incomeId, description: `Hospedagem · quarto ${reservation.roomNumber}`, amount: collection.amount, paymentMethod: collection.paymentMethod }],
          note: `Recebimento no checkout · ${collection.actor} · ${reservation.guestName}`,
          createdAt: collection.createdAt, updatedAt: new Date().toISOString(),
        };
        updates[`erp_geral/financeiro/incomes/${incomeId}`] = income;
        nextIncomes[incomeId] = income;
        incomeAfter[incomeId] = income;
      });
      if (!Object.keys(updates).length) return;
      updates[`erp_geral/quartos/reservations/${reservationId}/balanceDue`] = reservationBalanceDue(
        reservation, nextIncomes, finance.extras, {}, finance.suppressed,
      );
      const auditEvents = buildAuditEvents(crypto.randomUUID(), new Date().toISOString(), [
        { entity: 'finance-income', before: finance.incomes, after: incomeAfter },
      ]);
      Object.entries(auditEvents).forEach(([id, event]) => { updates[`erp_geral/financeiro/auditLog/${id}`] = event; });
      await update(ref(db), updates);
    });
  }
}

function hasReservationSlots(reservation: Reservation): boolean {
  return reservation.status === 'confirmada' || reservation.status === 'hospedado';
}

export async function reserveReservationSlots(reservation: Reservation): Promise<void> {
  if (!hasReservationSlots(reservation)) return;
  validateReservationPeriod(reservation);
  const [roomReservations, staysSnapshot] = await Promise.all([
    get(query(ref(db, 'erp_geral/quartos/reservationIndex'), orderByChild('roomId'), equalTo(reservation.roomId))),
    get(ref(db, 'erp_geral/recepcao/stays')),
  ]);
  if ((Object.values(staysSnapshot.val() ?? {}) as GuestStay[]).some((stay) => reservationOverlapsStay(reservation, stay))) {
    throw new Error(`O quarto ${reservation.roomNumber} já tem uma hospedagem neste período.`);
  }
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
  await runTransaction(ref(db, `erp_geral/quartos/reservationSlots/${reservation.roomId}`), (value) => {
    if (!value) return;
    const roomSlots = structuredClone(value) as Record<string, unknown>;
    removeReservationSlotPaths(roomSlots, reservation);
    return roomSlots;
  }, { applyLocally: false });
}

