import { useState, type FormEvent } from 'react';
import { registerOyoClosing, type OyoClosingRecord } from '../../services/oyoReconciliation';
import { formatBRL } from '../../services/money';

export function OyoReconciliation({ month, balance, pendingCash, readError, onSaved }: {
  month: string;
  balance: number | null;
  pendingCash: number | null;
  readError: string;
  onSaved: (month: string, record: OyoClosingRecord) => void;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim() || saving || pendingCash === null || balance !== null || readError) return;
    setSaving(true);
    setError('');
    try {
      const saved = await registerOyoClosing(month, Number(draft));
      onSaved(month, saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível lançar a RECOM.');
    } finally {
      setSaving(false);
    }
  }

  const monthLabel = month.split('-').reverse().join('/');
  return <section className="finance-panel">
    <div className="finance-panel-heading">
      <div>
        <h2>RECOM de {monthLabel}</h2>
        {balance !== null ? <p>Competência conciliada</p> : <>
          <p>Movimentos do mês a conciliar <strong>{pendingCash === null ? '—' : formatBRL(pendingCash)}</strong></p>
          <p>Pré-pagos do hotel, mais pagamentos à OYO, menos despesas compensadas e repasses recebidos.</p>
        </>}
      </div>
      {balance !== null && <p>Saldo final lançado <strong className={balance < 0 ? 'finance-amount-negative' : undefined}>{formatBRL(balance)}</strong></p>}
    </div>
    {readError && <p className="finance-alert" role="alert">{readError}</p>}
    {error && balance === null && <p className="finance-alert" role="alert">{error}</p>}
    {pendingCash === null ? !readError && <p>Carregando RECOM...</p> : balance === null && <form className="finance-settings-form" onSubmit={(event) => void submit(event)}>
      <label className="finance-field">
        <span>Total da RECOM de {monthLabel} (R$)</span>
        <input type="number" step="0.01" value={draft} onChange={(event) => setDraft(event.target.value)} aria-describedby="oyo-balance-sign" required />
      </label>
      <button type="submit" className="finance-button finance-button-primary" disabled={saving || Boolean(readError)}>{saving ? 'Lançando...' : 'Lançar RECOM'}</button>
      <p className="finance-form-hint" id="oyo-balance-sign">Use o saldo final do relatório (campo C), com sinal negativo quando houver valor a pagar. O lançamento encerra o Caixa OYO desta competência.</p>
    </form>}
  </section>;
}
