import { useState, type FormEvent } from 'react';
import type { UserRole } from '../types';
import './login.css';

interface LoginProps {
  onLogin: (role: UserRole) => void;
}

export function Login({ onLogin }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const user = username.trim().toLowerCase();
    const pass = password.trim();

    if (user === 'admin' && pass === 'admin123') {
      onLogin('admin');
    } else if (user === 'equipe' && pass === 'lindoia') {
      onLogin('viewer');
    } else {
      setError(true);
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand-panel">
        <div className="login-brand-lockup"><span>HL</span><small>HOTEL LINDOIA</small></div>
        <div className="login-brand-copy"><p>HOSPITALIDADE &amp; OPERAÇÃO</p><h1>Hotel<br />Lindoia</h1><span>GESTÃO INTEGRADA</span></div>
        <div className="login-brand-rule" />
        <p className="login-brand-footer">PAINEL DA EQUIPE</p>
      </section>

      <section className="login-form-panel">
        <div className="login-form-wrap">
          <span className="login-form-mark">HL</span>
          <p className="login-eyebrow">ACESSO DA EQUIPE</p>
          <h2>Entrar no sistema</h2>
          <p className="login-intro">Use suas credenciais para acessar a operação do hotel.</p>

          <form onSubmit={handleLogin} className="login-form">
            <label className="login-field"><span>Usuário</span><input autoComplete="username" required value={username} onChange={(event) => { setUsername(event.target.value); setError(false); }} placeholder="Digite seu usuário" /></label>
            <label className="login-field"><span>Senha</span><input autoComplete="current-password" required type="password" value={password} onChange={(event) => { setPassword(event.target.value); setError(false); }} placeholder="Digite sua senha" /></label>
            {error && <div className="login-error" role="alert">Usuário ou senha inválidos. Tente novamente.</div>}
            <button className="login-submit" type="submit">Entrar <span aria-hidden="true">→</span></button>
          </form>

          <p className="login-footnote">Acesso interno <span>·</span> Hotel Lindoia</p>
        </div>
      </section>
    </main>
  );
}