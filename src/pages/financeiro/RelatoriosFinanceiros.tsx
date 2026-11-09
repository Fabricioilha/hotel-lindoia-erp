import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FinanceMetric, FinanceMetricSkeleton } from '../../components/finance/FinanceMetric';
import { FinanceOverviewCards } from '../../components/finance/FinanceOverviewCards';
import { ExpenseDonut, ReportBreakdown, ReportTimeline } from '../../components/finance/ReportCharts';
import { DateInput } from '../../components/ui/DateInput';
import { exportCsv } from '../../services/financeCsv';
import type { FinanceRange } from '../../services/financeOverview';
import { financeDateKeyFromTimestamp, financeDateLabel, financeMonthRange, isFinanceDateKey, type FinanceGranularity } from '../../services/financePayments';
import { financeReport, previousReportMonth, reportChange, reportDays, reportOccupancy, shiftReportDay, type ReportMode } from '../../services/financeReports';
import { subscribeFinance } from '../../services/financeStore';
import { subscribeRoomDirectory } from '../../services/housekeepingStore';
import { formatBRL as money } from '../../services/money';
import { subscribeOyoClosings, type OyoClosingRecords } from '../../services/oyoReconciliation';
import { subscribeReceptionRooms } from '../../services/receptionStore';
import type { FinanceData } from '../../types/finance';
import type { HousekeepingRoom } from '../../types/housekeeping';
import type { ReceptionRoom } from '../../types/reception';
import './financeiro.css';
import './relatorios.css';

const MAX_DAILY_DAYS = 92;
const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const rangeLabel = ({ from, to }: FinanceRange) => `${financeDateLabel(from)} a ${financeDateLabel(to)}`;
const sameRange = (a: FinanceRange, b: FinanceRange) => a.from === b.from && a.to === b.to;
const chartColors = { revenue: 'var(--report-revenue)', expenses: 'var(--report-expense)', income: 'var(--report-income)' };

const iconPaths = {
  revenue: 'M3 17l6-6 4 4 7-8M15 7h5v5',
  result: 'M12 3v18m4-13H9.5a2.5 2.5 0 000 5h5a2.5 2.5 0 010 5H7',
  expense: 'M4 7h16M4 12h16M4 17h10m3-1 2 2 3-4',
  download: 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4',
  print: 'M6 9V3h12v6M6 17H4V9h16v8h-2M6 14h12v7H6zM17 12h.01',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v5m8-5v5',
};

function ReportIcon({ name }: { name: keyof typeof iconPaths }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

function Segments<T extends string>({ label, options, value, onChange }: {
  label: string; options: { id: T; label: string; disabled?: boolean }[]; value: T | ''; onChange: (id: T) => void;
}) {
  return <div className="report-segments inline-flex flex-wrap items-center gap-1 rounded-xl p-1" role="group" aria-label={label}>
    {options.map((option) => <button key={option.id} type="button" aria-pressed={value === option.id} disabled={option.disabled}
      title={option.disabled ? `A visão diária está disponível para intervalos de até ${MAX_DAILY_DAYS} dias.` : undefined}
      onClick={() => onChange(option.id)}>{option.label}</button>)}
  </div>;
}

function CustomPeriod({ range, onChange }: { range: FinanceRange; onChange: (next: FinanceRange) => void }) {
  const [draft, setDraft] = useState(range);
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isFinanceDateKey(draft.from) || !isFinanceDateKey(draft.to) || draft.from < '1900-01-01' || draft.from > draft.to) {
      setError('Confira as datas. A data inicial deve vir antes da data final ou coincidir com ela.');
      return;
    }
    onChange(draft);
  }
  return <form className="report-custom-period flex flex-wrap items-end gap-3" onSubmit={submit} aria-label="Período personalizado">
    <label className="finance-month"><span>Data inicial</span><DateInput name="reportFrom" value={draft.from} min="1900-01-01" onValueChange={(from) => setDraft((current) => ({ ...current, from }))} required /></label>
    <label className="finance-month"><span>Data final</span><DateInput name="reportTo" value={draft.to} min={draft.from || '1900-01-01'} onValueChange={(to) => setDraft((current) => ({ ...current, to }))} required /></label>
    <button type="submit" className="report-button report-button-primary">Aplicar período</button>
    {error && <p className="finance-alert w-full" role="alert">{error}</p>}
  </form>;
}

