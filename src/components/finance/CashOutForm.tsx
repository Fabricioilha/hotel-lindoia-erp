import { useEffect, useState, type FormEvent } from 'react';
import { updateCashOut } from '../../services/cashEdits';
import { db, get, ref } from '../../services/pocketbaseRealtime';
import { CASH_OUT_REASONS, LEGACY_BREAKFAST_CATEGORIES, BREAKFAST_EXPENSE_CATEGORY, type CashOut } from '../../types/reception';

export function CashOutForm({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const [record, setRecord] = useState<CashOut | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  const [attendant, setAttendant] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void get(ref(db, `erp_geral/recepcao/cashOuts/${id}`)).then((snapshot) => {
      if (!active) return;
      const item = snapshot.val<CashOut>();
      if (!item) { setError('Esta saída não existe mais. Atualize o fluxo de caixa.'); setLoading(false); return; }
      setRecord(item);
      setAmount(String(item.amount));
      setReason(LEGACY_BREAKFAST_CATEGORIES.includes(item.reason) ? BREAKFAST_EXPENSE_CATEGORY : item.reason);
      setNote(item.note);
      setDate(item.date);
      setAttendant(item.attendant);
      setLoading(false);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar a saída.');
      setLoading(false);
    });
    return () => { active = false; };
  }, [id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record) return;
    setSaving(true);
    setError('');
    try {
      await updateCashOut(id, { amount: Number(amount), reason, note, date, attendant }, record);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível corrigir a saída.');
    } finally {
      setSaving(false);
    }
  }

  return <form data-guard-unsaved onSubmit={(event) => void submit(event)}>
    <header className="finance-modal-header"><div><p className="finance-eyebrow">GERÊNCIA / CORREÇÃO</p><h2 id="finance-modal-title">Corrigir saída do plantão</h2></div><button type="button" className="finance-close" onClick={onClose} disabled={saving} aria-label="Fechar">×</button></header>
    <div className="finance-modal-body">
      {error && <div className="finance-alert" role="alert">{error}</div>}
      {loading ? <p>Carregando saída...</p> : record && <>
        <p className="finance-form-hint">Plantão de {record.attendant}. A correção atualiza a conferência e o financeiro. Recolhimento para o cofre não é despesa.</p>
        <label className="finance-field"><span>Valor (R$)</span><input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>
        <label className="finance-field"><span>Data do plantão</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
        <label className="finance-field"><span>Plantonista responsável</span><input value={attendant} onChange={(event) => setAttendant(event.target.value)} required /></label>
        <label className="finance-field"><span>Motivo</span><select value={reason} onChange={(event) => setReason(event.target.value)} required>{!CASH_OUT_REASONS.includes(reason) && <option value={reason}>{reason} (histórico)</option>}{CASH_OUT_REASONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="finance-field"><span>Observação</span><textarea rows={2} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      </>}
    </div>
    <footer className="finance-modal-footer"><button type="button" className="finance-button finance-button-soft" disabled={saving} onClick={onClose}>Cancelar</button><button type="submit" className="finance-button finance-button-primary" disabled={loading || saving || !record}>{saving ? 'Salvando...' : 'Salvar correção'}</button></footer>
  </form>;
}
