import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { PainelEstoque } from './pages/estoque/PainelEstoque';
import { VendaGeladeira } from './pages/VendaGeladeira';
import { Escala } from './pages/escala/Escala';
import { observeAuth, readUserRole, signInUser, signOutUser } from './services/authStore';
import type { UserRole } from './types';

const FluxoDeCaixa = lazy(() => import('./pages/financeiro/FluxoDeCaixa').then((module) => ({ default: module.FluxoDeCaixa })));
const FolhaDePagamento = lazy(() => import('./pages/financeiro/FolhaDePagamento').then((module) => ({ default: module.FolhaDePagamento })));

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
            <ProtectedRoute userRole={userRole}>
              <PainelEstoque actor={userRole === 'admin' ? 'Gerência' : 'Equipe'} canViewFinancials={userRole === 'admin'} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/vendas"
          element={
            <ProtectedRoute userRole={userRole}>
              <VendaGeladeira actor={userRole === 'admin' ? 'Gerência' : 'Equipe'} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/escala"
          element={
            <ProtectedRoute userRole={userRole}>
              <Escala userRole={userRole} />
            </ProtectedRoute>
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