function ChartSkeleton({ donut = false, rows }: { donut?: boolean; rows?: number }) {
  return <div className="report-surface report-chart-card min-w-0 rounded-2xl border p-4 shadow-sm sm:p-6" aria-hidden="true">
    <span className="report-skeleton h-5 w-40 rounded" /><span className="report-skeleton mt-2 h-3 w-3/4 rounded" />
    {rows ? <div className="report-skeleton-breakdown mt-6 grid gap-3">{Array.from({ length: rows }, (_, index) => <span className="report-skeleton h-4 rounded" key={index} />)}</div>
      : donut ? <><div className="report-donut-plot"><span className="report-skeleton report-skeleton-ring" /></div>
      <div className="grid gap-3">{Array.from({ length: 6 }, (_, index) => <span className="report-skeleton h-4 rounded" key={index} />)}</div></>
      : <div className="report-skeleton-plot" />}
  </div>;
}

function metricTrend(change: number | null, comparison: string, { lessIsBetter = false } = {}) {
  const direction = change === null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  const sentiment = direction === 'flat' ? 'neutral' : (direction === 'up') !== lessIsBetter ? 'good' : 'bad';
  return { direction, sentiment, comparison, value: change === null ? 'Sem base' : `${change > 0 ? '+' : ''}${pct.format(change)}%` } as const;
}

