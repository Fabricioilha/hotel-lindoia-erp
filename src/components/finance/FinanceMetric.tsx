import { useId, useState, type ReactNode } from 'react';

export function FinanceMetric({ label, value, detail, help, tone, negative, onOpen, actionLabel = 'Ver contas', icon, trend }: {
  label: string; value: string; detail: string; help: string; tone: string; negative?: boolean; onOpen?: () => void; actionLabel?: string;
  icon?: ReactNode;
  trend?: { value: string; direction: 'up' | 'down' | 'flat'; sentiment: 'good' | 'bad' | 'neutral'; comparison: string };
}) {
  const tooltipId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  return <article className={`finance-metric metric-${tone}${icon ? ' report-hero-metric report-surface rounded-2xl border shadow-sm' : ''}`}>
    <span className="metric-rule" />
    <div className="finance-metric-heading">
      <p>{icon && <span className="report-metric-icon" aria-hidden="true">{icon}</span>}{label}</p>
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
    {trend && <div className="report-metric-trend"><span data-sentiment={trend.sentiment}><i aria-hidden="true">{trend.direction === 'up' ? '↗' : trend.direction === 'down' ? '↘' : '–'}</i>{trend.value}</span><span>{trend.comparison}</span></div>}
  </article>;
}

export function FinanceMetricSkeleton() {
  return <div className="report-surface report-metric-placeholder rounded-2xl border p-5 shadow-sm" aria-hidden="true">
    <div className="flex items-center gap-3"><span className="report-skeleton h-8 w-8 rounded-lg" /><span className="report-skeleton h-3 w-24 rounded" /></div>
    <span className="report-skeleton mt-4 h-8 w-3/5 rounded-md" />
    <span className="report-skeleton mt-3 h-3 w-2/3 rounded" />
    <span className="report-skeleton mt-4 h-5 w-1/2 rounded-full" />
  </div>;
}
