import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import type { UserRole } from '../../types';
import { DutyContext } from '../../services/dutyContext';
import { FloatCheckGate } from './FloatCheckGate';
import { useDuty, useDutyRoster } from '../../services/useAttendant';
import { SidebarSlotContext } from './sidebarSlot';
import './sidebar.css';

const ICONS: Record<string, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  cart: 'M3 4h2l2.4 11h10.2l2-8H6M9 20h.01M17 20h.01',
  cash: 'M3 7h18v10H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M6 10v4M18 10v4',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  bed: 'M3 19V6M21 19v-5M3 14h18v-3a3 3 0 0 0-3-3H3M6 11V9h5v2',
  broom: 'M14 3l7 7-4 1-3-3-1-4zM13 9l-9 9 2 2 9-9',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l3-3h11v3M16 14h2',
  users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 1 0 0-5M17 14c2.5 0 4 1.8 4 4.5',
  logout: 'M10 4H5v16h5M14 8l4 4-4 4M18 12H9',
  chevron: 'M15 5l-7 7 7 7',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  outbox: 'M4 14v6h16v-6M12 15V3M8 7l4-4 4 4M4 14l2-4h12l2 4',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
  dollar: 'M12 3v18M16 7.5H10a2.5 2.5 0 0 0 0 5h4a2.5 2.5 0 0 1 0 5H8',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
};

function Icon({ name }: { name: string }) {
  return <svg className="app-nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>;
}

interface NavEntry { to: string; label: string; icon: string; end?: boolean }
interface NavGroup { id: string; title: string; items: NavEntry[] }

function groupsFor(isAdmin: boolean): NavGroup[] {
  const groups: NavGroup[] = [
    { id: 'plantao', title: 'PLANTÃO', items: [
      { to: '/', label: 'Painel principal', icon: 'home', end: true },
      { to: '/recepcao?novo=hospede', label: 'Adicionar hóspede', icon: 'bed' },
      { to: '/recepcao?novo=rotativo', label: 'Adicionar rotativo', icon: 'clock' },
      { to: '/vendas', label: 'Geladeira', icon: 'cart' },
      { to: '/saida-caixa', label: 'Saída de caixa', icon: 'dollar' },
      { to: '/conferir-caixa', label: 'Conferir caixa', icon: 'receipt' },
    ] },
    { id: 'rotina', title: 'ROTINA', items: [
      { to: '/limpeza', label: 'Controle de limpeza', icon: 'sparkle' },
      { to: '/saidas', label: 'Saída de produtos', icon: 'outbox' },
      { to: '/escala', label: 'Ver escala', icon: 'calendar' },
    ] },
  ];
  if (isAdmin) {
    groups.push(
      { id: 'hospedagem', title: 'HOSPEDAGEM', items: [
        { to: '/reservas', label: 'Reservas', icon: 'bed' },
        { to: '/quartos', label: 'Serviço de quarto', icon: 'broom' },
      ] },
      { id: 'gestao', title: 'GESTÃO', items: [
        { to: '/estoque', label: 'Estoque', icon: 'box' },
        { to: '/financeiro/caixa', label: 'Fluxo de caixa', icon: 'wallet' },
        { to: '/financeiro/folha', label: 'Folha de pagamento', icon: 'users' },
      ] },
    );
  }
  return groups;
}

function ShiftEndBanner() {
  const { duty, minutesLeft } = useDuty();
  if (!duty || minutesLeft === null || minutesLeft > 15) return null;
  const end = duty.end.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return <div className="shift-banner" role="alert">Seu turno termina às {end} (faltam {minutesLeft} min). Finalize seus lançamentos e <Link to="/conferir-caixa">confira o caixa</Link>; depois disso o plantão passa para o próximo da escala.</div>;
}

function isActiveItem(item: NavEntry, pathname: string, search: string) {
  const [path, query] = item.to.split('?');
  if (query) return pathname === path && search === `?${query}`;
  if (path === '/recepcao') return false;
  return item.end ? pathname === path : pathname === path || pathname.startsWith(`${path}/`);
}

export function AppShell({ userRole, onLogout }: { userRole: UserRole; onLogout: () => void }): ReactNode {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('hotel-lindoia:sidebar') === 'collapsed');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const isAdmin = userRole === 'admin';
  const location = useLocation();
  const duty = useDutyRoster(userRole === 'viewer');

  function toggleCollapsed() {
    const next = !collapsed;
    localStorage.setItem('hotel-lindoia:sidebar', next ? 'collapsed' : 'expanded');
    setCollapsed(next);
  }

  return (
    <div className={`app-shell ${collapsed ? 'is-collapsed' : ''}`}>
      <aside className="app-sidebar" aria-label="Menu principal">
        <div className="app-sidebar-header">
          <NavLink to="/" className="app-brand" title="Painel principal"><span className="app-brand-mark">HL</span><span className="app-brand-text"><strong>Hotel Lindoia</strong><small>GESTÃO OPERACIONAL</small></span></NavLink>
        </div>
        <button type="button" className="app-collapse" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'} title={collapsed ? 'Expandir menu' : 'Recolher menu'}>
          <Icon name="chevron" /><span className="app-nav-label">Recolher menu</span>
        </button>

        <nav className="app-nav" aria-label="Navegação do sistema">
          {groupsFor(isAdmin).map((group) => (
            <section key={group.id} className="app-nav-group">
              <button type="button" className="app-nav-title" aria-expanded={!closed[group.id]} onClick={() => setClosed((current) => ({ ...current, [group.id]: !current[group.id] }))}>
                <span>{group.title}</span><span aria-hidden="true">{closed[group.id] ? '▸' : '▾'}</span>
              </button>
              {(!closed[group.id] || collapsed) && group.items.map((item) => (
                <Link key={item.to} to={item.to} className={`app-nav-item ${isActiveItem(item, location.pathname, location.search) ? 'is-active' : ''}`} title={item.label}>
                  <Icon name={item.icon} /><span className="app-nav-label">{item.label}</span>
                </Link>
              ))}
            </section>
          ))}
        </nav>

        <div className="app-sidebar-slot" ref={setSlot} />

        <div className="app-sidebar-footer">
          <span className="app-sidebar-profile"><small>{isAdmin ? 'PERFIL' : 'PLANTONISTA'}</small><strong>{isAdmin ? 'Gerência' : duty.attendant || 'Sem plantonista na escala'}</strong></span>
          <button type="button" className="app-nav-item app-logout" onClick={onLogout} title="Encerrar sessão"><Icon name="logout" /><span className="app-nav-label">Encerrar sessão</span></button>
        </div>
      </aside>
      <div className="app-shell-main">
        <DutyContext.Provider value={duty}><SidebarSlotContext.Provider value={slot}><ShiftEndBanner />{!isAdmin && <FloatCheckGate />}<Outlet /></SidebarSlotContext.Provider></DutyContext.Provider>
      </div>
    </div>
  );
}
