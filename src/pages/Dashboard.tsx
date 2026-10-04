import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAttendant } from '../services/useAttendant';
import type { UserRole } from '../types';
import { emptyInventory, subscribeInventory } from '../services/inventoryStore';
import { emptyHousekeeping, migrateReservationPayments, subscribeHousekeeping, subscribeReservationCollections, syncReservationCollections } from '../services/housekeepingStore';
import { hotelOccupancySummary } from '../services/reservationAnalytics';
import { emptyFrigobar, subscribeFrigobar, syncFrigobarCatalog } from '../services/frigobarStore';
import { useFrigobarFinanceSync } from '../services/minibarFinanceSync';
import { emptyReception, localDateKey, subscribeReception, useCashOutFinanceSync, useReceptionFinanceSync } from '../services/receptionStore';
import { emptyCleaning, subscribeCleaning } from '../services/cleaningStore';
import { useInternalOutputSync } from '../services/internalOutputs';
import type { CleaningData } from '../types/cleaning';
import type { CashOut, GuestStay } from '../types/reception';
import type { InventoryData } from '../types/inventory';
import type { HousekeepingData } from '../types/housekeeping';
import type { FrigobarData } from '../types/frigobar';
import { ActionCard } from '../components/ui/ActionCard';
import './dashboard.css';

interface DashboardProps {
  userRole: UserRole;
  onLogout: () => void;
}

