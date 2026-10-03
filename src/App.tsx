import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { observeAuth, readUserRole, signInUser, signOutUser } from './services/authStore';
import type { UserRole } from './types';
import { ATTENDANT_STORAGE_KEY } from './types/reception';

const PainelEstoque = lazy(() => import('./pages/estoque/PainelEstoque').then((module) => ({ default: module.PainelEstoque })));
const VendaGeladeira = lazy(() => import('./pages/VendaGeladeira').then((module) => ({ default: module.VendaGeladeira })));
const Escala = lazy(() => import('./pages/escala/Escala').then((module) => ({ default: module.Escala })));
const FluxoDeCaixa = lazy(() => import('./pages/financeiro/FluxoDeCaixa').then((module) => ({ default: module.FluxoDeCaixa })));
const FolhaDePagamento = lazy(() => import('./pages/financeiro/FolhaDePagamento').then((module) => ({ default: module.FolhaDePagamento })));
const ListaQuartos = lazy(() => import('./pages/camareiras/ListaQuartos').then((module) => ({ default: module.ListaQuartos })));
const MapaReservas = lazy(() => import('./pages/reservas/MapaReservas').then((module) => ({ default: module.MapaReservas })));
const CaixaRecepcao = lazy(() => import('./pages/caixa/CaixaRecepcao').then((module) => ({ default: module.CaixaRecepcao })));

const FONT_SCALES = [1, 1.15, 1.3, 1.5];

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const [scale, setScale] = useState(() => FONT_SCALES.indexOf(Number(localStorage.getItem('hotel-lindoia:font-scale') ?? 1)) === -1 ? 0 : FONT_SCALES.indexOf(Number(localStorage.getItem('hotel-lindoia:font-scale') ?? 1)));
  function changeScale(step: number) {
    const next = Math.min(FONT_SCALES.length - 1, Math.max(0, scale + step));
    document.documentElement.style.setProperty('--font-scale', String(FONT_SCALES[next]));
    localStorage.setItem('hotel-lindoia:font-scale', String(FONT_SCALES[next]));
    setScale(next);
  }
  function toggle() {
    const next = !dark;
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    localStorage.setItem('hotel-lindoia:theme', next ? 'dark' : 'light');
    setDark(next);
  }
  return <div className="theme-toggle">
    <button type="button" onClick={() => changeScale(-1)} disabled={scale === 0} aria-label="Diminuir fonte">A-</button>
    <button type="button" onClick={() => changeScale(1)} disabled={scale === FONT_SCALES.length - 1} aria-label="Aumentar fonte">A+</button>
    <button type="button" onClick={toggle} aria-pressed={dark}>{dark ? 'Tema claro' : 'Tema escuro'}</button>
  </div>;
}

function VendaRoute({ userRole }: { userRole: UserRole }) {
  const isAdmin = userRole === 'admin';
  const actor = isAdmin ? 'Gerência' : sessionStorage.getItem(ATTENDANT_STORAGE_KEY) || 'Equipe';
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

  async function handleLogin(email: string, password: string) {
    setUserRole(await signInUser(email, password));
  }

  async function handleLogout() {
    await signOutUser();
    setUserRole(null);
  }

  return (
    <BrowserRouter>
      <ThemeToggle />
      {!authReady ? <main role="status" style={{ padding: 32 }}>Verificando sessão...</main> : <Routes>
        <Route 
          path="/login" 
          element={
            userRole ? <Navigate to="/" replace /> : <Login onLogin={handleLogin} />
          } 
        />
        
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
        <Route path="/financeiro/caixa" element={<ManagementRoute userRole={userRole}><Suspense fallback={<div role="status">Carregando fluxo financeiro...</div>}><FluxoDeCaixa /></Suspense></ManagementRoute>} />
        <Route path="/financeiro/folha" element={<ManagementRoute userRole={userRole}><Suspense fallback={<div role="status">Carregando folha...</div>}><FolhaDePagamento /></Suspense></ManagementRoute>} />
      </Routes>}
    </BrowserRouter>
  );
}

export default App;