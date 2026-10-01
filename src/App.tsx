import { useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { PainelEstoque } from './pages/estoque/PainelEstoque';
import { VendaGeladeira } from './pages/VendaGeladeira';
import type { UserRole } from './types';

function ProtectedRoute({ children, userRole }: { children: ReactNode; userRole: UserRole }) {
  if (!userRole) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function App() {
  const [userRole, setUserRole] = useState<UserRole>(null);

  return (
    <BrowserRouter>
      <Routes>
        <Route 
          path="/login" 
          element={
            userRole ? <Navigate to="/" replace /> : <Login onLogin={setUserRole} />
          } 
        />
        
        <Route 
          path="/" 
          element={
            <ProtectedRoute userRole={userRole}>
              <Dashboard userRole={userRole} onLogout={() => setUserRole(null)} />
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
      </Routes>
    </BrowserRouter>
  );
}

export default App;