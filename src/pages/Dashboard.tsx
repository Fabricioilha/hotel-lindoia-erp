import { StayAccount } from '../components/StayAccount';
import { cashShiftDate } from '../services/cashShiftDate';
import { acknowledgeCashCollection, subscribeCashCollections } from '../services/cashCollections';
import { acknowledgeCleaningConcern, subscribeCleaningConcerns } from '../services/cleaningConcerns';
import { checkoutQuery, requestCheckout } from '../services/checkoutClient';
import { currentOccupants, stayOccupiesDate, reservationOccupiesDate } from '../services/occupantDirectory';
import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAttendant } from '../services/useAttendant';
import type { UserRole } from '../types';
import { subscribeDashboardHousekeeping, subscribeCurrentReservationDirectory, subscribeReservationCollections, subscribeRoomCategories, subscribeRoomDirectory, syncReservationCollections, setRoomMaintenanceBlock, type DashboardHousekeepingData } from '../services/housekeepingStore';
import { breakfastsOnDate } from '../services/breakfastForecast';
import { departureDue, guestStayOccupiesToday, hotelOccupancySummary, occupiedRoomNumbers } from '../services/reservationAnalytics';
import { subscribeRoomAddOnInventory } from '../services/frigobarStore';
import { convertRotativoToDaily, emptyReception, localDateKey, saveRoomCharge, confirmStayArrival, subscribeReceptionBoard, subscribeReceptionRates } from '../services/receptionStore';
import { emptyCleaning, subscribeActiveCleaningTasks, subscribeDashboardCleaningTasks } from '../services/cleaningStore';
import { subscribeInventoryProducts } from '../services/inventoryStore';
import { useInternalOutputSync } from '../services/internalOutputs';
import type { CleaningData, CleaningTask } from '../types/cleaning';
import { FOLIO_PAYMENT_METHODS, ROOM_TYPE_LABELS, stayBreakfastDays, stayDailyAmount, weekdayKey, type CashOut, type GuestStay, type ReceptionRateSettings, type ReceptionRoom, type RoomCharge, type RoomChargeKind, type StayKind } from '../types/reception';
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
  const [checkoutAlertError, setCheckoutAlertError] = useState('');
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
  const [checkoutAlerts, setCheckoutAlerts] = useState<{ sourceType: 'stay' | 'reservation'; sourceId: string; roomNumber: string; guestName: string; pending: number }[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void checkoutQuery<typeof checkoutAlerts>('', controller.signal).then((alerts) => { setCheckoutAlerts(alerts); setCheckoutAlertError(''); }).catch(() => {
      if (!controller.signal.aborted) setCheckoutAlertError('Alertas de pendências indisponíveis. Confira os débitos antes de liberar o quarto.');
    });
    return () => controller.abort();
  }, [clock, userRole, boardStays]);
  const boardTodayKey = localDateKey(new Date(clock));
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
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
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
  const tomorrow = dateKeyAfterDays(boardTodayKey, 1);
  const breakfastForecast = userRole === 'admin' && boardReceptionLoaded && boardReservationsLoaded && !metricsError
    ? breakfastsOnDate(tomorrow, boardStays, housekeeping.reservations, roomCharges)
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
        </section>

        {checkoutAlertError && <p className="dashboard-checkout-warning" role="status">{checkoutAlertError}</p>}
        {cashCollectionError && <div className="notice notice-error" role="alert">{cashCollectionError}</div>}
        {cleaningConcernError && <div className="notice notice-error" role="alert">{cleaningConcernError}</div>}
        {userRole === 'admin' && cleaningConcerns.length > 0 && <div className="notice notice-error" role="status">
          <strong>Indícios de uso relatados pela limpeza — conferir hospedagens e caixa</strong>
          {cleaningConcerns.map((log) => <p key={log.id}>Quarto {log.roomNumber} · {log.attendant} · {new Date(log.completedAt).toLocaleString('pt-BR')} · informado por {log.reportedBy || 'Equipe'} · <Link to={`/quartos?room=${encodeURIComponent(log.roomNumber)}`}>Consultar quarto</Link> · <Link to="/conferir-caixa">Conferir caixa</Link> <button type="button" disabled={Boolean(acknowledgingConcern)} onClick={() => void acknowledgeConcern(log)}>{acknowledgingConcern === log.id ? 'Confirmando...' : 'OK, conferido'}</button></p>)}
          <p>Relato para apuração, não prova de irregularidade.</p>
        </div>}
        {userRole === 'admin' && cashCollections.length > 0 && <div className="notice notice-error" role="status">
          <strong>Recolhimentos de caixa aguardando confirmação</strong>
          {cashCollections.map((item) => <p key={item.id}>{new Date(item.createdAt).toLocaleString('pt-BR')} · {item.attendant} · {money(item.amount)}{item.note ? ` · ${item.note}` : ''} <button type="button" disabled={Boolean(acknowledgingCollection)} onClick={() => void acknowledgeCollection(item)}>{acknowledgingCollection === item.id ? 'Confirmando...' : 'OK, conferido'}</button></p>)}
        </div>}
        {checkoutAlerts.length > 0 && <div className="notice notice-error" role="alert"><strong>Saídas de hoje com pendências — conferir antes do checkout:</strong>{checkoutAlerts.map((item) => <p key={`${item.sourceType}-${item.sourceId}`}>Quarto {item.roomNumber} · {item.guestName} · {money(item.pending)} pendentes. Confira a hospedagem com a gerência e as vendas a cobrar. <button type="button" onClick={() => setActiveTool('geladeira')}>Conferir geladeira</button></p>)}</div>}
        {syncError && <div className="notice notice-error" role="alert">{syncError}</div>}
        {displayedNotice && <div key={displayedNotice.id} className="dashboard-toast" role="status"><span aria-hidden="true">✓</span>{displayedNotice.message}</div>}

        {userRole === 'admin' && <section className="dashboard-metrics" aria-label="Indicadores operacionais">
          <MetricCard title="Cafés da manhã amanhã" value={breakfastForecast === null ? '—' : String(breakfastForecast)} detail={metricsError ? 'Dados indisponíveis' : breakfastForecast === null ? 'Carregando hospedagens e reservas' : `${tomorrow.split('-').reverse().join('/')} · previsão para o pedido da padaria`} tone="gold" />
          <MetricCard title="Ocupação atual" value={valueOrLoading(occupancy.occupancyRate === null ? '—' : `${occupancy.occupancyRate}%`)} detail={detailOrLoading(occupancy.usableRooms ? `${occupancy.occupiedRooms} de ${occupancy.usableRooms} quartos utilizáveis` : 'Cadastre os quartos')} tone="blue" />
          <MetricCard title="Prontos para hospedagem" value={valueOrLoading(readyRooms)} detail={detailOrLoading('Limpos, livres e sem bloqueio de manutenção')} tone="green" />
          <MetricCard title="Limpezas designadas" value={valueOrLoading(cleaningNow)} detail={detailOrLoading('Quartos com limpeza designada em andamento')} tone="gold" />
          <MetricCard title="Quartos limpos hoje" value={valueOrLoading(cleanedToday)} detail={detailOrLoading('Quartos com limpeza concluída hoje')} tone="green" />
          <MetricCard title="Em limpeza" value={valueOrLoading(roomsInCleaning)} detail={detailOrLoading('Quartos com tarefa em andamento')} tone="gold" />
          <MetricCard title="Entradas hoje" value={valueOrLoading(occupancy.arrivalsToday.rooms)} detail={detailOrLoading('Quartos com chegada registrada ou prevista hoje')} tone="gold" />
          <MetricCard title="Entradas amanhã" value={valueOrLoading(occupancy.arrivalsTomorrow.rooms)} detail={detailOrLoading('Quartos com chegada prevista')} tone="blue" />
          <MetricCard title="Saídas hoje" value={valueOrLoading(occupancy.departuresToday.rooms)} detail={detailOrLoading('Quartos com checkout previsto')} tone="red" />
          <MetricCard title="Saídas amanhã" value={valueOrLoading(occupancy.departuresTomorrow.rooms)} detail={detailOrLoading('Quartos com checkout previsto')} tone="gold" />
          {userRole === 'admin' && <MetricCard title="Alertas de estoque" value={valueOrLoading(lowStockCount)} detail={detailOrLoading('Produtos ativos abaixo do mínimo ou sem saldo')} tone="neutral" />}
        </section>}

        {userRole !== 'admin' && <div className="duty-bar" aria-label="Plantonista">
          <span>Plantonista:</span>
          {attendant ? <strong>{attendant}</strong> : <small>Ninguém escalado neste horário</small>}
        </div>}

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
          reservations={userRole === 'admin' ? housekeeping.reservations : reservationDirectory}
          loaded={boardReceptionLoaded && boardRoomsLoaded && boardReservationsLoaded && boardCleaningLoaded}
          now={clock}
          attendant={attendant}
          userRole={userRole}
          entryContext={userRole === 'admin' ? { ...receptionEntryContext, roomDirectory: housekeeping.rooms, reservations: housekeeping.reservations } : receptionEntryContext}
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

