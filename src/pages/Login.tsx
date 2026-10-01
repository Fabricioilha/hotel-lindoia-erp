import { useState, type FormEvent } from 'react';
import './login.css';

interface LoginProps {
  onLogin: (email: string, password: string) => Promise<void>;
}

export function Login({ onLogin }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await onLogin(email, password);
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : '';
      const code = loginError && typeof loginError === 'object' && 'code' in loginError
        ? String(loginError.code)
        : '';
      if (message === 'Conta autenticada sem perfil de acesso.') {
        setError('Conta sem perfil de acesso. Solicite à gerência a liberação do usuário.');
      } else if (code === 'auth/network-request-failed') {
        setError('Não foi possível conectar ao Firebase. Verifique sua conexão.');
      } else {
        setError('E-mail ou senha inválidos. Verifique os dados e tente novamente.');
      }
    } finally {
      setSubmitting(false);
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
            <label className="login-field"><span>E-mail</span><input autoComplete="username" required type="email" value={email} onChange={(event) => { setEmail(event.target.value); setError(''); }} placeholder="nome@hotel.com.br" /></label>
            <label className="login-field"><span>Senha</span><input autoComplete="current-password" required type="password" value={password} onChange={(event) => { setPassword(event.target.value); setError(''); }} placeholder="Digite sua senha" /></label>
            {error && <div className="login-error" role="alert">{error}</div>}
            <button className="login-submit" type="submit" disabled={submitting}>{submitting ? 'Entrando...' : 'Entrar'} <span aria-hidden="true">→</span></button>
          </form>

          <p className="login-footnote">Acesso interno <span>·</span> Hotel Lindoia</p>
        </div>
      </section>
    </main>
  );
}