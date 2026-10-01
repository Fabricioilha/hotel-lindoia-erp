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

    if (user === 'admin' && pass === 'admin123') {
      onLogin('admin');
    } else if (user === 'equipe' && pass === 'lindoia') {
      onLogin('viewer');
    } else {
      setError(true);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[radial-linear(ellipse_at_top,var(--tw-gradient-stops))] from-slate-700 via-slate-900 to-black p-4">
      
      {/* Container de Vidro */}
      <div className="max-w-md w-full bg-white/5 backdrop-blur-xl rounded-3xl shadow-2xl border border-white/10 p-10 space-y-8">
        
        <div className="text-center">
          <div className="bg-indigo-500/20 text-indigo-400 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 text-4xl shadow-[0_0_15px_rgba(99,102,241,0.3)] border border-indigo-500/30">
            🏨
          </div>
          <h2 className="text-3xl font-black text-white tracking-wide">Hotel Lindoia</h2>
          <p className="text-indigo-200 mt-2 font-medium tracking-wider text-sm uppercase">Painel de Gestão Integrada</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-slate-300 mb-1.5 ml-1">Usuário</label>
            <input
              type="text"
              placeholder="Digite seu usuário"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-5 py-3.5 rounded-xl bg-slate-800/50 border border-slate-600 text-white placeholder-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-300 mb-1.5 ml-1">Senha</label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-5 py-3.5 rounded-xl bg-slate-800/50 border border-slate-600 text-white placeholder-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all"
            />
          </div>

          {error && (
            <div className="bg-red-500/20 text-red-300 text-sm p-4 rounded-xl text-center border border-red-500/30 animate-pulse">
              Credenciais inválidas. Tente novamente.
            </div>
          )}

          <button
            type="submit"
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-lg py-4 px-4 rounded-xl shadow-[0_0_20px_rgba(79,70,229,0.4)] hover:shadow-[0_0_25px_rgba(79,70,229,0.6)] transition-all active:scale-[0.98] mt-4"
          >
            Entrar no Sistema
          </button>
        </form>
      </div>
    </div>
  );
}