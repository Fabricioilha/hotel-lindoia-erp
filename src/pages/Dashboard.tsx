import { StayAccount } from '../components/StayAccount';
import { cashShiftDate } from '../services/cashShiftDate';
import { acknowledgeCashCollection, subscribeCashCollections } from '../services/cashCollections';
import { acknowledgeCleaningConcern, subscribeCleaningConcerns } from '../services/cleaningConcerns';
import { checkoutQuery, managerCheckoutAlerts, requestCheckout } from '../services/checkoutClient';
import type { CheckoutAlert } from '../services/checkoutPolicy';
import { departureDue, hotelDate, HOTEL_BREAKFAST_END_TIME, HOTEL_CHECK_IN_TIME, HOTEL_CHECKOUT_TIME } from '../services/hotelSchedule';
import { currentOccupants, stayOccupiesDate, reservationOccupiesDate } from '../services/occupantDirectory';
import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAttendant } from '../services/useAttendant';
import type { UserRole } from '../types';
import { subscribeDashboardHousekeeping, subscribeCurrentReservationDirectory, subscribeReservationCollections, subscribeRoomCategories, subscribeRoomDirectory, syncReservationCollections, setRoomMaintenanceBlock, type DashboardHousekeepingData } from '../services/housekeepingStore';
import { breakfastForecastDay, breakfastsOnDate } from '../services/breakfastForecast';
import { guestStayOccupiesToday, hotelOccupancySummary, occupiedRoomNumbers, reservationRotativoEndTimestamp, rotativoEndTimestamp } from '../services/reservationAnalytics';
import { subscribeRoomAddOnInventory } from '../services/frigobarStore';
import { convertRotativoToDaily, emptyReception, localDateKey, saveRoomCharge, confirmStayArrival, subscribeReceptionBoard, subscribeReceptionRates } from '../services/receptionStore';
import { emptyCleaning, subscribeActiveCleaningTasks, subscribeDashboardCleaningTasks } from '../services/cleaningStore';
import { subscribeInventoryProducts } from '../services/inventoryStore';
import { useInternalOutputSync } from '../services/internalOutputs';
import type { CleaningData, CleaningTask } from '../types/cleaning';
import { FOLIO_PAYMENT_METHODS, ROOM_TYPE_LABELS, stayBillingLines, stayBreakfastCountOnDate, weekdayKey, type CashOut, type GuestStay, type ReceptionRateSettings, type ReceptionRoom, type RoomCharge, type RoomChargeKind, type StayKind } from '../types/reception';
import { PAYMENT_METHOD_LABELS, type FinancePaymentMethod } from '../types/finance';
import type { StockProduct } from '../types/inventory';
import type { FrigobarData } from '../types/frigobar';
import { roomCategoryDescription, roomCategoryGuestCounts, type HousekeepingRoom, type ReservationDirectoryEntry, type RoomCategoryRecord, type RoomCleaningLog } from '../types/housekeeping';
import type { ReceptionEntryContext } from './caixa/CaixaRecepcao';
import { ActionCard } from '../components/ui/ActionCard';
import { PanelModalProvider } from '../components/ui/PanelModalContext';
import './dashboard.css';

const ReceptionQuickForm = lazy(() => import('./caixa/CaixaRecepcao').then((module) => ({ default: module.CaixaRecepcao })));
const SalesModalPage = lazy(() => import('./VendaGeladeira').then((module) => ({ default: module.VendaGeladeira })));
const CashOutModalPage = lazy(() => import('./caixa/SaidaCaixa').then((module) => ({ default: module.SaidaCaixa })));
const CleaningModalPage = lazy(() => import('./limpeza/ControleLimpeza').then((module) => ({ default: module.ControleLimpeza })));
const StockOutputModalPage = lazy(() => import('./saidas/SaidaProdutos').then((module) => ({ default: module.SaidaProdutos })));
const ScheduleModalPage = lazy(() => import('./escala/Escala').then((module) => ({ default: module.Escala })));
const ManagerRoomDialog = lazy(() => import('../components/ManagerRoomDialog').then((module) => ({ default: module.ManagerRoomDialog })));

type DashboardTool = 'geladeira' | 'saida-caixa' | 'limpeza' | 'estoque' | 'escala';

// Geladeira e Controle de Limpeza usam o modal largo, com cabeçalho no padrão dos demais formulários.
const TOOL_HEADINGS: Record<DashboardTool, { title: string; eyebrow?: string; wide?: boolean }> = {
  geladeira: { title: 'Geladeira', eyebrow: 'PONTO DE VENDA / RECEPÇÃO', wide: true },
  'saida-caixa': { title: 'Saída de Caixa' },
  limpeza: { title: 'Controle de Limpeza', eyebrow: 'OPERAÇÃO / HOSPEDAGEM', wide: true },
  estoque: { title: 'Estoque' },
  escala: { title: 'Escala' },
};

interface DashboardProps {
  userRole: UserRole;
  onLogout: () => void;
}

