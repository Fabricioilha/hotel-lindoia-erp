// src/App.tsx
import { useState } from 'react';
import { Login } from './pages/Login';
import type { UserRole } from './types';

function App() {
  const [userRole, setUserRole] = useState<UserRole>(null);

  const handleLogout = () => {
    setUserRole(null);
  };

  if (!userRole) {
    return <Login onLogin={setUserRole} />;
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e50', padding: '15px', color: 'white', borderRadius: '8px' }}>
        <h2>Painel de Gestão ERP</h2>
        <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
          <span>Perfil: <strong>{userRole === 'admin' ? 'Gerência' : 'Equipe'}</strong></span>
          <button 
            onClick={handleLogout}
            style={{ backgroundColor: '#e74c3c', color: 'white', border: 'none', padding: '5px 15px', borderRadius: '4px', cursor: 'pointer' }}
          >
            Sair
          </button>
        </div>
      </div>
      
      <div style={{ marginTop: '20px' }}>
        <h3>Bem-vindo ao Hotel Lindoia ERP!</h3>
        <p>A interface modular será carregada aqui...</p>
      </div>
    </div>
  );
}

export default App;