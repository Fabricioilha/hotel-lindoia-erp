import { useState, type FormEvent } from 'react';
import { saveOyoClosing, type OyoClosingRecord } from '../../services/oyoReconciliation';
import { formatBRL } from '../../services/money';

export function OyoReconciliation({ month, record, balance, ready, readError, onSaved }: {
  month: string;
  record: OyoClosingRecord | null;
  balance: number | null;
  ready: boolean;
  readError: string;
  onSaved: (month: string, record: OyoClosingRecord) => void;
}) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [baseline, setBaseline] = useState<OyoClosingRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function startEditing() {
    setDraft(balance === null ? '' : String(balance));
    setBaseline(record);
    setEditing(true);
    setNotice('');
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      const saved = await saveOyoClosing(month, Number(draft), baseline);
      onSaved(month, saved);
      setEditing(false);
      setNotice('Saldo final da RECOM salvo.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a RECOM.');
    } finally {
      setSaving(false);
    }
  }

  const monthLabel = month.split('-').reverse().join('/');
  return <section className="finance-panel">
    <div className="finance-panel-heading">
      <div>
        <h2>RECOM de {monthLabel}</h2>
        <p>Informe o saldo final do relatório da OYO (campo C). Esse valor já inclui o saldo anterior.</p>
      </div>
      {!editing && <button type="button" className="finance-button finance-button-dark" disabled={!ready} onClick={startEditing}>
        {balance === null ? 'Informar saldo final' : 'Editar saldo final'}
      </button>}
    </div>
    {readError && <p className="finance-alert" role="alert">{readError}</p>}
    {error && <p className="finance-alert" role="alert">{error}</p>}
    {notice && <p className="finance-notice" role="status">{notice}</p>}
    {editing ? <form className="finance-settings-form" onSubmit={(event) => void submit(event)}>
      <label className="finance-field">
        <span>Saldo final da RECOM (R$)</span>
        <input type="number" step="0.01" value={draft} onChange={(event) => setDraft(event.target.value)} aria-describedby="oyo-balance-sign" required />
      </label>
      <button type="submit" className="finance-button finance-button-primary" disabled={saving}>{saving ? 'Salvando...' : 'Salvar saldo'}</button>
      <button type="button" className="finance-button finance-button-soft" disabled={saving} onClick={() => { setEditing(false); setError(''); }}>Cancelar</button>
      <p className="finance-form-hint" id="oyo-balance-sign">Informe um valor negativo se o hotel deve à OYO, positivo se tem a receber ou zero se o campo C estiver zerado.</p>
    </form> : ready ? <p className="finance-empty-inline">
      {balance === null ? 'Nenhum saldo final informado neste mês.' : <>
        <strong>{formatBRL(Math.abs(balance))}</strong> {balance < 0 ? 'a pagar à OYO' : balance > 0 ? 'a receber da OYO' : '· sem saldo'}
      </>}
    </p> : !readError && <p>Carregando RECOM...</p>}
  </section>;
}
