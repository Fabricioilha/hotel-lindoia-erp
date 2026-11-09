import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FinanceMetric } from '../../components/finance/FinanceMetric';
import { FinanceOverviewCards } from '../../components/finance/FinanceOverviewCards';
import { FinancePeriodFilter } from '../../components/finance/FinancePeriodFilter';
import { financeOverview, type FinanceRange } from '../../services/financeOverview';
import { financeDateKeyFromTimestamp, financeDateLabel, financeMonthRange, financeMoney, isFinanceDateKey } from '../../services/financePayments';
import { subscribeFinance } from '../../services/financeStore';
import { formatBRL as money } from '../../services/money';
import { subscribeOyoClosings, type OyoClosingRecords } from '../../services/oyoReconciliation';
import type { FinanceData } from '../../types/finance';
import './financeiro.css';

type Timeline = ReturnType<typeof financeOverview>['timeline'];
type Breakdown = { label: string; value: number }[];
const axisMoney = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 2 });
const shortDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const pointLabel = (point: Timeline[number]) => point.from === point.to ? financeDateLabel(point.from)
  : `${financeDateLabel(point.from)} a ${financeDateLabel(point.to)}`;

function CashChart({ points }: { points: Timeline }) {
  const values = points.flatMap(({ incoming, outgoing }) => [incoming, outgoing]);
  const highest = Math.max(0, ...values);
  const lowest = Math.min(0, ...values);
  const width = 860;
  const height = 250;
  const left = 78;
  const right = 18;
  const top = 15;
  const bottom = 32;
  const plotHeight = height - top - bottom;
  const band = (width - left - right) / Math.max(points.length, 1);
  const bar = Math.min(24, band * .32);
  const y = (value: number) => top + ((highest - value) * plotHeight) / (highest - lowest || 1);
  const tickStep = Math.max(1, Math.ceil((points.length - 1) / 5));
  const ticks = Array.from({ length: 5 }, (_, i) => lowest + (highest - lowest) * i / 4);

  return <section className="finance-panel finance-chart-wide">
    <div className="finance-panel-heading"><div><h2>Movimento de caixa e banco</h2><p>Recebimentos e pagamentos nas datas lançadas no ERP.</p></div></div>
    {highest === lowest ? <p className="finance-empty-inline">Nenhum movimento de caixa ou banco neste período.</p> : <>
      <div className="finance-chart-legend"><span className="finance-chart-incoming">Entradas</span><span className="finance-chart-outgoing">Saídas</span></div>
      <div className="finance-chart-scroll">
        <svg className="finance-movement-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Gráfico de barras comparando entradas e saídas ao longo do período">
          {ticks.map((tick, i) => <g key={i}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} />
            <text x={left - 9} y={y(tick)} textAnchor="end" dominantBaseline="middle">R$ {axisMoney.format(tick)}</text>
          </g>)}
          <line className="finance-chart-baseline" x1={left} x2={width - right} y1={y(0)} y2={y(0)} />
          {points.map((point, index) => {
            const center = left + band * (index + .5);
            return <g key={point.from}>
              <title>{`${pointLabel(point)} · Entradas ${money(point.incoming)} · Saídas ${money(point.outgoing)}`}</title>
              <rect className="finance-chart-incoming" x={center - bar - 1} width={bar} y={Math.min(y(0), y(point.incoming))} height={Math.abs(y(point.incoming) - y(0))} rx="2" />
              <rect className="finance-chart-outgoing" x={center + 1} width={bar} y={Math.min(y(0), y(point.outgoing))} height={Math.abs(y(point.outgoing) - y(0))} rx="2" />
              {(index === points.length - 1 || (index % tickStep === 0 && points.length - 1 - index >= tickStep / 2)) &&
                <text x={center} y={height - 10} textAnchor="middle">{shortDate(point.from)}</text>}
            </g>;
          })}
        </svg>
      </div>
      <details className="finance-chart-data"><summary>Ver valores do gráfico</summary>
        <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Data ou intervalo</th><th className="numeric">Entradas</th><th className="numeric">Saídas</th></tr></thead>
          <tbody>{points.map((point) => <tr key={point.from}><td>{pointLabel(point)}</td><td className="numeric">{money(point.incoming)}</td><td className="numeric">{money(point.outgoing)}</td></tr>)}</tbody>
        </table></div>
      </details>
    </>}
  </section>;
}

function BreakdownChart({ title, description, rows, tone }: { title: string; description: string; rows: Breakdown; tone: string }) {
  const max = Math.max(0, ...rows.map((row) => Math.abs(row.value)));
  return <section className={`finance-panel finance-breakdown-chart ${tone}`}>
    <div className="finance-panel-heading"><div><h2>{title}</h2><p>{description}</p></div></div>
    {max === 0 ? <p className="finance-empty-inline">Nenhum valor registrado neste período.</p> : <ul className="finance-breakdown-list">
      {rows.map((row) => <li key={row.label}>
        <div><span>{row.label}</span><strong>{money(row.value)}</strong></div>
        <div className="finance-breakdown-track" aria-hidden="true"><span className={row.value < 0 ? 'finance-breakdown-negative' : undefined} style={{ width: `${Math.abs(row.value) / max * 100}%` }} /></div>
      </li>)}
    </ul>}
  </section>;
}

