import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BackToPanel } from '../../components/ui/BackToPanel';
import { useAttendant } from '../../services/useAttendant';
import { ActionCard } from '../../components/ui/ActionCard';
import type { UserRole } from '../../types';
import { DateInput } from '../../components/ui/DateInput';
import { PAYMENT_METHOD_LABELS, type FinancePaymentMethod } from '../../types/finance';
import {
  EXTRA_LABELS, FOLIO_PAYMENT_METHODS, ROOM_TYPE_LABELS, SELECTABLE_EXTRAS, extraTotal,
  stayDailyAmount,
  emptyReceptionRateSettings,
  type ExtraType, type GuestStay, type ReceptionData, type ReceptionRateSettings, type ReceptionRoom, type StayExtra, type StayKind,
} from '../../types/reception';
import { subscribeReservationDirectory, subscribeRoomDirectory } from '../../services/housekeepingStore';
import { roomCategoryDescription, type HousekeepingRoom, type ReservationDirectoryEntry } from '../../types/housekeeping';
import { emptyReception, localDateKey, saveStay, subscribeReception, subscribeReceptionRates, updateStayAndFinance } from '../../services/receptionStore';
import '../venda-geladeira.css';
import './recepcao.css';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const taxLabel = (method: FinancePaymentMethod) => method === 'prepaid' ? 'Pré-pago (já quitado)' : `Balcão - ${PAYMENT_METHOD_LABELS[method]}`;
const DAY_MS = 86_400_000;

function dateKeyAfterDays(dateKey: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '';
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function nightsBetweenDates(checkInDate: string, checkOutDate: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkInDate) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOutDate)) return 0;
  const checkIn = Date.parse(`${checkInDate}T00:00:00Z`);
  const checkOut = Date.parse(`${checkOutDate}T00:00:00Z`);
  return Number.isFinite(checkIn) && Number.isFinite(checkOut) ? Math.round((checkOut - checkIn) / DAY_MS) : 0;
}

function stayInterval(stay: GuestStay) {
  if (stay.kind === 'periodo') {
    const start = stay.checkInDate === localDateKey() ? Date.parse(stay.createdAt) : Date.parse(`${stay.checkInDate}T12:00:00`);
    return { start, end: start + (stay.hours ?? 4) * 3_600_000 };
  }
  const start = Date.parse(`${stay.checkInDate}T00:00:00`);
  return { start, end: start + stay.nights * DAY_MS };
}

function reservationInterval(reservation: ReservationDirectoryEntry) {
  if (!reservation.checkInDate || !reservation.checkOutDate) return undefined;
  const rotativo = reservation.channel === 'rotativo' && reservation.checkInTime && reservation.checkOutTime;
  const start = Date.parse(`${reservation.checkInDate}T${rotativo ? reservation.checkInTime : '00:00'}:00`);
  const end = Date.parse(`${reservation.checkOutDate}T${rotativo ? reservation.checkOutTime : '00:00'}:00`);
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : undefined;
}

function intervalsOverlap(left: { start: number; end: number }, right: { start: number; end: number }) {
  return left.start < right.end && right.start < left.end;
}

function parseAmount(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 0;
}

function parseOptionalRate(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : undefined;
}

interface ExtraDraft { id: string; type: ExtraType; label: string; amount: string; method: FinancePaymentMethod; mode: 'fixo' | 'por_diaria' }

export interface ReceptionEntryContext {
  stays: Record<string, GuestStay>;
  rooms: Record<string, ReceptionRoom>;
  roomDirectory: Record<string, HousekeepingRoom>;
  reservations: Record<string, ReservationDirectoryEntry>;
  attendant: string;
}

interface CaixaRecepcaoProps {
  userRole: UserRole;
  modalOnly?: boolean;
  initialKind?: StayKind;
  initialRoom?: string;
  editingStay?: GuestStay;
  entryContext?: ReceptionEntryContext;
  onModalClose?: (notice?: string) => void;
}

export function CaixaRecepcao(props: CaixaRecepcaoProps) {
  const [searchParams] = useSearchParams();
  const requested = props.editingStay
    ? (props.editingStay.kind === 'periodo' ? 'rotativo' : 'hospede')
    : props.modalOnly
      ? (props.initialKind === 'periodo' ? 'rotativo' : 'hospede')
      : searchParams.get('novo');
  const requestedRoom = props.editingStay?.roomNumber ?? (props.modalOnly ? props.initialRoom ?? '' : searchParams.get('quarto') ?? '');
  const formKey = props.editingStay ? `edit:${props.editingStay.id}` : `${props.modalOnly ? 'modal' : 'page'}:${requested ?? ''}:${requestedRoom}`;
  return <CaixaRecepcaoContent key={formKey} {...props} />;
}

