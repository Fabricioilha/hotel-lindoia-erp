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
  emptyReceptionRateSettings,
  type ExtraType, type GuestStay, type ReceptionData, type ReceptionRateSettings, type ReceptionRoom, type StayExtra, type StayKind,
} from '../../types/reception';
import { subscribeReservationDirectory, subscribeRoomDirectory } from '../../services/housekeepingStore';
import { roomCategoryDescription, type HousekeepingRoom, type ReservationDirectoryEntry } from '../../types/housekeeping';
import { emptyReception, localDateKey, saveStay, subscribeReception, subscribeReceptionRates } from '../../services/receptionStore';
import '../venda-geladeira.css';
import './recepcao.css';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const taxLabel = (method: FinancePaymentMethod) => method === 'prepaid' ? PAYMENT_METHOD_LABELS.prepaid : `Balcão - ${PAYMENT_METHOD_LABELS[method]}`;
const DAY_MS = 86_400_000;

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
  entryContext?: ReceptionEntryContext;
  onModalClose?: (notice?: string) => void;
}

export function CaixaRecepcao(props: CaixaRecepcaoProps) {
  const [searchParams] = useSearchParams();
  const requested = props.modalOnly
    ? (props.initialKind === 'periodo' ? 'rotativo' : 'hospede')
    : searchParams.get('novo');
  const requestedRoom = props.modalOnly ? props.initialRoom ?? '' : searchParams.get('quarto') ?? '';
  const formKey = `${props.modalOnly ? 'modal' : 'page'}:${requested ?? ''}:${requestedRoom}`;
  return <CaixaRecepcaoContent key={formKey} {...props} />;
}

