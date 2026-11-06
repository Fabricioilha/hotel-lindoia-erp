import { useEffect, useState, type FormEvent } from 'react';
import { calculateOyoReconciliation, saveOyoReconciliation, subscribeOyoReconciliation, type OyoReconciliation as Reconciliation } from '../../services/oyoReconciliation';

const fields = [
  ['revenue', 'Receita total do relatório'],
  ['costs', 'Custos totais OYO'],
  ['adjustments', 'Ajustes (+ ou −)'],
  ['priorBalance', 'Saldo anterior (+ ou −)'],
  ['reportedShare', 'Participação líquida do hotel (A), informada pela OYO'],
  ['collectedByHotel', 'Recebido pelo hotel'],
  ['paidToHotel', 'Repasses da OYO ao hotel'],
  ['paidToOyo', 'Pagamentos do hotel à OYO'],
] as const;
type Field = typeof fields[number][0];
type Draft = Record<Field, string>;
const emptyDraft = (): Draft => ({ revenue: '', costs: '', adjustments: '', priorBalance: '', reportedShare: '', collectedByHotel: '', paidToHotel: '', paidToOyo: '' });
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function OyoReconciliation({ month }: { month: string }) {
  const [record, setRecord] = useState<Reconciliation | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [baseline, setBaseline] = useState<Reconciliation | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    return subscribeOyoReconciliation(month, (next) => {
      setRecord(next);
      setReady(true);
      setLoading(false);
    }, (cause) => { setError(cause.message); setReady(false); setLoading(false); });
  }, [month]);

  function startEditing() {
    setDraft(record ? Object.fromEntries(fields.map(([key]) => [key, String(record[key])])) as Draft : emptyDraft());
    setBaseline(record);
    setEditing(true);
    setNotice('');
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (fields.some(([key]) => draft[key].trim() === '')) { setError('Preencha todos os valores; informe zero quando não houver movimento.'); return; }
    const values = Object.fromEntries(fields.map(([key]) => [key, Number(draft[key])])) as Record<Field, number>;
    const next = { ...values, updatedAt: new Date().toISOString() };
    setSaving(true);
    setError('');
    try {
      await saveOyoReconciliation(month, next, baseline);
      setEditing(false);
      setNotice('Conciliação salva. Os lançamentos financeiros não foram alterados.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a conciliação.');
    } finally {
      setSaving(false);
    }
  }

  const result = record ? calculateOyoReconciliation(record) : null;
  return <section className="finance-panel">
    <div className="finance-panel-heading"><div><h2>Conciliação mensal OYO</h2><p>Informe os totais do relatório para o mês selecionado. Valores negativos no saldo anterior e ajustes representam débitos.</p></div>
      {!editing && <button type="button" className="finance-button finance-button-soft" disabled={!ready} onClick={startEditing}>{record ? 'Editar conciliação' : 'Informar conciliação'}</button>}</div>
    <p className="finance-form-hint">Conferência independente: estes valores não criam nem alteram entradas, despesas ou transferências. Compare-os com os lançamentos e corrija-os nas respectivas telas. O relatório pode usar critérios diferentes dos movimentos do sistema.</p>
    {error && <div className="finance-alert" role="alert">{error}</div>}
    {notice && <div className="finance-notice" role="status">{notice}</div>}
    {loading ? <p>Carregando conciliação...</p> : editing ? <form onSubmit={(event) => void submit(event)}>
      <div className="finance-category-grid">{fields.map(([key, label]) => <label className="finance-field" key={key}><span>{label} (R$)</span><input type="number" step="0.01" value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} required /></label>)}</div>
      <div className="finance-heading-actions"><button type="submit" className="finance-button finance-button-primary" disabled={saving}>{saving ? 'Salvando...' : 'Salvar conciliação'}</button><button type="button" className="finance-button finance-button-soft" disabled={saving} onClick={() => setEditing(false)}>Cancelar</button></div>
    </form> : record && result ? <>
      <div className="finance-category-grid">{fields.map(([key, label]) => <p key={key}>{label}: <strong>{money(record[key])}</strong></p>)}</div>
      <p>Conferência das linhas (receita − custos + ajustes + saldo anterior): <strong>{money(result.calculatedShare)}</strong> · Diferença para A informado: <strong>{money(result.difference)}</strong>{result.difference !== 0 ? ' — conferir com a OYO; não presumir a origem da diferença.' : ''}</p>
      <p>Participação líquida informada pela OYO (A): <strong>{money(result.share)}</strong> · Recebido líquido pelo hotel (B): <strong>{money(result.received)}</strong></p>
      <p>Acerto (A − B): <strong>{money(result.balance)}</strong> {result.balance < 0 ? 'a pagar à OYO' : result.balance > 0 ? 'a receber da OYO' : 'sem saldo'}</p>
    </> : <p className="finance-empty-inline">Nenhuma conciliação informada para este mês.</p>}
  </section>;
}