export function Dashboard({ userRole, onLogout }: DashboardProps) {
  const profile = userRole === 'admin' ? 'Gerência Geral' : 'Equipe Operacional';
  const location = useLocation();
  const navigate = useNavigate();
  const flash = (location.state as { notice?: string } | null)?.notice;
  const [temporaryNotice, setTemporaryNotice] = useState<{ id: string; message: string } | null>(null);
  const [activeTool, setActiveTool] = useState<DashboardTool | null>(null);
  const [quickReceptionKind, setQuickReceptionKind] = useState<StayKind | null>(null);
  const [quickCheckoutOpen, setQuickCheckoutOpen] = useState(false);
  const [housekeeping, setHousekeeping] = useState<DashboardHousekeepingData>({ rooms: {}, reservations: {}, cleaningLogs: {} });
  const [inventoryProducts, setInventoryProducts] = useState<Record<string, StockProduct>>({});
  const [metricsLoadedKey, setMetricsLoadedKey] = useState('');
  const [metricsErrorKey, setMetricsErrorKey] = useState('');
  const [frigobarStock, setFrigobarStock] = useState<Record<string, number>>({});
  const [syncError, setSyncError] = useState('');
  const [boardStays, setBoardStays] = useState<Record<string, GuestStay>>({});
  const [roomCharges, setRoomCharges] = useState<Record<string, RoomCharge>>(emptyReception().roomCharges);
  const [receptionRooms, setReceptionRooms] = useState<Record<string, ReceptionRoom>>({});
  const [roomDirectory, setRoomDirectory] = useState<Record<string, HousekeepingRoom>>({});
  const [reservationDirectory, setReservationDirectory] = useState<Record<string, ReservationDirectoryEntry>>({});
  const [receptionRates, setReceptionRates] = useState<ReceptionRateSettings>({ roomRates: {}, roomRatesByGuests: {}, addOnRates: {}, holidays: {} });
  const [priceCategories, setPriceCategories] = useState<RoomCategoryRecord[]>([]);
  const [boardRoomsLoadedKey, setBoardRoomsLoadedKey] = useState('');
  const [boardReservationsLoadedKey, setBoardReservationsLoadedKey] = useState('');
  const [boardReceptionLoadedKey, setBoardReceptionLoadedKey] = useState('');
  const [clock, setClock] = useState(() => Date.now());
  const [checkoutResult, setCheckoutResult] = useState<{ date: string; alerts: CheckoutAlert[] | null } | null>(null);
  const [cashCollections, setCashCollections] = useState<CashOut[]>([]);
  const [cashCollectionError, setCashCollectionError] = useState('');
  const [acknowledgingCollection, setAcknowledgingCollection] = useState('');
  const [cleaningConcerns, setCleaningConcerns] = useState<RoomCleaningLog[]>([]);
  const [cleaningConcernError, setCleaningConcernError] = useState('');
  const [acknowledgingConcern, setAcknowledgingConcern] = useState('');
  useEffect(() => {
    if (userRole !== 'admin') return;
    return subscribeCashCollections(setCashCollections, (cause) => setCashCollectionError(`Não foi possível carregar os recolhimentos: ${cause.message}`));
  }, [userRole]);
  async function acknowledgeCollection(item: CashOut) {
    setCashCollectionError('');
    setAcknowledgingCollection(item.id);
    try {
      await acknowledgeCashCollection(item);
    } catch (cause) {
      setCashCollectionError(cause instanceof Error ? cause.message : 'Não foi possível confirmar o recolhimento.');
    } finally {
      setAcknowledgingCollection('');
    }
  }
  useEffect(() => {
    if (userRole !== 'admin') return;
    return subscribeCleaningConcerns(setCleaningConcerns, (cause) => setCleaningConcernError(`Não foi possível carregar os relatos de limpeza: ${cause.message}`));
  }, [userRole]);
  async function acknowledgeConcern(log: RoomCleaningLog) {
    setCleaningConcernError('');
    setAcknowledgingConcern(log.id);
    try {
      await acknowledgeCleaningConcern(log);
    } catch (cause) {
      setCleaningConcernError(cause instanceof Error ? cause.message : 'Não foi possível confirmar a conferência.');
    } finally {
      setAcknowledgingConcern('');
    }
  }
  const boardTodayKey = hotelDate(new Date(clock));
  useEffect(() => {
    const controller = new AbortController();
    const alertsRequest = userRole === 'admin'
      ? managerCheckoutAlerts(new Date(clock))
      : checkoutQuery<CheckoutAlert[]>('', controller.signal);
    void alertsRequest.then((alerts) => {
      if (!controller.signal.aborted) setCheckoutResult({ date: boardTodayKey, alerts });
    }).catch(() => {
      if (!controller.signal.aborted) setCheckoutResult({ date: boardTodayKey, alerts: null });
    });
    return () => controller.abort();
  }, [clock, userRole, boardStays, boardTodayKey]);
  const checkoutToday = checkoutResult?.date === boardTodayKey ? checkoutResult : null;
  const checkoutAlerts = checkoutToday?.alerts;
  const checkoutAlertsByRoom = new Map(checkoutAlerts?.map((alert) => [alert.roomNumber.trim(), alert]));
  const boardWeekday = weekdayKey(boardTodayKey);
  const todayHoliday = receptionRates.holidays[boardTodayKey];
  const priceSuggestions = useMemo(() => priceCategories.flatMap((category) => {
    if (!boardWeekday) return [];
    const guestCounts = roomCategoryGuestCounts(category);
    const maximumGuests = guestCounts.at(-1) ?? 1;
    return guestCounts.flatMap((guestCount) => {
      const rates = receptionRates.roomRatesByGuests?.[category.id]?.[guestCount];
      const legacyRates = guestCount === maximumGuests ? receptionRates.roomRates[category.id] : undefined;
      const holidayRateKey = boardWeekday === 'friday' || boardWeekday === 'saturday' ? 'holidayWeekend' : 'holidayWeekday';
      const amount = todayHoliday
        ? rates?.[holidayRateKey] ?? rates?.holiday ?? rates?.[boardWeekday] ?? legacyRates?.[holidayRateKey] ?? legacyRates?.holiday ?? legacyRates?.[boardWeekday]
        : rates?.[boardWeekday] ?? legacyRates?.[boardWeekday];
      return amount === undefined ? [] : [{ category: `${category.name} · ${guestCount} ${guestCount === 1 ? 'hóspede' : 'hóspedes'}`, amount }];
    });
  }), [priceCategories, receptionRates, boardWeekday, todayHoliday]);
  const priceSuggestionSummary = priceSuggestions.map(({ category, amount }) => `${category} ${money(amount)}`).join(' · ');
  const boardRequestKey = `${userRole}:${boardTodayKey}`;
  const metricsLoaded = metricsLoadedKey === boardRequestKey;
  const metricsError = metricsErrorKey === boardRequestKey;
  const boardRoomsLoaded = boardRoomsLoadedKey === boardRequestKey;
  const boardReservationsLoaded = boardReservationsLoadedKey === boardRequestKey;
  const boardReceptionLoaded = boardReceptionLoadedKey === boardRequestKey;
  const [activeCleaningTasks, setActiveCleaningTasks] = useState<Record<string, CleaningTask>>({});
  const [boardCleaningLoadedKey, setBoardCleaningLoadedKey] = useState('');
  const boardCleaningLoaded = boardCleaningLoadedKey === (userRole === 'admin' ? boardRequestKey : String(userRole));
  const attendant = useAttendant();
  const salesActor = userRole === 'admin' ? 'Gerência' : attendant || 'Equipe';
  const receptionEntryContext = useMemo<ReceptionEntryContext>(() => ({
    stays: boardStays,
    rooms: receptionRooms,
    roomDirectory,
    reservations: reservationDirectory,
    attendant,
  }), [attendant, boardStays, receptionRooms, roomDirectory, reservationDirectory]);

  function closeTool() {
    setActiveTool(null);
  }

  function showTemporaryNotice(message: string) {
    setTemporaryNotice({ id: crypto.randomUUID(), message });
  }

  useEffect(() => {
    if (!flash) return;
    const clearFlash = window.setTimeout(() => {
      const nextState = location.state && typeof location.state === 'object'
        ? { ...(location.state as Record<string, unknown>) }
        : {};
      delete nextState.notice;
      navigate(`${location.pathname}${location.search}${location.hash}`, {
        replace: true,
        state: Object.keys(nextState).length > 0 ? nextState : null,
      });
    }, 3000);
    return () => window.clearTimeout(clearFlash);
  }, [flash, location.hash, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    if (!temporaryNotice) return;
    const noticeId = temporaryNotice.id;
    const clearTimer = window.setTimeout(() => {
      setTemporaryNotice((current) => current?.id === noticeId ? null : current);
    }, 3000);
    return () => window.clearTimeout(clearTimer);
  }, [temporaryNotice]);

  useEffect(() => {
    function tick() {
      const now = Date.now();
      setClock(now);
      timer = window.setTimeout(tick, 60_000 - now % 60_000);
    }
    let timer = window.setTimeout(tick, 60_000 - Date.now() % 60_000);
    return () => window.clearTimeout(timer);
  }, []);

  const [cleaning, setCleaning] = useState<CleaningData>(emptyCleaning());

  useInternalOutputSync(userRole === 'admin', setSyncError);

  useEffect(() => {
    if (userRole === 'admin') {
      return;
    }
    return subscribeActiveCleaningTasks((tasks) => {
      setActiveCleaningTasks(tasks);
      setBoardCleaningLoadedKey(String(userRole));
    }, (cause) => {
      setSyncError(cause.message);
      setBoardCleaningLoadedKey(String(userRole));
    });
  }, [userRole]);

  useEffect(() => {
    const requestKey = boardRequestKey;
    return subscribeReceptionBoard((data) => {
      setBoardStays(data.stays);
      setRoomCharges(data.roomCharges);
      setReceptionRooms(data.rooms);
      setBoardReceptionLoadedKey(requestKey);
    }, (cause) => {
      setSyncError(cause.message);
      if (userRole === 'admin') setMetricsErrorKey(requestKey);
      setBoardReceptionLoadedKey(requestKey);
    }, { includeUpcomingBreakfastCharges: userRole === 'admin' });
  }, [boardRequestKey, userRole]);

  useEffect(() => {
    if (userRole === 'admin') return;
    const requestKey = boardRequestKey;
    const unsubscribeRooms = subscribeRoomDirectory((rooms) => {
      setRoomDirectory(rooms);
      setBoardRoomsLoadedKey(requestKey);
    }, (cause) => {
      setSyncError(cause.message);
      setBoardRoomsLoadedKey(requestKey);
    });
    const unsubscribeReservations = subscribeCurrentReservationDirectory((reservations) => {
      setReservationDirectory(reservations);
      setBoardReservationsLoadedKey(requestKey);
    }, (cause) => {
      setSyncError(cause.message);
      setBoardReservationsLoadedKey(requestKey);
    });
    return () => {
      unsubscribeRooms();
      unsubscribeReservations();
    };
  }, [boardRequestKey, userRole]);

  useEffect(() => {
    if (userRole === 'admin') return;
    const stopRates = subscribeReceptionRates(setReceptionRates, () => setReceptionRates({ roomRates: {}, roomRatesByGuests: {}, addOnRates: {}, holidays: {} }));
    return () => stopRates();
  }, [userRole]);

  useEffect(() => {
    if (userRole === 'admin') return;
    return subscribeRoomCategories(setPriceCategories, () => setPriceCategories([]));
  }, [userRole]);

  useEffect(() => {
    if (userRole !== 'admin') return;
    let roomsLoaded = false;
    let inventoryLoaded = false;
    let minibarStockLoaded = false;
    const markLoaded = () => {
      if (roomsLoaded && inventoryLoaded && minibarStockLoaded) setMetricsLoadedKey(boardRequestKey);
    };
    const unsubscribeRooms = subscribeDashboardHousekeeping(boardTodayKey, (data) => {
      setHousekeeping(data);
      setBoardRoomsLoadedKey(boardRequestKey);
      setBoardReservationsLoadedKey(boardRequestKey);
      roomsLoaded = true;
      markLoaded();
    }, () => {
      setMetricsErrorKey(boardRequestKey);
      setBoardRoomsLoadedKey(boardRequestKey);
      setBoardReservationsLoadedKey(boardRequestKey);
      roomsLoaded = true;
      markLoaded();
    });
    const unsubscribeInventory = subscribeInventoryProducts((products) => {
      setInventoryProducts(products);
      inventoryLoaded = true;
      markLoaded();
    }, () => {
      setMetricsErrorKey(boardRequestKey);
      inventoryLoaded = true;
      markLoaded();
    });
    const unsubscribeMinibar = subscribeRoomAddOnInventory(({ stock }) => {
      setFrigobarStock(stock);
      minibarStockLoaded = true;
      markLoaded();
    }, () => {
      setMetricsErrorKey(boardRequestKey);
      minibarStockLoaded = true;
      markLoaded();
    });
    return () => {
      unsubscribeRooms();
      unsubscribeInventory();
      unsubscribeMinibar();
    };
  }, [userRole, boardRequestKey, boardTodayKey]);

  useEffect(() => {
    if (userRole !== 'admin') return;
    return subscribeDashboardCleaningTasks(boardTodayKey, (data) => {
      setCleaning(data);
      setBoardCleaningLoadedKey(boardRequestKey);
    }, (cause) => {
      setSyncError(cause.message);
      setMetricsErrorKey(boardRequestKey);
      setBoardCleaningLoadedKey(boardRequestKey);
    });
  }, [userRole, boardRequestKey, boardTodayKey]);

  useEffect(() => {
    if (userRole !== 'admin') return;
    return subscribeReservationCollections((collections) => {
      if (Object.keys(collections).length > 0) void syncReservationCollections().catch((cause: unknown) => setSyncError(cause instanceof Error ? cause.message : 'Não foi possível conciliar as cobranças de checkout.'));
    }, (cause) => setSyncError(cause.message));
  }, [userRole]);

  const metricDate = new Date(clock);
  const occupancy = hotelOccupancySummary(housekeeping, metricDate, { stays: boardStays, rooms: receptionRooms });
  const breakfastDay = breakfastForecastDay(metricDate);
  const breakfastForecast = userRole === 'admin' && boardReceptionLoaded && boardReservationsLoaded && !metricsError
    ? breakfastsOnDate(breakfastDay.date, boardStays, housekeeping.reservations, roomCharges)
    : null;
  const occupiedNumbers = occupiedRoomNumbers(housekeeping, boardStays, metricDate);
  const lowStockCount = Object.values(inventoryProducts).filter((product) => {
    const quantity = product.category === 'frigobar'
      ? Number(frigobarStock[product.id] ?? product.locationQuantities['Geladeira - Recepção'] ?? 0)
      : Object.values(product.locationQuantities ?? {}).reduce((total, value) => total + Number(value || 0), 0);
    return product.active !== false && (quantity <= 0 || (product.minimumQuantity > 0 && quantity <= product.minimumQuantity));
  }).length;
  const cleaningTasks = Object.values(cleaning.tasks);
  const cleaningNow = new Set(cleaningTasks.filter((task) => task.status === 'em_limpeza').map((task) => task.roomNumber.trim())).size;
  const cleanedToday = new Set([
    ...cleaningTasks.filter((task) => task.status === 'concluido' && task.completedAt && localDateKey(new Date(task.completedAt)) === boardTodayKey).map((task) => task.roomNumber.trim()),
    ...Object.values(housekeeping.cleaningLogs).filter((log) => log.date === boardTodayKey).map((log) => log.roomNumber.trim()),
  ]).size;
  const boardRooms = userRole === 'admin' ? Object.values(housekeeping.rooms) : Object.values(roomDirectory);
  const currentCleaningTasks = userRole === 'admin'
    ? cleaningTasks.filter((task) => task.status === 'em_limpeza')
    : Object.values(activeCleaningTasks);
  const cleaningRoomNumbers = new Set([
    ...boardRooms.filter((room) => room.cleaningStatus === 'em_limpeza').map((room) => room.number),
    ...currentCleaningTasks.map((task) => task.roomNumber),
  ]);
  const readyRooms = new Set(Object.values(housekeeping.rooms).filter((room) =>
    room.cleaningStatus === 'limpo'
      && room.maintenanceStatus !== 'em_manutencao'
      && !occupiedNumbers.has(room.number.trim())
      && !cleaningRoomNumbers.has(room.number),
  ).map((room) => room.number.trim())).size;
  const roomsInCleaning = cleaningRoomNumbers.size;
  const allMetricsLoaded = metricsLoaded && boardReceptionLoaded && boardCleaningLoaded;
  const displayedNotice = temporaryNotice ?? (flash ? { id: location.key, message: flash } : null);
  const valueOrLoading = (value: string | number) => allMetricsLoaded && !metricsError ? String(value) : '—';
  const detailOrLoading = (detail: string) => metricsError ? 'Dados indisponíveis' : allMetricsLoaded ? detail : 'Carregando dados';
  const liveReservations = userRole === 'admin' ? housekeeping.reservations : reservationDirectory;
  const todayLiveOccupants = useMemo(() => currentOccupants(boardStays, liveReservations, boardTodayKey, clock), [boardStays, liveReservations, boardTodayKey, clock]);
  const pendingDeparturesCount = useMemo(() => todayLiveOccupants.filter((item) => {
    if (item.sourceType === 'stay') {
      const stay = boardStays[item.sourceId];
      if (!stay) return false;
      if (stay.kind === 'periodo') {
        const end = rotativoEndTimestamp(stay);
        return Number.isFinite(end) && clock >= end;
      }
      return departureDue(item.checkOutDate, clock);
    }
    const reservation = liveReservations[item.sourceId];
    if (!reservation) return false;
    if (reservation.channel === 'rotativo') {
      const end = reservationRotativoEndTimestamp(reservation);
      return Number.isFinite(end) && clock >= end;
    }
    return departureDue(item.checkOutDate, clock);
  }).length, [todayLiveOccupants, boardStays, liveReservations, clock]);
  const checkoutMetric = <MetricCard title="Pendências de checkout" value={checkoutAlerts ? String(checkoutAlerts.length) : '—'}
    detail={!checkoutToday ? 'Consultando contas dos quartos' : !checkoutAlerts ? 'Consulta indisponível' : checkoutAlerts.length ? 'Hospedagens atuais com saldo a receber' : 'Hospedagens atuais sem saldo a receber'}
    tone={checkoutAlertsByRoom.size ? 'red' : 'neutral'} />;

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <Link to="/" className="dashboard-brand">
          <span className="dashboard-monogram">HL</span>
          <span><strong>Hotel Lindoia</strong><small>GESTÃO OPERACIONAL</small></span>
        </Link>
        <div className="dashboard-header-actions">
          <span className="dashboard-profile"><small>PERFIL ATIVO</small><strong>{profile}</strong></span>
          <button className="dashboard-logout" onClick={onLogout}>Encerrar sessão</button>
        </div>
      </header>

      <main className={`dashboard-content ${userRole !== 'admin' ? 'dashboard-content-employee' : ''}`}>
        <section className="dashboard-welcome">
          <div>
            <p className="dashboard-eyebrow">HOTEL LINDOIA <span>/</span> OPERAÇÃO</p>
            <h1>Visão operacional</h1>
            <p>Acesse os serviços do hotel e acompanhe a operação.</p>
          </div>
          {userRole === 'admin' && <Link to="/financeiro/relatorios" className="dashboard-reports-link inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold shadow-sm">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4v16h18M6 15l4-5 4 3 6-7m-4 0h4v4" /></svg>
            Relatórios e gráficos <span aria-hidden="true">→</span>
          </Link>}
        </section>

        {cashCollectionError && <div className="notice notice-error" role="alert">{cashCollectionError}</div>}
        {cleaningConcernError && <div className="notice notice-error" role="alert">{cleaningConcernError}</div>}
        {userRole === 'admin' && cleaningConcerns.length > 0 && <div className="notice notice-error" role="status">
          <strong>Indícios de uso relatados pela limpeza — conferir hospedagens e caixa</strong>
          {cleaningConcerns.map((log) => <p key={log.id}>Quarto {log.roomNumber} · {log.attendant} · {new Date(log.completedAt).toLocaleString('pt-BR')} · informado por {log.reportedBy || 'Equipe'} · <Link to={`/quartos?room=${encodeURIComponent(log.roomNumber)}`}>Consultar quarto</Link> · <Link to="/conferir-caixa">Conferir caixa</Link> <button type="button" disabled={Boolean(acknowledgingConcern)} onClick={() => void acknowledgeConcern(log)}>{acknowledgingConcern === log.id ? 'Confirmando...' : 'OK, conferido'}</button></p>)}
          <p>Relato para apuração, não prova de irregularidade.</p>
        </div>}
        {userRole === 'admin' && cashCollections.length > 0 && (() => {
          const totalPending = cashCollections.reduce((sum, item) => sum + item.amount, 0);
          const plural = cashCollections.length > 1;
          return (
            <section className="manager-collection-banner" role="status" aria-live="polite" aria-label="Recolhimentos de caixa aguardando confirmação">
              <div className="manager-collection-head">
                <div className="manager-collection-title-group">
                  <span className="manager-collection-icon" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l3-3h11v3M16 14h2" />
                    </svg>
                  </span>
                  <div>
                    <p className="manager-collection-eyebrow">SAÍDA DE CAIXA · RECOLHIDO PELA GERÊNCIA</p>
                    <h2>{plural ? `${cashCollections.length} recolhimentos de caixa aguardando confirmação` : 'Recolhimento de caixa aguardando confirmação'}</h2>
                    <p className="manager-collection-subtitle">Dinheiro retirado do caixa do plantão para a gerência. Confira o valor recebido em mãos antes de confirmar.</p>
                  </div>
                </div>
                <div className="manager-collection-summary">
                  <div className="manager-collection-total">
                    <small>{plural ? 'Total a conferir' : 'Valor a conferir'}</small>
                    <strong>{money(totalPending)}</strong>
                  </div>
                  <Link to="/conferir-caixa" className="manager-collection-link">Conferir caixa →</Link>
                </div>
              </div>

              <ul className="manager-collection-list">
                {cashCollections.map((item) => {
                  const created = new Date(item.createdAt);
                  const dateLabel = created.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
                  const timeLabel = created.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                  const busy = acknowledgingCollection === item.id;
                  return (
                    <li key={item.id} className="manager-collection-item">
                      <div className="manager-collection-amount">
                        <small>Valor recolhido</small>
                        <strong>{money(item.amount)}</strong>
                      </div>
                      <div className="manager-collection-meta">
                        <div className="manager-collection-meta-top">
                          <span className="manager-collection-attendant">
                            <span className="manager-collection-avatar" aria-hidden="true">{(item.attendant || 'E').slice(0, 1).toUpperCase()}</span>
                            <span>Plantonista: <strong>{item.attendant || 'Equipe'}</strong></span>
                          </span>
                          <span className="manager-collection-datetime">
                            <ClockIcon />
                            {dateLabel} às {timeLabel}
                          </span>
                        </div>
                        {item.note && <p className="manager-collection-note"><strong>Observação:</strong> {item.note}</p>}
                      </div>
                      <button
                        type="button"
                        className="manager-collection-confirm"
                        disabled={Boolean(acknowledgingCollection)}
                        onClick={() => void acknowledgeCollection(item)}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 13 4 4L19 7" /></svg>
                        {busy ? 'Confirmando…' : 'Confirmar recebimento'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })()}
        {syncError && <div className="notice notice-error" role="alert">{syncError}</div>}
        {displayedNotice && <div key={displayedNotice.id} className="dashboard-toast" role="status"><span aria-hidden="true">✓</span>{displayedNotice.message}</div>}

        {userRole === 'admin' && <section className="dashboard-metrics" aria-label="Indicadores operacionais">
          <MetricCard title={`Cafés da manhã · ${breakfastDay.isTomorrow ? 'amanhã' : 'hoje'}`} value={breakfastForecast === null ? '—' : String(breakfastForecast)} detail={metricsError ? 'Dados indisponíveis' : breakfastForecast === null ? 'Carregando hospedagens e reservas' : `${breakfastDay.date.split('-').reverse().join('/')} · ${breakfastDay.isTomorrow ? 'previsão para o pedido da padaria' : `serviço até ${HOTEL_BREAKFAST_END_TIME}`}`} tone="gold" />
          {checkoutMetric}
          <MetricCard title="Ocupação atual" value={valueOrLoading(occupancy.occupancyRate === null ? '—' : `${occupancy.occupancyRate}%`)} detail={detailOrLoading(occupancy.usableRooms ? `${occupancy.occupiedRooms} de ${occupancy.usableRooms} quartos utilizáveis` : 'Cadastre os quartos')} tone="blue" />
          <MetricCard title="Prontos para hospedagem" value={valueOrLoading(readyRooms)} detail={detailOrLoading('Limpos, livres e sem bloqueio de manutenção')} tone="green" />
          <MetricCard title="Limpezas designadas" value={valueOrLoading(cleaningNow)} detail={detailOrLoading('Quartos com limpeza designada em andamento')} tone="gold" />
          <MetricCard title="Quartos limpos hoje" value={valueOrLoading(cleanedToday)} detail={detailOrLoading('Quartos com limpeza concluída hoje')} tone="green" />
          <MetricCard title="Em limpeza" value={valueOrLoading(roomsInCleaning)} detail={detailOrLoading('Quartos com tarefa em andamento')} tone="gold" />
          <MetricCard title="Entradas hoje" value={valueOrLoading(occupancy.arrivalsToday.rooms)} detail={detailOrLoading(`Chegadas registradas ou previstas · check-in às ${HOTEL_CHECK_IN_TIME}`)} tone="gold" />
          <MetricCard title="Entradas amanhã" value={valueOrLoading(occupancy.arrivalsTomorrow.rooms)} detail={detailOrLoading(`Quartos com chegada prevista · check-in às ${HOTEL_CHECK_IN_TIME}`)} tone="blue" />
          <MetricCard title="Saídas hoje" value={valueOrLoading(occupancy.departuresToday.rooms)} detail={detailOrLoading(`Quartos com checkout previsto às ${HOTEL_CHECKOUT_TIME}`)} tone="red" />
          <MetricCard title="Saídas amanhã" value={valueOrLoading(occupancy.departuresTomorrow.rooms)} detail={detailOrLoading(`Quartos com checkout previsto às ${HOTEL_CHECKOUT_TIME}`)} tone="gold" />
          {userRole === 'admin' && <MetricCard title="Alertas de estoque" value={valueOrLoading(lowStockCount)} detail={detailOrLoading('Produtos ativos abaixo do mínimo ou sem saldo')} tone="neutral" />}
        </section>}

        {userRole !== 'admin' && <div className="duty-bar" aria-label="Plantonista">
          <span>Plantonista:</span>
          {attendant ? <strong>{attendant}</strong> : <small>Ninguém escalado neste horário</small>}
        </div>}
        {userRole !== 'admin' && <div className="dashboard-employee-checkout">{checkoutMetric}</div>}

        {userRole !== 'admin' && <section className="dashboard-modules dashboard-employee-modules" aria-label="O que você quer fazer?">
          <div className="dashboard-section-heading">
            <div><p className="dashboard-eyebrow">PLANTÃO</p><h2>O que você quer fazer?</h2></div>
            {priceSuggestionSummary && <small className="dashboard-price-suggestions" title={`Sugestões de diária para hoje${todayHoliday ? ` · ${todayHoliday}` : ''}: ${priceSuggestionSummary}`} aria-label={`Sugestões de diária para hoje: ${priceSuggestionSummary}`}>
              Diárias hoje{todayHoliday ? ` · ${todayHoliday}` : ''}: {priceSuggestionSummary}
            </small>}
          </div>
          <div className="action-grid">
            <ActionCard tone="blue" icon="bed" title="Adicionar Hóspede" onClick={() => setQuickReceptionKind('hospede')} />
            <ActionCard tone="gold" icon="clock" title="Adicionar Rotativo" onClick={() => setQuickReceptionKind('periodo')} />
            <ActionCard
              tone="amber"
              icon="checkout"
              title="Dar Check Out"
              hint={pendingDeparturesCount > 0 ? `${pendingDeparturesCount} saída(s) pendente(s)` : todayLiveOccupants.length > 0 ? `${todayLiveOccupants.length} ocupado(s)` : undefined}
              badge={pendingDeparturesCount > 0 ? pendingDeparturesCount : todayLiveOccupants.length > 0 ? todayLiveOccupants.length : undefined}
              onClick={() => setQuickCheckoutOpen(true)}
            />
            <ActionCard tone="red" icon="cart" title="Geladeira" onClick={() => setActiveTool('geladeira')} />
            <ActionCard tone="green" icon="receipt" title="Caixa" to="/conferir-caixa" />
            <ActionCard tone="slate" icon="wallet" title="Saída de Caixa" onClick={() => setActiveTool('saida-caixa')} />
            <ActionCard tone="teal" icon="sparkle" title="Controle de Limpeza" onClick={() => setActiveTool('limpeza')} />
            <ActionCard tone="purple" icon="outbox" title="Estoque" onClick={() => setActiveTool('estoque')} />
            <ActionCard tone="blue" icon="calendar" title="Escala" onClick={() => setActiveTool('escala')} />
          </div>
        </section>}

        <RoomBoard
          rooms={userRole === 'admin' ? housekeeping.rooms : roomDirectory}
          cleaningRoomNumbers={cleaningRoomNumbers}
          cleaningTasks={currentCleaningTasks}
          receptionRooms={receptionRooms}
          stays={boardStays}
          roomCharges={roomCharges}
          checkoutAlerts={checkoutAlertsByRoom}
          checkoutAlertsLoaded={Boolean(checkoutToday && checkoutAlerts)}
          reservations={userRole === 'admin' ? housekeeping.reservations : reservationDirectory}
          loaded={boardReceptionLoaded && boardRoomsLoaded && boardReservationsLoaded && boardCleaningLoaded}
          now={clock}
          attendant={attendant}
          userRole={userRole}
          entryContext={userRole === 'admin' ? { ...receptionEntryContext, roomDirectory: housekeeping.rooms, reservations: housekeeping.reservations } : receptionEntryContext}
          quickCheckoutOpen={quickCheckoutOpen}
          onCloseQuickCheckout={() => setQuickCheckoutOpen(false)}
          onChargeSaved={showTemporaryNotice}
        />

        <section className="dashboard-task-strip" aria-label="Prioridades do plantão"><a href="#room-board">Quartos e hospedagens<strong>Ver ocupação e saídas</strong><span>Abra o quarto para consultar a conta ou receber.</span></a><Link to="/limpeza">Limpeza<strong>{roomsInCleaning} em andamento</strong><span>Quartos aguardando limpeza ficam indisponíveis.</span></Link><Link to="/conferir-caixa">Caixa do plantão<strong>Conferir recebimentos</strong><span>Veja pagamentos, saídas e passagem de turno.</span></Link></section>

        {userRole === 'admin' && <section className="dashboard-modules">
          <div className="dashboard-section-heading">
            <div><p className="dashboard-eyebrow">ACESSO RÁPIDO</p><h2>Módulos do hotel</h2></div>
          </div>
          <div className="module-grid">
            <ModuleCard number="01" title="Lançar Venda" description="Venda bebidas, receba na hora ou registre por quarto." route="/vendas" />
            {userRole === 'admin' && <ModuleCard number="02" title="Controle de estoque" description="Limpeza, rouparia, manutenção e itens da recepção." route="/estoque" />}
            {userRole === 'admin' && <ModuleCard number="03" title="Gerenciar quartos" description="Configure categorias e camas por quarto; acompanhe limpeza e manutenção." route="/quartos" />}
            <ModuleCard number="04" title="Escala de funcionários" description="Calendário de turnos e equipe operacional." route="/escala" />
            {userRole === 'admin' && <ModuleCard number="05" title="Gestão financeira" description="Fluxo de caixa, folha e despesas do hotel." route="/financeiro/caixa" />}
            {userRole === 'admin' && <ModuleCard number="06" title="Recepção e reservas" description="Check-in, check-out e gestão de hóspedes." route="/reservas" />}
            <ModuleCard number="07" title="Caixa - Recepção" description="Plantão: entrada de hóspedes e movimentação do turno." route="/recepcao" />
            <ModuleCard number="08" title="Controle de Limpeza de Quartos" description="Designe quartos às camareiras e confirme quando estiverem limpos." route="/limpeza" />
            <ModuleCard number="09" title="Saída de produtos" description="Retire itens do estoque para uso interno do hotel." route="/saidas" />
            <ModuleCard number="10" title="Conferir caixa" description="Resumo das movimentações de cada plantonista por dia." route="/conferir-caixa" />
            <ModuleCard number="11" title="Saída de caixa" description="Dinheiro retirado do caixa para compras." route="/saida-caixa" />
          </div>
        </section>}
      </main>

      {quickReceptionKind && <Suspense fallback={<div className="reception-overlay" role="status">Abrindo cadastro…</div>}>
        <ReceptionQuickForm
          userRole={userRole}
          modalOnly
          initialKind={quickReceptionKind}
          entryContext={receptionEntryContext}
          onModalClose={(message) => {
            setQuickReceptionKind(null);
            if (message) showTemporaryNotice(message);
          }}
        />
      </Suspense>}

      {activeTool && <div className="dashboard-tool-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeTool(); }}>
        <section className={`dashboard-tool-modal${TOOL_HEADINGS[activeTool].wide ? ' dashboard-tool-modal--wide' : ''}`} data-tool={activeTool} role="dialog" aria-modal="true" aria-labelledby="dashboard-tool-title">
          <header className="dashboard-tool-modal-header">
            {TOOL_HEADINGS[activeTool].eyebrow
              ? <div><p className="dashboard-tool-eyebrow">{TOOL_HEADINGS[activeTool].eyebrow}</p><h2 id="dashboard-tool-title">{TOOL_HEADINGS[activeTool].title}</h2></div>
              : <h2 id="dashboard-tool-title">{TOOL_HEADINGS[activeTool].title}</h2>}
            <button type="button" aria-label="Fechar e voltar ao painel" onClick={closeTool}>×</button>
          </header>
          <div className="dashboard-tool-modal-content">
            <PanelModalProvider close={closeTool}>
              <Suspense fallback={<p className="dashboard-tool-loading" role="status">Carregando…</p>}>
                {activeTool === 'geladeira' && <SalesModalPage actor={salesActor} isAdmin={userRole === 'admin'} modalOnly />}
                {activeTool === 'saida-caixa' && <CashOutModalPage userRole={userRole} />}
                {activeTool === 'limpeza' && <CleaningModalPage userRole={userRole} modalOnly />}
                {activeTool === 'estoque' && <StockOutputModalPage userRole={userRole} />}
                {activeTool === 'escala' && <ScheduleModalPage userRole={userRole} />}
              </Suspense>
            </PanelModalProvider>
          </div>
        </section>
      </div>}
    </div>
  );
}

function dateKeyAfterDays(dateKey: string, days: number) {
  if (!Number.isFinite(days)) return '';
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string) {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(startTime) && Number.isFinite(endTime) ? Math.round((endTime - startTime) / 86_400_000) : 0;
}

function parseRoomChargeAmount(value: string) {
  const normalized = value.trim().includes(',')
    ? value.trim().replace(/\./g, '').replace(',', '.')
    : value.trim();
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
}

function money(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatTimeBR(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function isOccupantCheckoutDue(occupant: Pick<BoardOccupant, 'rotativo' | 'rotativoEnd' | 'checkOutDate'>, now: number): boolean {
  if (occupant.rotativo) {
    return occupant.rotativoEnd !== undefined && Number.isFinite(occupant.rotativoEnd) && now >= occupant.rotativoEnd;
  }
  return departureDue(occupant.checkOutDate, now);
}

interface BoardOccupant {
  roomNumber: string;
  sourceType: 'stay' | 'reservation';
  sourceId: string;
  name: string;
  peopleCount: number;
  includedBreakfastCount: number;
  breakfastAllowed: boolean;
  rotativo: boolean;
  rotativoHours?: number;
  rotativoEnd?: number;
  startDate: string;
  checkOutDate: string;
}

function buildOccupantsMap(
  stays: Record<string, GuestStay>,
  reservations: Record<string, ReservationDirectoryEntry>,
  today: string,
  actualToday: string,
  now: number,
  historical: boolean,
): Map<string, BoardOccupant> {
  const currentSelection = new Map(currentOccupants(stays, reservations, today, now).map((item) => [item.roomNumber, item]));
  const occupants = new Map<string, BoardOccupant>();
  const addOccupant = (roomNumber: string, candidate: Omit<BoardOccupant, 'roomNumber'>) => {
    const normalized = roomNumber.trim();
    if (!historical && (currentSelection.get(normalized)?.sourceId !== candidate.sourceId || currentSelection.get(normalized)?.sourceType !== candidate.sourceType)) return;
    const current = occupants.get(normalized);
    if (!current || candidate.startDate >= current.startDate) occupants.set(normalized, { ...candidate, roomNumber: normalized });
  };
  Object.values(stays).forEach((stay) => {
    if (!stay.roomNumber || !stayOccupiesDate(stay, today, actualToday, now)) return;
    const rotativoEnd = stay.kind === 'periodo' ? rotativoEndTimestamp(stay) : undefined;
    addOccupant(stay.roomNumber, {
      sourceType: 'stay',
      sourceId: stay.id,
      name: (stay.guestName ?? '').trim() || (stay.kind === 'periodo' ? 'Rotativo' : 'Titular não informado'),
      peopleCount: Math.max(1, Math.floor(stay.guestCount ?? (stay.hasAdditionalGuests ? 2 : 1))),
      includedBreakfastCount: stay.kind === 'hospede' ? stayBreakfastCountOnDate(stay, today) : 0,
      breakfastAllowed: stay.kind !== 'periodo',
      rotativo: stay.kind === 'periodo',
      ...(stay.kind === 'periodo' ? { rotativoHours: stay.hours ?? 4, rotativoEnd } : {}),
      startDate: stay.checkInDate,
      checkOutDate: stay.kind === 'periodo' ? stay.checkInDate : stay.checkOutDate ?? dateKeyAfterDays(stay.checkInDate, stay.nights),
    });
  });
  Object.values(reservations).forEach((reservation) => {
    if (!reservation.roomNumber || !reservationOccupiesDate(reservation, today, actualToday, now)) return;
    const rotativoEnd = reservation.channel === 'rotativo' ? reservationRotativoEndTimestamp(reservation) : undefined;
    addOccupant(reservation.roomNumber, {
      sourceType: 'reservation',
      sourceId: reservation.id,
      name: reservation.guestName?.trim() || (reservation.channel === 'rotativo' ? 'Rotativo' : 'Titular não informado'),
      peopleCount: Math.max(1, Number(reservation.adults ?? 1) + Number(reservation.children ?? 0)),
      includedBreakfastCount: reservation.channel !== 'rotativo' && reservation.breakfastIncluded === true
        ? Math.max(1, Number(reservation.adults ?? 1) + Number(reservation.children ?? 0))
        : 0,
      breakfastAllowed: reservation.channel !== 'rotativo',
      rotativo: reservation.channel === 'rotativo',
      ...(reservation.channel === 'rotativo' ? { rotativoHours: 4, rotativoEnd } : {}),
      startDate: reservation.checkInDate ?? '',
      checkOutDate: reservation.checkOutDate ?? today,
    });
  });
  return occupants;
}

type RoomBoardAction = RoomChargeKind | 'conversao_diaria';

function RoomBoard({ rooms, cleaningRoomNumbers, cleaningTasks, receptionRooms, stays: currentStays, roomCharges, checkoutAlerts, checkoutAlertsLoaded, reservations: currentReservations, loaded, now, attendant, userRole, entryContext, quickCheckoutOpen, onCloseQuickCheckout, onChargeSaved }: {
  rooms: Record<string, HousekeepingRoom>;
  cleaningRoomNumbers: ReadonlySet<string>;
  cleaningTasks: CleaningTask[];
  receptionRooms: Record<string, ReceptionRoom>;
  stays: Record<string, GuestStay>;
  roomCharges: Record<string, RoomCharge>;
  checkoutAlerts: ReadonlyMap<string, CheckoutAlert>;
  checkoutAlertsLoaded: boolean;
  reservations: Record<string, ReservationDirectoryEntry>;
  loaded: boolean;
  now: number;
  attendant: string;
  userRole: UserRole;
  entryContext: ReceptionEntryContext;
  quickCheckoutOpen: boolean;
  onCloseQuickCheckout: () => void;
  onChargeSaved: (message: string) => void;
}) {
  const isAdmin = userRole === 'admin';
  const [selectedManagerRoom, setSelectedManagerRoom] = useState('');
  const [selectedOccupant, setSelectedOccupant] = useState<BoardOccupant | null>(null);
  const [newGuestRoom, setNewGuestRoom] = useState('');
  const [newGuestKind, setNewGuestKind] = useState<StayKind | null>(null);
  const [chargeKind, setChargeKind] = useState<RoomBoardAction>('hospede_extra');
  const [guestName, setGuestName] = useState('');
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargeDays, setChargeDays] = useState('1');
  const [hasConversionBreakfast, setHasConversionBreakfast] = useState(false);
  const [conversionBreakfastRate, setConversionBreakfastRate] = useState('');
  const [conversionBreakfastMethod, setConversionBreakfastMethod] = useState<FinancePaymentMethod>('pix');
  const [conversionBreakfastSplit, setConversionBreakfastSplit] = useState(false);
  const [conversionBreakfastSplitMethod, setConversionBreakfastSplitMethod] = useState<FinancePaymentMethod>('cash');
  const [conversionBreakfastSplitAmount, setConversionBreakfastSplitAmount] = useState('');
  const [productId, setProductId] = useState('');
  const [quantityPerDay, setQuantityPerDay] = useState('1');
  const [addOnInventoryResult, setAddOnInventoryResult] = useState<{
    requestKey: string;
    data: Pick<FrigobarData, 'products' | 'stock'> | null;
    error: string;
  } | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<FinancePaymentMethod>('pix');
  const [splitPayment, setSplitPayment] = useState(false);
  const [splitMethod, setSplitMethod] = useState<FinancePaymentMethod>('cash');
  const [splitAmount, setSplitAmount] = useState('');
  const [chargeError, setChargeError] = useState('');
  const [savingCharge, setSavingCharge] = useState(false);
  const actualToday = hotelDate(new Date(now));
  const [arrivalBusy, setArrivalBusy] = useState('');
  const [arrivalError, setArrivalError] = useState('');
  const [maintenanceBusy, setMaintenanceBusy] = useState('');
  const [maintenanceError, setMaintenanceError] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const today = selectedDate || actualToday;
  const historical = today !== actualToday;
  const isPast = today < actualToday;
  const [history, setHistory] = useState<{ date: string; stays: Record<string, GuestStay>; reservations: Record<string, ReservationDirectoryEntry> } | null>(null);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    if (!isPast) return;
    const controller = new AbortController();
    void checkoutQuery<{ stays: Record<string, GuestStay>; reservations: Record<string, ReservationDirectoryEntry> }>('?action=history&date=' + today, controller.signal)
      .then((data) => { setHistory({ date: today, ...data }); setHistoryError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setHistoryError(cause.message); });
    return () => controller.abort();
  }, [isPast, today]);
  const stays = isPast ? history?.date === today ? history.stays : {} : currentStays;
  const reservations = isPast ? history?.date === today ? history.reservations : {} : currentReservations;
  const boardLoaded = loaded && (!isPast || history?.date === today);
  const roomsByNumber = new Map(Object.values(rooms).map((room) => [room.number.trim(), room]));
  const receptionRoomsByNumber = new Map(Object.values(receptionRooms).map((room) => [room.number.trim(), room]));
  const roomNumbers = [...new Set([
    ...Object.values(rooms).map((room) => room.number.trim()),
    ...Object.values(receptionRooms).map((room) => room.number.trim()),
  ])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));

  const occupants = buildOccupantsMap(stays, reservations, today, actualToday, now, historical);
  const liveTodayOccupants = historical
    ? buildOccupantsMap(currentStays, currentReservations, actualToday, actualToday, now, false)
    : occupants;

  const chargesForOccupant = (occupant: BoardOccupant) => Object.values(roomCharges).filter((charge) =>
    charge.sourceType === occupant.sourceType && charge.sourceId === occupant.sourceId,
  );

  function openChargeForm(occupant: BoardOccupant) {
    setSelectedOccupant(occupant);
    setChargeKind('hospede_extra');
    setGuestName('');
    setChargeAmount('');
    setChargeDays('1');
    setHasConversionBreakfast(false);
    setConversionBreakfastRate('');
    setConversionBreakfastMethod('pix');
    setConversionBreakfastSplit(false);
    setConversionBreakfastSplitAmount('');
    setProductId('');
    setQuantityPerDay('1');
    setPaymentMethod('pix');
    setSplitPayment(false);
    setSplitMethod('cash');
    setSplitAmount('');
    setChargeError('');
  }

  function changeChargeKind(kind: RoomBoardAction, initialGuestName = '') {
    setChargeKind(kind);
    setGuestName(initialGuestName);
    setChargeAmount('');
    setChargeDays('1');
    setHasConversionBreakfast(false);
    setConversionBreakfastRate('');
    setConversionBreakfastMethod('pix');
    setConversionBreakfastSplit(false);
    setConversionBreakfastSplitAmount('');
    setProductId('');
    setQuantityPerDay('1');
    setSplitPayment(false);
    setSplitAmount('');
    setChargeError('');
  }

  const validDays = Number(chargeDays);
  const daysAllowed = selectedOccupant
    ? chargeKind === 'conversao_diaria' ? 60 : Math.max(1, daysBetween(today, selectedOccupant.checkOutDate))
    : 1;
  const inventoryRequestKey = selectedOccupant && chargeKind === 'bebida'
    ? `${selectedOccupant.sourceType}:${selectedOccupant.sourceId}`
    : '';
  const hasCurrentInventoryResult = addOnInventoryResult?.requestKey === inventoryRequestKey;
  const addOnInventory = inventoryRequestKey && hasCurrentInventoryResult ? addOnInventoryResult.data : null;
  const inventoryError = hasCurrentInventoryResult ? addOnInventoryResult?.error ?? '' : '';
  const inventoryLoading = Boolean(inventoryRequestKey) && !hasCurrentInventoryResult;
  const availableProducts = Object.values(addOnInventory?.products ?? {}).filter((product) =>
    product.active && product.salePrice > 0 && Number(addOnInventory?.stock[product.id] ?? 0) > 0,
  );
  const selectedProductId = availableProducts.some((product) => product.id === productId)
    ? productId
    : availableProducts[0]?.id ?? '';
  const selectedProduct = availableProducts.find((product) => product.id === selectedProductId);
  const selectedStock = selectedProduct ? Number(addOnInventory?.stock[selectedProduct.id] ?? 0) : 0;
  const quantityPerDayValue = Number(quantityPerDay);
  const totalDrinkQuantity = Number.isInteger(validDays) && Number.isInteger(quantityPerDayValue) ? validDays * quantityPerDayValue : 0;
  const conversionStay = selectedOccupant?.sourceType === 'stay' ? stays[selectedOccupant.sourceId] : undefined;
  const conversionCredit = conversionStay?.kind === 'periodo' ? stayBillingLines(conversionStay)
    .filter((line) => line.category === 'Rotativo' && line.method !== 'courtesy')
    .reduce((sum, line) => sum + Math.round(line.amount * 100), 0) / 100 : 0;
  const conversionDailyTotal = chargeKind === 'conversao_diaria'
    ? Math.max(0, parseRoomChargeAmount(chargeAmount) * (Number.isInteger(validDays) ? validDays : 0) - conversionCredit)
    : 0;
  const conversionBreakfastTotal = chargeKind === 'conversao_diaria' && hasConversionBreakfast
    ? parseRoomChargeAmount(conversionBreakfastRate) * (selectedOccupant?.peopleCount ?? 1) * (Number.isInteger(validDays) ? validDays : 0)
    : 0;
  const chargeTotal = chargeKind === 'conversao_diaria'
    ? conversionDailyTotal + conversionBreakfastTotal
    : chargeKind === 'bebida'
      ? (selectedProduct?.salePrice ?? 0) * totalDrinkQuantity
      : parseRoomChargeAmount(chargeAmount) * (Number.isInteger(validDays) ? validDays : 0);
  const splitLimit = chargeKind === 'conversao_diaria' ? conversionDailyTotal : chargeTotal;

  useEffect(() => {
    if (!inventoryRequestKey) return;
    const requestKey = inventoryRequestKey;
    return subscribeRoomAddOnInventory((data) => {
      setAddOnInventoryResult({ requestKey, data, error: '' });
    }, (cause) => {
      setAddOnInventoryResult({
        requestKey,
        data: null,
        error: cause.message || 'Não foi possível consultar o estoque de bebidas.',
      });
    });
  }, [inventoryRequestKey]);

  async function submitRoomCharge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOccupant) return;
    const days = Number(chargeDays);
    const amount = Math.round(chargeTotal * 100) / 100;
    const secondAmount = splitPayment ? parseRoomChargeAmount(splitAmount) : 0;
    const chargeGuest = guestName.trim() || (chargeKind === 'cafe_avulso' || chargeKind === 'cama_extra' || chargeKind === 'bebida' ? selectedOccupant.name : '');
    if (!attendant.trim()) return setChargeError('Não há plantonista definido para registrar este pagamento.');
    if (!Number.isInteger(days) || days < 1 || days > daysAllowed) return setChargeError(`Informe uma quantidade de dias entre 1 e ${daysAllowed}.`);
    if (chargeKind !== 'bebida' && !parseRoomChargeAmount(chargeAmount)) return setChargeError('Informe um valor por dia maior que zero.');
    if (chargeKind === 'conversao_diaria' && (selectedOccupant.sourceType !== 'stay' || !selectedOccupant.rotativo)) return setChargeError('A conversão está disponível somente para um rotativo cadastrado na recepção.');
    if (chargeKind === 'conversao_diaria' && !chargeGuest) return setChargeError('Informe o nome do hóspede titular.');
    if (chargeKind === 'hospede_extra' && !chargeGuest) return setChargeError('Informe o nome do hóspede extra.');
    if (chargeKind === 'cafe_avulso' && !selectedOccupant.breakfastAllowed) return setChargeError('Café da manhã não está disponível para hospedagem rotativa.');
    if (chargeKind === 'bebida' && (!selectedProduct || !Number.isInteger(quantityPerDayValue) || quantityPerDayValue < 1 || totalDrinkQuantity > selectedStock)) return setChargeError('Selecione uma bebida e uma quantidade disponível no estoque.');
    if (splitLimit > 0 && splitPayment && (!secondAmount || secondAmount >= Math.min(amount, splitLimit) || splitMethod === paymentMethod)) {
      return setChargeError('A 2ª forma precisa ter valor válido e ser diferente da 1ª forma de pagamento.');
    }
    if (chargeKind === 'conversao_diaria') {
      const rotativo = selectedOccupant.sourceType === 'stay' ? stays[selectedOccupant.sourceId] : undefined;
      if (!rotativo || rotativo.kind !== 'periodo' || rotativo.status !== 'hospedado') return setChargeError('Este rotativo não está mais ativo. Atualize a tela e tente novamente.');
      if (hasConversionBreakfast && !parseRoomChargeAmount(conversionBreakfastRate)) return setChargeError('Informe um valor diário maior que zero para o café da manhã.');
      const breakfastSecondAmount = conversionBreakfastSplit ? parseRoomChargeAmount(conversionBreakfastSplitAmount) : 0;
      if (hasConversionBreakfast && conversionBreakfastSplit && (!breakfastSecondAmount || breakfastSecondAmount >= conversionBreakfastTotal || conversionBreakfastSplitMethod === conversionBreakfastMethod)) return setChargeError('Informe duas formas diferentes para o café e um valor positivo menor que o total do café na segunda forma.');
      const checkOutDate = dateKeyAfterDays(today, days);
      const overlaps = (start: string, end: string) => start < checkOutDate && today < end;
      const conflictingStay = Object.values(stays).some((stay) => stay.id !== rotativo.id && stay.status === 'hospedado'
        && stay.roomNumber === selectedOccupant.roomNumber && (stay.kind === 'periodo'
          ? guestStayOccupiesToday(stay, today, now)
          : overlaps(stay.checkInDate, stay.checkOutDate ?? dateKeyAfterDays(stay.checkInDate, stay.nights))));
      const conflictingReservation = Object.values(reservations).some((reservation) => (reservation.status === undefined || reservation.status === 'confirmada' || reservation.status === 'hospedado')
        && reservation.roomNumber === selectedOccupant.roomNumber && reservation.checkInDate && reservation.checkOutDate
        && overlaps(reservation.checkInDate, reservation.checkOutDate));
      if (conflictingStay || conflictingReservation) return setChargeError('Há outra hospedagem ou reserva para este quarto dentro do período escolhido. Confira a disponibilidade antes de converter.');
      if (conversionDailyTotal > 0 && splitPayment && (!secondAmount || secondAmount >= conversionDailyTotal || splitMethod === paymentMethod)) {
        return setChargeError('A 2ª forma de pagamento deve ser menor que o valor restante das diárias e diferente da 1ª forma.');
      }
      const createdAt = new Date().toISOString();
      const dailyStay: GuestStay = {
        id: crypto.randomUUID(), kind: 'hospede', checkInDate: today, nights: days, roomNumber: selectedOccupant.roomNumber,
        guestName: chargeGuest, dailyRate: parseRoomChargeAmount(chargeAmount),
        creditApplied: conversionCredit,
        dailyMethod: paymentMethod,
        ...(conversionDailyTotal > 0 && splitPayment && secondAmount ? { dailySplit: { method: splitMethod, amount: secondAmount } } : {}),
        guestCount: selectedOccupant.peopleCount, hasBreakfast: hasConversionBreakfast,
        breakfastCount: hasConversionBreakfast ? selectedOccupant.peopleCount : 0,
        breakfastRate: hasConversionBreakfast ? parseRoomChargeAmount(conversionBreakfastRate) : 0,
        ...(hasConversionBreakfast ? { breakfastMethod: conversionBreakfastMethod, ...(conversionBreakfastSplit ? { breakfastSplit: { method: conversionBreakfastSplitMethod, amount: breakfastSecondAmount } } : {}) } : {}),
        taxAmount: 0, taxMethod: paymentMethod, extras: [], note: `Conversão do rotativo ${rotativo.id}; crédito aplicado de ${money(conversionCredit)}.`,
        attendant: attendant.trim(), status: 'hospedado', checkOutDate, createdAt,
      };
      setSavingCharge(true);
      setChargeError('');
      try {
        await convertRotativoToDaily(rotativo, dailyStay);
        onChargeSaved(`Rotativo do quarto ${selectedOccupant.roomNumber} convertido em diária.`);
        setSelectedOccupant(null);
      } catch (cause) {
        setChargeError(cause instanceof Error ? cause.message : 'Não foi possível converter o rotativo em diária.');
      } finally {
        setSavingCharge(false);
      }
      return;
    }
    if (!amount) return setChargeError('O valor calculado precisa ser maior que zero.');

    const existingCharges = chargesForOccupant(selectedOccupant);
    const normalizedGuest = chargeGuest.toLocaleLowerCase('pt-BR');
    const validThrough = dateKeyAfterDays(today, days - 1);
    const overlapsDays = (charge: RoomCharge) => (charge.validFrom ?? charge.date) <= validThrough && today <= (charge.validThrough ?? charge.date);
    if (chargeKind === 'hospede_extra' && existingCharges.some((charge) =>
      charge.kind === 'hospede_extra'
      && charge.guestName.toLocaleLowerCase('pt-BR') === normalizedGuest
      && overlapsDays(charge),
    )) return setChargeError('Este hóspede já está adicionado ao quarto neste período.');
    if (chargeKind === 'cafe_avulso') {
      if (selectedOccupant.includedBreakfastCount > 0 && normalizedGuest === selectedOccupant.name.toLocaleLowerCase('pt-BR')) {
        return setChargeError('O café da manhã já está incluído para o hóspede titular.');
      }
      if (existingCharges.some((charge) => charge.kind === 'cafe_avulso' && overlapsDays(charge)
        && charge.guestName.toLocaleLowerCase('pt-BR') === normalizedGuest)) {
        return setChargeError('O café da manhã já está registrado para este hóspede em algum dia do período.');
      }
    }

    const createdAt = new Date().toISOString();
    const charge: RoomCharge = {
      id: crypto.randomUUID(),
      roomNumber: selectedOccupant.roomNumber,
      sourceType: selectedOccupant.sourceType,
      sourceId: selectedOccupant.sourceId,
      kind: chargeKind,
      guestName: chargeGuest,
      amount,
      days,
      ...(chargeKind === 'bebida'
        ? { quantity: totalDrinkQuantity, productId: selectedProduct!.id, productName: selectedProduct!.name }
        : { dailyRate: parseRoomChargeAmount(chargeAmount) }),
      date: cashShiftDate(new Date()),
      payments: {
        part1: { method: paymentMethod, amount: splitPayment ? Math.round((amount - secondAmount) * 100) / 100 : amount },
        ...(splitPayment ? { part2: { method: splitMethod, amount: secondAmount } } : {}),
      },
      attendant: attendant.trim(),
      createdAt,
      ...(chargeKind !== 'bebida' ? { validFrom: today, validThrough } : {}),
    };
    setSavingCharge(true);
    setChargeError('');
    try {
      await saveRoomCharge(charge);
      const labels: Record<RoomChargeKind, string> = { hospede_extra: 'Hóspede extra', cafe_avulso: 'Café da manhã', cama_extra: 'Cama extra', bebida: 'Bebida' };
      onChargeSaved(`${labels[chargeKind]} registrado no quarto ${selectedOccupant.roomNumber}.`);
      setSelectedOccupant(null);
    } catch (cause) {
      setChargeError(cause instanceof Error ? cause.message : 'Não foi possível registrar o adicional.');
    } finally {
      setSavingCharge(false);
    }
  }

  useEffect(() => {
    if (!selectedOccupant) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingCharge) setSelectedOccupant(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedOccupant, savingCharge]);

  useEffect(() => {
    if (!newGuestRoom || newGuestKind) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNewGuestRoom('');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newGuestRoom, newGuestKind]);

  return <section className="dashboard-rooms" aria-label="Situação dos quartos">
    <div className="dashboard-section-heading">
      <div><p className="dashboard-eyebrow">{isAdmin ? 'GERÊNCIA' : 'RECEPÇÃO'}</p><h2 id="room-board">{historical ? `Quartos em ${new Date(today + 'T12:00:00').toLocaleDateString('pt-BR')}` : 'Quartos de hoje'}</h2>{isAdmin && <small>Clique no quarto para ver a reserva, liberar ou bloquear.</small>}</div>
      {boardLoaded && <small>{roomNumbers.length} quartos · {roomNumbers.filter((number) => occupants.has(number)).length} ocupados</small>}
    </div>
    <div className="dashboard-board-date">
      {!isAdmin && <button type="button" className="dashboard-board-date-arrow" aria-label="Dia anterior" title="Dia anterior" onClick={() => { setSelectedDate(dateKeyAfterDays(today, -1)); setSelectedOccupant(null); setSelectedManagerRoom(''); setHistoryError(''); }}>‹</button>}
      <label>Consultar dia <input type="date" value={today} onChange={(event) => { if (event.target.value) { setSelectedDate(event.target.value); setSelectedOccupant(null); setSelectedManagerRoom(''); setHistoryError(''); } }} /></label>
      {!isAdmin && <button type="button" className="dashboard-board-date-arrow" aria-label="Dia seguinte" title="Dia seguinte" onClick={() => { setSelectedDate(dateKeyAfterDays(today, 1)); setSelectedOccupant(null); setSelectedManagerRoom(''); setHistoryError(''); }}>›</button>}
      <button type="button" onClick={() => { setSelectedDate(''); setSelectedOccupant(null); setSelectedManagerRoom(''); setHistoryError(''); }}>Hoje</button>
      {historical && <small>Consulta de ocupação. Limpeza e ações estão disponíveis na visão de hoje.</small>}
    </div>
    {isPast && historyError && <p role="alert">Não foi possível consultar a ocupação histórica. Volte a Hoje ou escolha uma data futura.</p>}
    {!boardLoaded
      ? <p className="dashboard-rooms-empty">{isPast && historyError ? 'Histórico indisponível nesta consulta.' : 'Carregando os quartos…'}</p>
      : roomNumbers.length === 0
        ? <p className="dashboard-rooms-empty">Nenhum quarto cadastrado.</p>
        : <div className="dashboard-room-grid">
          {roomNumbers.map((number) => {
            const room = roomsByNumber.get(number);
            const roomProfile = receptionRoomsByNumber.get(number);
            const occupant = occupants.get(number);
            const checkoutAlert = historical ? undefined : checkoutAlerts.get(number.trim());
            const checkoutLabel = checkoutAlert && occupant?.sourceType === checkoutAlert.sourceType && occupant.sourceId === checkoutAlert.sourceId
              ? `A receber no checkout · ${money(checkoutAlert.pending)}` : '';
            const cleaningTask = cleaningTasks.find((task) => task.roomNumber.trim() === number.trim() && task.status === 'em_limpeza');
            const isCleaning = !historical && (room?.cleaningStatus === 'em_limpeza' || cleaningRoomNumbers.has(number));
            const inMaintenance = !historical && !occupant && room?.maintenanceStatus === 'em_manutencao';
            const typeDescription = room?.categoryName || room?.bedComposition
              ? roomCategoryDescription(room)
              : roomProfile
              ? ROOM_TYPE_LABELS[roomProfile.type]
              : room?.category === 'casal'
                ? ROOM_TYPE_LABELS.casal
                : room?.category === 'solteiro'
                  ? ROOM_TYPE_LABELS.solteiro
                  : room?.category === 'triplo'
                    ? ROOM_TYPE_LABELS.triplo
                    : 'Tipo de quarto não informado';
            const description = room?.categoryName || room?.bedComposition
              ? roomCategoryDescription(room)
              : room?.bedCount
              ? `${typeDescription.split(' · ')[0]} · ${room.bedCount} ${room.bedCount === 1 ? 'cama' : 'camas'}`
              : typeDescription;
            const awaitingCheckout = !historical && Boolean(occupant) && isOccupantCheckoutDue(occupant!, now);
            const awaitingCleaning = !historical && !occupant && !inMaintenance && !isCleaning && Boolean(room) && room?.cleaningStatus !== 'limpo';
            const status = awaitingCheckout ? 'checkout' : occupant ? 'occupied' : inMaintenance ? 'maintenance' : isCleaning ? 'cleaning' : awaitingCleaning ? 'dirty' : 'free';
            const statusLabel = status === 'dirty' ? 'Aguardando limpeza' : status === 'cleaning' ? 'Em limpeza' : status === 'checkout' ? 'Saída pendente' : status === 'occupied' ? historical && occupant?.sourceType === 'reservation' && reservations[occupant.sourceId]?.status === 'confirmada' ? 'Reservado' : 'Ocupado' : status === 'maintenance' ? 'Em manutenção' : 'Livre';
            const unavailable = Boolean(inMaintenance || (!occupant && room && room.cleaningStatus !== 'limpo') || (!occupant && isCleaning));
            const cleaningLabel = isCleaning ? ', em limpeza' : '';
            const roomAction = isAdmin ? `Gerenciar quarto ${number}`
              : unavailable ? `Quarto ${number} ${statusLabel.toLocaleLowerCase('pt-BR')} e indisponível`
                : occupant ? `Abrir opções ou fazer check-out do quarto ${number}` : `Adicionar hóspede ou rotativo ao quarto ${number}`;
            const occupantCharges = occupant ? chargesForOccupant(occupant) : [];
            const activeExtraGuests = occupantCharges.filter((charge) => charge.kind === 'hospede_extra'
              && (charge.validFrom ?? charge.date) <= today
              && today <= (charge.validThrough ?? occupant?.checkOutDate ?? today));
            const activeBreakfastCharges = occupantCharges.filter((charge) => charge.kind === 'cafe_avulso'
              && (charge.validFrom ?? charge.date) <= today && today <= (charge.validThrough ?? charge.date));
            const peopleToday = occupant ? occupant.peopleCount + activeExtraGuests.length : 0;
            const breakfastsToday = occupant ? occupant.includedBreakfastCount + activeBreakfastCharges.length : 0;
            const peopleLabel = `${peopleToday} ${peopleToday === 1 ? 'pessoa' : 'pessoas'}`;
            const breakfastLabel = `${breakfastsToday} ${breakfastsToday === 1 ? 'café da manhã' : 'cafés da manhã'}`;
            const activeOtherCharges = occupantCharges.filter((charge) => (charge.kind === 'cama_extra' || charge.kind === 'bebida')
              && (charge.kind === 'bebida' ? charge.date === today : (charge.validFrom ?? charge.date) <= today && today <= (charge.validThrough ?? charge.date)));
            return <button
              type="button"
              className={`dashboard-room is-${status}${isCleaning ? ' is-cleaning' : ''}${checkoutLabel ? ' has-checkout-alert' : ''}`}
              key={number}
              disabled={historical || (!isAdmin && unavailable)}
              title={`${roomAction}${cleaningLabel}${checkoutLabel ? ` · ${checkoutLabel}` : ''}`}
              aria-label={`Quarto ${number}, ${statusLabel.toLocaleLowerCase('pt-BR')}${occupant ? ` por ${occupant.name}` : ''}${cleaningLabel}.${checkoutLabel ? ` ${checkoutLabel}.` : ''}${isAdmin ? ' Abrir opções da gerência.' : unavailable ? ' Indisponível.' : occupant ? ' Abrir opções do quarto.' : ' Adicionar hóspede ou rotativo.'}`}
              onClick={() => isAdmin
                ? setSelectedManagerRoom(number)
                : occupant
                ? openChargeForm(occupant)
                : !unavailable && setNewGuestRoom(number)}
            >
              <div className="dashboard-room-top">
                <strong><RoomIcon />{number}</strong>
                <div className="dashboard-room-indicators">
                  {checkoutLabel && <span className="dashboard-room-alert" title={checkoutLabel} aria-hidden="true">!</span>}
                  <span className={`dashboard-room-status is-${status}`} role="img" aria-label={statusLabel} title={statusLabel}><RoomStatusIcon status={status} /></span>
                </div>
              </div>
              <small className="dashboard-room-type">{description}</small>
              {isCleaning && <small className="dashboard-room-cleaning"><RoomStatusIcon status="cleaning" />Em limpeza</small>}
              {!historical && awaitingCheckout && <small className="dashboard-room-checkout-pill"><ClockIcon />Saída pendente</small>}
              {!historical && occupant && !awaitingCheckout && occupant.rotativo && occupant.rotativoEnd && <small className="dashboard-room-rotativo-tag">Rotativo · até {formatTimeBR(occupant.rotativoEnd)}</small>}
              {!historical && !occupant && !isCleaning && !inMaintenance && room && <small className={`dashboard-room-cleanliness is-${room.cleaningStatus}`}>{room.cleaningStatus === 'limpo' ? 'Limpo · Disponível' : 'Sujo · Aguardando limpeza'}</small>}
              {!historical && !occupant && inMaintenance && <small className="dashboard-room-cleanliness is-maintenance">Em manutenção</small>}
              {isAdmin && cleaningTask && <small className="dashboard-room-extra-guest">Camareira: {cleaningTask.camareira}</small>}
              <div className="dashboard-room-stats" aria-label={`${peopleLabel} no quarto e ${breakfastLabel} hoje`}>
                <span className={peopleToday > 0 ? 'has-value' : ''} title={peopleLabel} aria-label={peopleLabel}><PeopleIcon />{peopleToday}</span>
                <span className={breakfastsToday > 0 ? 'has-value has-breakfast' : 'no-breakfast'} title={breakfastLabel} aria-label={breakfastLabel}><BreakfastIcon />{breakfastsToday > 0 ? `${breakfastsToday} Café` : 'Sem café'}</span>
              </div>
              {occupant
                ? <>
                  <div className="dashboard-room-guest"><strong>{occupant.name}</strong></div>
                  {activeExtraGuests.map((charge) => <small className="dashboard-room-extra-guest" key={charge.id}>+ {charge.guestName}</small>)}
                  {activeOtherCharges.map((charge) => <small className="dashboard-room-extra-guest" key={charge.id}>{charge.kind === 'bebida' ? `🥤 ${charge.productName ?? 'Bebida'} ×${charge.quantity ?? 1}` : '🛏 Cama extra'}</small>)}
                </>
                : null}
            </button>;
          })}
        </div>}
    {!historical && boardLoaded && (() => {
      const expected = Object.values(stays).filter((stay) => stay.awaitingArrival && stay.status === 'hospedado' && stay.checkInDate <= dateKeyAfterDays(today, 1)).sort((a, b) => a.checkInDate.localeCompare(b.checkInDate));
      if (expected.length === 0) return null;
      return <details className="dashboard-maintenance" open>
        <summary>Chegadas previstas ({expected.length}) · Check-in às {HOTEL_CHECK_IN_TIME}</summary>
        {arrivalError && <p role="alert">{arrivalError}</p>}
        <ul className="dashboard-arrivals">{expected.map((stay) => <li key={stay.id}>
          <span><strong>Quarto {stay.roomNumber} · {stay.guestName}</strong><br /><small>{stay.guestCount ?? 1} pessoa(s) · chegada {new Date(`${stay.checkInDate}T12:00:00`).toLocaleDateString('pt-BR')} · {stay.nights} diária(s){stay.hasBreakfast ? ' · com café' : ''}{stay.note ? ` · ${stay.note}` : ''}</small></span>
          <button type="button" className="dashboard-room-charge-submit" disabled={arrivalBusy === stay.id} onClick={async () => {
            const room = roomsByNumber.get(stay.roomNumber);
            if (room && (room.maintenanceStatus === 'em_manutencao' || room.cleaningStatus !== 'limpo')) { setArrivalError(`O quarto ${stay.roomNumber} ainda não está limpo e liberado.`); return; }
            if (occupants.has(stay.roomNumber)) { setArrivalError(`O quarto ${stay.roomNumber} está ocupado no momento.`); return; }
            setArrivalBusy(stay.id); setArrivalError('');
            try { await confirmStayArrival(stay.id); onChargeSaved(`Check-in do quarto ${stay.roomNumber} confirmado.`); } catch (cause) { setArrivalError(cause instanceof Error ? cause.message : 'Não foi possível confirmar o check-in.'); } finally { setArrivalBusy(''); }
          }}>Conferir dados e fazer check-in</button>
        </li>)}</ul>
      </details>;
    })()}
    {!isAdmin && !historical && boardLoaded && (() => {
      const pending = roomNumbers.filter((number) => { const room = roomsByNumber.get(number); return room && !occupants.has(number) && room.cleaningStatus !== 'limpo' && room.maintenanceStatus !== 'em_manutencao' && !cleaningRoomNumbers.has(number); });
      const manageable = roomNumbers.filter((number) => !occupants.has(number) && !cleaningRoomNumbers.has(number) && roomsByNumber.get(number));
      return <>
        {new Date(now).getHours() >= 12 && pending.length > 0 && <p role="alert" className="dashboard-noon-alert">Atenção: já passou do meio-dia e existem quartos a serem limpos e liberados: {pending.join(', ')}.</p>}
        <details className="dashboard-maintenance">
          <summary>Bloquear / liberar quarto para manutenção</summary>
          {maintenanceError && <p role="alert">{maintenanceError}</p>}
          <div className="dashboard-maintenance-list">
            {manageable.map((number) => { const room = roomsByNumber.get(number)!; const blocked = room.maintenanceStatus === 'em_manutencao'; return <button type="button" key={number} disabled={maintenanceBusy === number} onClick={async () => { setMaintenanceBusy(number); setMaintenanceError(''); try { await setRoomMaintenanceBlock(room.id, !blocked); } catch (cause) { setMaintenanceError(cause instanceof Error ? cause.message : 'Não foi possível alterar o quarto.'); } finally { setMaintenanceBusy(''); } }}>{blocked ? `Liberar ${number} (em manutenção)` : `Bloquear ${number}`}</button>; })}
          </div>
        </details>
      </>;
    })()}
    {isAdmin && selectedManagerRoom && <Suspense fallback={<p role="status">Abrindo opções do quarto…</p>}>
      <ManagerRoomDialog
        key={`${selectedManagerRoom}:${occupants.get(selectedManagerRoom)?.sourceId ?? 'livre'}`}
        number={selectedManagerRoom}
        room={roomsByNumber.get(selectedManagerRoom)}
        receptionRoom={receptionRoomsByNumber.get(selectedManagerRoom)}
        occupant={occupants.get(selectedManagerRoom)}
        stay={occupants.get(selectedManagerRoom)?.sourceType === 'stay' ? stays[occupants.get(selectedManagerRoom)!.sourceId] : undefined}
        charges={occupants.has(selectedManagerRoom) ? chargesForOccupant(occupants.get(selectedManagerRoom)!) : []}
        cleaningTasks={cleaningTasks.filter((task) => task.roomNumber.trim() === selectedManagerRoom.trim())}
        onClose={() => setSelectedManagerRoom('')}
        onSaved={onChargeSaved}
      />
    </Suspense>}
    {selectedOccupant && (() => {
      const selectedAlert = checkoutAlerts.get(selectedOccupant.roomNumber.trim());
      const selectedHasAlert = Boolean(selectedAlert && selectedAlert.sourceType === selectedOccupant.sourceType && selectedAlert.sourceId === selectedOccupant.sourceId);
      const selectedDue = isOccupantCheckoutDue(selectedOccupant, now);
      const rotativoEndText = formatTimeBR(selectedOccupant.rotativoEnd);
      return <div className="dashboard-room-charge-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingCharge) setSelectedOccupant(null); }}>
        <form className="dashboard-room-charge-modal dashboard-occupied-room-modal" role="dialog" aria-modal="true" aria-labelledby="room-charge-title" onSubmit={(event) => void submitRoomCharge(event)}>
          <header className="dashboard-room-charge-header">
            <div><p className="dashboard-eyebrow">QUARTO {selectedOccupant.roomNumber}</p><h2 id="room-charge-title">Opções do quarto</h2><small>Titular: {selectedOccupant.name}</small></div>
            <button type="button" className="dashboard-room-charge-close" aria-label="Fechar" disabled={savingCharge} onClick={() => setSelectedOccupant(null)}>×</button>
          </header>
          <section className={`dashboard-room-checkout-panel${selectedDue ? ' is-due' : ''}${selectedHasAlert ? ' has-alert' : ''}`} aria-label="Check-out do quarto">
            <div className="dashboard-room-checkout-copy">
              <div className="dashboard-room-checkout-tags">
                <strong>Check-out do quarto {selectedOccupant.roomNumber}</strong>
                {selectedDue && <span className="dashboard-room-checkout-tag is-due">Saída pendente</span>}
                {selectedOccupant.rotativo && <span className="dashboard-room-checkout-tag">Rotativo{rotativoEndText ? ` · até ${rotativoEndText}` : ''}</span>}
              </div>
              <p>
                {selectedOccupant.rotativo
                  ? selectedDue
                    ? `Período rotativo encerrado${rotativoEndText ? ` às ${rotativoEndText}` : ''}. Confirme o check-out para marcar o quarto como Sujo (Aguardando limpeza).`
                    : `Ao encerrar o rotativo, o quarto passa para Sujo (Aguardando limpeza) e só volta a ficar livre após a limpeza.`
                  : selectedDue
                    ? `Saída prevista para ${selectedOccupant.checkOutDate.split('-').reverse().join('/')} às ${HOTEL_CHECKOUT_TIME}. Confira a conta e faça o check-out para liberar o quarto para limpeza.`
                    : `Ao confirmar o check-out, o quarto passa para Sujo (Aguardando limpeza) e só volta a ficar disponível após a limpeza.`}
              </p>
              {selectedHasAlert && selectedAlert && <p className="dashboard-room-checkout-pending" role="status">Saldo pendente de <strong>{money(selectedAlert.pending)}</strong> na conta ou geladeira. Receba antes de concluir o check-out.</p>}
            </div>
            <button type="button" className="dashboard-room-release-button" disabled={savingCharge} onClick={() => {
              if (!window.confirm(`Dar check-out do quarto ${selectedOccupant.roomNumber}? O quarto ficará como Sujo (Aguardando limpeza).`)) return;
              setSavingCharge(true); setChargeError('');
              void requestCheckout({ sourceType: selectedOccupant.sourceType, sourceId: selectedOccupant.sourceId })
                .then(() => { setSelectedOccupant(null); onChargeSaved(`Check-out realizado. Quarto ${selectedOccupant.roomNumber} aguardando limpeza.`); })
                .catch((cause) => setChargeError(cause.message)).finally(() => setSavingCharge(false));
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
              {savingCharge ? 'Realizando check-out…' : 'Dar Check-out'}
            </button>
          </section>
          {chargeError && <p className="dashboard-room-charge-error" role="alert">{chargeError}</p>}
          {selectedOccupant.sourceType === 'stay' && stays[selectedOccupant.sourceId] && <StayAccount stay={stays[selectedOccupant.sourceId]} charges={chargesForOccupant(selectedOccupant)} attendant={attendant} canManage={userRole === 'admin'} onSaved={onChargeSaved} />}
          <fieldset className="dashboard-room-charge-types">
            <legend>O que deseja fazer?</legend>
            <label><input type="radio" name="roomChargeKind" value="hospede_extra" checked={chargeKind === 'hospede_extra'} onChange={() => changeChargeKind('hospede_extra')} /><span>Hóspede extra</span></label>
            {selectedOccupant.breakfastAllowed && <label><input type="radio" name="roomChargeKind" value="cafe_avulso" checked={chargeKind === 'cafe_avulso'} onChange={() => changeChargeKind('cafe_avulso')} /><span>Café da manhã</span></label>}
            <label><input type="radio" name="roomChargeKind" value="cama_extra" checked={chargeKind === 'cama_extra'} onChange={() => changeChargeKind('cama_extra', selectedOccupant.name)} /><span>Cama extra</span></label>
            <label><input type="radio" name="roomChargeKind" value="bebida" checked={chargeKind === 'bebida'} onChange={() => changeChargeKind('bebida', selectedOccupant.name)} /><span>Bebida</span></label>
            {selectedOccupant.rotativo && selectedOccupant.sourceType === 'stay' && <label><input type="radio" name="roomChargeKind" value="conversao_diaria" checked={chargeKind === 'conversao_diaria'} onChange={() => changeChargeKind('conversao_diaria', selectedOccupant.name === 'Titular não informado' || selectedOccupant.name === 'Rotativo' ? '' : selectedOccupant.name)} /><span>Converter em diária</span></label>}
          </fieldset>
          <div className="dashboard-room-charge-grid">
            {chargeKind !== 'bebida' && <label className="dashboard-room-charge-field dashboard-room-charge-wide"><span>{chargeKind === 'hospede_extra' ? 'Nome do hóspede extra' : chargeKind === 'conversao_diaria' ? 'Nome do hóspede titular' : chargeKind === 'cafe_avulso' ? 'Quem vai tomar café?' : 'Hóspede responsável pela cama extra'}</span><input value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={120} placeholder="Nome completo" required={chargeKind === 'hospede_extra' || chargeKind === 'conversao_diaria'} autoFocus /></label>}
            {chargeKind === 'bebida' && <>
              <label className="dashboard-room-charge-field"><span>Bebida</span><select value={selectedProductId} onChange={(event) => setProductId(event.target.value)} disabled={inventoryLoading || availableProducts.length === 0} required><option value="">{inventoryLoading ? 'Consultando estoque…' : 'Selecione'}</option>{availableProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {money(product.salePrice)} · saldo {addOnInventory?.stock[product.id] ?? 0}</option>)}</select></label>
              <label className="dashboard-room-charge-field"><span>Unidades por dia</span><input type="number" min="1" max={Math.max(1, Math.floor(selectedStock / Math.max(1, validDays || 1)))} step="1" value={quantityPerDay} onChange={(event) => setQuantityPerDay(event.target.value)} required /></label>
              {inventoryError && <p className="dashboard-room-charge-error dashboard-room-charge-wide" role="alert">{inventoryError}</p>}
              {!inventoryLoading && !inventoryError && availableProducts.length === 0 && <p className="dashboard-room-charge-error dashboard-room-charge-wide">Não há bebidas disponíveis com saldo no estoque da recepção.</p>}
            </>}
            <label className="dashboard-room-charge-field"><span>{chargeKind === 'conversao_diaria' ? 'Valor de 1 diária (R$)' : chargeKind === 'cafe_avulso' ? 'Valor por dia do café (R$)' : chargeKind === 'cama_extra' ? 'Valor por dia da cama extra (R$)' : chargeKind === 'bebida' ? 'Estadia vinculada ao hóspede' : 'Valor por dia do hóspede extra (R$)'}</span>{chargeKind === 'bebida' ? <input value={selectedOccupant.name} readOnly /> : <input inputMode="decimal" value={chargeAmount} onChange={(event) => setChargeAmount(event.target.value)} placeholder="0,00" required />}</label>
            <label className="dashboard-room-charge-field"><span>{chargeKind === 'conversao_diaria' ? 'Quantidade de diárias' : 'Quantidade de dias'}</span><input type="number" min="1" max={daysAllowed} step="1" value={chargeDays} onChange={(event) => setChargeDays(event.target.value)} required /></label>
            {chargeKind === 'conversao_diaria' && <>
              <label className="dashboard-room-charge-split dashboard-room-charge-wide"><input type="checkbox" checked={hasConversionBreakfast} onChange={(event) => setHasConversionBreakfast(event.target.checked)} /> Incluir café da manhã nas diárias</label>
              {hasConversionBreakfast && <>
                <label className="dashboard-room-charge-field"><span>Valor por café/dia (R$)</span><input inputMode="decimal" value={conversionBreakfastRate} onChange={(event) => setConversionBreakfastRate(event.target.value)} placeholder="0,00" required /></label>
                <label className="dashboard-room-charge-field"><span>Pagamento do café</span><select value={conversionBreakfastMethod} onChange={(event) => {
                  const method = event.target.value as FinancePaymentMethod;
                  setConversionBreakfastMethod(method);
                  if (conversionBreakfastSplitMethod === method) setConversionBreakfastSplitMethod(FOLIO_PAYMENT_METHODS.find((option) => option !== method) ?? method);
                }}>{FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}</select></label>
                <label className="dashboard-room-charge-split dashboard-room-charge-wide"><input type="checkbox" checked={conversionBreakfastSplit} onChange={(event) => setConversionBreakfastSplit(event.target.checked)} /> Combinar pagamento do café</label>
                {conversionBreakfastSplit && <>
                  <label className="dashboard-room-charge-field"><span>2ª forma do café</span><select value={conversionBreakfastSplitMethod} onChange={(event) => setConversionBreakfastSplitMethod(event.target.value as FinancePaymentMethod)}>{FOLIO_PAYMENT_METHODS.filter((method) => method !== conversionBreakfastMethod).map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}</select></label>
                  <label className="dashboard-room-charge-field"><span>Valor na 2ª forma do café (R$)</span><input inputMode="decimal" value={conversionBreakfastSplitAmount} onChange={(event) => setConversionBreakfastSplitAmount(event.target.value)} required /></label>
                </>}
              </>}
            </>}
            <label className="dashboard-room-charge-field"><span>{splitPayment ? '1ª forma de pagamento' : 'Forma de pagamento'}</span><select value={paymentMethod} onChange={(event) => {
              const method = event.target.value as FinancePaymentMethod;
              setPaymentMethod(method);
              if (splitMethod === method) setSplitMethod(FOLIO_PAYMENT_METHODS.find((option) => option !== method) ?? method);
            }}>{FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}</select></label>
            <label className="dashboard-room-charge-split dashboard-room-charge-wide"><input type="checkbox" checked={splitPayment} disabled={splitLimit <= 0} onChange={(event) => setSplitPayment(event.target.checked)} /> Combinar duas formas de pagamento{chargeKind === 'conversao_diaria' ? ' das diárias' : ''}</label>
            {splitPayment && splitLimit > 0 && <>
              <label className="dashboard-room-charge-field"><span>2ª forma de pagamento</span><select value={splitMethod} onChange={(event) => setSplitMethod(event.target.value as FinancePaymentMethod)}>{FOLIO_PAYMENT_METHODS.filter((method) => method !== paymentMethod).map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}</select></label>
              <label className="dashboard-room-charge-field"><span>Valor na 2ª forma (R$)</span><input inputMode="decimal" value={splitAmount} onChange={(event) => setSplitAmount(event.target.value)} placeholder="0,00" required /></label>
            </>}
          </div>
          <div className="dashboard-room-charge-total"><span>{chargeKind === 'conversao_diaria' ? `Total da diária após crédito de ${money(conversionCredit)}` : 'Total cobrado'}</span><strong>{money(chargeTotal)}</strong>
            {chargeKind === 'bebida' && selectedProduct && <small>{totalDrinkQuantity} unidade(s) · {money(selectedProduct.salePrice)} cada · estoque disponível {selectedStock}</small>}
            {chargeKind === 'conversao_diaria' && <small>Diárias após crédito: {money(conversionDailyTotal)}{hasConversionBreakfast ? ` · café: ${money(conversionBreakfastTotal)}` : ''}</small>}
            {chargeKind !== 'conversao_diaria' && chargeKind !== 'bebida' && <small>{validDays} dia(s) × {money(parseRoomChargeAmount(chargeAmount))} por dia</small>}
            {splitPayment && splitLimit > 0 && parseRoomChargeAmount(splitAmount) > 0 && <small>{PAYMENT_METHOD_LABELS[paymentMethod]} {money(Math.max(0, splitLimit - parseRoomChargeAmount(splitAmount)))} + {PAYMENT_METHOD_LABELS[splitMethod]} {money(parseRoomChargeAmount(splitAmount))}</small>}
            {chargeKind === 'conversao_diaria' && hasConversionBreakfast && <small>Café: {PAYMENT_METHOD_LABELS[conversionBreakfastMethod]} {money(Math.max(0, conversionBreakfastTotal - (conversionBreakfastSplit ? parseRoomChargeAmount(conversionBreakfastSplitAmount) : 0)))}{conversionBreakfastSplit ? ` + ${PAYMENT_METHOD_LABELS[conversionBreakfastSplitMethod]} ${money(parseRoomChargeAmount(conversionBreakfastSplitAmount))}` : ''}</small>}
          </div>
          <div className="dashboard-room-charge-actions"><button type="button" className="dashboard-room-charge-cancel" disabled={savingCharge} onClick={() => setSelectedOccupant(null)}>Cancelar</button><button type="submit" className="dashboard-room-charge-submit" disabled={savingCharge || (chargeKind === 'bebida' && (!selectedProduct || inventoryLoading || Boolean(inventoryError)))}>{savingCharge ? 'Registrando…' : chargeKind === 'conversao_diaria' ? 'Converter em diária' : 'Confirmar pagamento'}</button></div>
        </form>
      </div>;
    })()}
    {quickCheckoutOpen && (
      <QuickCheckoutModal
        occupants={[...liveTodayOccupants.values()]}
        checkoutAlerts={checkoutAlerts}
        checkoutAlertsLoaded={checkoutAlertsLoaded}
        now={now}
        onClose={onCloseQuickCheckout}
        onOpenAccount={(occupant) => {
          onCloseQuickCheckout();
          if (historical) setSelectedDate('');
          openChargeForm(occupant);
        }}
        onCheckedOut={(message) => onChargeSaved(message)}
      />
    )}
    {newGuestRoom && !newGuestKind && <div className="dashboard-room-charge-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewGuestRoom(''); }}>
      <section className="dashboard-room-choice" role="dialog" aria-modal="true" aria-labelledby="room-choice-title">
        <div><p className="dashboard-eyebrow">QUARTO {newGuestRoom}</p><h2 id="room-choice-title">Quarto livre</h2><p>O que deseja cadastrar neste quarto?</p></div>
        <div className="dashboard-room-choice-actions">
          <button type="button" onClick={() => setNewGuestKind('hospede')}><RoomIcon /><strong>Hóspede</strong></button>
          <button type="button" onClick={() => setNewGuestKind('periodo')}><ClockIcon /><strong>Rotativo</strong></button>
        </div>
        <button type="button" className="dashboard-room-choice-cancel" onClick={() => setNewGuestRoom('')}>Cancelar</button>
      </section>
    </div>}
    {newGuestRoom && newGuestKind && <Suspense fallback={<div className="reception-overlay" role="status">Abrindo cadastro do quarto {newGuestRoom}…</div>}>
      <ReceptionQuickForm
        userRole={userRole}
        modalOnly
        initialKind={newGuestKind}
        initialRoom={newGuestRoom}
        entryContext={entryContext}
        onModalClose={(message) => {
          setNewGuestRoom('');
          setNewGuestKind(null);
          if (message) onChargeSaved(message);
        }}
      />
    </Suspense>}
  </section>;
}

function QuickCheckoutModal({ occupants, checkoutAlerts, checkoutAlertsLoaded, now, onClose, onOpenAccount, onCheckedOut }: {
  occupants: BoardOccupant[];
  checkoutAlerts: ReadonlyMap<string, CheckoutAlert>;
  checkoutAlertsLoaded: boolean;
  now: number;
  onClose: () => void;
  onOpenAccount: (occupant: BoardOccupant) => void;
  onCheckedOut: (message: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [confirmingKey, setConfirmingKey] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [errorState, setErrorState] = useState<{ message: string; occupant?: BoardOccupant } | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyKey) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busyKey, onClose]);

  const sorted = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    return occupants
      .map((occupant) => {
        const alert = checkoutAlerts.get(occupant.roomNumber.trim());
        const matchedAlert = alert && alert.sourceType === occupant.sourceType && alert.sourceId === occupant.sourceId ? alert : undefined;
        return {
          occupant,
          due: isOccupantCheckoutDue(occupant, now),
          alert: matchedAlert,
        };
      })
      .filter(({ occupant }) => !term
        || occupant.roomNumber.toLocaleLowerCase('pt-BR').includes(term)
        || occupant.name.toLocaleLowerCase('pt-BR').includes(term))
      .sort((a, b) => Number(b.due) - Number(a.due) || a.occupant.roomNumber.localeCompare(b.occupant.roomNumber, 'pt-BR', { numeric: true }));
  }, [occupants, checkoutAlerts, now, search]);

  const dueCount = occupants.filter((occupant) => isOccupantCheckoutDue(occupant, now)).length;
  const pendingBalanceCount = occupants.filter((occupant) => {
    const alert = checkoutAlerts.get(occupant.roomNumber.trim());
    return Boolean(alert && alert.sourceType === occupant.sourceType && alert.sourceId === occupant.sourceId);
  }).length;

  async function confirmCheckout(occupant: BoardOccupant) {
    const key = `${occupant.sourceType}:${occupant.sourceId}`;
    setBusyKey(key);
    setErrorState(null);
    try {
      await requestCheckout({ sourceType: occupant.sourceType, sourceId: occupant.sourceId });
      setConfirmingKey('');
      onCheckedOut(`Check-out do quarto ${occupant.roomNumber} realizado. Quarto aguardando limpeza.`);
      if (occupants.length <= 1) onClose();
    } catch (cause) {
      setConfirmingKey('');
      setErrorState({
        message: cause instanceof Error ? cause.message : 'Não foi possível concluir o check-out.',
        occupant,
      });
    } finally {
      setBusyKey('');
    }
  }

  return (
    <div className="dashboard-room-charge-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyKey) onClose(); }}>
      <section className="dashboard-room-charge-modal dashboard-quick-checkout-modal" role="dialog" aria-modal="true" aria-labelledby="quick-checkout-title">
        <header className="dashboard-room-charge-header">
          <div>
            <p className="dashboard-eyebrow">RECEPÇÃO / CHECK-OUT</p>
            <h2 id="quick-checkout-title">Dar Check-out</h2>
            <small>Após o check-out, o quarto muda para Sujo (Aguardando limpeza) e só volta a ficar livre depois de limpo.</small>
          </div>
          <button type="button" className="dashboard-room-charge-close" aria-label="Fechar" disabled={Boolean(busyKey)} onClick={onClose}>×</button>
        </header>

        <div className="quick-checkout-stats">
          <span><strong>{occupants.length}</strong> {occupants.length === 1 ? 'quarto ocupado' : 'quartos ocupados'}</span>
          {dueCount > 0 && <span className="is-due"><strong>{dueCount}</strong> {dueCount === 1 ? 'saída pendente' : 'saídas pendentes'}</span>}
          {pendingBalanceCount > 0 && <span className="has-alert"><strong>{pendingBalanceCount}</strong> com saldo a receber</span>}
        </div>

        {occupants.length > 0 && (
          <label className="quick-checkout-search">
            <span>Buscar quarto ou hóspede</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Ex.: 209 ou nome do hóspede"
              autoFocus
            />
          </label>
        )}

        {errorState && (
          <div className="quick-checkout-error" role="alert">
            <p>{errorState.message}</p>
            {errorState.occupant && (
              <button type="button" onClick={() => onOpenAccount(errorState.occupant!)}>
                Abrir conta do quarto {errorState.occupant.roomNumber}
              </button>
            )}
          </div>
        )}

        {occupants.length === 0 ? (
          <div className="quick-checkout-empty">
            <strong>Nenhum quarto ocupado no momento</strong>
            <p>Todos os quartos estão livres, aguardando limpeza ou em manutenção.</p>
          </div>
        ) : sorted.length === 0 ? (
          <div className="quick-checkout-empty">
            <strong>Nenhum quarto encontrado</strong>
            <p>Tente outro número de quarto ou nome de hóspede.</p>
          </div>
        ) : (
          <ul className="quick-checkout-list">
            {sorted.map(({ occupant, due, alert }) => {
              const key = `${occupant.sourceType}:${occupant.sourceId}`;
              const confirming = confirmingKey === key;
              const busy = busyKey === key;
              const endTime = formatTimeBR(occupant.rotativoEnd);
              const stayInfo = occupant.rotativo
                ? endTime
                  ? due ? `Rotativo · encerrou às ${endTime}` : `Rotativo · encerra às ${endTime}`
                  : 'Rotativo'
                : `Diária · saída ${occupant.checkOutDate ? occupant.checkOutDate.split('-').reverse().join('/') : 'hoje'}`;
              return (
                <li key={key} className={`quick-checkout-item${due ? ' is-due' : ''}${alert ? ' has-alert' : ''}`}>
                  <div className="quick-checkout-room">
                    <span className="quick-checkout-room-badge">Qto {occupant.roomNumber}</span>
                    <div className="quick-checkout-info">
                      <div className="quick-checkout-name-row">
                        <strong>{occupant.name}</strong>
                        {due && <span className="quick-checkout-pill is-due">Saída pendente</span>}
                        {alert
                          ? <span className="quick-checkout-pill has-alert">Saldo: {money(alert.pending)}</span>
                          : checkoutAlertsLoaded
                            ? <span className="quick-checkout-pill is-paid">Conta quitada</span>
                            : null}
                      </div>
                      <small>{stayInfo}</small>
                    </div>
                  </div>
                  {confirming ? (
                    <div className="quick-checkout-confirm">
                      <p>Confirmar check-out do quarto <strong>{occupant.roomNumber}</strong>? O quarto ficará como <strong>Sujo (Aguardando limpeza)</strong>.</p>
                      <div className="quick-checkout-confirm-actions">
                        <button type="button" className="quick-checkout-secondary" disabled={busy} onClick={() => setConfirmingKey('')}>Cancelar</button>
                        <button type="button" className="quick-checkout-primary" disabled={busy} onClick={() => void confirmCheckout(occupant)}>
                          {busy ? 'Finalizando…' : 'Confirmar check-out'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="quick-checkout-actions">
                      <button type="button" className="quick-checkout-secondary" disabled={Boolean(busyKey)} onClick={() => onOpenAccount(occupant)}>
                        {alert ? 'Abrir conta e receber' : 'Ver conta'}
                      </button>
                      {!alert && (
                        <button type="button" className="quick-checkout-primary" disabled={Boolean(busyKey)} onClick={() => { setErrorState(null); setConfirmingKey(key); }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                          Dar Check-out
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function MetricCard({ title, value, detail, tone }: { title: string; value: string; detail: string; tone: string }) {
  return <article className={`dashboard-metric metric-${tone}`}><span className="metric-rule" /><p>{title}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function RoomIcon() {
  return <svg className="dashboard-room-number-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 19V6M21 19v-5M3 14h18v-3a3 3 0 0 0-3-3H3M6 11V9h5v2" /></svg>;
}

function PeopleIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.8M18 14a5 5 0 0 1 3 4.5" /></svg>;
}

function ClockIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}

function RoomStatusIcon({ status }: { status: 'occupied' | 'free' | 'maintenance' | 'cleaning' | 'checkout' | 'dirty' }) {
  if (status === 'checkout') return <ClockIcon />;
  if (status === 'dirty') status = 'cleaning';
  const path = status === 'occupied'
    ? <><circle cx="12" cy="8" r="3" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>
    : status === 'free'
      ? <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>
      : status === 'cleaning'
        ? <><path d="m4 20 9-9M12 4l8 8M14 2l8 8M3 18l3 3M13 11 6 4" /></>
        : <><path d="M14.5 6.5a5 5 0 0 0-6.7 6.7L3 18l3 3 4.8-4.8a5 5 0 0 0 6.7-6.7l-3.2 3.2-3-3z" /></>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;
}

function BreakfastIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9h13v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM17 11h2a2 2 0 0 1 0 4h-2M8 5V3m5 2V3" /></svg>;
}

function ModuleCard({ number, title, description, route, disabled = false }: { number: string; title: string; description: string; route?: string; disabled?: boolean }) {
  const content = <><span className="module-number">{number}</span><div className="module-copy"><strong>{title}</strong><p>{description}</p></div><span className="module-arrow" aria-hidden="true">→</span></>;
  if (route) return <Link className="module-card module-active" to={route}>{content}</Link>;
  return <article className={`module-card ${disabled ? 'module-disabled' : ''}`}>{content}{disabled && <small className="module-lock">Acesso restrito</small>}</article>;
}
