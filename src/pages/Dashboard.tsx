import { Link } from 'react-router-dom';
import type { UserRole } from '../types';
import './dashboard.css';

interface DashboardProps {
  userRole: UserRole;
  onLogout: () => void;
}

export function Dashboard({ userRole, onLogout }: DashboardProps) {
  const profile = userRole === 'admin' ? 'Gerência Geral' : 'Equipe Operacional';

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
            <p>Acesse os serviços do hotel e registre vendas da recepção.</p>
          </div>
        </section>

        <section className="dashboard-metrics" aria-label="Indicadores operacionais">
          <MetricCard title="Quartos livres" value="12" detail="Disponíveis para hospedagem" tone="blue" />
          <MetricCard title="Em limpeza" value="3" detail="Aguardando liberação" tone="gold" />
          <MetricCard title="Equipe no turno" value="5" detail="Operação de hoje" tone="red" />
          <MetricCard title="Alertas de estoque" value="2" detail="Itens para reposição" tone="neutral" />
        </section>

        <section className="dashboard-modules">
          <div className="dashboard-section-heading">
            <div><p className="dashboard-eyebrow">ACESSO RÁPIDO</p><h2>Módulos do hotel</h2></div>
          </div>
          <div className="module-grid">
            <ModuleCard number="01" title="Geladeira - Recepção" description="Venda bebidas, receba na hora ou registre por quarto." route="/vendas" />
            <ModuleCard number="02" title="Controle de estoque" description="Limpeza, rouparia, manutenção e itens da recepção." route="/estoque" />
            <ModuleCard number="03" title="Serviço de quarto" description="Status de limpeza, ocupação e manutenção reportada." />
            <ModuleCard number="04" title="Escala de funcionários" description="Calendário de turnos e equipe operacional." route="/escala" />
            <ModuleCard number="05" title="Gestão financeira" description="Fluxo de caixa, folha e despesas do hotel." route={userRole === 'admin' ? '/financeiro/caixa' : undefined} disabled={userRole !== 'admin'} />
            <ModuleCard number="06" title="Recepção e reservas" description="Check-in, check-out e gestão de hóspedes." />
          </div>
        </section>
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