function CaixaRecepcaoContent({ userRole, modalOnly = false, initialKind = 'hospede', initialRoom = '', entryContext, onModalClose }: CaixaRecepcaoProps) {
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
  const requested = modalOnly ? (initialKind === 'periodo' ? 'rotativo' : 'hospede') : searchParams.get('novo');
  const requestedRoom = modalOnly ? initialRoom : searchParams.get('quarto') ?? '';
  const formKind: StayKind | null = requested === 'hospede' ? 'hospede' : requested === 'rotativo' ? 'periodo' : null;
  const [checkInDate, setCheckInDate] = useState(() => localDateKey());
  const [roomNumber, setRoomNumber] = useState(() => requestedRoom);
  const [guestName, setGuestName] = useState('');
  const [guestCount, setGuestCount] = useState('1');
  const [nights, setNights] = useState('1');
  const [hours, setHours] = useState('4');
  const [dailyRate, setDailyRate] = useState('');
  const [lodgingTotalText, setLodgingTotalText] = useState('');
  const [dailyMethod, setDailyMethod] = useState<FinancePaymentMethod>('pix');
  const [splitPayment, setSplitPayment] = useState(false);
  const [splitMethod, setSplitMethod] = useState<FinancePaymentMethod>('cash');
  const [splitAmount, setSplitAmount] = useState('');
  const [hasBreakfast, setHasBreakfast] = useState(false);
  const [breakfastCount, setBreakfastCount] = useState('1');
  const [breakfastRate, setBreakfastRate] = useState('');
  const [breakfastMethod, setBreakfastMethod] = useState<FinancePaymentMethod>('pix');
  const [breakfastSplitPayment, setBreakfastSplitPayment] = useState(false);
  const [breakfastSplitMethod, setBreakfastSplitMethod] = useState<FinancePaymentMethod>('cash');
  const [breakfastSplitAmount, setBreakfastSplitAmount] = useState('');
  const [hasTax, setHasTax] = useState(false);
  const [taxAmount, setTaxAmount] = useState('');
  const [taxMethod, setTaxMethod] = useState<FinancePaymentMethod>('cash');
  const [extras, setExtras] = useState<ExtraDraft[]>([]);
  const [note, setNote] = useState('');
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
  const allRoomNumbers = [...new Set([...Object.values(roomDirectory).map((room) => room.number), ...Object.values(data.rooms).map((room) => room.number)])]
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
  const draftNights = formKind === 'periodo' ? 1 : Math.min(60, Math.max(1, Math.floor(Number(nights) || 1)));
  const draftGuestCount = Number(guestCount);
  const draftBreakfastCount = Number(breakfastCount);
  const enteredLodgingTotal = parseOptionalRate(lodgingTotalText);
  const dailyTotal = formKind === 'hospede'
    ? enteredLodgingTotal ?? 0
    : parseAmount(dailyRate) * draftNights;
  const breakfastTotal = parseAmount(breakfastRate) * draftBreakfastCount * draftNights;
  const breakfastSplit = breakfastSplitPayment ? parseAmount(breakfastSplitAmount) : 0;
  const draftSplit = splitPayment ? parseAmount(splitAmount) : 0;
  const draftExtras = extras.map((extra) => ({ ...extra, amount: parseAmount(extra.amount) }));
  const draftTotal = dailyTotal
    + (formKind === 'hospede' && hasBreakfast ? parseAmount(breakfastRate) * draftBreakfastCount * draftNights : 0)
    + (formKind === 'hospede' && hasTax && taxMethod !== 'prepaid' ? parseAmount(taxAmount) : 0)
    + draftExtras.reduce((total, extra) => total + extraTotal(extra, draftNights), 0);

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
    const rate = formKind === 'hospede'
      ? draftNights ? Math.round((dailyTotal / draftNights) * 100) / 100 : 0
      : parseAmount(dailyRate);
    const withBreakfast = formKind === 'hospede' && hasBreakfast;
    const breakfast = withBreakfast ? parseAmount(breakfastRate) : 0;
    const withTax = formKind === 'hospede' && hasTax;
    const tax = withTax ? parseAmount(taxAmount) : 0;
    if (!checkInDate) return setError('Informe uma data válida.');
    if (!roomNumber.trim()) return setError('Informe o quarto.');
    if (formKind === 'hospede' && !guestName.trim()) return setError('Informe o nome do hóspede titular.');
    if (!Number.isInteger(draftGuestCount) || draftGuestCount < 1 || draftGuestCount > 10) return setError('Informe de 1 a 10 pessoas no quarto.');
    if (formKind === 'hospede' && enteredLodgingTotal === undefined) return setError('Informe um valor válido para o total das diárias.');
    if (formKind === 'periodo' && !rate) return setError('Informe o valor do rotativo.');
    if (splitPayment && (!draftSplit || draftSplit >= dailyTotal)) return setError('O valor da segunda forma de pagamento deve ser maior que zero e menor que o valor da diária.');
    if (withBreakfast && (!Number.isInteger(draftBreakfastCount) || draftBreakfastCount < 1 || draftBreakfastCount > draftGuestCount)) return setError('A quantidade de cafés deve ficar entre 1 e o número de hóspedes.');
    if (withBreakfast && !breakfast) return setError('Informe o valor de cada café.');
    if (withBreakfast && breakfastSplitPayment && (!breakfastSplit || breakfastSplit >= breakfastTotal || breakfastSplitMethod === breakfastMethod)) return setError('Escolha duas formas diferentes para o café e informe um valor positivo menor que o total do café na segunda forma.');
    if (withTax && !tax) return setError('Informe o valor da taxa ou desmarque "Cobrar taxa".');
    if (formKind === 'hospede' && draftExtras.some((extra) => !extra.amount || !extra.label.trim())) return setError('Preencha o nome e o valor de todos os extras.');
    const stay: GuestStay = {
      id: crypto.randomUUID(),
      kind: formKind,
      checkInDate,
      nights: draftNights,
      roomNumber: roomNumber.trim(),
      guestName: formKind === 'hospede' ? guestName.trim() : '',
      guestCount: draftGuestCount,
      ...(formKind === 'periodo' ? { hours: draftHours } : {}),
      dailyRate: rate,
      ...(formKind === 'hospede' ? { lodgingTotal: enteredLodgingTotal } : {}),
      dailyMethod,
      ...(splitPayment ? { dailySplit: { method: splitMethod, amount: draftSplit } } : {}),
      hasBreakfast: withBreakfast,
      breakfastCount: withBreakfast ? draftBreakfastCount : 0,
      breakfastRate: breakfast,
      ...(withBreakfast ? { breakfastMethod, ...(breakfastSplitPayment ? { breakfastSplit: { method: breakfastSplitMethod, amount: breakfastSplit } } : {}) } : {}),
      taxAmount: tax,
      taxMethod,
      extras: formKind === 'periodo' ? [] : draftExtras.map<StayExtra>((extra) => ({ ...extra, label: extra.label.trim() })),
      note: note.trim(),
      attendant,
      status: 'hospedado',
      createdAt: new Date().toISOString(),
    };
    if (!reservationDirectoryLoaded) return setError('Aguarde o carregamento da disponibilidade dos quartos e tente novamente.');
    const requestedInterval = stayInterval(stay);
    const conflictsWithReservation = Object.values(reservationDirectory).some((reservation) => {
      if (reservation.roomNumber !== stay.roomNumber || !['confirmada', 'hospedado'].includes(reservation.status ?? '')) return false;
      const interval = reservationInterval(reservation);
      return interval && intervalsOverlap(requestedInterval, interval);
    });
    const conflictsWithStay = Object.values(data.stays).some((existing) => {
      if (existing.status !== 'hospedado' || existing.roomNumber !== stay.roomNumber) return false;
      return intervalsOverlap(requestedInterval, stayInterval(existing));
    });
    if (conflictsWithReservation || conflictsWithStay) return setError(`O quarto ${stay.roomNumber} já tem uma hospedagem ou reserva nesse período.`);
    setSaving(true);
    const message = formKind === 'periodo' ? `Rotativo do quarto ${stay.roomNumber} registrado com sucesso.` : `Hóspede do quarto ${stay.roomNumber} registrado com sucesso.`;
    await run(async () => {
      await saveStay(stay);
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
      {formKind && attendant && <div className="reception-overlay" role="dialog" aria-modal="true" aria-label={formKind === 'periodo' ? 'Adicionar rotativo' : 'Adicionar hóspede'} onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) cancelForm(); }}>
        <form className="reception-panel reception-modal" onSubmit={(event) => void submitStay(event)}>
          <div className="reception-modal-head">
            <h2>{formKind === 'periodo' ? 'Adicionar rotativo' : 'Adicionar hóspede'}</h2>
            <button type="button" className="reception-close" onClick={cancelForm} aria-label="Fechar">×</button>
          </div>
          <div className="reception-modal-body">
            {error && <div className="sales-alert" role="alert">{error}</div>}
            <div className="reception-grid">
              <label className="sales-field"><span>Data de entrada (digite ou use o calendário)</span><DateInput name="checkInDate" value={checkInDate} onValueChange={setCheckInDate} required /></label>
              <label className="sales-field"><span>Quarto</span><select value={roomNumber} onChange={(event) => setRoomNumber(event.target.value)} required><option value="">Selecione um quarto cadastrado</option>{allRoomNumbers.map((number) => <option key={number} value={number}>{number} · {describeRoom(number)}</option>)}</select></label>
              {formKind === 'hospede' && <label className="sales-field reception-wide"><span>Hóspede titular</span><input value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={120} required /></label>}
              <label className="sales-field"><span>Quantidade de pessoas</span><input type="number" min="1" max="10" step="1" value={guestCount} onChange={(event) => {
                const nextCount = event.target.value;
                const previousCount = Number(guestCount);
                setGuestCount(nextCount);
                if (hasBreakfast && Number.isInteger(Number(nextCount)) && Number(nextCount) >= 1) {
                  setBreakfastCount((current) => Number(current) === previousCount ? nextCount : String(Math.min(Number(current) || 1, Number(nextCount))));
                }
              }} required /></label>
              <p className="reception-hint reception-wide">Incluindo o titular; não é necessário cadastrar os dados dos demais hóspedes.</p>
              {formKind === 'periodo' && <label className="sales-field"><span>Quantidade de horas</span><input type="number" min={1} max={24} value={hours} onChange={(event) => setHours(event.target.value)} /></label>}
              {formKind === 'hospede' && <label className="sales-field reception-wide"><span>Quantidade de diárias</span><input type="number" min={1} max={60} value={nights} onChange={(event) => setNights(event.target.value)} /></label>}
              {formKind === 'hospede' ? <label className="sales-field reception-wide"><span>Valor total das diárias (R$)</span><span className="reception-money-input"><span>R$</span><input inputMode="decimal" value={lodgingTotalText} placeholder="Informe o valor combinado" onChange={(event) => setLodgingTotalText(event.target.value)} required /></span></label> : <label className="sales-field"><span>Valor do rotativo (R$)</span><input inputMode="decimal" value={dailyRate} onChange={(event) => setDailyRate(event.target.value)} required /></label>}
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
              {formKind === 'hospede' && <div className="reception-optional reception-wide">
                <label className="reception-check"><input type="checkbox" checked={hasBreakfast} onChange={(event) => {
                  setHasBreakfast(event.target.checked);
                  if (event.target.checked) {
                    setBreakfastCount(String(Number.isInteger(draftGuestCount) && draftGuestCount > 0 ? draftGuestCount : 1));
                    const suggestedBreakfast = rateSettings.addOnRates.breakfast;
                    if (suggestedBreakfast !== undefined) setBreakfastRate(String(suggestedBreakfast).replace('.', ','));
                  }
                }} /> Inclui café da manhã</label>
                {hasBreakfast && <>
                  <label className="reception-small-field"><span>Quantidade de cafés por dia</span><input type="number" min="1" max={Number.isInteger(draftGuestCount) ? draftGuestCount : 1} step="1" value={breakfastCount} onChange={(event) => setBreakfastCount(event.target.value)} /></label>
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
                  <p className="reception-hint">Total do café: {money(breakfastTotal)}. Informe como o café foi pago, mesmo quando a diária for pré-paga.</p>
                </>}
              </div>}
              {formKind === 'hospede' && <div className="reception-optional reception-wide">
                <label className="reception-check"><input type="checkbox" checked={hasTax} onChange={(event) => setHasTax(event.target.checked)} /> Cobrar taxa</label>
                {hasTax && <>
                  <label className="reception-small-field"><span>Taxa (R$)</span><input inputMode="decimal" value={taxAmount} onChange={(event) => setTaxAmount(event.target.value)} /></label>
                  <label className="reception-small-field"><span>Pagamento da taxa</span><select value={taxMethod} onChange={(event) => setTaxMethod(event.target.value as FinancePaymentMethod)}>
                    {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{taxLabel(method)}</option>)}
                  </select></label>
                  <p className="reception-hint reception-wide">Quando a taxa já foi paga diretamente à OYO, selecione pré-pago. Ela fica fora do total cobrado do hóspede.</p>
                </>}
              </div>}
            </div>

            {formKind === 'hospede' && <div className="reception-extras">
              <div className="reception-extras-head"><strong>Extras</strong>
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

            <label className="reception-note"><span>Observações</span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={3} placeholder="Escreva aqui qualquer informação importante sobre este registro" /></label>
          </div>
          <footer className="reception-modal-footer">
            <p className="reception-total">Total: <strong>{money(draftTotal)}</strong></p>
            <div className="reception-actions">
              <button className="reception-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : formKind === 'periodo' ? 'Confirmar rotativo' : 'Salvar Registro'}</button>
              <button type="button" className="sales-outline-button" onClick={cancelForm}>Cancelar</button>
            </div>
          </footer>
        </form>
      </div>}
    </div>
  );
}
