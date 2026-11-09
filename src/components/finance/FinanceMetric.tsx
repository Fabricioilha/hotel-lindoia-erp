import { useId, useState } from 'react';

export function FinanceMetric({ label, value, detail, help, tone, negative, onOpen, actionLabel = 'Ver contas' }: {
  label: string; value: string; detail: string; help: string; tone: string; negative?: boolean; onOpen?: () => void; actionLabel?: string;
}) {
  const tooltipId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  return <article className={`finance-metric metric-${tone}`}>
    <span className="metric-rule" />
    <div className="finance-metric-heading">
      <p>{label}</p>
      <div className="finance-metric-help" onMouseEnter={() => setHelpOpen(true)} onMouseLeave={() => setHelpOpen(false)}>
        <button type="button" className="finance-metric-info" aria-label={`Sobre ${label.toLocaleLowerCase('pt-BR')}`} aria-describedby={tooltipId}
          onFocus={() => setHelpOpen(true)} onBlur={() => setHelpOpen(false)} onClick={() => setHelpOpen(true)}
          onKeyDown={(event) => { if (event.key === 'Escape') setHelpOpen(false); }}>i</button>
        <div id={tooltipId} role="tooltip" className="finance-metric-tooltip" hidden={!helpOpen}>{help}</div>
      </div>
    </div>
    {onOpen ? <button type="button" className="finance-metric-value-button" aria-label={`${label}, ${value}. ${actionLabel}`} onClick={onOpen}><strong>{value}</strong></button>
      : <strong className={negative ? 'finance-amount-negative' : undefined}>{value}</strong>}
    <small>{detail}</small>
  </article>;
}