function CaixaRecepcaoContent({ userRole, modalOnly = false, initialKind = 'hospede', initialRoom = '', editingStay, entryContext, onModalClose }: CaixaRecepcaoProps) {
  const isAdmin = userRole === 'admin';
  const [receptionData, setReceptionData] = useState<ReceptionData>(() => emptyReception());
  const [rateSettings, setRateSettings] = useState<ReceptionRateSettings>(() => emptyReceptionRateSettings());
  const [subscribedRoomDirectory, setSubscribedRoomDirectory] = useState<Record<string, HousekeepingRoom>>({});
  const [subscribedReservationDirectory, setSubscribedReservationDirectory] = useState<Record<string, ReservationDirectoryEntry>>({});
  const [subscribedReservationDirectoryLoaded, setSubscribedReservationDirectoryLoaded] = useState(false);
  const data = entryContext
    ? { ...receptionData, stays: entryContext.stays, rooms: entryContext.rooms }
    : receptionData;
  const roomDirectory = entryContext?.roomDirectory ?? subscribedRoomDirectory;
  const reservationDirectory = entryContext?.reservations ?? subscribedReservationDirectory;
  const reservationDirectoryLoaded = Boolean(entryContext) || subscribedReservationDirectoryLoaded;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dutyAttendant = useAttendant();
  const attendant = isAdmin ? 'Gerência' : entryContext?.attendant ?? dutyAttendant;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = editingStay
    ? (editingStay.kind === 'periodo' ? 'rotativo' : 'hospede')
    : modalOnly
      ? (initialKind === 'periodo' ? 'rotativo' : 'hospede')
      : searchParams.get('novo');
  const requestedRoom = editingStay?.roomNumber ?? (modalOnly ? initialRoom : searchParams.get('quarto') ?? '');
  const formKind: StayKind | null = requested === 'hospede' ? 'hospede' : requested === 'rotativo' ? 'periodo' : null;
  const initialCheckIn = editingStay?.checkInDate ?? localDateKey();
  const initialNights = Math.max(1, editingStay?.nights ?? 1);
  const initialRate = editingStay ? stayDailyAmount(editingStay) / initialNights : 0;
  const initialRateText = editingStay?.kind === 'hospede' ? String(Math.round(initialRate * 100) / 100).replace('.', ',') : '';
  const [checkInDate, setCheckInDate] = useState(() => initialCheckIn);
  const [checkOutDate, setCheckOutDate] = useState(() => editingStay?.checkOutDate ?? dateKeyAfterDays(initialCheckIn, initialNights));
  const [roomNumber, setRoomNumber] = useState(() => requestedRoom);
  const [guestName, setGuestName] = useState(() => editingStay?.guestName ?? '');
  const [guestCount, setGuestCount] = useState(() => String(editingStay?.guestCount ?? (editingStay?.hasAdditionalGuests ? 2 : 1)));
  const [hours, setHours] = useState(() => String(editingStay?.hours ?? 4));
  const [dailyRate, setDailyRate] = useState(() => editingStay?.kind === 'periodo' ? String(editingStay.dailyRate).replace('.', ',') : '');
  const [dailyRateText, setDailyRateText] = useState(() => initialRateText);
  const [dailyMethod, setDailyMethod] = useState<FinancePaymentMethod>(() => editingStay?.dailyMethod ?? 'pix');
  const [splitPayment, setSplitPayment] = useState(() => Boolean(editingStay?.dailySplit));
  const [splitMethod, setSplitMethod] = useState<FinancePaymentMethod>(() => editingStay?.dailySplit?.method ?? 'cash');
  const [splitAmount, setSplitAmount] = useState(() => editingStay?.dailySplit ? String(editingStay.dailySplit.amount).replace('.', ',') : '');
  const [hasBreakfast, setHasBreakfast] = useState(() => Boolean(editingStay?.hasBreakfast));
  const [breakfastCount, setBreakfastCount] = useState(() => String(editingStay?.breakfastCount ?? 1));
  const [breakfastDays, setBreakfastDays] = useState(() => String(editingStay?.breakfastDays ?? editingStay?.nights ?? 1));
  const [breakfastRate, setBreakfastRate] = useState(() => editingStay?.hasBreakfast ? String(editingStay.breakfastRate).replace('.', ',') : '');
  const [breakfastMethod, setBreakfastMethod] = useState<FinancePaymentMethod>(() => editingStay?.breakfastMethod ?? editingStay?.dailyMethod ?? 'pix');
  const [breakfastSplitPayment, setBreakfastSplitPayment] = useState(() => Boolean(editingStay?.breakfastSplit));
  const [breakfastSplitMethod, setBreakfastSplitMethod] = useState<FinancePaymentMethod>(() => editingStay?.breakfastSplit?.method ?? 'cash');
  const [breakfastSplitAmount, setBreakfastSplitAmount] = useState(() => editingStay?.breakfastSplit ? String(editingStay.breakfastSplit.amount).replace('.', ',') : '');
  const [hasTax, setHasTax] = useState(() => Boolean(editingStay && editingStay.taxAmount > 0));
  const [taxAmount, setTaxAmount] = useState(() => editingStay?.taxAmount ? String(editingStay.taxAmount).replace('.', ',') : '');
  const [taxMethod, setTaxMethod] = useState<FinancePaymentMethod>(() => editingStay?.taxMethod ?? 'cash');
  const [taxSplitPayment, setTaxSplitPayment] = useState(() => Boolean(editingStay?.taxSplit));
  const [taxSplitMethod, setTaxSplitMethod] = useState<FinancePaymentMethod>(() => editingStay?.taxSplit?.method ?? 'prepaid');
  const [taxSplitAmount, setTaxSplitAmount] = useState(() => editingStay?.taxSplit ? String(editingStay.taxSplit.amount).replace('.', ',') : '');
  const [extras, setExtras] = useState<ExtraDraft[]>(() => (editingStay?.extras ?? []).map((extra) => ({ ...extra, amount: String(extra.amount).replace('.', ','), method: extra.method ?? editingStay?.dailyMethod ?? 'pix', mode: extra.mode ?? 'fixo' })));
  const [note, setNote] = useState(() => editingStay?.note ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (entryContext) return;
    return subscribeReception((next) => {
      setReceptionData(next);
    }, (cause) => {
      setError(cause.message);
    });
  }, [entryContext]);

  useEffect(() => subscribeReceptionRates(setRateSettings, (cause) => {
    setError(`Não foi possível carregar as tarifas: ${cause.message}`);
  }), []);

  useEffect(() => {
    if (entryContext) return;
    return subscribeRoomDirectory(
      setSubscribedRoomDirectory,
      () => setSubscribedRoomDirectory({}),
    );
  }, [entryContext]);

  useEffect(() => {
    if (entryContext) return;
    return subscribeReservationDirectory((next) => {
      setSubscribedReservationDirectory(next);
      setSubscribedReservationDirectoryLoaded(true);
    }, (cause) => {
      setError(`Não foi possível consultar a disponibilidade dos quartos: ${cause.message}`);
      setSubscribedReservationDirectoryLoaded(false);
    });
  }, [entryContext]);

  const today = localDateKey();
  const allRoomNumbers = [...new Set([...Object.values(roomDirectory).map((room) => room.number), ...Object.values(data.rooms).map((room) => room.number), ...(editingStay?.roomNumber ? [editingStay.roomNumber] : [])])]
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  const roomByNumber = new Map(Object.values(roomDirectory).map((room) => [room.number, room]));
  const receptionRoomByNumber = new Map(Object.values(data.rooms).map((room) => [room.number, room]));
  const describeRoom = (number: string) => {
    const receptionRoom = receptionRoomByNumber.get(number);
    const room = roomByNumber.get(number);
    if (room?.categoryName || room?.bedComposition) return roomCategoryDescription(room);
    if (room?.bedCount && receptionRoom) return `${ROOM_TYPE_LABELS[receptionRoom.type].split(' · ')[0]} · ${room.bedCount} ${room.bedCount === 1 ? 'cama' : 'camas'}`;
    if (receptionRoom) return ROOM_TYPE_LABELS[receptionRoom.type];
    if (room?.category) return roomCategoryDescription(room);
    if (room?.bedCount) return `${room.bedCount} ${room.bedCount === 1 ? 'cama' : 'camas'}`;
    return 'Tipo e camas não informados';
  };

  const draftHours = Math.min(24, Math.max(1, Math.floor(Number(hours) || 4)));
  const calculatedNights = nightsBetweenDates(checkInDate, checkOutDate);
  const draftNights = formKind === 'periodo' ? 1 : Math.max(1, Math.min(60, calculatedNights || 1));
  const draftGuestCount = Number(guestCount);
  const draftBreakfastCount = Number(breakfastCount);
  const draftBreakfastDays = Number(breakfastDays);
  const enteredDailyRate = parseOptionalRate(dailyRateText);
  const unchangedStayRateAndPeriod = Boolean(editingStay?.kind === 'hospede'
    && dailyRateText === initialRateText
    && checkInDate === editingStay.checkInDate
    && checkOutDate === (editingStay.checkOutDate ?? dateKeyAfterDays(editingStay.checkInDate, initialNights)));
  const dailyTotal = formKind === 'hospede'
    ? unchangedStayRateAndPeriod ? stayDailyAmount(editingStay!) : Math.round((enteredDailyRate ?? 0) * draftNights * 100) / 100
    : parseAmount(dailyRate) * draftNights;
  const breakfastTotal = parseAmount(breakfastRate) * draftBreakfastCount * draftBreakfastDays;
  const breakfastSplit = breakfastSplitPayment ? parseAmount(breakfastSplitAmount) : 0;
  const appliedBreakfastSplit = breakfastSplitPayment && breakfastSplit > 0 && breakfastSplit < breakfastTotal ? breakfastSplit : 0;
  const breakfastPrepaidAmount = hasBreakfast
    ? (breakfastMethod === 'prepaid' ? breakfastTotal - appliedBreakfastSplit : 0)
      + (breakfastSplitPayment && breakfastSplitMethod === 'prepaid' ? appliedBreakfastSplit : 0)
    : 0;
  const breakfastHotelAmount = Math.max(0, Math.round((breakfastTotal - breakfastPrepaidAmount) * 100) / 100);
  const tax = parseAmount(taxAmount);
  const taxSplit = taxSplitPayment ? parseAmount(taxSplitAmount) : 0;
  const appliedTaxSplit = taxSplitPayment && taxSplit > 0 && taxSplit < tax ? taxSplit : 0;
  const taxHotelAmount = hasTax
    ? (taxMethod !== 'prepaid' ? tax - (taxSplitMethod === 'prepaid' ? appliedTaxSplit : 0) : 0)
      + (taxSplitMethod !== 'prepaid' ? appliedTaxSplit : 0)
    : 0;
  const taxPrepaidAmount = hasTax
    ? (taxMethod === 'prepaid' ? tax - (taxSplitMethod === 'prepaid' ? appliedTaxSplit : 0) : 0)
      + (taxSplitMethod === 'prepaid' ? appliedTaxSplit : 0)
    : 0;
  const draftSplit = splitPayment ? parseAmount(splitAmount) : 0;
  const appliedDailySplit = splitPayment && draftSplit > 0 && draftSplit < dailyTotal ? draftSplit : 0;
  const dailyPrepaidAmount = (dailyMethod === 'prepaid' ? dailyTotal - appliedDailySplit : 0)
    + (splitPayment && splitMethod === 'prepaid' ? appliedDailySplit : 0);
  const dailyHotelAmount = Math.max(0, Math.round((dailyTotal - dailyPrepaidAmount) * 100) / 100);
  const draftExtras = extras.map((extra) => ({ ...extra, amount: parseAmount(extra.amount) }));
  const extrasTotal = draftExtras.reduce((total, extra) => total + extraTotal(extra, draftNights), 0);
  const extrasPrepaidTotal = draftExtras.filter((extra) => extra.method === 'prepaid').reduce((total, extra) => total + extraTotal(extra, draftNights), 0);
  const extrasHotelTotal = Math.max(0, Math.round((extrasTotal - extrasPrepaidTotal) * 100) / 100);
  const oyoRetainedTotal = dailyPrepaidAmount + breakfastPrepaidAmount + extrasPrepaidTotal;
  const draftTotal = (formKind === 'hospede' ? dailyHotelAmount : dailyTotal)
    + (formKind === 'hospede' && hasBreakfast ? breakfastHotelAmount : 0)
    + (formKind === 'hospede' ? taxHotelAmount : 0)
    + extrasHotelTotal;

  function changeCheckInDate(nextDate: string) {
    setCheckInDate(nextDate);
    if (!nextDate) return;
    const nextCheckOutDate = checkOutDate > nextDate ? checkOutDate : dateKeyAfterDays(nextDate, 1);
    if (nextCheckOutDate !== checkOutDate) setCheckOutDate(nextCheckOutDate);
    const nightsForDates = nightsBetweenDates(nextDate, nextCheckOutDate);
    if (nightsForDates > 0) setBreakfastDays((current) => String(Math.min(Number(current) || 1, Math.min(60, nightsForDates))));
  }

  function changeCheckOutDate(nextDate: string) {
    setCheckOutDate(nextDate);
    const nightsForDates = nightsBetweenDates(checkInDate, nextDate);
    if (nightsForDates > 0) setBreakfastDays((current) => String(Math.min(Number(current) || 1, Math.min(60, nightsForDates))));
  }

  async function run(action: () => Promise<void>, success = '') {
    setError('');
    setNotice('');
    try {
      await action();
      if (success) setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a operação.');
    }
  }

  function openForm(kind: StayKind) {
    setError('');
    setNotice('');
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('novo', kind === 'periodo' ? 'rotativo' : 'hospede');
    setSearchParams(nextParams);
  }

  function closeForm() {
    if (modalOnly) {
      onModalClose?.();
      return;
    }
    setSearchParams({}, { replace: true });
  }

  function cancelForm() {
    if (modalOnly) {
      onModalClose?.();
      return;
    }
    navigate('/', { replace: true });
  }

  useEffect(() => {
    if (!formKind) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) {
        if (modalOnly) onModalClose?.();
        else navigate('/', { replace: true });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [formKind, saving, navigate, modalOnly, onModalClose]);

  function addExtra(type: ExtraType) {
    const mode = type === 'cama_extra' || type === 'hospede_extra' ? 'por_diaria' : 'fixo';
    const suggested = rateSettings.addOnRates[type];
    setExtras((current) => [...current, { id: crypto.randomUUID(), type, label: type === 'outros' ? '' : EXTRA_LABELS[type], amount: suggested === undefined ? '' : String(suggested).replace('.', ','), method: 'pix', mode }]);
  }

  function updateExtra(id: string, patch: Partial<ExtraDraft>) {
    setExtras((current) => current.map((extra) => extra.id === id ? { ...extra, ...patch } : extra));
  }

  async function submitStay(event: FormEvent) {
    event.preventDefault();
    if (!formKind) return;
    const rate = formKind === 'hospede' ? enteredDailyRate ?? 0 : parseAmount(dailyRate);
    const withBreakfast = formKind === 'hospede' && hasBreakfast;
    const breakfast = withBreakfast ? parseAmount(breakfastRate) : 0;
    const withTax = formKind === 'hospede' && hasTax;
    const tax = withTax ? parseAmount(taxAmount) : 0;
    if (!checkInDate) return setError('Informe uma data válida.');
    if (formKind === 'hospede' && !checkOutDate) return setError('Informe uma data de saída válida.');
    if (formKind === 'hospede' && calculatedNights < 1) return setError('A data de saída deve ser posterior à data de entrada.');
    if (formKind === 'hospede' && calculatedNights > 60) return setError('A hospedagem pode ter no máximo 60 diárias.');
    if (!roomNumber.trim()) return setError('Informe o quarto.');
    if (formKind === 'hospede' && !guestName.trim()) return setError('Informe o nome do hóspede titular.');
    if (!Number.isInteger(draftGuestCount) || draftGuestCount < 1 || draftGuestCount > 10) return setError('Informe de 1 a 10 pessoas no quarto.');
    if (formKind === 'hospede' && enteredDailyRate === undefined) return setError('Informe um valor válido para a diária.');
    if (formKind === 'periodo' && !rate) return setError('Informe o valor do rotativo.');
    if (splitPayment && (!draftSplit || draftSplit >= dailyTotal)) return setError('O valor da segunda forma de pagamento deve ser maior que zero e menor que o valor total da hospedagem.');
    if (withBreakfast && (!Number.isInteger(draftBreakfastCount) || draftBreakfastCount < 1 || draftBreakfastCount > draftGuestCount)) return setError('A quantidade de cafés deve ficar entre 1 e o número de hóspedes.');
    if (withBreakfast && (!Number.isInteger(draftBreakfastDays) || draftBreakfastDays < 1 || draftBreakfastDays > draftNights)) return setError('A quantidade de dias com café deve ficar entre 1 e o número de diárias.');
    if (withBreakfast && !breakfast) return setError('Informe o valor de cada café.');
    if (withBreakfast && breakfastSplitPayment && (!breakfastSplit || breakfastSplit >= breakfastTotal || breakfastSplitMethod === breakfastMethod)) return setError('Escolha duas formas diferentes para o café e informe um valor positivo menor que o total do café na segunda forma.');
    if (withTax && !tax) return setError('Informe o valor da taxa ou desmarque "Cobrar taxa".');
    if (withTax && taxSplitPayment && (!taxSplit || taxSplit >= tax || taxSplitMethod === taxMethod)) return setError('Escolha duas formas diferentes para a taxa e informe um valor positivo menor que o total na segunda forma.');
    if (formKind === 'hospede' && draftExtras.some((extra) => !extra.amount || !extra.label.trim())) return setError('Preencha o nome e o valor de todos os extras.');
    const stay: GuestStay = {
      id: editingStay?.id ?? crypto.randomUUID(),
      kind: formKind,
      checkInDate,
      nights: draftNights,
      ...(formKind === 'hospede' ? { checkOutDate } : {}),
      roomNumber: roomNumber.trim(),
      guestName: formKind === 'hospede' ? guestName.trim() : '',
      guestCount: draftGuestCount,
      ...(formKind === 'periodo' ? { hours: draftHours } : {}),
      dailyRate: rate,
      ...(formKind === 'hospede' ? { lodgingTotal: dailyTotal } : {}),
      ...(editingStay?.creditApplied !== undefined ? { creditApplied: editingStay.creditApplied } : {}),
      ...(editingStay?.convertedFromStayId ? { convertedFromStayId: editingStay.convertedFromStayId } : {}),
      ...(editingStay?.voidedPayments ? { voidedPayments: editingStay.voidedPayments } : {}),
      dailyMethod,
      ...(splitPayment ? { dailySplit: { method: splitMethod, amount: draftSplit } } : {}),
      hasBreakfast: withBreakfast,
      breakfastCount: withBreakfast ? draftBreakfastCount : 0,
      ...(withBreakfast ? { breakfastDays: draftBreakfastDays } : {}),
      breakfastRate: breakfast,
      ...(withBreakfast ? { breakfastMethod, ...(breakfastSplitPayment ? { breakfastSplit: { method: breakfastSplitMethod, amount: breakfastSplit } } : {}) } : {}),
      taxAmount: tax,
      taxMethod,
      ...(withTax && taxSplitPayment ? { taxSplit: { method: taxSplitMethod, amount: taxSplit } } : {}),
      extras: formKind === 'periodo' ? [] : draftExtras.map<StayExtra>((extra) => ({ ...extra, label: extra.label.trim() })),
      note: note.trim(),
      attendant: editingStay?.attendant ?? attendant,
      status: editingStay?.status ?? 'hospedado',
      createdAt: editingStay?.createdAt ?? new Date().toISOString(),
    };
    if (!reservationDirectoryLoaded) return setError('Aguarde o carregamento da disponibilidade dos quartos e tente novamente.');
    const requestedInterval = stayInterval(stay);
    const conflictsWithReservation = Object.values(reservationDirectory).some((reservation) => {
      if (reservation.roomNumber !== stay.roomNumber || !['confirmada', 'hospedado'].includes(reservation.status ?? '')) return false;
      const interval = reservationInterval(reservation);
      return interval && intervalsOverlap(requestedInterval, interval);
    });
    const conflictsWithStay = Object.values(data.stays).some((existing) => {
      if (existing.id === stay.id || existing.status !== 'hospedado' || existing.roomNumber !== stay.roomNumber) return false;
      return intervalsOverlap(requestedInterval, stayInterval(existing));
    });
    if (conflictsWithReservation || conflictsWithStay) return setError(`O quarto ${stay.roomNumber} já tem uma hospedagem ou reserva nesse período.`);
    setSaving(true);
    const message = editingStay
      ? `Hospedagem do quarto ${stay.roomNumber} atualizada.`
      : formKind === 'periodo' ? `Rotativo do quarto ${stay.roomNumber} registrado com sucesso.` : `Hóspede do quarto ${stay.roomNumber} registrado com sucesso.`;
    await run(async () => {
      if (editingStay) await updateStayAndFinance(stay);
      else await saveStay(stay);
      if (modalOnly) {
        onModalClose?.(message);
        return;
      }
      closeForm();
      navigate('/', { state: { notice: message } });
    });
    setSaving(false);
  }

  const header = (
    <header className="sales-header">
      <Link to="/" className="sales-brand"><span className="sales-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>CAIXA - RECEPÇÃO</small></span></Link>
      <nav className="sales-header-links" aria-label="Navegação"><Link to="/vendas">Lançar venda</Link><Link to="/escala">Escala</Link><Link to="/">Painel inicial</Link></nav>
    </header>
  );

  const alerts = <>
    {error && <div className="sales-alert" role="alert">{error}</div>}
    {notice && <div className="sales-success" role="status">{notice}</div>}
  </>;

  if (!attendant && !modalOnly) {
    return (
      <div className="sales-page">
        {header}
        <main className="sales-content">
          <BackToPanel />
          <div className="sales-title-row"><div><p className="sales-eyebrow">CAIXA <span>/</span> RECEPÇÃO</p><h1>Sem plantonista na escala</h1><p>O plantonista é definido automaticamente pela escala do dia. Não há ninguém escalado neste horário; avise a gerência para ajustar a escala.</p></div></div>
        </main>
      </div>
    );
  }

  return (
    <div className={modalOnly ? 'reception-modal-only' : 'sales-page'}>
      {!modalOnly && header}
      {!modalOnly && <main className="sales-content">
        <BackToPanel />
        <div className="sales-title-row">
          <div><p className="sales-eyebrow">CAIXA <span>/</span> RECEPÇÃO</p><h1>O que você quer lançar?</h1><p>Toque em uma das opções abaixo para registrar a movimentação do seu plantão.</p></div>
          <span className="reception-today"><small>Hoje</small><strong>{new Date(`${today}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</strong></span>
          <span className="sales-operator reception-duty">Plantonista <strong>{attendant}</strong></span>
        </div>
        {alerts}

        <div className="action-grid">
          <ActionCard tone="blue" title="Adicionar hóspede" hint="Check-in com diárias, café, taxa e extras" icon="bed" onClick={() => openForm('hospede')} />
          <ActionCard tone="gold" title="Adicionar rotativo" hint="Estadia por horas" icon="clock" onClick={() => openForm('periodo')} />
          <ActionCard tone="red" title="Vender itens da geladeira" hint="Bebidas e itens da recepção" icon="cart" to="/vendas" />
        </div>

        {isAdmin && <Link to="/funcionarios">Gerenciar funcionários e categorias</Link>}
      </main>}

      {modalOnly && !attendant && <div className="reception-overlay" role="dialog" aria-modal="true" aria-label="Plantão indisponível">
        <section className="reception-panel reception-modal">
          <h2>Sem plantonista na escala</h2>
          <p>Não há ninguém escalado neste horário. Avise a gerência para ajustar a escala.</p>
          <button type="button" className="reception-primary" onClick={cancelForm}>Fechar</button>
        </section>
      </div>}
      {formKind && attendant && <div className="reception-overlay" role="dialog" aria-modal="true" aria-label={editingStay ? `Editar ${formKind === 'periodo' ? 'rotativo' : 'hóspede'}` : formKind === 'periodo' ? 'Adicionar rotativo' : 'Adicionar hóspede'} onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) cancelForm(); }}>
        <form className="reception-panel reception-modal" onSubmit={(event) => void submitStay(event)}>
          <div className="reception-modal-head">
            <h2>{editingStay ? `Editar ${formKind === 'periodo' ? 'rotativo' : 'hóspede'}` : formKind === 'periodo' ? 'Adicionar rotativo' : 'Adicionar hóspede'}</h2>
            <button type="button" className="reception-close" onClick={cancelForm} aria-label="Fechar">×</button>
          </div>
          <div className="reception-modal-body">
            {error && <div className="sales-alert" role="alert">{error}</div>}
            <div className="reception-grid">
              {formKind === 'hospede' && <div className="reception-step-heading reception-wide"><span>1</span><div><strong>Hospedagem</strong><small>Entrada, quarto e quantidade de hóspedes.</small></div></div>}
              <label className="sales-field"><span>Data de entrada</span><DateInput name="checkInDate" value={checkInDate} onValueChange={changeCheckInDate} required /></label>
              {formKind === 'hospede' && <label className="sales-field"><span>Data de saída</span><DateInput name="checkOutDate" value={checkOutDate} onValueChange={changeCheckOutDate} min={dateKeyAfterDays(checkInDate, 1)} max={dateKeyAfterDays(checkInDate, 60)} required /><small className={`reception-date-nights${calculatedNights < 1 || calculatedNights > 60 ? ' is-invalid' : ''}`}>{calculatedNights >= 1 && calculatedNights <= 60 ? `${calculatedNights} ${calculatedNights === 1 ? 'diária' : 'diárias'}` : calculatedNights > 60 ? 'Limite de 60 diárias' : 'A saída deve ser depois da entrada'}</small></label>}
              <label className="sales-field"><span>Quarto</span><select value={roomNumber} onChange={(event) => setRoomNumber(event.target.value)} required><option value="">Selecione um quarto cadastrado</option>{allRoomNumbers.map((number) => <option key={number} value={number}>{number} · {describeRoom(number)}</option>)}</select></label>
              <label className="sales-field"><span>{formKind === 'hospede' ? 'Quantidade de hóspedes' : 'Quantidade de pessoas'}</span><input type="number" min="1" max="10" step="1" value={guestCount} onChange={(event) => {
                const nextCount = event.target.value;
                const previousCount = Number(guestCount);
                setGuestCount(nextCount);
                if (hasBreakfast && Number.isInteger(Number(nextCount)) && Number(nextCount) >= 1) {
                  setBreakfastCount((current) => Number(current) === previousCount ? nextCount : String(Math.min(Number(current) || 1, Number(nextCount))));
                }
              }} required /></label>
              {formKind === 'periodo' && <label className="sales-field"><span>Quantidade de horas</span><input type="number" min={1} max={24} value={hours} onChange={(event) => setHours(event.target.value)} /></label>}
              {formKind === 'hospede' && <label className="sales-field"><span>Hóspede titular</span><input value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={120} required /></label>}
              {formKind === 'hospede' ? <label className="sales-field"><span>Valor da Diária (R$)</span><span className="reception-money-input"><span>R$</span><input inputMode="decimal" value={dailyRateText} onChange={(event) => setDailyRateText(event.target.value)} required /></span></label> : <label className="sales-field"><span>Valor do rotativo (R$)</span><input inputMode="decimal" value={dailyRate} onChange={(event) => setDailyRate(event.target.value)} required /></label>}
              {formKind === 'hospede' && <div className="reception-step-heading reception-wide"><span>2</span><div><strong>Pagamento das diárias</strong><small>Escolha uma forma ou divida o valor entre duas.</small></div></div>}
              <label className="sales-field"><span>{splitPayment ? '1ª forma de pagamento' : 'Forma de pagamento (FP)'}</span><select value={dailyMethod} onChange={(event) => setDailyMethod(event.target.value as FinancePaymentMethod)}>
                {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
              </select></label>
              <label className="reception-check reception-wide"><input type="checkbox" checked={splitPayment} onChange={(event) => setSplitPayment(event.target.checked)} /> Combinar pagamento (o cliente vai pagar com duas formas)</label>
              {splitPayment && <div className="reception-split reception-wide">
                <label className="sales-field"><span>2ª forma de pagamento</span><select value={splitMethod} onChange={(event) => setSplitMethod(event.target.value as FinancePaymentMethod)}>
                  {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
                </select></label>
                <label className="sales-field"><span>Valor na 2ª forma (R$)</span><input inputMode="decimal" value={splitAmount} onChange={(event) => setSplitAmount(event.target.value)} /></label>
                <p className="reception-hint">{dailyTotal > 0 && draftSplit > 0 && draftSplit < dailyTotal
                  ? <>{PAYMENT_METHOD_LABELS[dailyMethod]}: <strong>{money(dailyTotal - draftSplit)}</strong> · {PAYMENT_METHOD_LABELS[splitMethod]}: <strong>{money(draftSplit)}</strong></>
                  : 'Informe quanto será pago na 2ª forma; o restante da diária fica na 1ª.'}</p>
              </div>}
              {formKind === 'periodo' && <p className="reception-hint reception-wide">Rotativo por hora, sem café da manhã e sem taxa. Altere a quantidade de horas se precisar.</p>}
              {formKind === 'hospede' && <div className="reception-step-heading reception-wide"><span>3</span><div><strong>Serviços adicionais</strong></div></div>}
              {formKind === 'hospede' && <section className="reception-optional reception-service-card reception-service-breakfast reception-wide" aria-label="Café da manhã">
                <div className="reception-service-intro"><strong>Café da manhã</strong><small>Escolha a quantidade e os dias cobrados.</small></div>
                <label className="reception-check"><input type="checkbox" checked={hasBreakfast} onChange={(event) => {
                  setHasBreakfast(event.target.checked);
                  if (event.target.checked) {
                    setBreakfastCount(String(Number.isInteger(draftGuestCount) && draftGuestCount > 0 ? draftGuestCount : 1));
                    setBreakfastDays(String(draftNights));
                    const suggestedBreakfast = rateSettings.addOnRates.breakfast;
                    if (suggestedBreakfast !== undefined) setBreakfastRate(String(suggestedBreakfast).replace('.', ','));
                  }
                }} /> Incluir café da manhã</label>
                {hasBreakfast && <>
                  <label className="reception-small-field"><span>Quantidade de cafés por dia</span><input type="number" min="1" max={Number.isInteger(draftGuestCount) ? draftGuestCount : 1} step="1" value={breakfastCount} onChange={(event) => setBreakfastCount(event.target.value)} /></label>
                  <label className="reception-small-field"><span>Quantidade de dias com café</span><input type="number" min="1" max={draftNights} step="1" value={breakfastDays} onChange={(event) => setBreakfastDays(event.target.value)} /></label>
                  <label className="reception-small-field"><span>Valor de cada café por dia (R$)</span><input inputMode="decimal" value={breakfastRate} onChange={(event) => setBreakfastRate(event.target.value)} /></label>
                  <label className="sales-field"><span>Pagamento do café</span><select value={breakfastMethod} onChange={(event) => {
                    const method = event.target.value as FinancePaymentMethod;
                    setBreakfastMethod(method);
                    if (breakfastSplitMethod === method) setBreakfastSplitMethod(FOLIO_PAYMENT_METHODS.find((option) => option !== method) ?? method);
                  }}>{FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}</select></label>
                  <label className="reception-check"><input type="checkbox" checked={breakfastSplitPayment} onChange={(event) => setBreakfastSplitPayment(event.target.checked)} /> Combinar pagamento do café</label>
                  {breakfastSplitPayment && <div className="reception-split reception-wide">
                    <label className="sales-field"><span>2ª forma do café</span><select value={breakfastSplitMethod} onChange={(event) => setBreakfastSplitMethod(event.target.value as FinancePaymentMethod)}>{FOLIO_PAYMENT_METHODS.filter((method) => method !== breakfastMethod).map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}</select></label>
                    <label className="sales-field"><span>Valor na 2ª forma do café (R$)</span><input inputMode="decimal" value={breakfastSplitAmount} onChange={(event) => setBreakfastSplitAmount(event.target.value)} required /></label>
                  </div>}
                  <p className="reception-hint reception-wide">Total do café: {money(breakfastTotal)} ({draftBreakfastCount || 0} café(s) por dia × {draftBreakfastDays || 0} dia(s)). O café é cobrado apenas pelos dias informados, independentemente do pagamento das diárias.</p>
                </>}
              </section>}
              {formKind === 'hospede' && <section className="reception-optional reception-service-card reception-service-tax reception-wide" aria-label="Taxa">
                <div className="reception-service-intro"><strong>Taxa</strong><small>O valor pago no balcão entra como entrada e saída para a OYO; taxa pré-paga fica fora do fluxo financeiro.</small></div>
                <label className="reception-check"><input type="checkbox" checked={hasTax} onChange={(event) => setHasTax(event.target.checked)} /> Cobrar taxa</label>
                {hasTax && <>
                  <label className="reception-small-field"><span>Taxa (R$)</span><input inputMode="decimal" value={taxAmount} onChange={(event) => setTaxAmount(event.target.value)} /></label>
                  <label className="reception-small-field"><span>{taxSplitPayment ? '1ª forma da taxa' : 'Pagamento da taxa'}</span><select value={taxMethod} onChange={(event) => {
                    const method = event.target.value as FinancePaymentMethod;
                    setTaxMethod(method);
                    if (taxSplitMethod === method) setTaxSplitMethod(FOLIO_PAYMENT_METHODS.find((option) => option !== method) ?? method);
                  }}>
                    {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{taxLabel(method)}</option>)}
                  </select></label>
                  <label className="reception-check reception-wide"><input type="checkbox" checked={taxSplitPayment} onChange={(event) => setTaxSplitPayment(event.target.checked)} /> Combinar pagamento da taxa</label>
                  {taxSplitPayment && <div className="reception-split reception-wide">
                    <label className="sales-field"><span>2ª forma da taxa</span><select value={taxSplitMethod} onChange={(event) => setTaxSplitMethod(event.target.value as FinancePaymentMethod)}>{FOLIO_PAYMENT_METHODS.filter((method) => method !== taxMethod).map((method) => <option key={method} value={method}>{taxLabel(method)}</option>)}</select></label>
                    <label className="sales-field"><span>Valor na 2ª forma (R$)</span><input inputMode="decimal" value={taxSplitAmount} onChange={(event) => setTaxSplitAmount(event.target.value)} required /></label>
                  </div>}
                  <p className="reception-hint reception-wide">A pagar no hotel: {money(taxHotelAmount)}. Taxa já pré-paga e quitada, fora do fluxo financeiro: {money(taxPrepaidAmount)}. Se combinar, o valor informado na 2ª forma será descontado do saldo da 1ª.</p>
                </>}
              </section>}
            </div>

            {formKind === 'hospede' && <div className="reception-extras">
              <div className="reception-step-heading reception-step-heading-inline"><span>4</span><div><strong>Extras</strong></div></div>
              <div className="reception-extras-head"><strong>Selecione para adicionar</strong>
                <span>{SELECTABLE_EXTRAS.map((type) => <button key={type} type="button" className="reception-chip" onClick={() => addExtra(type)}>+ {EXTRA_LABELS[type]}</button>)}</span>
              </div>
              {extras.map((extra) => (
                <div key={extra.id} className="reception-extra-row">
                  {extra.type === 'outros'
                    ? <input aria-label="Descrição do extra" placeholder="Descrição" value={extra.label} onChange={(event) => updateExtra(extra.id, { label: event.target.value })} maxLength={60} />
                    : <strong>{extra.label}</strong>}
                  <input aria-label={`Valor de ${extra.label || 'extra'}`} inputMode="decimal" placeholder="Valor (R$)" value={extra.amount} onChange={(event) => updateExtra(extra.id, { amount: event.target.value })} />
                  <select aria-label={`Cobrança de ${extra.label || 'extra'}`} value={extra.mode} onChange={(event) => updateExtra(extra.id, { mode: event.target.value as 'fixo' | 'por_diaria' })}><option value="fixo">Valor único</option><option value="por_diaria">Por diária</option></select>
                  <select aria-label="Forma de pagamento do extra" value={extra.method} onChange={(event) => updateExtra(extra.id, { method: event.target.value as FinancePaymentMethod })}>
                    {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
                  </select>
                  <button type="button" className="reception-link-button" onClick={() => setExtras((current) => current.filter((item) => item.id !== extra.id))}>Remover</button>
                </div>
              ))}
            </div>}

            {formKind === 'hospede' && <div className="reception-step-heading reception-step-heading-inline"><span>5</span><div><strong>Observações</strong><small>Campo opcional para instruções ou detalhes importantes.</small></div></div>}
            <label className="reception-note"><span>{formKind === 'hospede' ? 'Anotações da hospedagem (opcional)' : 'Observações'}</span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={3} placeholder={formKind === 'hospede' ? 'Ex.: preferência de quarto ou informação importante para o plantão' : 'Escreva aqui qualquer informação importante sobre este registro'} /></label>
          </div>
          <footer className="reception-modal-footer">
            {formKind === 'hospede' ? <div className="reception-total-summary">
              <p><span>Diárias a pagar no hotel</span><strong>{money(dailyHotelAmount)}</strong></p>
              {dailyPrepaidAmount > 0 && <p><span>Diárias pré-pagas · retido pela OYO</span><strong>{money(dailyPrepaidAmount)}</strong></p>}
              {hasBreakfast && breakfastHotelAmount > 0 && <p><span>Café a pagar no hotel · {draftBreakfastDays} {draftBreakfastDays === 1 ? 'dia' : 'dias'}</span><strong>{money(breakfastHotelAmount)}</strong></p>}
              {hasBreakfast && breakfastPrepaidAmount > 0 && <p><span>Café pré-pago · retido pela OYO</span><strong>{money(breakfastPrepaidAmount)}</strong></p>}
              {hasTax && taxHotelAmount > 0 && <p><span>Taxa a pagar no hotel</span><strong>{money(taxHotelAmount)}</strong></p>}
              {hasTax && taxPrepaidAmount > 0 && <small>Taxa pré-paga e quitada, fora do fluxo financeiro: {money(taxPrepaidAmount)}</small>}
              {extrasHotelTotal > 0 && <p><span>Extras a pagar no hotel</span><strong>{money(extrasHotelTotal)}</strong></p>}
              {extrasPrepaidTotal > 0 && <p><span>Extras pré-pagos · retido pela OYO</span><strong>{money(extrasPrepaidTotal)}</strong></p>}
              {oyoRetainedTotal > 0 && <small>Total pré-pago retido pela OYO (sem taxa): {money(oyoRetainedTotal)}</small>}
              <p className="reception-total"><span>Total a pagar no hotel</span><strong>{money(draftTotal)}</strong></p>
            </div> : <p className="reception-total">Total: <strong>{money(draftTotal)}</strong></p>}
            <div className="reception-actions">
              <button className="reception-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : editingStay ? 'Salvar alterações' : formKind === 'periodo' ? 'Confirmar rotativo' : 'Salvar hospedagem'}</button>
              <button type="button" className="sales-outline-button" onClick={cancelForm}>Cancelar</button>
            </div>
          </footer>
        </form>
      </div>}
    </div>
  );
}
