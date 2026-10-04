import { useEffect, useState, type FormEvent } from 'react';
import { emptyReception, saveFloatCheck, subscribeReception } from '../../services/receptionStore';
import { useDuty } from '../../services/useAttendant';
import { FLOAT_AMOUNT, type ReceptionData } from '../../types/reception';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Ao assumir o plantão, o plantonista confirma se o anterior deixou o troco no caixa.
export function FloatCheckGate() {
  const { attendant, duty, previous } = useDuty();
  const [data, setData] = useState<ReceptionData>(emptyReception());
  const [loaded, setLoaded] = useState(false);
  const [different, setDifferent] = useState(false);
  const [amount, setAmount] = useState('');
  const [justification, setJustification] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => subscribeReception((next) => {
    setData(next);
    setLoaded(true);
  }, () => undefined), []);

  if (!loaded || !duty || !attendant) return null;
  const id = `${duty.start.getTime()}-${attendant.replace(/[^A-Za-z0-9]/g, '_')}`;
  if (data.floatChecks[id]) return null;

  async function save(counted: number, reason: string) {
    setSaving(true);
    setError('');
    try {
      await saveFloatCheck({ id, attendant, previousAttendant: previous, expected: FLOAT_AMOUNT, counted, justification: reason, createdAt: new Date().toISOString() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível registrar a conferência.');
    } finally {
      setSaving(false);
    }
  }

  function submitDifferent(event: FormEvent) {
    event.preventDefault();
    const counted = Number(amount.replace(',', '.'));
    if (!Number.isFinite(counted) || counted < 0 || amount.trim() === '') return setError('Informe quanto há no caixa.');
    if (counted === FLOAT_AMOUNT) return void save(counted, '');
    if (!justification.trim()) return setError('Explique o motivo da diferença.');
    void save(Math.round(counted * 100) / 100, justification.trim());
  }

  return (
    <div className="float-gate" role="dialog" aria-modal="true" aria-labelledby="float-title">
      <div className="float-box">
        <p className="float-eyebrow">TROCA DE PLANTÃO</p>
        <h2 id="float-title">Conferência do troco</h2>
        <p>Olá, <strong>{attendant}</strong>. {previous ? <>O plantonista anterior (<strong>{previous}</strong>) deixou</> : 'O caixa foi deixado'} com {money(FLOAT_AMOUNT)} de troco?</p>
        {error && <div className="float-error" role="alert">{error}</div>}
        {!different ? <div className="float-actions">
          <button type="button" className="float-yes" disabled={saving} onClick={() => void save(FLOAT_AMOUNT, '')}>Sim, tem {money(FLOAT_AMOUNT)}</button>
          <button type="button" className="float-no" disabled={saving} onClick={() => setDifferent(true)}>Não, o valor é diferente</button>
        </div> : <form onSubmit={submitDifferent} className="float-form">
          <label>Quanto há no caixa agora? (R$)<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus /></label>
          <label>Justificativa<textarea rows={3} value={justification} onChange={(event) => setJustification(event.target.value)} maxLength={300} placeholder="Explique por que o valor é diferente de R$ 300,00" /></label>
          <div className="float-actions">
            <button type="submit" className="float-yes" disabled={saving}>{saving ? 'Registrando...' : 'Registrar valor'}</button>
            <button type="button" className="float-back" disabled={saving} onClick={() => setDifferent(false)}>Voltar</button>
          </div>
        </form>}
      </div>
    </div>
  );
}
