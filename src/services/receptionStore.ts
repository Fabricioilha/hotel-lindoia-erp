import { endAt, equalTo, get, increment, onValue, orderByChild, query, ref, remove, runTransaction, set, startAt, update } from 'firebase/database';
import { db } from '../config/firebase';
import { commitDeletion, removeChargeUpdates, removeFinanceEntries } from './deletionStore';
import { stayFinanceEntries, stayFinanceEntryIds, stayOyoFeeExpense } from './operationalLedger';
import { roomChargeFinanceEntries } from './operationalLedger';
import { reservationIncomeContext } from './reservationFinance';
import { roomCleaningTaskUpdates } from './cleaningStore';
import { withStockProductLocks } from './frigobarStore';
import { withTransactionData } from './firebaseTransactions';
import type { FinanceIncome } from '../types/finance';
import type { HousekeepingRoom } from '../types/housekeeping';
import { emptyReceptionRateSettings, type CashOut, type FloatCheck, type GuestStay, type ReceptionData, type ReceptionRateSettings, type ReceptionRoom, type RoomCharge } from '../types/reception';
import { staffReference } from './staffStore';

const PATH = 'erp_geral/recepcao';
const RATE_PATH = `${PATH}/rates`;

export function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fiveYearsAgoDateKey(): string {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  return localDateKey(cutoff);
}

export function emptyReception(): ReceptionData {
  return { attendants: {}, stays: {}, roomCharges: {}, rooms: {}, cashOuts: {}, floatChecks: {} };
}

export function subscribeReception(onChange: (data: ReceptionData) => void, onError: (error: Error) => void): () => void {
  const keys: (keyof ReceptionData)[] = ['stays', 'roomCharges', 'rooms', 'cashOuts', 'floatChecks'];
  const cutoff = fiveYearsAgoDateKey();
  const loaded = new Set<keyof ReceptionData>();
  const current = { ...emptyReception() } as unknown as Record<string, unknown>;
  const stops = keys.map((key) => {
    const dataRef = ref(db, `${PATH}/${key}`);
    const orderField = key === 'stays' ? 'checkInDate'
      : key === 'roomCharges' || key === 'cashOuts' ? 'date'
        : key === 'floatChecks' ? 'createdAt' : '';
    const dataQuery = orderField ? query(dataRef, orderByChild(orderField), startAt(cutoff)) : dataRef;
    return onValue(dataQuery, (snapshot) => {
      current[key] = snapshot.val() ?? {};
      loaded.add(key);
      if (loaded.size === keys.length) onChange({ ...current } as unknown as ReceptionData);
    }, onError);
  });
  return () => stops.forEach((stop) => stop());
}

export interface ReceptionStayDirectoryData {
  stays: Record<string, GuestStay>;
  rooms: Record<string, ReceptionRoom>;
}

export function subscribeReceptionStayDirectory(
  onChange: (data: ReceptionStayDirectoryData) => void,
  onError: (error: Error) => void,
  dateRange?: { from: string; to: string },
): () => void {
  let stays: Record<string, GuestStay> | undefined;
  let rooms: Record<string, ReceptionRoom> | undefined;
  const publish = () => {
    if (stays !== undefined && rooms !== undefined) onChange({ stays, rooms });
  };
  const staysRef = ref(db, PATH + '/stays');
  const staysQuery = dateRange
    ? query(staysRef, orderByChild('checkInDate'), startAt(dateRange.from), endAt(dateRange.to))
    : query(staysRef, orderByChild('checkInDate'), startAt(fiveYearsAgoDateKey()));
  const stopStays = onValue(staysQuery, (snapshot) => {
    stays = snapshot.val() ?? {};
    publish();
  }, onError);
  const stopRooms = onValue(ref(db, PATH + '/rooms'), (snapshot) => {
    rooms = snapshot.val() ?? {};
    publish();
  }, onError);
  return () => {
    stopStays();
    stopRooms();
  };
}

export function subscribeTodayCashOuts(onChange: (cashOuts: Record<string, CashOut>) => void, onError: (error: Error) => void): () => void {
  const today = localDateKey();
  const todayCashOuts = query(ref(db, `${PATH}/cashOuts`), orderByChild('date'), equalTo(today));
  return onValue(todayCashOuts, (snapshot) => onChange(snapshot.val() ?? {}), onError);
}

export function subscribeFloatCheck(id: string, onChange: (exists: boolean) => void, onError: (error: Error) => void): () => void {
  return onValue(ref(db, `${PATH}/floatChecks/${id}`), (snapshot) => onChange(snapshot.exists()), onError);
}

export function subscribeReceptionRates(onChange: (settings: ReceptionRateSettings) => void, onError: (error: Error) => void): () => void {
  return onValue(ref(db, RATE_PATH), (snapshot) => {
    const value = snapshot.val() as Partial<ReceptionRateSettings> | null;
    onChange({ ...emptyReceptionRateSettings(), ...value,
      roomRates: value?.roomRates ?? {}, roomRatesByGuests: value?.roomRatesByGuests ?? {},
      addOnRates: value?.addOnRates ?? {}, holidays: value?.holidays ?? {},
    });
  }, onError);
}

