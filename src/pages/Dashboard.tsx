// src/pages/Dashboard.tsx
import type { UserRole } from '../types';

interface DashboardProps {
  userRole: UserRole;
  onLogout: () => void;
}

export function Dashboard({ userRole, onLogout }: DashboardProps) {
  return (
    <div className="min-h-screen w-full flex flex-col bg-slate-50 font-sans">
      
      {/* Navbar Premium */}
      <header className="bg-slate-900 text-white shadow-lg border-b border-slate-700/50">
        <div className="w-full px-6 sm:px-10 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className="bg-indigo-500 text-white w-10 h-10 rounded-lg flex items-center justify-center text-xl shadow-md">
              🏨
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Lindoia ERP</h1>
              <p className="text-xs text-slate-400 tracking-wider">WORKSPACE INTEGRADO</p>
            </div>
          </div>
          
          <div className="flex items-center gap-6">
            <div className="hidden sm:flex flex-col text-right">
              <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Perfil Ativo</span>
              <span className="text-sm text-emerald-400 font-bold bg-emerald-400/10 px-2 py-0.5 rounded">
                {userRole === 'admin' ? 'Gerência Geral' : 'Equipe Operacional'}
              </span>
            </div>
            <div className="h-8 w-px bg-slate-700 hidden sm:block"></div>
            <button 
              onClick={onLogout}
              className="bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white px-5 py-2 rounded-lg text-sm font-bold transition-all border border-red-500/30"
            >
              Encerrar Sessão
            </button>
          </div>
        </div>
      </header>

      {/* Área de Conteúdo Fluida (Ocupa o resto da tela) */}
      <main className="flex-grow w-full px-6 sm:px-10 py-8 space-y-10">
        
        {/* Métricas Rápidas (Grid Fluido) */}
        <div>
          <h2 className="text-2xl font-bold text-slate-800 tracking-tight mb-5">Visão Operacional</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            <MetricCard titulo="Quartos Livres" valor="12" icon="🔑" bgIcon="bg-emerald-500/20" corIcon="text-emerald-600" />
            <MetricCard titulo="Em Limpeza" valor="3" icon="🧹" bgIcon="bg-amber-500/20" corIcon="text-amber-600" />
            <MetricCard titulo="Equipe no Turno" valor="5" icon="👥" bgIcon="bg-indigo-500/20" corIcon="text-indigo-600" />
            <MetricCard titulo="Alertas Estoque" valor="2" icon="⚠" bgIcon="bg-red-500/20" corIcon="text-red-600" />
          </div>
        </div>

        {/* Módulos do ERP */}
        <div>
          <h3 className="text-2xl font-bold text-slate-800 tracking-tight mb-5">Módulos do Sistema</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            <ModuleCard 
              titulo="Serviço de Quarto" 
              icon="🛏️"
              descricao="Gestão mobile-first de status, limpeza e manutenções reportadas." 
              ativo={true}
              rota="/quartos"
            />
            <ModuleCard 
              titulo="Controle de Estoque" 
              icon="📦"
              descricao="Gestão de almoxarifado: limpeza, rouparia, frigobar e mobiliário." 
              ativo={true}
              rota="/estoque"
            />
            <ModuleCard 
              titulo="Escala de Funcionários" 
              icon="📅"
              descricao="Calendário e turnos interativos de toda a equipe do hotel." 
              ativo={true}
              rota="/escala"
            />
            <ModuleCard 
              titulo="Gestão Financeira" 
              icon="💰"
              descricao="Controle de fluxo de caixa, folha de pagamento e despesas fixas." 
              ativo={userRole === 'admin'} 
              rota="/financeiro"
            />
            <ModuleCard 
              titulo="Recepção e Reservas" 
              icon="🛎️"
              descricao="Painel de check-in, check-out e gestão de hóspedes ativos." 
              ativo={true}
              rota="/reservas"
            />
          </div>
        </div>
      </main>
    </div>
  );
}

// Subcomponente: Cartão de Métrica Elegante
function MetricCard({ titulo, valor, icon, bgIcon, corIcon }: { titulo: string, valor: string, icon: string, bgIcon: string, corIcon: string }) {
  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200/60 flex items-center justify-between hover:shadow-md transition-all group">
      <div>
        <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-2">{titulo}</p>
        <p className="text-4xl font-black text-slate-800 group-hover:scale-105 transition-transform origin-left">{valor}</p>
      </div>
      <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl ${bgIcon} ${corIcon} shadow-inner`}>
        {icon}
      </div>
    </div>
  );
}

// Subcomponente: Cartão de Módulo Expansivo
function ModuleCard({ titulo, icon, descricao, ativo, rota }: { titulo: string, icon: string, descricao: string, ativo: boolean, rota: string }) {
  return (
    <div className={`relative p-7 rounded-2xl border transition-all duration-300 flex flex-col justify-between h-full ${
      ativo 
        ? 'bg-white border-slate-200 hover:border-indigo-400 hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] hover:-translate-y-1.5 cursor-pointer group' 
        : 'bg-slate-100 border-slate-200 opacity-60 cursor-not-allowed'
    }`}>
      <div>
        <div className="flex items-center gap-4 mb-5">
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-3xl shrink-0 transition-colors duration-300 ${ativo ? 'bg-indigo-50 text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white shadow-sm' : 'bg-slate-200 grayscale'}`}>
            {icon}
          </div>
          <h4 className={`text-xl font-bold ${ativo ? 'text-slate-800' : 'text-slate-500'}`}>{titulo}</h4>
        </div>
        <p className="text-sm text-slate-500 leading-relaxed">{descricao}</p>
      </div>
      
      <div className="mt-6 pt-5 border-t border-slate-100 flex items-center justify-between">
        {ativo ? (
          <span className="text-indigo-600 font-bold text-sm flex items-center gap-2 group-hover:text-indigo-700">
            Acessar Módulo 
            <span className="bg-indigo-100 w-6 h-6 rounded-full flex items-center justify-center group-hover:translate-x-2 transition-transform">→</span>
          </span>
        ) : (
          <span className="text-red-500/80 font-bold text-sm flex items-center gap-2 bg-red-50 px-3 py-1 rounded-lg">
            <span>🔒</span> Acesso Restrito
          </span>
        )}
      </div>
    </div>
  );
}