import { endAt, get, increment, onValue, orderByChild, query, ref, remove, runTransaction, set, startAt, update } from 'firebase/database';
import { db } from '../config/firebase';
import { commitDeletion, removeChargeUpdates, removeFinanceEntries } from './deletionStore';
import { stayFinanceEntries } from './operationalLedger';
import { type CashOut, type FloatCheck, type GuestStay, type ReceptionData, type ReceptionRoom, type RoomCharge } from '../types/reception';
import { staffReference } from './staffStore';

const PATH = 'erp_geral/recepcao';

export function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function emptyReception(): ReceptionData {
  return { attendants: {}, stays: {}, roomCharges: {}, rooms: {}, cashOuts: {}, floatChecks: {} };
}

export function subscribeReception(onChange: (data: ReceptionData) => void, onError: (error: Error) => void, options: { includeHistoricalCharges?: boolean } = {}): () => void {
  const keys: (keyof ReceptionData)[] = ['stays', 'roomCharges', 'rooms', 'cashOuts', 'floatChecks'];
  const chargeStart = new Date();
  chargeStart.setDate(chargeStart.getDate() - 365);
  const loaded = new Set<keyof ReceptionData>();
  const current = { ...emptyReception() } as unknown as Record<string, unknown>;
  const stops = keys.map((key) => {
    const dataRef = ref(db, `${PATH}/${key}`);
    const dataQuery = key === 'roomCharges' && !options.includeHistoricalCharges
      ? query(dataRef, orderByChild('date'), startAt(localDateKey(chargeStart)), endAt(localDateKey()))
      : dataRef;
    return onValue(dataQuery, (snapshot) => {
      current[key] = snapshot.val() ?? {};
      loaded.add(key);
      if (loaded.size === keys.length) onChange({ ...current } as unknown as ReceptionData);
    }, onError);
  });
  return () => stops.forEach((stop) => stop());
}

export interface ReceptionBoardData {
  stays: Record<string, GuestStay>;
  roomCharges: Record<string, RoomCharge>;
  rooms: Record<string, ReceptionRoom>;
}

export function subscribeReceptionBoard(onChange: (data: ReceptionBoardData) => void, onError: (error: Error) => void, options: { includeRoomCharges?: boolean } = {}): () => void {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const from = new Date(today);
  from.setDate(from.getDate() - 365);
  const loaded = new Set<keyof ReceptionBoardData>();
  let stays: Record<string, GuestStay> = {};
  let roomCharges: Record<string, RoomCharge> = {};
  let rooms: Record<string, ReceptionRoom> = {};
  if (options.includeRoomCharges === false) loaded.add('roomCharges');
  const emit = (key: keyof ReceptionBoardData) => {
    loaded.add(key);
    if (loaded.size === 3) onChange({ stays, roomCharges, rooms });
  };
  const staysQuery = query(
    ref(db, `${PATH}/stays`),
    orderByChild('checkInDate'),
    startAt(localDateKey(from)),
    endAt(localDateKey(tomorrow)),
  );
  const stopStays = onValue(staysQuery, (snapshot) => {
    stays = snapshot.val() ?? {};
    emit('stays');
  }, onError);
  const stopRooms = onValue(ref(db, `${PATH}/rooms`), (snapshot) => {
    rooms = snapshot.val() ?? {};
    emit('rooms');
  }, onError);
  const roomChargesQuery = query(
    ref(db, `${PATH}/roomCharges`),
    orderByChild('date'),
    startAt(localDateKey(from)),
    endAt(localDateKey(today)),
  );
  const stopRoomCharges = options.includeRoomCharges === false ? () => {} : onValue(roomChargesQuery, (snapshot) => {
    roomCharges = snapshot.val() ?? {};
    emit('roomCharges');
  }, onError);
  return () => {
    stopStays();
    stopRooms();
    stopRoomCharges();
  };
}

export function saveRoom(room: ReceptionRoom): Promise<void> {
  return set(ref(db, `${PATH}/rooms/${room.id}`), room);
}

export function deleteRoom(id: string): Promise<void> {
  return remove(ref(db, `${PATH}/rooms/${id}`));
}

export function saveFloatCheck(check: FloatCheck): Promise<void> {
  return set(ref(db, `${PATH}/floatChecks/${check.id}`), { ...check, ...staffReference(check.attendant) });
}

export function deleteFloatCheck(id: string): Promise<void> { return remove(ref(db, `${PATH}/floatChecks/${id}`)); }

export function saveCashOut(cashOut: CashOut): Promise<void> {
  return set(ref(db, `${PATH}/cashOuts/${cashOut.id}`), { ...cashOut, ...staffReference(cashOut.attendant) });
}

export function saveStay(stay: GuestStay): Promise<void> {
  return set(ref(db, `${PATH}/stays/${stay.id}`), { ...stay, ...staffReference(stay.attendant) });
}

