import { useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import type { UserRole } from './types';

function App() {
  const [userRole, setUserRole] = useState<UserRole>(null);

  const ProtectedRoute = ({ children }: { children: ReactNode }) => {
    if (!userRole) {
      return <Navigate to="/login" replace />;
    }
    return children;
  };

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
            <ProtectedRoute>
              <Dashboard userRole={userRole} onLogout={() => setUserRole(null)} />
            </ProtectedRoute>
          } 
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;