export async function saveReceptionRates(settings: ReceptionRateSettings): Promise<void> {
  const roomRates = Object.values(settings.roomRates).flatMap((rates) => Object.values(rates ?? {}));
  const roomRatesByGuests = Object.values(settings.roomRatesByGuests ?? {}).flatMap((guestRates) =>
    Object.values(guestRates).flatMap((rates) => Object.values(rates ?? {})));
  const addOnRates = Object.values(settings.addOnRates);
  if ([...roomRates, ...roomRatesByGuests, ...addOnRates].some((rate) => !Number.isFinite(rate) || rate! < 0)) {
    throw new Error('Os valores das diárias e adicionais devem ser números iguais ou maiores que zero.');
  }
  if (Object.entries(settings.holidays).some(([date, label]) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || !label.trim())) {
    throw new Error('Confira as datas e os nomes dos feriados cadastrados.');
  }
  await set(ref(db, RATE_PATH), settings);
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
  from.setDate(from.getDate() - 60);
  const loaded = new Set<keyof ReceptionBoardData>();
  let stays: Record<string, GuestStay> = {};
  let rangeStays: Record<string, GuestStay> = {};
  let activeStays: Record<string, GuestStay> = {};
  let rangeLoaded = false;
  let activeLoaded = false;
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
    rangeStays = snapshot.val() ?? {};
    rangeLoaded = true;
    stays = { ...rangeStays, ...activeStays };
    if (activeLoaded) emit('stays');
  }, onError);
  const activeQuery = query(ref(db, `${PATH}/stays`), orderByChild('status'), equalTo('hospedado'));
  const stopActiveStays = onValue(activeQuery, (snapshot) => {
    activeStays = snapshot.val() ?? {};
    activeLoaded = true;
    stays = { ...rangeStays, ...activeStays };
    if (rangeLoaded) emit('stays');
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
    stopActiveStays();
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

export async function updateStayAndFinance(stay: GuestStay): Promise<void> {
  const stayRef = ref(db, `${PATH}/stays/${stay.id}`);
  const snapshot = await get(stayRef);
  if (!snapshot.exists()) throw new Error('Esta hospedagem já foi excluída. Atualize a lista antes de editar.');

  const previous = snapshot.val() as GuestStay;
  const voidedPayments = { ...previous.voidedPayments, ...stay.voidedPayments };
  const updatedStay = { ...stay, ...staffReference(stay.attendant),
    ...(Object.keys(voidedPayments).length ? { voidedPayments } : {}) };
  const previousIds = stayFinanceEntryIds({ ...previous, voidedPayments: undefined });
  const nextEntries = stayFinanceEntries(updatedStay);
  const allIncomeIds = new Set([...previousIds, ...stayFinanceEntryIds({ ...updatedStay, voidedPayments: undefined })]);
  const incomeIds = [...allIncomeIds];
  const [savedIncomeSnapshots, savedFeeSnapshot, suppressedSnapshot, chargesSnapshot, roomsSnapshot] = await Promise.all([
    Promise.all(incomeIds.map((id) => get(ref(db, `erp_geral/financeiro/incomes/${id}`)))),
    get(ref(db, `erp_geral/financeiro/expenses/recepcao-${stay.id}-oyo-fee`)),
    get(ref(db, 'erp_geral/financeiro/suppressed')),
    get(ref(db, `${PATH}/roomCharges`)),
    get(ref(db, 'erp_geral/quartos/rooms')),
  ]);
  const savedIncomes: Record<string, FinanceIncome | null> = {};
  incomeIds.forEach((id, index) => { savedIncomes[id] = savedIncomeSnapshots[index].val() as FinanceIncome | null; });
  const suppressed = (suppressedSnapshot.val() ?? {}) as Record<string, boolean>;
  const timestamp = new Date().toISOString();
  const updates: Record<string, unknown> = { [`${PATH}/stays/${stay.id}`]: updatedStay };

  allIncomeIds.forEach((id) => {
    const entry = nextEntries[id];
    if (entry) {
      if (suppressed[id] || voidedPayments[id]) return;
      const saved = savedIncomes[id];
      updates[`erp_geral/financeiro/incomes/${id}`] = saved?.operationalOverride
        ? { ...reservationIncomeContext(saved, previous, updatedStay), updatedAt: timestamp }
        : { ...entry, createdAt: saved?.createdAt ?? entry.createdAt, updatedAt: timestamp };
    } else {
      updates[`erp_geral/financeiro/incomes/${id}`] = null;
      updates[`erp_geral/financeiro/suppressed/${id}`] = true;
    }
  });

  const feeId = `recepcao-${stay.id}-oyo-fee`;
  const fee = stayOyoFeeExpense(updatedStay);
  const feeHasManagerOverride = Boolean(fee && (savedFeeSnapshot.val() as { operationalOverride?: boolean } | null)?.operationalOverride);
  if (!feeHasManagerOverride && !suppressed[feeId]) {
    updates[`erp_geral/financeiro/expenses/${feeId}`] = fee ? { ...fee, updatedAt: timestamp } : null;
    updates[`erp_geral/financeiro/suppressed/${feeId}`] = fee ? null : true;
  }
  const linkedCharges = (Object.values(chargesSnapshot.val() ?? {}) as RoomCharge[]).filter((charge) => charge.sourceType === 'stay' && charge.sourceId === stay.id);
  for (const charge of linkedCharges) {
    const nextCharge = { ...charge, roomNumber: updatedStay.roomNumber,
      guestName: charge.guestName === previous.guestName ? updatedStay.guestName || charge.guestName : charge.guestName };
    updates[`${PATH}/roomCharges/${charge.id}`] = nextCharge;
    for (const entry of Object.values(roomChargeFinanceEntries(nextCharge))) {
      if (suppressed[entry.id]) continue;
      const savedSnapshot = await get(ref(db, `erp_geral/financeiro/incomes/${entry.id}`));
      const saved = savedSnapshot.val() as FinanceIncome | null;
      updates[`erp_geral/financeiro/incomes/${entry.id}`] = saved?.operationalOverride
        ? { ...reservationIncomeContext(saved, previous, updatedStay), updatedAt: timestamp }
        : { ...entry, updatedAt: timestamp };
    }
  }
  if (previous.status === 'hospedado' && previous.roomNumber !== updatedStay.roomNumber) {
    const previousRoom = (Object.values(roomsSnapshot.val() ?? {}) as HousekeepingRoom[]).find((room) => room.number === previous.roomNumber);
    if (previousRoom) {
      updates[`erp_geral/quartos/rooms/${previousRoom.id}/cleaningStatus`] = 'sujo';
      Object.assign(updates, await roomCleaningTaskUpdates(previousRoom, 'sujo', 'Gerência'));
    }
  }
  await update(ref(db), updates);
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
  if ((await get(chargeRef)).exists()) return;
  if (charge.sourceType !== 'stay' && charge.sourceType !== 'reservation') throw new Error('Selecione uma hospedagem válida antes de registrar o adicional.');
  const sourcePath = charge.sourceType === 'stay' ? `${PATH}/stays/${charge.sourceId}` : `erp_geral/quartos/reservationIndex/${charge.sourceId}`;
  const source = (await get(ref(db, sourcePath))).val() as { roomNumber?: string; guestName?: string; status?: string } | null;
  if (!source || source.status !== 'hospedado' || source.roomNumber !== charge.roomNumber) throw new Error('Esta hospedagem foi alterada ou encerrada. Atualize o quarto antes de cobrar o adicional.');
  if (charge.kind !== 'bebida') {
    await withStockProductLocks([`charge-${charge.id}`], async () => {
      if (!(await get(chargeRef)).exists()) await set(chargeRef, charge);
    });
    return;
  }

  await withStockProductLocks([charge.productId!, `charge-${charge.id}`], async () => {
    if ((await get(chargeRef)).exists()) return;
    let availableAtFailure = 0;
    const stockResult = await withTransactionData('erp_geral/frigobar/operations/stock', (stockRef) => runTransaction(stockRef, (value) => {
      const stock = { ...(value as Record<string, unknown> | null ?? {}) };
      const available = Number(stock[charge.productId!] ?? 0);
      availableAtFailure = available;
      if (available < charge.quantity!) return;
      stock[charge.productId!] = available - charge.quantity!;
      return stock;
    }, { applyLocally: false }));
    if (!stockResult.committed) {
      if (availableAtFailure < (charge.quantity ?? 0)) throw new Error(`Saldo insuficiente da bebida. Disponível: ${availableAtFailure}.`);
      throw new Error('Não foi possível reservar o saldo da bebida. Atualize a tela e tente novamente.');
    }
    try {
      await set(chargeRef, charge);
    } catch (cause) {
      const savedCharge = await get(chargeRef);
      if (!savedCharge.exists()) {
        await withTransactionData('erp_geral/frigobar/operations/stock', (stockRef) => runTransaction(stockRef, (value) => {
          const stock = { ...(value as Record<string, unknown> | null ?? {}) };
          stock[charge.productId!] = Number(stock[charge.productId!] ?? 0) + (charge.quantity ?? 0);
          return stock;
        }, { applyLocally: false }));
      } else {
        return;
      }
      throw cause;
    }
  });
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
    removeFinanceEntries(updates, stayFinanceEntryIds({ ...item, voidedPayments: undefined }));
    removeFinanceEntries(updates, [`recepcao-${item.id}-oyo-fee`], 'expenses');
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

