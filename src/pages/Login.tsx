// src/pages/Login.tsx
import React, { useState } from 'react';
import type { UserRole } from '../types';

interface LoginProps {
  onLogin: (role: UserRole) => void;
}

export function Login({ onLogin }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    
    const user = username.trim().toLowerCase();
    const pass = password.trim();

    // Verificação baseada nas regras originais
    if (user === 'admin' && pass === 'admin123') {
      onLogin('admin');
    } else if (user === 'equipe' && pass === 'lindoia') {
      onLogin('viewer');
    } else {
      setError(true);
    }
  };

  return (
    <div style={styles.overlay}>
      <h2 style={{ marginBottom: '30px', color: 'white' }}>🏨 ERP - Hotel Lindoia</h2>
      <div style={styles.loginBox}>
        <h3 style={{ marginTop: 0, color: '#2c3e50' }}>Acesso ao Sistema</h3>
        
        <form onSubmit={handleLogin}>
          <input
            type="text"
            placeholder="Usuário"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={styles.input}
          />
          <input
            type="password"
            placeholder="Senha"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
          />
          <button type="submit" style={styles.button}>Entrar</button>
        </form>

        {error && (
          <p style={{ color: 'red', fontSize: '13px', marginTop: '10px' }}>
            Credenciais inválidas!
          </p>
        )}
      </div>
    </div>
  );
}

// Estilos isolados baseados no CSS original do projeto
const styles = {
  overlay: {
    position: 'fixed' as const,
    top: 0, left: 0, width: '100%', height: '100%',
    backgroundColor: '#2c3e50',
    display: 'flex', flexDirection: 'column' as const,
    justifyContent: 'center', alignItems: 'center',
    zIndex: 2000,
  },
  loginBox: {
    backgroundColor: 'white',
    padding: '30px',
    borderRadius: '8px',
    width: '300px',
    textAlign: 'center' as const,
    boxShadow: '0 4px 15px rgba(0,0,0,0.2)',
  },
  input: {
    width: '90%',
    marginBottom: '15px',
    padding: '10px',
    border: '1px solid #ccc',
    borderRadius: '4px',
    fontSize: '14px',
  },
  button: {
    backgroundColor: '#3498db',
    color: 'white',
    border: 'none',
    padding: '10px',
    width: '100%',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '16px',
  }
};