export async function saveRoomCharge(charge: RoomCharge): Promise<void> {
  charge = { ...charge, ...staffReference(charge.attendant) };
  const paymentLines = Object.values(charge.payments ?? {});
  const paidAmount = Math.round(paymentLines.reduce((total, payment) => total + payment.amount, 0) * 100) / 100;
  if (!charge.id || !charge.roomNumber.trim() || !charge.sourceId.trim() || !charge.guestName.trim()
    || !Number.isFinite(charge.amount) || charge.amount <= 0 || paymentLines.length === 0
    || paymentLines.some((payment) => !Number.isFinite(payment.amount) || payment.amount <= 0)
    || paidAmount !== Math.round(charge.amount * 100) / 100
    || !Number.isInteger(charge.days) || (charge.days ?? 0) < 1
    || (charge.kind === 'bebida' && (!charge.productId || !Number.isInteger(charge.quantity) || (charge.quantity ?? 0) < 1))) {
    throw new Error('Informe o hóspede, o valor e a forma completa de pagamento.');
  }
  const chargeRef = ref(db, `${PATH}/roomCharges/${charge.id}`);
  if (charge.kind !== 'bebida') {
    await set(chargeRef, charge);
    return;
  }

  const stockRef = ref(db, 'erp_geral/frigobar/operations/stock');
  let availableAtFailure = 0;
  const stockResult = await runTransaction(stockRef, (value) => {
    const stock = { ...(value as Record<string, unknown> | null ?? {}) };
    const available = Number(stock[charge.productId!] ?? 0);
    availableAtFailure = available;
    if (available < charge.quantity!) return;
    stock[charge.productId!] = available - charge.quantity!;
    return stock;
  });
  if (!stockResult.committed) {
    if (availableAtFailure < (charge.quantity ?? 0)) throw new Error(`Saldo insuficiente da bebida. Disponível: ${availableAtFailure}.`);
    throw new Error('Não foi possível reservar o saldo da bebida. Atualize a tela e tente novamente.');
  }
  try {
    await set(chargeRef, charge);
  } catch (cause) {
    const savedCharge = await get(chargeRef);
    if (!savedCharge.exists()) {
      await runTransaction(stockRef, (value) => {
        const stock = { ...(value as Record<string, unknown> | null ?? {}) };
        stock[charge.productId!] = Number(stock[charge.productId!] ?? 0) + (charge.quantity ?? 0);
        return stock;
      });
    }
    throw cause;
  }
}

export async function convertRotativoToDaily(rotativo: GuestStay, dailyStay: GuestStay): Promise<void> {
  if (rotativo.kind !== 'periodo' || rotativo.status !== 'hospedado'
    || dailyStay.kind !== 'hospede' || dailyStay.status !== 'hospedado'
    || rotativo.roomNumber !== dailyStay.roomNumber || rotativo.id === dailyStay.id) {
    throw new Error('Não foi possível converter este rotativo em diária. Atualize os quartos e tente novamente.');
  }
  await update(ref(db), {
    [`${PATH}/stays/${rotativo.id}/status`]: 'encerrado',
    [`${PATH}/stays/${dailyStay.id}`]: { ...dailyStay, ...staffReference(dailyStay.attendant), convertedFromStayId: rotativo.id },
  });
}

function incomeIdsForStay(stay: GuestStay): string[] {
  return Object.keys(stayFinanceEntries(stay));
}

export async function deleteStay(stay: GuestStay): Promise<void> {
  const [staySnapshot, chargeSnapshot] = await Promise.all([get(ref(db, `${PATH}/stays`)), get(ref(db, `${PATH}/roomCharges`))]);
  const stays = Object.values(staySnapshot.val() ?? {}) as GuestStay[];
  const ids = new Set([stay.id]);
  let previousSize = 0;
  while (previousSize !== ids.size) {
    previousSize = ids.size;
    stays.filter((item) => item.convertedFromStayId && ids.has(item.convertedFromStayId)).forEach((item) => ids.add(item.id));
  }
  const charges = (Object.values(chargeSnapshot.val() ?? {}) as RoomCharge[]).filter((item) => item.sourceType === 'stay' && ids.has(item.sourceId));
  const updates: Record<string, unknown> = {};
  stays.filter((item) => ids.has(item.id)).forEach((item) => {
    updates[`${PATH}/stays/${item.id}`] = null;
    removeFinanceEntries(updates, incomeIdsForStay({ ...item, voidedPayments: undefined }));
  });
  if (!Object.keys(updates).length) return;
  const stock: Record<string, number> = {};
  charges.forEach((charge) => {
    removeChargeUpdates(updates, charge);
    if (charge.kind === 'bebida' && charge.productId) stock[charge.productId] = (stock[charge.productId] ?? 0) + (charge.quantity ?? 0);
  });
  Object.entries(stock).forEach(([id, quantity]) => { updates[`erp_geral/frigobar/operations/stock/${id}`] = increment(quantity); });
  await commitDeletion([...ids].map((id) => `stay-${id}`).concat(charges.map((item) => `charge-${item.id}`)), updates);
}

export async function deleteCashOut(id: string): Promise<void> {
  const updates: Record<string, unknown> = { [`${PATH}/cashOuts/${id}`]: null };
  removeFinanceEntries(updates, [`caixa-${id}`], 'expenses');
  await commitDeletion([`cash-out-${id}`], updates);
}

export async function deleteRoomCharge(charge: RoomCharge): Promise<void> {
  const snapshot = await get(ref(db, `${PATH}/roomCharges/${charge.id}`));
  if (!snapshot.exists()) return;
  const current = snapshot.val() as RoomCharge;
  const updates: Record<string, unknown> = {};
  removeChargeUpdates(updates, current);
  if (current.kind === 'bebida' && current.productId) updates[`erp_geral/frigobar/operations/stock/${current.productId}`] = increment(current.quantity ?? 0);
  await commitDeletion([`charge-${current.id}`], updates);
}