export function RelatoriosFinanceiros() {
  const today = financeDateKeyFromTimestamp(new Date().toISOString());
  const [params, setParams] = useSearchParams();
  const from = params.get('de') ?? '';
  const to = params.get('ate') ?? '';
  const range = isFinanceDateKey(from) && isFinanceDateKey(to) && from <= to ? { from, to } : financeMonthRange(today.slice(0, 7));
  const [data, setData] = useState<FinanceData | null>(null);
  const [error, setError] = useState('');
  const [closings, setClosings] = useState<OyoClosingRecords | null>(null);
  const [oyoReadError, setOyoReadError] = useState('');

  useEffect(() => subscribeFinance((next) => { setData(next); setError(''); }, (cause) => setError(cause.message)), []);
  useEffect(() => subscribeOyoClosings((next) => { setClosings(next); setOyoReadError(''); },
    () => setOyoReadError('Não foi possível consultar os fechamentos da OYO.')), []);

  function changePeriod(next: FinanceRange) {
    setParams({ de: next.from, ate: next.to });
  }

  const overview = data ? financeOverview(data, range, today) : null;
  const expenseRows = overview?.expenseCategories.slice(0, 7) ?? [];
  if (overview && overview.expenseCategories.length > 7) {
    expenseRows.push({ label: 'Demais categorias', value: financeMoney(overview.expenseCategories.slice(7).reduce((sum, row) => sum + row.value, 0)) });
  }

  return <div className="finance-page cash-flow-page finance-reports-page">
    <header className="finance-header">
      <Link to="/" className="finance-brand"><span className="finance-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>GESTÃO FINANCEIRA</small></span></Link>
      <nav aria-label="Módulos financeiros"><Link to="/financeiro/caixa">Fluxo de caixa</Link><Link to="/financeiro/relatorios" className="finance-nav-active" aria-current="page">Relatórios e gráficos</Link></nav>
    </header>
    <main className="finance-content">
      <div className="finance-page-heading">
        <div><p className="finance-eyebrow">GESTÃO <span>/</span> FINANCEIRO</p><h1>Relatórios e gráficos</h1><p>Acompanhe os recebimentos, as vendas e as despesas registradas no hotel.</p></div>
        {overview && <span className="finance-report-cutoff">Movimentos até {financeDateLabel(overview.asOf)}</span>}
      </div>
      <FinancePeriodFilter key={`${range.from}:${range.to}`} range={range} today={today} onChange={changePeriod} />
      {error && <p className="finance-alert" role="alert">Não foi possível atualizar os lançamentos. {error}</p>}
      {!overview && !error && <p className="finance-empty" role="status">Carregando relatórios financeiros...</p>}
      {overview && <>
        <section className="finance-metrics finance-report-totals" aria-label="Totais do período">
          <FinanceMetric label="Entradas em caixa e banco" value={money(overview.received)} detail="Recebimentos e repasses da OYO" tone="green"
            help="Soma recebimentos diretos e repasses da OYO. Pré-pagos retidos pela OYO e transferências entre caixa e banco ficam fora deste total." />
          <FinanceMetric label="Saídas de caixa e banco" value={money(overview.outflow)} detail="Pagamentos feitos no período" tone="coral"
            help="Soma as despesas e a folha pagas com caixa ou banco e os pagamentos enviados à OYO. Compensações com valores retidos pela OYO aparecem nas despesas pagas." />
          <FinanceMetric label="Despesas pagas" value={money(overview.expensesPaid)} detail={`${money(overview.compensated)} compensados pela OYO`} tone="navy"
            help="Soma as despesas e a folha pagas no período, incluindo compensações com valores retidos pela OYO. As datas dos pagamentos determinam o período." />
        </section>
        <div className="finance-report-charts">
          <CashChart points={overview.timeline} />
          <BreakdownChart title="Recebimentos por forma de pagamento" description="Pagamentos diretos e repasses efetivamente registrados." tone="is-income" rows={[
            { label: 'Dinheiro', value: overview.methods.cash }, { label: 'Crédito', value: overview.methods.credit }, { label: 'Débito', value: overview.methods.debit },
            { label: 'Pix', value: overview.methods.pix }, { label: 'Transferência bancária', value: overview.methods.bankTransfer }, { label: 'Repasses da OYO', value: overview.repasses },
          ]} />
          <BreakdownChart title="Vendas por tipo" description="Vendas da Geladeira e recebimentos de café e extras." tone="is-sales" rows={[
            { label: 'Geladeira', value: overview.sales.geladeira }, { label: 'Café da manhã', value: overview.sales.breakfast }, { label: 'Extras', value: overview.sales.extras },
          ]} />
          <BreakdownChart title="Despesas pagas por categoria" description="Inclui folha e despesas compensadas pela OYO." tone="is-expense" rows={expenseRows} />
        </div>
        {data && <details className="finance-panel finance-report-detail">
          <summary>Ver indicadores detalhados do período</summary>
          <FinanceOverviewCards data={data} overview={overview} closings={closings} oyoReadError={oyoReadError} />
        </details>}
      </>}
      <footer className="finance-page-footer"><span>Hotel Lindoia</span><span>Relatórios financeiros</span></footer>
    </main>
  </div>;
}
