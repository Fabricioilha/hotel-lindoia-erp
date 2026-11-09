import { useId, useState, type ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Pie, PieChart, ReferenceLine, ResponsiveContainer, Sector, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { FinanceGranularity } from '../../services/financePayments';
import { financeCents, financeDateLabel } from '../../services/financePayments';
import { reportCategorySlices, reportChange, type ReportCategory, type ReportPoint } from '../../services/financeReports';
import { formatBRL as money } from '../../services/money';

type Series = { key: 'revenue' | 'expenses' | 'incoming' | 'outgoing'; label: string; color: string };
const compactMoney = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const margin = { top: 12, right: 10, left: 0, bottom: 0 };
const colors = ['#de775c', '#aa5cab', '#6c70c9', '#3282a6', '#2b8f7d', '#a37a36'];
const caption = (point: ReportPoint) => point.from === point.to ? financeDateLabel(point.from)
  : `${financeDateLabel(point.from)} a ${financeDateLabel(point.to)}`;

function ChartPanel({ title, description, summary, children }: { title: string; description: string; summary?: string; children: ReactNode }) {
  const titleId = useId();
  return <section className="report-surface report-chart-card min-w-0 rounded-2xl border p-4 shadow-sm sm:p-6" aria-labelledby={titleId}>
    <div className="report-chart-heading flex flex-wrap items-start justify-between gap-3">
      <div><h2 id={titleId}>{title}</h2><p>{description}</p></div>
      {summary && <strong className="report-chart-summary tabular-nums">{summary}</strong>}
    </div>
    {children}
  </section>;
}

function variation(value: number, previous: number | undefined, against: string) {
  if (previous === undefined) return 'Sem intervalo anterior';
  const change = reportChange(value, previous);
  return change === null ? 'Base anterior zerada' : `${change > 0 ? '+' : ''}${percent.format(change)}% ${against}`;
}

function TimelineTooltip({ active, label, points, series }: TooltipContentProps & { points: ReportPoint[]; series: Series[] }) {
  const index = active ? points.findIndex((point) => point.from === label) : -1;
  const point = points[index];
  if (!point) return null;
  const previous = points[index - 1];
  return <div className="report-chart-tooltip" role="status">
    <strong>{caption(point)}</strong>
    {series.map((line) => <div key={line.key}>
      <span><i style={{ background: line.color }} />{line.label}</span><b>{money(point[line.key])}</b>
      <small>{variation(point[line.key], previous?.[line.key], 'vs. intervalo anterior')}</small>
    </div>)}
  </div>;
}

export function ReportTimeline({ title, description, points, series, kind, granularity, total }: {
  title: string; description: string; points: ReportPoint[]; series: Series[]; kind: 'area' | 'bars'; granularity: FinanceGranularity; total?: number;
}) {
  const gradientId = useId();
  const primary = series[0];
  const empty = !points.some((point) => series.some((line) => point[line.key] !== 0));
  const Chart = kind === 'area' ? AreaChart : BarChart;
  const tickDate = (date: string) => granularity === 'day' ? date.slice(8) + '/' + date.slice(5, 7)
    : date.slice(5, 7) + '/' + date.slice(2, 4);
  return <ChartPanel title={title} description={description} summary={total === undefined ? undefined : money(total)}>
    <div className="report-chart-legend flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((line) => <span key={line.key}><i style={{ background: line.color }} />{line.label}</span>)}
    </div>
    <div className="report-chart-plot">
      {empty ? <div className="report-chart-empty">Sem valores no período selecionado.</div> :
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <Chart data={points} margin={margin} accessibilityLayer title={title}>
            <defs><linearGradient id={gradientId} x1="0%" x2="0%" y1="0%" y2="100%"><stop offset="0%" stopColor={primary.color} stopOpacity=".32" /><stop offset="100%" stopColor={primary.color} stopOpacity=".035" /></linearGradient></defs>
            <CartesianGrid stroke="var(--report-grid)" strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="from" tickFormatter={tickDate} tick={{ fill: 'var(--report-muted)', fontSize: 11 }}
              tickLine={false} axisLine={false} tickMargin={9} minTickGap={18} interval="preserveStartEnd" />
            <YAxis tickFormatter={(value: number) => 'R$ ' + compactMoney.format(value)} tick={{ fill: 'var(--report-muted)', fontSize: 11 }}
              tickLine={false} axisLine={false} tickMargin={7} width={65} tickCount={5} />
            <ReferenceLine y={0} stroke="var(--report-border)" />
            <Tooltip content={(props) => <TimelineTooltip {...props} points={points} series={series} />}
              cursor={kind === 'area' ? { stroke: 'var(--report-muted)', strokeDasharray: '3 4' } : { fill: 'var(--report-subtle)', opacity: .85 }}
              isAnimationActive={false} />
            {kind === 'area' ? <Area dataKey={primary.key} name={primary.label} type="monotone" baseValue={0}
              stroke={primary.color} strokeWidth={2.5} fill={`url(#${gradientId})`} fillOpacity={1}
              dot={points.length === 1} activeDot={{ r: 5, stroke: 'var(--report-surface)', strokeWidth: 2.5 }}
              isAnimationActive={false} /> : series.map((line) => <Bar key={line.key} dataKey={line.key} name={line.label}
              fill={line.color} radius={3} maxBarSize={30} isAnimationActive={false} />)}
          </Chart>
        </ResponsiveContainer>}
    </div>
    <details className="report-chart-data">
      <summary>Ver valores do gráfico</summary>
      <div className="finance-table-wrap"><table className="finance-table">
        <thead><tr><th>Intervalo</th>{series.map((line) => <th key={line.key} className="numeric">{line.label}</th>)}</tr></thead>
        <tbody>{points.map((point) => <tr key={point.from}><td>{caption(point)}</td>{series.map((line) => <td key={line.key} className="numeric">{money(point[line.key])}</td>)}</tr>)}</tbody>
      </table></div>
    </details>
  </ChartPanel>;
}

export function ExpenseDonut({ title, description, rows, previous, hasComparison }: {
  title: string; description: string; rows: ReportCategory[]; previous: ReportCategory[]; hasComparison: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const slices = reportCategorySlices(rows, previous);
  const total = slices.reduce((sum, row) => sum + financeCents(row.value), 0);
  const segments = slices.map((row, index) => ({
    ...row, share: financeCents(row.value) / total * 100, fill: colors[index],
  }));
  const selected = active === null ? undefined : segments[active];
  const corrections = rows.filter((row) => row.value < 0);
  return <ChartPanel title={title} description={description}>
    <div className="report-donut-plot" onPointerLeave={() => setActive(null)}>
      {!total ? <div className="report-chart-empty">Sem despesas para distribuir.</div> : <>
        <div aria-hidden="true" className="report-donut-chart">
          <PieChart width={206} height={206} accessibilityLayer={false}>
            <Pie data={segments} dataKey="value" nameKey="label" innerRadius={69} outerRadius={92}
              startAngle={90} endAngle={-270} paddingAngle={segments.length > 1 ? 2 : 0} stroke="none"
              isAnimationActive={false} rootTabIndex={-1} onMouseEnter={(_, index) => setActive(index)}
              onClick={(_, index) => setActive(index)}
              shape={(props) => <Sector {...props} opacity={selected && active !== props.index ? .43 : 1}
                outerRadius={props.outerRadius + (active === props.index ? 3 : 0)} />} />
          </PieChart>
        </div>
        <div className="report-donut-center">
          <span>{selected ? selected.label : 'Total distribuído'}</span>
          <strong>{money(selected?.value ?? total / 100)}</strong>
          {selected && <small>{percent.format(selected.share)}% do total</small>}
        </div>
      </>}
    </div>
    {segments.length > 0 && <ul className="report-donut-legend">
      {segments.map((segment, index) => <li key={index}>
        <button type="button" className="report-donut-row" aria-pressed={active === index}
          aria-label={`${segment.label}, ${money(segment.value)}, ${percent.format(segment.share)}% do total. ${variation(segment.value, hasComparison ? segment.previous : undefined, 'vs. período anterior')}`}
          onFocus={() => setActive(index)} onBlur={() => setActive(null)} onPointerEnter={() => setActive(index)}
          onPointerLeave={() => setActive(null)} onClick={() => setActive(index)} onKeyDown={(event) => { if (event.key === 'Escape') setActive(null); }}>
          <i style={{ background: segment.fill }} /><span>{segment.label}</span><b>{percent.format(segment.share)}%</b>
        </button>
      </li>)}
    </ul>}
    <div className="report-donut-note" aria-live="polite">{selected
      ? variation(selected.value, hasComparison ? selected.previous : undefined, 'vs. período anterior')
      : total > 0 ? 'Passe o mouse ou selecione uma categoria.' : ''}</div>
    {corrections.length > 0 && <details className="report-chart-data"><summary>Ver estornos e correções</summary>
      <ul>{corrections.map((row) => <li key={row.label}>{row.label} · {money(row.value)}</li>)}</ul>
    </details>}
  </ChartPanel>;
}

export function ReportBreakdown({ title, description, rows, color }: { title: string; description: string; rows: ReportCategory[]; color: string }) {
  const max = Math.max(0, ...rows.map(({ value }) => Math.abs(value)));
  return <ChartPanel title={title} description={description}>
    {max === 0 ? <p className="report-empty-inline">Sem valores no período.</p> : <ul className="report-breakdown">
      {rows.map((row) => <li key={row.label}>
        <div><span>{row.label}</span><strong>{money(row.value)}</strong></div>
        <div className="report-breakdown-track" aria-hidden="true"><i style={{ width: `${Math.abs(row.value) / max * 100}%`, background: color }} /></div>
      </li>)}
    </ul>}
  </ChartPanel>;
}