interface BoardOccupant {
  roomNumber: string;
  sourceType: 'stay' | 'reservation';
  sourceId: string;
  name: string;
  peopleCount: number;
  includedBreakfastCount: number;
  breakfastAllowed: boolean;
  rotativo: boolean;
  startDate: string;
  checkOutDate: string;
}

type RoomBoardAction = RoomChargeKind | 'conversao_diaria';

function RoomBoard({ rooms, cleaningRoomNumbers, cleaningTasks, receptionRooms, stays: currentStays, roomCharges, reservations: currentReservations, loaded, now, attendant, userRole, entryContext, onChargeSaved }: {
  rooms: Record<string, HousekeepingRoom>;
  cleaningRoomNumbers: ReadonlySet<string>;
  cleaningTasks: CleaningTask[];
  receptionRooms: Record<string, ReceptionRoom>;
  stays: Record<string, GuestStay>;
  roomCharges: Record<string, RoomCharge>;
  reservations: Record<string, ReservationDirectoryEntry>;
  loaded: boolean;
  now: number;
  attendant: string;
  userRole: UserRole;
  entryContext: ReceptionEntryContext;
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
  const actualToday = localDateKey(new Date(now));
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
  const roomsByNumber = new Map(Object.values(rooms).map((room) => [room.number, room]));
  const receptionRoomsByNumber = new Map(Object.values(receptionRooms).map((room) => [room.number, room]));
  const roomNumbers = [...new Set([
    ...Object.values(rooms).map((room) => room.number),
    ...Object.values(receptionRooms).map((room) => room.number),
  ])].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));

  const currentSelection = new Map(currentOccupants(stays, reservations, today, now).map((item) => [item.roomNumber, item]));
  const occupants = new Map<string, BoardOccupant>();
  const addOccupant = (roomNumber: string, candidate: Omit<BoardOccupant, 'roomNumber'>) => {
    if (!historical && (currentSelection.get(roomNumber.trim())?.sourceId !== candidate.sourceId || currentSelection.get(roomNumber.trim())?.sourceType !== candidate.sourceType)) return;
    const current = occupants.get(roomNumber);
    if (!current || candidate.startDate >= current.startDate) occupants.set(roomNumber, { ...candidate, roomNumber });
  };
  Object.values(stays).forEach((stay) => {
    if (!stay.roomNumber || !stayOccupiesDate(stay, today, actualToday, now)) return;
    addOccupant(stay.roomNumber, {
      sourceType: 'stay',
      sourceId: stay.id,
      name: (stay.guestName ?? '').trim() || 'Titular não informado',
      peopleCount: Math.max(1, Math.floor(stay.guestCount ?? (stay.hasAdditionalGuests ? 2 : 1))),
      includedBreakfastCount: stay.kind === 'hospede' && stay.hasBreakfast && today > stay.checkInDate && today <= dateKeyAfterDays(stay.checkInDate, stayBreakfastDays(stay))
        ? Math.max(1, Math.floor(stay.breakfastCount ?? 1))
        : 0,
      breakfastAllowed: stay.kind !== 'periodo',
      rotativo: stay.kind === 'periodo',
      startDate: stay.checkInDate,
      checkOutDate: stay.kind === 'periodo' ? stay.checkInDate : stay.checkOutDate ?? dateKeyAfterDays(stay.checkInDate, stay.nights),
    });
  });
  Object.values(reservations).forEach((reservation) => {
    if (!reservation.roomNumber || !reservationOccupiesDate(reservation, today, actualToday, now)) return;
    addOccupant(reservation.roomNumber, {
      sourceType: 'reservation',
      sourceId: reservation.id,
      name: reservation.guestName?.trim() || 'Titular não informado',
      peopleCount: Math.max(1, Number(reservation.adults ?? 1) + Number(reservation.children ?? 0)),
      includedBreakfastCount: reservation.channel !== 'rotativo' && reservation.breakfastIncluded === true
        ? Math.max(1, Number(reservation.adults ?? 1) + Number(reservation.children ?? 0))
        : 0,
      breakfastAllowed: reservation.channel !== 'rotativo',
      rotativo: reservation.channel === 'rotativo',
      startDate: reservation.checkInDate ?? '',
      checkOutDate: reservation.checkOutDate ?? today,
    });
  });

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
  const conversionDailyTotal = chargeKind === 'conversao_diaria'
    ? Math.max(0, parseRoomChargeAmount(chargeAmount) * (Number.isInteger(validDays) ? validDays : 0) - (selectedOccupant?.sourceType === 'stay' ? stayDailyAmount(stays[selectedOccupant.sourceId]) : 0))
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
        creditApplied: Math.round(rotativo.dailyRate * rotativo.nights * 100) / 100,
        dailyMethod: paymentMethod,
        ...(conversionDailyTotal > 0 && splitPayment && secondAmount ? { dailySplit: { method: splitMethod, amount: secondAmount } } : {}),
        guestCount: selectedOccupant.peopleCount, hasBreakfast: hasConversionBreakfast,
        breakfastCount: hasConversionBreakfast ? selectedOccupant.peopleCount : 0,
        breakfastRate: hasConversionBreakfast ? parseRoomChargeAmount(conversionBreakfastRate) : 0,
        ...(hasConversionBreakfast ? { breakfastMethod: conversionBreakfastMethod, ...(conversionBreakfastSplit ? { breakfastSplit: { method: conversionBreakfastSplitMethod, amount: breakfastSecondAmount } } : {}) } : {}),
        taxAmount: 0, taxMethod: paymentMethod, extras: [], note: `Conversão do rotativo ${rotativo.id}; crédito aplicado de ${money(rotativo.dailyRate * rotativo.nights)}.`,
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
            const awaitingCheckout = !historical && occupant && !occupant.rotativo && departureDue(occupant.checkOutDate, now);
            const awaitingCleaning = !historical && !occupant && !inMaintenance && !isCleaning && Boolean(room) && room?.cleaningStatus !== 'limpo';
            const status = awaitingCheckout ? 'checkout' : occupant ? 'occupied' : inMaintenance ? 'maintenance' : isCleaning ? 'cleaning' : awaitingCleaning ? 'dirty' : 'free';
            const statusLabel = status === 'dirty' ? 'Aguardando limpeza' : status === 'cleaning' ? 'Em limpeza' : status === 'checkout' ? 'Saída pendente' : status === 'occupied' ? historical && occupant?.sourceType === 'reservation' && reservations[occupant.sourceId]?.status === 'confirmada' ? 'Reservado' : 'Ocupado' : status === 'maintenance' ? 'Em manutenção' : 'Livre';
            const unavailable = Boolean(inMaintenance || (!occupant && room && room.cleaningStatus !== 'limpo') || (!occupant && isCleaning));
            const cleaningLabel = isCleaning ? ', em limpeza' : '';
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
              className={`dashboard-room is-${status}${isCleaning ? ' is-cleaning' : ''}`}
              key={number}
              disabled={historical || (!isAdmin && unavailable)}
              title={isAdmin ? `Gerenciar quarto ${number}${cleaningLabel}` : unavailable ? `Quarto ${number} ${statusLabel.toLocaleLowerCase('pt-BR')} e indisponível${cleaningLabel}` : occupant ? `Adicionar hóspede, café, cama ou bebida ao quarto ${number}${cleaningLabel}` : `Adicionar hóspede ou rotativo ao quarto ${number}${cleaningLabel}`}
              aria-label={isAdmin ? `Quarto ${number}, ${statusLabel.toLocaleLowerCase('pt-BR')}${occupant ? ` por ${occupant.name}` : ''}${cleaningLabel}. Abrir opções da gerência.` : unavailable ? `Quarto ${number}, ${statusLabel.toLocaleLowerCase('pt-BR')}, indisponível${cleaningLabel}` : occupant ? `Quarto ${number}, ${statusLabel.toLocaleLowerCase('pt-BR')} por ${occupant.name}${cleaningLabel}. Abrir opções do quarto.` : `Quarto ${number}, livre${cleaningLabel}. Adicionar hóspede ou rotativo.`}
              onClick={() => isAdmin
                ? setSelectedManagerRoom(number)
                : occupant
                ? openChargeForm(occupant)
                : !unavailable && setNewGuestRoom(number)}
            >
              <div className="dashboard-room-top">
                <strong><RoomIcon />{number}</strong>
                <span className={`dashboard-room-status is-${status}`} role="img" aria-label={statusLabel} title={statusLabel}><RoomStatusIcon status={status} /></span>
              </div>
              <small className="dashboard-room-type">{description}</small>
              {isCleaning && <small className="dashboard-room-cleaning"><RoomStatusIcon status="cleaning" />Em limpeza</small>}
              {!historical && !isCleaning && room && <small className={`dashboard-room-cleanliness is-${room.cleaningStatus}`}>{room.cleaningStatus === 'limpo' ? 'Limpo' : 'Aguardando limpeza'}</small>}
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
        <summary>Chegadas previstas ({expected.length})</summary>
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
    {selectedOccupant && <div className="dashboard-room-charge-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingCharge) setSelectedOccupant(null); }}>
      <form className="dashboard-room-charge-modal dashboard-occupied-room-modal" role="dialog" aria-modal="true" aria-labelledby="room-charge-title" onSubmit={(event) => void submitRoomCharge(event)}>
        <header className="dashboard-room-charge-header">
          <div><p className="dashboard-eyebrow">QUARTO {selectedOccupant.roomNumber}</p><h2 id="room-charge-title">Opções do quarto</h2><small>Titular: {selectedOccupant.name}</small></div>
          <button type="button" className="dashboard-room-charge-close" aria-label="Fechar" disabled={savingCharge} onClick={() => setSelectedOccupant(null)}>×</button>
        </header>
        {!selectedOccupant.rotativo && departureDue(selectedOccupant.checkOutDate, now) && <p className="dashboard-room-checkout-notice" role="status">Saída prevista para {selectedOccupant.checkOutDate.split('-').reverse().join('/')} às 12h. O encerramento ainda precisa ser confirmado; confira a conta e libere o quarto para limpeza.</p>}
        <button type="button" className="dashboard-room-release-button" disabled={savingCharge} onClick={() => {
          if (!window.confirm(`Fazer o check-out do quarto ${selectedOccupant.roomNumber}? O quarto ficará aguardando limpeza.`)) return;
          setSavingCharge(true); setChargeError('');
          void requestCheckout({ sourceType: selectedOccupant.sourceType, sourceId: selectedOccupant.sourceId })
            .then(() => { setSelectedOccupant(null); onChargeSaved(`Check-out realizado. Quarto ${selectedOccupant.roomNumber} aguardando limpeza.`); })
            .catch((cause) => setChargeError(cause.message)).finally(() => setSavingCharge(false));
        }}><span aria-hidden="true">↗</span>{savingCharge ? 'Realizando check-out…' : 'Fazer check-out'}</button>
        {selectedOccupant.sourceType === 'stay' && stays[selectedOccupant.sourceId] && <StayAccount stay={stays[selectedOccupant.sourceId]} charges={chargesForOccupant(selectedOccupant)} attendant={attendant} onSaved={onChargeSaved} />}
        <fieldset className="dashboard-room-charge-types">
          <legend>O que deseja fazer?</legend>
          <label><input type="radio" name="roomChargeKind" value="hospede_extra" checked={chargeKind === 'hospede_extra'} onChange={() => changeChargeKind('hospede_extra')} /><span>Hóspede extra</span></label>
          {selectedOccupant.breakfastAllowed && <label><input type="radio" name="roomChargeKind" value="cafe_avulso" checked={chargeKind === 'cafe_avulso'} onChange={() => changeChargeKind('cafe_avulso')} /><span>Café da manhã</span></label>}
          <label><input type="radio" name="roomChargeKind" value="cama_extra" checked={chargeKind === 'cama_extra'} onChange={() => changeChargeKind('cama_extra', selectedOccupant.name)} /><span>Cama extra</span></label>
          <label><input type="radio" name="roomChargeKind" value="bebida" checked={chargeKind === 'bebida'} onChange={() => changeChargeKind('bebida', selectedOccupant.name)} /><span>Bebida</span></label>
          {selectedOccupant.rotativo && selectedOccupant.sourceType === 'stay' && <label><input type="radio" name="roomChargeKind" value="conversao_diaria" checked={chargeKind === 'conversao_diaria'} onChange={() => changeChargeKind('conversao_diaria', selectedOccupant.name === 'Titular não informado' ? '' : selectedOccupant.name)} /><span>Converter em diária</span></label>}
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
        <div className="dashboard-room-charge-total"><span>{chargeKind === 'conversao_diaria' ? `Total da diária após crédito de ${money(selectedOccupant.sourceType === 'stay' ? stayDailyAmount(stays[selectedOccupant.sourceId]) : 0)}` : 'Total cobrado'}</span><strong>{money(chargeTotal)}</strong>
          {chargeKind === 'bebida' && selectedProduct && <small>{totalDrinkQuantity} unidade(s) · {money(selectedProduct.salePrice)} cada · estoque disponível {selectedStock}</small>}
          {chargeKind === 'conversao_diaria' && <small>Diárias após crédito: {money(conversionDailyTotal)}{hasConversionBreakfast ? ` · café: ${money(conversionBreakfastTotal)}` : ''}</small>}
          {chargeKind !== 'conversao_diaria' && chargeKind !== 'bebida' && <small>{validDays} dia(s) × {money(parseRoomChargeAmount(chargeAmount))} por dia</small>}
          {splitPayment && splitLimit > 0 && parseRoomChargeAmount(splitAmount) > 0 && <small>{PAYMENT_METHOD_LABELS[paymentMethod]} {money(Math.max(0, splitLimit - parseRoomChargeAmount(splitAmount)))} + {PAYMENT_METHOD_LABELS[splitMethod]} {money(parseRoomChargeAmount(splitAmount))}</small>}
          {chargeKind === 'conversao_diaria' && hasConversionBreakfast && <small>Café: {PAYMENT_METHOD_LABELS[conversionBreakfastMethod]} {money(Math.max(0, conversionBreakfastTotal - (conversionBreakfastSplit ? parseRoomChargeAmount(conversionBreakfastSplitAmount) : 0)))}{conversionBreakfastSplit ? ` + ${PAYMENT_METHOD_LABELS[conversionBreakfastSplitMethod]} ${money(parseRoomChargeAmount(conversionBreakfastSplitAmount))}` : ''}</small>}
        </div>
        {chargeError && <p className="dashboard-room-charge-error" role="alert">{chargeError}</p>}
        <div className="dashboard-room-charge-actions"><button type="button" className="dashboard-room-charge-cancel" disabled={savingCharge} onClick={() => setSelectedOccupant(null)}>Cancelar</button><button type="submit" className="dashboard-room-charge-submit" disabled={savingCharge || (chargeKind === 'bebida' && (!selectedProduct || inventoryLoading || Boolean(inventoryError)))}>{savingCharge ? 'Registrando…' : chargeKind === 'conversao_diaria' ? 'Converter em diária' : 'Confirmar pagamento'}</button></div>
      </form>
    </div>}
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
