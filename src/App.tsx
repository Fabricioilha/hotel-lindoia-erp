import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { AppShell } from './components/layout/Sidebar';
import { observeAuth, readUserRole, signInUser, signOutUser } from './services/authStore';
import type { UserRole } from './types';
import { useAttendant } from './services/useAttendant';
import { initializeStaff } from './services/staffStore';
import './modal-theme.css';

const Funcionarios = lazy(() => import('./pages/Funcionarios').then((module) => ({ default: module.Funcionarios })));

const PainelEstoque = lazy(() => import('./pages/estoque/PainelEstoque').then((module) => ({ default: module.PainelEstoque })));
const VendaGeladeira = lazy(() => import('./pages/VendaGeladeira').then((module) => ({ default: module.VendaGeladeira })));
const Escala = lazy(() => import('./pages/escala/Escala').then((module) => ({ default: module.Escala })));
const FluxoDeCaixa = lazy(() => import('./pages/financeiro/FluxoDeCaixa').then((module) => ({ default: module.FluxoDeCaixa })));
const FolhaDePagamento = lazy(() => import('./pages/financeiro/FolhaDePagamento').then((module) => ({ default: module.FolhaDePagamento })));
const ListaQuartos = lazy(() => import('./pages/camareiras/ListaQuartos').then((module) => ({ default: module.ListaQuartos })));
const MapaReservas = lazy(() => import('./pages/reservas/MapaReservas').then((module) => ({ default: module.MapaReservas })));
const ControleLimpeza = lazy(() => import('./pages/limpeza/ControleLimpeza').then((module) => ({ default: module.ControleLimpeza })));
const SaidaProdutos = lazy(() => import('./pages/saidas/SaidaProdutos').then((module) => ({ default: module.SaidaProdutos })));
const SaidaCaixa = lazy(() => import('./pages/caixa/SaidaCaixa').then((module) => ({ default: module.SaidaCaixa })));
const ConferirCaixa = lazy(() => import('./pages/caixa/ConferirCaixa').then((module) => ({ default: module.ConferirCaixa })));
const CaixaRecepcao = lazy(() => import('./pages/caixa/CaixaRecepcao').then((module) => ({ default: module.CaixaRecepcao })));
const Tarifas = lazy(() => import('./pages/Tarifas').then((module) => ({ default: module.Tarifas })));

function VendaRoute({ userRole }: { userRole: UserRole }) {
  const isAdmin = userRole === 'admin';
  const attendant = useAttendant();
  const actor = isAdmin ? 'Gerência' : attendant || 'Equipe';
  return <Suspense fallback={<div role="status">Carregando vendas...</div>}><VendaGeladeira actor={actor} isAdmin={isAdmin} /></Suspense>;
}

