import { useState, type FormEvent } from 'react';
import { DateInput } from '../ui/DateInput';
import type { FinanceRange } from '../../services/financeOverview';
import { financeDateLabel, financeMonthRange, isFinanceDateKey } from '../../services/financePayments';

export function FinancePeriodFilter({ range, today, onChange }: { range: FinanceRange; today: string; onChange: (next: FinanceRange) => void }) {
  const [draft, setDraft] = useState(range);
  const [error, setError] = useState('');

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isFinanceDateKey(draft.from) || !isFinanceDateKey(draft.to) || draft.from > draft.to) {
      setError('Informe um período válido. A data inicial deve ser igual ou anterior à final.');
      return;
    }
    setError('');
    onChange(draft);
  }

  function reset() {
    const next = financeMonthRange(today.slice(0, 7));
    setError('');
    setDraft(next);
    onChange(next);
  }

  return <form className="finance-range-form finance-overview-filter" aria-label="Selecionar período de análise" onSubmit={apply}>
    <div className="finance-overview-filter-title"><strong>Período de análise</strong><span role="status">{financeDateLabel(range.from)} a {financeDateLabel(range.to)}</span></div>
    <div className="finance-range-dates">
      <label className="finance-month"><span>Data inicial</span><DateInput name="overviewFrom" value={draft.from} onValueChange={(from) => setDraft((current) => ({ ...current, from }))} required /></label>
      <label className="finance-month"><span>Data final</span><DateInput name="overviewTo" value={draft.to} onValueChange={(to) => setDraft((current) => ({ ...current, to }))} required /></label>
      <button type="submit" className="finance-button finance-button-dark">Aplicar período</button>
      <button type="button" className="finance-button finance-button-soft" onClick={reset}>Mês atual</button>
    </div>
    {error && <p className="finance-alert" role="alert">{error}</p>}
  </form>;
}