export function Dashboard({ userRole, onLogout }: DashboardProps) {
  const profile = userRole === 'admin' ? 'Gerência Geral' : 'Equipe Operacional';
  const [housekeeping, setHousekeeping] = useState<HousekeepingData>(emptyHousekeeping());
  const [inventory, setInventory] = useState<InventoryData>(emptyInventory());
  const [metricsLoaded, setMetricsLoaded] = useState(false);
  const [metricsError, setMetricsError] = useState(false);
  const [frigobar, setFrigobar] = useState<FrigobarData>(emptyFrigobar());
  const [syncError, setSyncError] = useState('');
  const [receptionStays, setReceptionStays] = useState<Record<string, GuestStay>>(emptyReception().stays);
  const [cashOuts, setCashOuts] = useState<Record<string, CashOut>>({});
  const attendant = useAttendant();
  const flash = (useLocation().state as { notice?: string } | null)?.notice;

  const [cleaning, setCleaning] = useState<CleaningData>(emptyCleaning());

  useFrigobarFinanceSync(frigobar.sales, userRole === 'admin', setSyncError);
  useInternalOutputSync(userRole === 'admin', setSyncError);
  useReceptionFinanceSync(receptionStays, userRole === 'admin', setSyncError);
  useCashOutFinanceSync(cashOuts, userRole === 'admin', setSyncError);

  useEffect(() => {
    if (userRole !== 'admin') return;
    return subscribeCleaning(setCleaning, (cause) => setSyncError(cause.message));
  }, [userRole]);

  useEffect(() => {
    return subscribeReception((data) => {
      if (userRole !== 'admin') return;
      setReceptionStays(data.stays);
      setCashOuts(data.cashOuts);
    }, (cause) => setSyncError(cause.message));
  }, [userRole]);

  useEffect(() => {
    if (userRole !== 'admin') return;
    let roomsLoaded = false;
    let inventoryLoaded = userRole !== 'admin';
    const markLoaded = () => {
      if (roomsLoaded && inventoryLoaded) setMetricsLoaded(true);
    };
    const unsubscribeRooms = subscribeHousekeeping((data) => {
      setHousekeeping(data);
      roomsLoaded = true;
      markLoaded();
    }, () => {
      setMetricsError(true);
      roomsLoaded = true;
      markLoaded();
    });
    const unsubscribeInventory = userRole === 'admin' ? subscribeInventory((data) => {
      setInventory(data);
      void syncFrigobarCatalog(data).catch((cause: unknown) => setSyncError(cause instanceof Error ? cause.message : 'Não foi possível atualizar o catálogo da geladeira.'));
      inventoryLoaded = true;
      markLoaded();
    }, () => {
      setMetricsError(true);
      inventoryLoaded = true;
      markLoaded();
    }) : () => {};
    return () => {
      unsubscribeRooms();
      unsubscribeInventory();
    };
  }, [userRole]);

  useEffect(() => {
    if (userRole !== 'admin') return;
    void migrateReservationPayments().catch((cause: unknown) => setSyncError(cause instanceof Error ? cause.message : 'Não foi possível migrar recebimentos antigos das reservas.'));
    return subscribeFrigobar(setFrigobar, (cause) => setSyncError(cause.message));
  }, [userRole]);

  useEffect(() => {
    if (userRole !== 'admin') return;
    return subscribeReservationCollections((collections) => {
      if (Object.keys(collections).length > 0) void syncReservationCollections().catch((cause: unknown) => setSyncError(cause instanceof Error ? cause.message : 'Não foi possível conciliar as cobranças de checkout.'));
    }, (cause) => setSyncError(cause.message));
  }, [userRole]);

  const occupancy = hotelOccupancySummary(housekeeping);
  const activeRoomIds = new Set(Object.values(housekeeping.reservations)
    .filter((reservation) => reservation.status === 'hospedado')
    .map((reservation) => reservation.roomId));
  const readyRooms = Object.values(housekeeping.rooms).filter((room) =>
    room.cleaningStatus === 'limpo'
      && room.maintenanceStatus !== 'em_manutencao'
      && !activeRoomIds.has(room.id),
  ).length;
  const roomsInCleaning = Object.values(housekeeping.rooms).filter((room) => room.cleaningStatus === 'em_limpeza').length;
  const lowStockCount = Object.values(inventory.products).filter((product) => {
    const quantity = product.category === 'frigobar'
      ? Number(frigobar.stock[product.id] ?? product.locationQuantities['Geladeira - Recepção'] ?? 0)
      : Object.values(product.locationQuantities ?? {}).reduce((total, value) => total + Number(value || 0), 0);
    return product.active !== false && product.minimumQuantity > 0 && quantity <= product.minimumQuantity;
  }).length;
  const cleaningTasks = Object.values(cleaning.tasks);
  const cleaningNow = cleaningTasks.filter((task) => task.status === 'em_limpeza').length;
  const cleanedToday = cleaningTasks.filter((task) => task.status === 'concluido' && localDateKey(new Date(task.completedAt ?? task.assignedAt)) === localDateKey()).length;
  const valueOrLoading = (value: string | number) => metricsLoaded && !metricsError ? String(value) : '—';
  const detailOrLoading = (detail: string) => metricsError ? 'Dados indisponíveis' : metricsLoaded ? detail : 'Carregando dados';

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

      <main className="dashboard-content">
        <section className="dashboard-welcome">
          <div>
            <p className="dashboard-eyebrow">HOTEL LINDOIA <span>/</span> OPERAÇÃO</p>
            <h1>Visão operacional</h1>
            <p>Acesse os serviços do hotel e acompanhe a operação.</p>
          </div>
        </section>
        {syncError && <div className="notice notice-error" role="alert">{syncError}</div>}
        {flash && <div className="notice notice-success" role="status">{flash}</div>}

        {userRole === 'admin' && <section className="dashboard-metrics" aria-label="Indicadores operacionais">
          <MetricCard title="Ocupação atual" value={valueOrLoading(occupancy.occupancyRate === null ? '—' : `${occupancy.occupancyRate}%`)} detail={detailOrLoading(occupancy.usableRooms ? `${occupancy.occupiedRooms} de ${occupancy.usableRooms} quartos utilizáveis` : 'Cadastre os quartos')} tone="blue" />
          <MetricCard title="Prontos para hospedagem" value={valueOrLoading(readyRooms)} detail={detailOrLoading('Limpos, livres e sem bloqueio de manutenção')} tone="green" />
          <MetricCard title="Limpezas designadas" value={String(cleaningNow)} detail="Camareiras com quarto em andamento" tone="gold" />
          <MetricCard title="Quartos limpos hoje" value={String(cleanedToday)} detail="Limpezas concluídas pelas camareiras" tone="green" />
          <MetricCard title="Em limpeza" value={valueOrLoading(roomsInCleaning)} detail={detailOrLoading('Quartos com tarefa em andamento')} tone="gold" />
          <MetricCard title="Entradas hoje" value={valueOrLoading(occupancy.arrivalsToday.rooms)} detail={detailOrLoading('Quartos com chegada prevista')} tone="gold" />
          <MetricCard title="Entradas amanhã" value={valueOrLoading(occupancy.arrivalsTomorrow.rooms)} detail={detailOrLoading('Quartos com chegada prevista')} tone="blue" />
          <MetricCard title="Saídas hoje" value={valueOrLoading(occupancy.departuresToday.rooms)} detail={detailOrLoading('Quartos com checkout previsto')} tone="red" />
          <MetricCard title="Saídas amanhã" value={valueOrLoading(occupancy.departuresTomorrow.rooms)} detail={detailOrLoading('Quartos com checkout previsto')} tone="gold" />
          {userRole === 'admin' && <MetricCard title="Alertas de estoque" value={valueOrLoading(lowStockCount)} detail={detailOrLoading('Produtos no mínimo ou abaixo')} tone="neutral" />}
        </section>}

        {userRole !== 'admin' && <div className="duty-bar" aria-label="Plantonista">
          <span>Plantonista (conforme a escala):</span>
          {attendant ? <strong>{attendant}</strong> : <small>Ninguém escalado neste horário</small>}
        </div>}

        {userRole !== 'admin' && <section className="dashboard-modules" aria-label="O que você quer fazer?">
          <div className="dashboard-section-heading">
            <div><p className="dashboard-eyebrow">PLANTÃO</p><h2>O que você quer fazer?</h2></div>
          </div>
          <div className="action-grid">
            <ActionCard tone="blue" icon="bed" title="Adicionar hóspede" hint="Check-in com diárias, café, taxa e extras" to="/recepcao?novo=hospede" />
            <ActionCard tone="gold" icon="clock" title="Adicionar rotativo" hint="Estadia de 4 horas" to="/recepcao?novo=rotativo" />
            <ActionCard tone="red" icon="cart" title="Vender itens da geladeira" hint="Bebidas e itens da recepção" to="/vendas" />
            <ActionCard tone="green" icon="receipt" title="Conferir caixa" hint="Resumo do seu plantão, hoje e dias anteriores" to="/conferir-caixa" />
            <ActionCard tone="slate" icon="wallet" title="Saída de caixa" hint="Dinheiro retirado do caixa para compras" to="/saida-caixa" />
            <ActionCard tone="teal" icon="sparkle" title="Controle de limpeza de quartos" hint="Designe camareiras e confirme quartos limpos" to="/limpeza" />
            <ActionCard tone="purple" icon="outbox" title="Saída de produtos" hint="Retirar itens do estoque para uso do hotel" to="/saidas" />
            <ActionCard tone="blue" icon="calendar" title="Ver escala" hint="Turnos e equipe do mês" to="/escala" />
          </div>
        </section>}

        {userRole === 'admin' && <section className="dashboard-modules">
          <div className="dashboard-section-heading">
            <div><p className="dashboard-eyebrow">ACESSO RÁPIDO</p><h2>Módulos do hotel</h2></div>
          </div>
          <div className="module-grid">
            <ModuleCard number="01" title="Lançar Venda" description="Venda bebidas, receba na hora ou registre por quarto." route="/vendas" />
            {userRole === 'admin' && <ModuleCard number="02" title="Controle de estoque" description="Limpeza, rouparia, manutenção e itens da recepção." route="/estoque" />}
            {userRole === 'admin' && <ModuleCard number="03" title="Serviço de quarto" description="Status de limpeza, ocupação e manutenção reportada." route="/quartos" />}
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
    </div>
  );
}

function MetricCard({ title, value, detail, tone }: { title: string; value: string; detail: string; tone: string }) {
  return <article className={`dashboard-metric metric-${tone}`}><span className="metric-rule" /><p>{title}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function ModuleCard({ number, title, description, route, disabled = false }: { number: string; title: string; description: string; route?: string; disabled?: boolean }) {
  const content = <><span className="module-number">{number}</span><div className="module-copy"><strong>{title}</strong><p>{description}</p></div><span className="module-arrow" aria-hidden="true">→</span></>;
  if (route) return <Link className="module-card module-active" to={route}>{content}</Link>;
  return <article className={`module-card ${disabled ? 'module-disabled' : ''}`}>{content}{disabled && <small className="module-lock">Acesso restrito</small>}</article>;
}