function ProtectedRoute({ children, userRole }: { children: ReactNode; userRole: UserRole }) {
  if (!userRole) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function ManagementRoute({ children, userRole }: { children: ReactNode; userRole: UserRole }) {
  if (!userRole) return <Navigate to="/login" replace />;
  if (userRole !== 'admin') return <Navigate to="/" replace />;
  return children;
}

function App() {
  const [userRole, setUserRole] = useState<UserRole>(null);
  const [authReady, setAuthReady] = useState(false);
  const [staffError, setStaffError] = useState('');

  useEffect(() => {
    if (userRole !== 'admin') return;
    void initializeStaff().then(() => setStaffError('')).catch((cause: unknown) => setStaffError(cause instanceof Error ? cause.message : 'Não foi possível preparar o cadastro de funcionários.'));
  }, [userRole]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void observeAuth((user) => {
      void (async () => {
        try {
          if (!user) {
            setUserRole(null);
            return;
          }
          const role = await readUserRole(user.uid);
          if (role) setUserRole(role);
          else {
            await signOutUser();
            setUserRole(null);
          }
        } catch {
          await signOutUser();
          setUserRole(null);
        } finally {
          setAuthReady(true);
        }
      })();
    }).then((stop) => {
      if (cancelled) stop();
      else unsubscribe = stop;
    }).catch(() => setAuthReady(true));

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (userRole) document.documentElement.dataset.role = userRole;
    else delete document.documentElement.dataset.role;
  }, [userRole]);

  async function handleLogin(email: string, password: string) {
    setUserRole(await signInUser(email, password));
  }

  async function handleLogout() {
    await signOutUser();
    setUserRole(null);
  }

  return (
    <BrowserRouter>
      {staffError && <div role="alert">Cadastro de funcionários: {staffError}</div>}
      {!authReady ? <main role="status" style={{ padding: 32 }}>Verificando sessão...</main> : <Routes>
        <Route 
          path="/login" 
          element={
            userRole ? <Navigate to="/" replace /> : <Login onLogin={handleLogin} />
          } 
        />
        
        <Route element={<ProtectedRoute userRole={userRole}><AppShell userRole={userRole} onLogout={() => void handleLogout()} /></ProtectedRoute>}>
        <Route 
          path="/" 
          element={
            <ProtectedRoute userRole={userRole}>
              <Dashboard userRole={userRole} onLogout={handleLogout} />
            </ProtectedRoute>
          } 
        />
        <Route
          path="/estoque"
          element={
            <ManagementRoute userRole={userRole}>
              <Suspense fallback={<div role="status">Carregando estoque...</div>}><PainelEstoque actor={userRole === 'admin' ? 'Gerência' : 'Equipe'} canViewFinancials={userRole === 'admin'} /></Suspense>
            </ManagementRoute>
          }
        />
        <Route
          path="/vendas"
          element={
            <ProtectedRoute userRole={userRole}>
              <VendaRoute userRole={userRole} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/recepcao"
          element={
            <ProtectedRoute userRole={userRole}>
              <Suspense fallback={<div role="status">Carregando caixa...</div>}><CaixaRecepcao userRole={userRole} /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="/saida-caixa"
          element={
            <ProtectedRoute userRole={userRole}>
              <Suspense fallback={<div role="status">Carregando...</div>}><SaidaCaixa userRole={userRole} /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="/conferir-caixa"
          element={
            <ProtectedRoute userRole={userRole}>
              <Suspense fallback={<div role="status">Carregando...</div>}><ConferirCaixa userRole={userRole} /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="/limpeza"
          element={
            <ProtectedRoute userRole={userRole}>
              <Suspense fallback={<div role="status">Carregando limpeza...</div>}><ControleLimpeza userRole={userRole} /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="/saidas"
          element={
            <ProtectedRoute userRole={userRole}>
              <Suspense fallback={<div role="status">Carregando saídas...</div>}><SaidaProdutos userRole={userRole} /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="/escala"
          element={
            <ProtectedRoute userRole={userRole}>
              <Suspense fallback={<div role="status">Carregando escala...</div>}><Escala userRole={userRole} /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="/quartos"
          element={
            <ManagementRoute userRole={userRole}>
              <Suspense fallback={<div role="status">Carregando quartos...</div>}><ListaQuartos userRole={userRole} /></Suspense>
            </ManagementRoute>
          }
        />
        <Route
          path="/reservas"
          element={
            <ManagementRoute userRole={userRole}>
              <Suspense fallback={<div role="status">Carregando reservas...</div>}><MapaReservas userRole={userRole} /></Suspense>
            </ManagementRoute>
          }
        />
        <Route path="/financeiro" element={<Navigate to="/financeiro/caixa" replace />} />
        <Route path="/funcionarios" element={<ManagementRoute userRole={userRole}><Suspense fallback={<div role="status">Carregando funcionários...</div>}><Funcionarios /></Suspense></ManagementRoute>} />
        <Route path="/tarifas" element={<ManagementRoute userRole={userRole}><Suspense fallback={<div role="status">Carregando tarifas...</div>}><Tarifas /></Suspense></ManagementRoute>} />
        <Route path="/financeiro/caixa" element={<ManagementRoute userRole={userRole}><Suspense fallback={<div role="status">Carregando fluxo financeiro...</div>}><FluxoDeCaixa /></Suspense></ManagementRoute>} />
        <Route path="/financeiro/folha" element={<ManagementRoute userRole={userRole}><Suspense fallback={<div role="status">Carregando folha...</div>}><FolhaDePagamento /></Suspense></ManagementRoute>} />
        </Route>
      </Routes>}
    </BrowserRouter>
  );
}

export default App;