export function RelatoriosFinanceiros() {
  const today = financeDateKeyFromTimestamp(new Date().toISOString());
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<FinanceData | null>(null);
  const [error, setError] = useState('');
  const [rooms, setRooms] = useState<Record<string, HousekeepingRoom> | null>(null);
  const [receptionRooms, setReceptionRooms] = useState<Record<string, ReceptionRoom> | null>(null);
  const [closings, setClosings] = useState<OyoClosingRecords | null>(null);
  const [oyoReadError, setOyoReadError] = useState('');
  const [customOpen, setCustomOpen] = useState(false);

  useEffect(() => {
    const stops = [
      subscribeFinance((next) => { setData(next); setError(''); }, (cause) => setError(cause.message), { includeAudit: false }),
      subscribeRoomDirectory(setRooms, () => undefined),
      subscribeReceptionRooms(setReceptionRooms, () => undefined),
      subscribeOyoClosings((next) => { setClosings(next); setOyoReadError(''); },
        () => setOyoReadError('Não foi possível consultar os fechamentos da OYO.')),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  const month = financeMonthRange(today.slice(0, 7));
  const presets = [
    { id: 'current', label: 'Mês atual', range: month },
    { id: 'previous', label: 'Mês anterior', range: previousReportMonth(today) },
    { id: 'quarter', label: 'Últimos 90 dias', range: { from: shiftReportDay(today, -89), to: today } },
  ];
  const from = params.get('de') ?? '';
  const to = params.get('ate') ?? '';
  const range = isFinanceDateKey(from) && isFinanceDateKey(to) && from >= '1900-01-01' && from <= to ? { from, to } : month;
  const preset = presets.find((option) => sameRange(range, option.range));
  const mode: ReportMode = params.get('visao') === 'caixa' ? 'cash' : 'performance';
  const cash = mode === 'cash';
  const canShowDaily = reportDays(range) <= MAX_DAILY_DAYS;
  const grouping = params.get('agrupar');
  const granularity: FinanceGranularity = !canShowDaily || grouping === 'mes' || (grouping !== 'dia' && reportDays(range) > 31) ? 'month' : 'day';
  const report = useMemo(() => data ? financeReport(data, { from: range.from, to: range.to }, today, granularity) : null, [data, range.from, range.to, today, granularity]);
  const roomNumbers = useMemo(() => rooms && receptionRooms ? new Set([...Object.values(rooms), ...Object.values(receptionRooms)].map(({ number }) => number.trim()).filter(Boolean)) : null, [rooms, receptionRooms]);
  const occupancy = useMemo(() => data && report && roomNumbers ? reportOccupancy(data, roomNumbers, report.effective) : null, [data, report, roomNumbers]);
  const previousOccupancy = useMemo(() => data && report?.comparison && roomNumbers ? reportOccupancy(data, roomNumbers, report.comparison.range) : null, [data, report, roomNumbers]);
  const comparisonLabel = report?.comparison?.label ?? 'Sem período comparável';
  const current = report?.current;
  const previous = report?.previous;
  const overview = current?.overview;
  const categories = (cash ? overview?.expenseCategories : current?.registeredCategories) ?? [];
  const previousCategories = (cash ? previous?.overview.expenseCategories : previous?.registeredCategories) ?? [];
  const revenueAmount = cash ? overview?.received : current?.revenue;
  const previousRevenue = cash ? previous?.overview.received : previous?.revenue;
  const resultAmount = cash ? current?.cashResult : current?.profit;
  const previousResult = cash ? previous?.cashResult : previous?.profit;
  const expenseAmount = cash ? overview?.expensesPaid : overview?.expenses;
  const previousExpenses = cash ? previous?.overview.expensesPaid : previous?.overview.expenses;

  function changePeriod(next: FinanceRange) {
    setParams((current) => { const query = new URLSearchParams(current); query.set('de', next.from); query.set('ate', next.to); return query; });
    setCustomOpen(false);
  }

  function setReportOption(key: string, value: string) {
    setParams((current) => { const query = new URLSearchParams(current); query.set(key, value); return query; }, { replace: true });
  }

  function download() {
    if (!report || !current) return;
    exportCsv(`hotel-lindoia-relatorio-${mode}-${range.from}-${range.to}.csv`, [
      ['Hotel Lindoia', cash ? 'Movimento de caixa' : 'Desempenho financeiro'],
      ['Período selecionado', range.from, range.to],
      ['Dados até', report.effective.to],
      ['Base de comparação', report.comparison?.range.from ?? '', report.comparison?.range.to ?? ''],
      [],
      ['Indicador', 'Período atual', 'Período anterior'],
      [cash ? 'Entradas em caixa e banco (R$)' : 'Receita total (R$)', revenueAmount ?? '', previousRevenue ?? ''],
      [cash ? 'Resultado de caixa (R$)' : 'Lucro estimado (R$)', resultAmount ?? '', previousResult ?? ''],
      ['Taxa de ocupação (%)', occupancy?.rate ?? '', previousOccupancy?.rate ?? ''],
      [cash ? 'Despesas pagas (R$)' : 'Despesas registradas (R$)', expenseAmount ?? '', previousExpenses ?? ''],
      [],
      ['Início', 'Fim', ...(cash ? ['Entradas (R$)', 'Saídas (R$)'] : ['Faturamento (R$)', 'Despesas registradas (R$)'])],
      ...current.points.map((point) => [point.from, point.to, ...(cash ? [point.incoming, point.outgoing] : [point.revenue, point.expenses])]),
      [],
      ['Categoria de despesa', 'Valor (R$)'],
      ...[...categories].sort((a, b) => b.value - a.value).map((row) => [row.label, row.value]),
    ], true);
  }

  const revenueSeries = cash ? { key: 'incoming', label: 'Entradas', color: chartColors.income } as const
    : { key: 'revenue', label: 'Faturamento', color: chartColors.revenue } as const;
  const comparisonSeries = cash ? [revenueSeries, { key: 'outgoing', label: 'Saídas', color: chartColors.expenses }] as const
    : [revenueSeries, { key: 'expenses', label: 'Despesas', color: chartColors.expenses }] as const;

  return <div className="finance-page cash-flow-page finance-reports-page">
    <header className="finance-header">
      <Link to="/" className="finance-brand"><span className="finance-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>GESTÃO FINANCEIRA</small></span></Link>
      <nav aria-label="Módulos financeiros"><Link to="/financeiro/caixa">Fluxo de caixa</Link><Link to="/financeiro/relatorios" className="finance-nav-active" aria-current="page">Relatórios e gráficos</Link></nav>
    </header>
    <main className="finance-content report-content">
      <header className="report-intro flex flex-wrap items-end justify-between gap-5">
        <div><p className="report-kicker">GESTÃO FINANCEIRA</p><h1>Relatórios e gráficos</h1><p>Faturamento e despesas do Hotel Lindoia.</p></div>
        <div className="report-actions flex flex-wrap items-center gap-2">
          <button type="button" className="report-button" disabled={!report} onClick={() => window.print()}><ReportIcon name="print" />Exportar PDF</button>
          <button type="button" className="report-button report-button-primary" disabled={!report} onClick={download}><ReportIcon name="download" />Exportar CSV</button>
        </div>
      </header>
      <div className="report-surface report-toolbar rounded-2xl border p-3 shadow-sm sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segments label="Período" value={customOpen ? 'custom' : preset?.id ?? 'custom'}
            options={[...presets, { id: 'custom', label: 'Personalizado' }]} onChange={(id) => {
              if (id === 'custom') setCustomOpen((open) => !open);
              else changePeriod(presets.find((item) => item.id === id)!.range);
            }} />
          <div className="flex flex-wrap items-center gap-2">
            <Segments label="Tipo de relatório" value={mode} options={[{ id: 'performance', label: 'Desempenho' }, { id: 'cash', label: 'Caixa' }]}
              onChange={(value) => setReportOption('visao', value === 'cash' ? 'caixa' : 'desempenho')} />
            <Segments label="Agrupamento do gráfico" value={granularity} options={[{ id: 'day', label: 'Diário', disabled: !canShowDaily }, { id: 'month', label: 'Mensal' }]}
              onChange={(value) => setReportOption('agrupar', value === 'month' ? 'mes' : 'dia')} />
          </div>
        </div>
        {customOpen && <CustomPeriod key={range.from + range.to} range={range} onChange={changePeriod} />}
      </div>
      <div className="report-context flex flex-wrap items-center gap-x-4 gap-y-1" aria-live="polite">
        <span><ReportIcon name="calendar" />{rangeLabel(range)}</span>
        {report && <small>{report.effective.to < report.effective.from ? 'Período futuro' : `Dados até ${financeDateLabel(report.effective.to)}`}</small>}
        {report?.comparison && <small>Comparação com {rangeLabel(report.comparison.range)}</small>}
      </div>
      {error && <p className="finance-alert" role="alert">Não foi possível atualizar os lançamentos. {error}</p>}
      <div className="report-results" aria-busy={!current && !error}>
        {!current && !error && <p className="sr-only" role="status">Carregando relatórios financeiros</p>}
        <section className="report-hero-grid grid gap-3" aria-label="Indicadores do período">
          {!current ? Array.from({ length: cash ? 3 : 2 }, (_, index) => <FinanceMetricSkeleton key={index} />) : <>
            <FinanceMetric label={cash ? 'Entradas em caixa e banco' : 'Receita total'} value={money(revenueAmount ?? 0)} tone="green" icon={<ReportIcon name="revenue" />}
              detail={cash ? 'Recebimentos e repasses da OYO' : 'Pela data do serviço ou lançamento'}
              help={cash ? 'Inclui recebimentos diretos e repasses da OYO nas datas registradas no caixa e banco.' : 'Inclui a parte do hotel nos pré-pagos. As taxas da OYO ficam fora do faturamento do hotel.'}
              trend={metricTrend(reportChange(revenueAmount ?? 0, previousRevenue ?? null), comparisonLabel)} />
            {cash && <FinanceMetric label="Resultado de caixa" value={money(resultAmount ?? 0)} tone="navy" icon={<ReportIcon name="result" />}
              detail="Entradas − saídas + ajustes" negative={(resultAmount ?? 0) < 0}
              help="Diferença entre entradas e saídas de caixa e banco, acrescida dos ajustes do caixa físico."
              trend={metricTrend(reportChange(resultAmount ?? 0, previousResult ?? null), comparisonLabel)} />}
            <FinanceMetric label={cash ? 'Despesas pagas' : 'Despesas registradas'} value={money(expenseAmount ?? 0)} tone="coral" icon={<ReportIcon name="expense" />}
              detail={cash ? 'Inclui compensações da OYO' : 'Compras, contas e folha do período'}
              help={cash ? 'Soma pagamentos de despesas e folha no período, inclusive compensações com retidos da OYO.' : 'Compras no cartão entram na data da compra. As outras contas e a folha entram pelo vencimento.'}
              trend={metricTrend(reportChange(expenseAmount ?? 0, previousExpenses ?? null), comparisonLabel, { lessIsBetter: true })} />
          </>}
        </section>
        <div className="report-chart-grid grid gap-4" data-ready={Boolean(current)}>
          {!current || !overview ? <><ChartSkeleton /><ChartSkeleton donut /><div className="report-wide"><ChartSkeleton /></div>
            <div className="report-wide grid grid-cols-1 gap-4 lg:grid-cols-2"><ChartSkeleton rows={6} /><ChartSkeleton rows={3} /></div></> : <>
            <ReportTimeline key={mode + granularity + range.from + range.to} title={cash ? 'Entradas no período' : 'Faturamento do período'}
              description={cash ? 'Recebimentos e repasses pelas datas registradas.' : 'Receita do hotel pela data do serviço ou lançamento.'}
              points={current.points} series={[revenueSeries]} kind="area" granularity={granularity} total={revenueAmount} />
            <ExpenseDonut key={mode + range.from + range.to} title="Despesas por categoria" description={cash ? 'Distribuição dos pagamentos efetuados.' : 'Distribuição das despesas registradas.'}
              rows={categories} previous={previousCategories} hasComparison={Boolean(previous)} />
            <div className="report-wide">
              <ReportTimeline key={mode + granularity + range.from + range.to} title={cash ? 'Entradas e saídas' : 'Receitas e despesas'}
                description={cash ? 'Movimentações do caixa físico e do banco.' : 'Faturamento e despesas registradas no mesmo intervalo.'}
                points={current.points} series={[...comparisonSeries]} kind="bars" granularity={granularity} />
            </div>
            <div className="report-wide grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ReportBreakdown title="Recebimentos por forma de pagamento" description="Pagamentos diretos e repasses registrados." color={chartColors.income} rows={[
                { label: 'Dinheiro', value: overview.methods.cash }, { label: 'Crédito', value: overview.methods.credit }, { label: 'Débito', value: overview.methods.debit },
                { label: 'Pix', value: overview.methods.pix }, { label: 'Transferência bancária', value: overview.methods.bankTransfer }, { label: 'Repasses da OYO', value: overview.repasses },
              ]} />
              <ReportBreakdown title="Vendas por tipo" description="Geladeira e recebimentos de café e extras." color={chartColors.revenue} rows={[
                { label: 'Geladeira', value: overview.sales.geladeira }, { label: 'Café da manhã', value: overview.sales.breakfast }, { label: 'Extras', value: overview.sales.extras },
              ]} />
            </div>
          </>}
        </div>
        {data && overview && <details className="report-surface finance-report-detail rounded-2xl border p-4 shadow-sm sm:p-6">
          <summary>Ver indicadores detalhados do período</summary>
          <FinanceOverviewCards data={data} overview={overview} closings={closings} oyoReadError={oyoReadError} />
        </details>}
      </div>
      <footer className="finance-page-footer"><span>Hotel Lindoia</span><span>Relatórios financeiros</span></footer>
    </main>
  </div>;
}
