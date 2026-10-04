import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { UserRole } from '../../types';
import { CASH_OUT_REASONS, type CashOut } from '../../types/reception';
import { emptyReception, localDateKey, saveCashOut, subscribeReception } from '../../services/receptionStore';
import { BackToPanel } from '../../components/ui/BackToPanel';
import { useAttendant } from '../../services/useAttendant';
import './caixa.css';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function SaidaCaixa({ userRole }: { userRole: UserRole }) {
  const sessionAttendant = useAttendant();
  const attendant = userRole === 'admin' ? 'Gerência' : sessionAttendant;
  const [cashOuts, setCashOuts] = useState<Record<string, CashOut>>(emptyReception().cashOuts);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => subscribeReception((data) => setCashOuts(data.cashOuts), (cause) => setError(cause.message)), []);

  if (!attendant) {
    return <div className="cx-page"><div className="cx-panel"><h1>Saída de caixa</h1><p>Não há plantonista na escala neste horário. O plantonista é definido automaticamente pela escala; avise a gerência para ajustá-la.</p><Link className="cx-primary" to="/">Voltar ao Painel principal</Link></div></div>;
  }

  const today = localDateKey();
  const mine = Object.values(cashOuts).filter((item) => item.attendant === attendant && item.date === today).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const total = mine.reduce((sum, item) => sum + item.amount, 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    const value = Number(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return setError('Informe o valor retirado do caixa.');
    if (!reason) return setError('Escolha o motivo da retirada.');
    const cashOut: CashOut = { id: crypto.randomUUID(), amount: Math.round(value * 100) / 100, reason, note: note.trim(), attendant, date: today, createdAt: new Date().toISOString() };
    if (!window.confirm(`Confirmar retirada de ${money(cashOut.amount)} do caixa de ${attendant} para "${reason}"?`)) return;
    setSaving(true);
    try {
      await saveCashOut(cashOut);
      setAmount('');
      setReason('');
      setNote('');
      setNotice(`Retirada de ${money(cashOut.amount)} registrada.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível registrar a retirada.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cx-page">
      <BackToPanel />
      <header className="cx-title">
        <p className="cx-eyebrow">PLANTÃO <span>/</span> CAIXA</p>
        <h1>Saída de caixa</h1>
        <p>Use quando retirar dinheiro do caixa para uma compra (mercado, padaria, farmácia...). Guarde o comprovante.</p>
      </header>
      {error && <div className="cx-alert" role="alert">{error}</div>}
      {notice && <div className="cx-success" role="status">{notice}</div>}

      <form className="cx-panel" onSubmit={(event) => void submit(event)}>
        <label className="cx-field cx-big">Quanto saiu do caixa? (R$)
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0,00" autoFocus />
        </label>
        <div className="cx-field">Motivo
          <div className="cx-chips">{CASH_OUT_REASONS.map((item) => <button key={item} type="button" className={`cx-chip ${reason === item ? 'is-on' : ''}`} onClick={() => setReason(item)}>{item}</button>)}</div>
        </div>
        <label className="cx-field">O que foi comprado? (opcional)
          <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} placeholder="Ex.: leite, pão e café para o café da manhã" />
        </label>
        <p className="cx-who">Plantonista: <strong>{attendant}</strong></p>
        <button type="submit" className="cx-primary" disabled={saving}>{saving ? 'Registrando...' : 'Registrar retirada'}</button>
      </form>

      <section className="cx-panel">
        <h2>Retiradas de hoje no caixa de {attendant} <small>{money(total)}</small></h2>
        {mine.length === 0 ? <p className="cx-muted">Nenhuma retirada registrada hoje.</p> : <ul className="cx-list">
          {mine.map((item) => <li key={item.id}><span className="cx-time">{timeOf(item.createdAt)}</span><span>{item.reason}{item.note ? ` · ${item.note}` : ''}</span><strong>{money(item.amount)}</strong></li>)}
        </ul>}
      </section>
    </div>
  );
}
