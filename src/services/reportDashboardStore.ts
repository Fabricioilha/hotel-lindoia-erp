import {
  CHART_PALETTES,
  CHART_DIMENSIONS,
  CHART_TYPES,
  DEFAULT_CHART_STYLE,
  type ChartDimension,
  type ChartPaletteId,
  type ChartSeriesConfig,
  type ChartStyleConfig,
  type ChartType,
  type ChartWidgetConfig,
  type OperationalSourceKey,
  type ReportDashboardTab,
  type ReportDashboardsConfig,
} from '../types/reportCharts';
import { db, onValue, ref, set } from './pocketbaseRealtime';
import { requiredSourcesForMetrics } from './reportMetricsCatalog';

const CONFIG_PATH = 'erp_geral/financeiro/reportDashboards';
const LOCAL_CACHE_KEY = 'hotel-lindoia:report-dashboards:v1';

const VALID_TYPES = new Set<ChartType>(CHART_TYPES.map((t) => t.id));
const VALID_DIMENSIONS = new Set<ChartDimension>(CHART_DIMENSIONS.map((d) => d.id));
const VALID_PALETTES = new Set<ChartPaletteId>(CHART_PALETTES.map((p) => p.id));

function styleWith(patch: Partial<ChartStyleConfig> = {}): ChartStyleConfig {
  return { ...DEFAULT_CHART_STYLE, ...patch };
}

export function createDefaultDashboards(): ReportDashboardTab[] {
  return [
    {
      id: 'visao-geral',
      name: 'Visão geral',
      widgets: [
        {
          id: 'w-evolucao-financeira',
          title: 'Evolução financeira',
          description: 'Faturamento, despesas registradas e lucro líquido estimado ao longo do período.',
          chartType: 'composed',
          dimension: 'timeline',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-rev', metricId: 'revenue', label: 'Faturamento', color: '#4c60cf', visualType: 'bar' },
            { id: 's-exp', metricId: 'expenses_registered', label: 'Despesas', color: '#bd624a', visualType: 'bar' },
            { id: 's-prof', metricId: 'profit_estimated', label: 'Lucro estimado', color: '#147d6b', visualType: 'line' },
          ],
          style: styleWith({ paletteId: 'hotel', showGrid: true }),
        },
        {
          id: 'w-despesas-categoria',
          title: 'Despesas por categoria',
          description: 'Participação de cada categoria de despesa no período.',
          chartType: 'donut',
          dimension: 'expense_category',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-cat', metricId: 'expenses_registered', label: 'Despesas registradas', color: '#bd624a' },
          ],
          style: styleWith({ paletteId: 'hotel', topN: 6 }),
        },
        {
          id: 'w-fluxo-caixa',
          title: 'Entradas e saídas de caixa',
          description: 'Recebimentos efetivos em caixa e banco versus despesas pagas no período.',
          chartType: 'bar',
          dimension: 'timeline',
          size: 'full',
          height: 'normal',
          series: [
            { id: 's-in', metricId: 'received', label: 'Entradas', color: '#147d6b' },
            { id: 's-out', metricId: 'expenses_paid', label: 'Despesas pagas', color: '#bd624a' },
            { id: 's-res', metricId: 'cash_result', label: 'Resultado de caixa', color: '#4c60cf' },
          ],
          style: styleWith({ paletteId: 'hotel' }),
        },
        {
          id: 'w-recebimentos-forma',
          title: 'Recebimentos por forma de pagamento',
          description: 'Distribuição dos pagamentos diretos e repasses registrados.',
          chartType: 'breakdown',
          dimension: 'payment_method',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-pay', metricId: 'received', label: 'Recebido', color: '#147d6b' },
          ],
          style: styleWith({ paletteId: 'emerald', topN: 8 }),
        },
        {
          id: 'w-receita-canal',
          title: 'Faturamento por canal',
          description: 'Comparativo entre hospedagens OYO, Balcão/Direto e Rotativo.',
          chartType: 'horizontal_bar',
          dimension: 'channel',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-ch', metricId: 'revenue', label: 'Faturamento', color: '#4c60cf' },
          ],
          style: styleWith({ paletteId: 'ocean', showValues: true }),
        },
      ],
    },
    {
      id: 'oyo-taxas',
      name: 'OYO & Taxas',
      widgets: [
        {
          id: 'w-oyo-retido-balcao',
          title: 'Retenção OYO, Taxa no Balcão e Repasses',
          description: 'Quanto a OYO reteve em pré-pagos, quanta taxa foi cobrada no balcão e os repasses recebidos.',
          chartType: 'bar',
          dimension: 'timeline',
          size: 'full',
          height: 'normal',
          series: [
            { id: 's-ret', metricId: 'oyo_retained', label: 'Retido pela OYO (pré-pago)', color: '#4f46e5' },
            { id: 's-cnt', metricId: 'oyo_counter_fees', label: 'Taxa paga no balcão', color: '#ea580c' },
            { id: 's-rep', metricId: 'oyo_repasses', label: 'Repasses recebidos', color: '#147d6b' },
            { id: 's-cmp', metricId: 'oyo_compensated', label: 'Compensado pela OYO', color: '#a37a36' },
          ],
          style: styleWith({ paletteId: 'hotel', showGrid: true }),
        },
        {
          id: 'w-oyo-kpis',
          title: 'Resumo de taxas e retenções no período',
          description: 'Indicadores consolidados de OYO e taxas da máquina de cartão com comparação ao período anterior.',
          chartType: 'kpi',
          dimension: 'timeline',
          size: 'full',
          height: 'compact',
          series: [
            { id: 's-k-ret', metricId: 'oyo_retained', label: 'Retido pela OYO', color: '#4f46e5' },
            { id: 's-k-cnt', metricId: 'oyo_counter_fees', label: 'Taxa OYO no balcão', color: '#ea580c' },
            { id: 's-k-card', metricId: 'card_fees', label: 'Taxas máquina cartão', color: '#d97706' },
            { id: 's-k-rep', metricId: 'oyo_repasses', label: 'Repasses OYO', color: '#147d6b' },
          ],
          style: styleWith({ paletteId: 'hotel', showComparison: true }),
        },
        {
          id: 'w-taxas-cartao',
          title: 'Taxas da máquina de cartão ao longo do tempo',
          description: 'Custo das taxas de crédito e débito descontadas no período.',
          chartType: 'area',
          dimension: 'timeline',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-cf', metricId: 'card_fees', label: 'Taxas de cartão', color: '#d97706' },
          ],
          style: styleWith({ paletteId: 'terracotta', fillStyle: 'gradient' }),
        },
        {
          id: 'w-taxa-balcao-forma',
          title: 'Taxa OYO no balcão por forma de pagamento',
          description: 'Como os hóspedes pagaram as taxas no balcão (Dinheiro, Pix, Cartão).',
          chartType: 'donut',
          dimension: 'payment_method',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-cf-m', metricId: 'oyo_counter_fees', label: 'Taxa no balcão', color: '#ea580c' },
          ],
          style: styleWith({ paletteId: 'terracotta', topN: 6 }),
        },
      ],
    },
    {
      id: 'lucratividade',
      name: 'Café & Geladeira',
      widgets: [
        {
          id: 'w-geladeira-lucro',
          title: 'Lucro da geladeira (Receita vs CMV vs Lucro)',
          description: 'Receita de vendas, custo dos produtos vendidos (CMV) e lucro estimado no período.',
          chartType: 'composed',
          dimension: 'timeline',
          size: 'full',
          height: 'normal',
          series: [
            { id: 's-fr-rev', metricId: 'fridge_revenue', label: 'Receita', color: '#2563eb', visualType: 'bar' },
            { id: 's-fr-cmv', metricId: 'fridge_cogs', label: 'Custo (CMV)', color: '#bd624a', visualType: 'bar' },
            { id: 's-fr-luc', metricId: 'fridge_profit', label: 'Lucro', color: '#059669', visualType: 'line' },
          ],
          style: styleWith({ paletteId: 'emerald' }),
        },
        {
          id: 'w-geladeira-produtos',
          title: 'Top produtos da geladeira (Lucro vs Receita)',
          description: 'Produtos que mais geram lucro e faturamento na geladeira da recepção.',
          chartType: 'horizontal_bar',
          dimension: 'fridge_product',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-fp-luc', metricId: 'fridge_profit', label: 'Lucro (R$)', color: '#059669' },
            { id: 's-fp-rev', metricId: 'fridge_revenue', label: 'Receita (R$)', color: '#2563eb' },
          ],
          style: styleWith({ paletteId: 'emerald', topN: 8, showValues: true }),
        },
        {
          id: 'w-geladeira-reposicao',
          title: 'Vendas vs Compras de reposição da geladeira',
          description: 'Compare o faturamento da geladeira com as compras de reposição no estoque.',
          chartType: 'bar',
          dimension: 'timeline',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-fr-v', metricId: 'fridge_revenue', label: 'Vendas geladeira', color: '#2563eb' },
            { id: 's-fr-r', metricId: 'fridge_restock_cost', label: 'Compras reposição', color: '#d97706' },
          ],
          style: styleWith({ paletteId: 'ocean' }),
        },
        {
          id: 'w-cafe-lucro',
          title: 'Resultado do café da manhã',
          description: 'Receita atribuída, custos de insumos + I9 e lucro líquido do café.',
          chartType: 'composed',
          dimension: 'timeline',
          size: 'full',
          height: 'normal',
          series: [
            { id: 's-br-rev', metricId: 'breakfast_revenue', label: 'Receita', color: '#4c60cf', visualType: 'bar' },
            { id: 's-br-cost', metricId: 'breakfast_cost', label: 'Custo (Insumos + I9)', color: '#bd624a', visualType: 'bar' },
            { id: 's-br-prof', metricId: 'breakfast_profit', label: 'Lucro', color: '#147d6b', visualType: 'line' },
          ],
          style: styleWith({ paletteId: 'hotel' }),
        },
      ],
    },
    {
      id: 'operacao-camareiras',
      name: 'Operação & Camareiras',
      widgets: [
        {
          id: 'w-camareiras-desempenho',
          title: 'Desempenho das camareiras (Quartos limpos & Tempo médio)',
          description: 'Total de quartos concluídos (barras) e tempo médio em minutos (linha no eixo direito).',
          chartType: 'composed',
          dimension: 'housekeeper',
          size: 'full',
          height: 'normal',
          series: [
            { id: 's-hk-qty', metricId: 'cleaning_completed', label: 'Quartos limpos', color: '#4c60cf', visualType: 'bar', yAxis: 'left' },
            { id: 's-hk-min', metricId: 'cleaning_avg_minutes', label: 'Tempo médio (min)', color: '#d97706', visualType: 'line', yAxis: 'right' },
          ],
          style: styleWith({ paletteId: 'hotel', showValues: true }),
        },
        {
          id: 'w-limpeza-manutencao',
          title: 'Gastos: Material de limpeza vs Manutenção',
          description: 'Acompanhe categorias específicas de manutenção e limpeza (clique em Editar para trocar ou somar categorias).',
          chartType: 'bar',
          dimension: 'timeline',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-cat-limp', metricId: 'expense_by_category', label: 'Material de limpeza', color: '#0891b2', categories: ['Material de limpeza'], basis: 'accrual' },
            { id: 's-cat-man', metricId: 'expense_by_category', label: 'Manutenção', color: '#c2410c', categories: ['Manutenção'], basis: 'accrual' },
          ],
          style: styleWith({ paletteId: 'terracotta' }),
        },
        {
          id: 'w-ocupacao-faturamento',
          title: 'Ocupação (%) vs Faturamento (R$)',
          description: 'Relação entre a taxa de ocupação dos quartos e o faturamento gerado no período.',
          chartType: 'composed',
          dimension: 'timeline',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-occ-rev', metricId: 'revenue', label: 'Faturamento (R$)', color: '#4c60cf', visualType: 'bar', yAxis: 'left' },
            { id: 's-occ-pct', metricId: 'occupancy_rate', label: 'Ocupação (%)', color: '#147d6b', visualType: 'line', yAxis: 'right' },
          ],
          style: styleWith({ paletteId: 'ocean' }),
        },
        {
          id: 'w-camareiras-tempo',
          title: 'Evolução de limpezas concluídas',
          description: 'Volume de quartos limpos por dia ou mês no período.',
          chartType: 'area',
          dimension: 'timeline',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-cl-day', metricId: 'cleaning_completed', label: 'Quartos limpos', color: '#4c60cf' },
            { id: 's-cl-dw', metricId: 'cleaning_doors_windows', label: 'Portas e janelas', color: '#147d6b' },
          ],
          style: styleWith({ paletteId: 'hotel', fillStyle: 'gradient' }),
        },
        {
          id: 'w-saidas-estoque',
          title: 'Retiradas internas de estoque por setor',
          description: 'Custo estimado de insumos retirados do estoque para cada área operacional.',
          chartType: 'horizontal_bar',
          dimension: 'stock_destination',
          size: 'half',
          height: 'normal',
          series: [
            { id: 's-st-dest', metricId: 'stock_outputs_cost', label: 'Custo estimado', color: '#a37a36' },
          ],
          style: styleWith({ paletteId: 'executive', showValues: true }),
        },
      ],
    },
  ];
}

export function createDefaultConfig(): ReportDashboardsConfig {
  const dashboards = createDefaultDashboards();
  return {
    version: 1,
    activeDashboardId: dashboards[0].id,
    dashboards,
  };
}

export interface ChartTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  build: () => ChartWidgetConfig;
}

function uid(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

export const CHART_TEMPLATES: ChartTemplate[] = [
  {
    id: 'tpl-oyo-flow',
    name: 'OYO retido vs Taxa no balcão',
    category: 'OYO & Taxas',
    description: 'Analise quanto a OYO reteve em pré-pagos, taxa recebida no balcão e repasses.',
    build: () => ({
      id: uid('w'),
      title: 'OYO: Retido vs Taxa no balcão',
      description: 'Comparativo de valores retidos pela OYO, taxas pagas no balcão e repasses.',
      chartType: 'bar',
      dimension: 'timeline',
      size: 'full',
      height: 'normal',
      series: [
        { id: uid('s'), metricId: 'oyo_retained', label: 'Retido pela OYO', color: '#4f46e5' },
        { id: uid('s'), metricId: 'oyo_counter_fees', label: 'Taxa paga no balcão', color: '#ea580c' },
        { id: uid('s'), metricId: 'oyo_repasses', label: 'Repasses OYO', color: '#147d6b' },
      ],
      style: styleWith({ paletteId: 'hotel' }),
    }),
  },
  {
    id: 'tpl-cat-limpeza-manutencao',
    name: 'Material de limpeza & Manutenção',
    category: 'Categorias',
    description: 'Compare gastos em categorias específicas (você pode escolher qualquer categoria).',
    build: () => ({
      id: uid('w'),
      title: 'Material de limpeza vs Manutenção',
      description: 'Gastos registrados nas categorias selecionadas ao longo do período.',
      chartType: 'bar',
      dimension: 'timeline',
      size: 'half',
      height: 'normal',
      series: [
        { id: uid('s'), metricId: 'expense_by_category', label: 'Material de limpeza', color: '#0891b2', categories: ['Material de limpeza'], basis: 'accrual' },
        { id: uid('s'), metricId: 'expense_by_category', label: 'Manutenção', color: '#c2410c', categories: ['Manutenção'], basis: 'accrual' },
      ],
      style: styleWith({ paletteId: 'terracotta' }),
    }),
  },
  {
    id: 'tpl-geladeira-lucro',
    name: 'Lucro da geladeira',
    category: 'Geladeira',
    description: 'Receita de vendas, CMV (custo do estoque) e lucro líquido da geladeira.',
    build: () => ({
      id: uid('w'),
      title: 'Lucro da geladeira',
      description: 'Receita, custo dos produtos vendidos (CMV) e lucro estimado.',
      chartType: 'composed',
      dimension: 'timeline',
      size: 'full',
      height: 'normal',
      series: [
        { id: uid('s'), metricId: 'fridge_revenue', label: 'Receita', color: '#2563eb', visualType: 'bar' },
        { id: uid('s'), metricId: 'fridge_cogs', label: 'Custo (CMV)', color: '#bd624a', visualType: 'bar' },
        { id: uid('s'), metricId: 'fridge_profit', label: 'Lucro', color: '#059669', visualType: 'line' },
      ],
      style: styleWith({ paletteId: 'emerald' }),
    }),
  },
  {
    id: 'tpl-geladeira-top',
    name: 'Ranking de produtos da geladeira',
    category: 'Geladeira',
    description: 'Quais itens da geladeira mais dão lucro ou mais vendem.',
    build: () => ({
      id: uid('w'),
      title: 'Produtos mais lucrativos da geladeira',
      description: 'Lucro estimado e receita por produto vendido.',
      chartType: 'horizontal_bar',
      dimension: 'fridge_product',
      size: 'half',
      height: 'normal',
      series: [
        { id: uid('s'), metricId: 'fridge_profit', label: 'Lucro', color: '#059669' },
        { id: uid('s'), metricId: 'fridge_revenue', label: 'Receita', color: '#2563eb' },
      ],
      style: styleWith({ paletteId: 'emerald', topN: 8, showValues: true }),
    }),
  },
  {
    id: 'tpl-camareiras',
    name: 'Desempenho das camareiras',
    category: 'Operação',
    description: 'Quartos limpos e tempo médio por camareira no período.',
    build: () => ({
      id: uid('w'),
      title: 'Desempenho das camareiras',
      description: 'Quartos limpos concluídos e tempo médio em minutos por camareira.',
      chartType: 'composed',
      dimension: 'housekeeper',
      size: 'full',
      height: 'normal',
      series: [
        { id: uid('s'), metricId: 'cleaning_completed', label: 'Quartos limpos', color: '#4c60cf', visualType: 'bar', yAxis: 'left' },
        { id: uid('s'), metricId: 'cleaning_avg_minutes', label: 'Tempo médio (min)', color: '#d97706', visualType: 'line', yAxis: 'right' },
      ],
      style: styleWith({ paletteId: 'hotel', showValues: true }),
    }),
  },
  {
    id: 'tpl-cafe-lucro',
    name: 'Lucro do café da manhã',
    category: 'Café',
    description: 'Receita do café, custo com insumos/I9 e lucro líquido.',
    build: () => ({
      id: uid('w'),
      title: 'Resultado do café da manhã',
      description: 'Receita atribuída menos compras de insumos e pagamentos à I9.',
      chartType: 'composed',
      dimension: 'timeline',
      size: 'full',
      height: 'normal',
      series: [
        { id: uid('s'), metricId: 'breakfast_revenue', label: 'Receita', color: '#4c60cf', visualType: 'bar' },
        { id: uid('s'), metricId: 'breakfast_cost', label: 'Custo', color: '#bd624a', visualType: 'bar' },
        { id: uid('s'), metricId: 'breakfast_profit', label: 'Lucro', color: '#147d6b', visualType: 'line' },
      ],
      style: styleWith({ paletteId: 'hotel' }),
    }),
  },
  {
    id: 'tpl-ocupacao-faturamento',
    name: 'Ocupação (%) vs Faturamento',
    category: 'Operação',
    description: 'Cruza a taxa de ocupação dos quartos com o faturamento no eixo duplo.',
    build: () => ({
      id: uid('w'),
      title: 'Ocupação vs Faturamento',
      description: 'Comparativo da receita com a taxa de ocupação do hotel.',
      chartType: 'composed',
      dimension: 'timeline',
      size: 'half',
      height: 'normal',
      series: [
        { id: uid('s'), metricId: 'revenue', label: 'Faturamento', color: '#4c60cf', visualType: 'bar', yAxis: 'left' },
        { id: uid('s'), metricId: 'occupancy_rate', label: 'Ocupação (%)', color: '#147d6b', visualType: 'line', yAxis: 'right' },
      ],
      style: styleWith({ paletteId: 'ocean' }),
    }),
  },
  {
    id: 'tpl-em-branco',
    name: 'Gráfico em branco (personalizado)',
    category: 'Livre',
    description: 'Comece do zero escolhendo livremente métrica, dimensão, cores e estilo.',
    build: () => ({
      id: uid('w'),
      title: 'Nova análise personalizada',
      description: 'Personalize métricas, cores e estilo livremente.',
      chartType: 'bar',
      dimension: 'timeline',
      size: 'half',
      height: 'normal',
      series: [
        { id: uid('s'), metricId: 'expense_by_category', label: 'Despesas selecionadas', color: '#4c60cf', categories: [], basis: 'accrual' },
      ],
      style: styleWith({ paletteId: 'hotel' }),
    }),
  },
];

function sanitizeSeries(raw: unknown, idx: number): ChartSeriesConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const metricId = typeof s.metricId === 'string' && s.metricId.trim() ? s.metricId.trim() : '';
  if (!metricId) return null;
  const color = typeof s.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.color.trim())
    ? s.color.trim()
    : CHART_PALETTES[0].colors[idx % CHART_PALETTES[0].colors.length];
  return {
    id: typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `s-${idx + 1}`,
    metricId,
    ...(typeof s.label === 'string' && s.label.trim() ? { label: s.label.trim() } : {}),
    color,
    ...(Array.isArray(s.categories) ? { categories: s.categories.filter((c): c is string => typeof c === 'string' && Boolean(c.trim())) } : {}),
    ...(s.basis === 'accrual' || s.basis === 'cash' ? { basis: s.basis } : {}),
    ...(s.wallet === 'all' || s.wallet === 'cash' || s.wallet === 'bank' || s.wallet === 'oyo' ? { wallet: s.wallet } : {}),
    ...(s.channel === 'all' || s.channel === 'oyo' || s.channel === 'balcao' || s.channel === 'rotativo' ? { channel: s.channel } : {}),
    ...(s.visualType === 'bar' || s.visualType === 'line' || s.visualType === 'area' ? { visualType: s.visualType } : {}),
    ...(s.yAxis === 'left' || s.yAxis === 'right' ? { yAxis: s.yAxis } : {}),
  };
}

function sanitizeStyle(raw: unknown): ChartStyleConfig {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const paletteId = typeof s.paletteId === 'string' && VALID_PALETTES.has(s.paletteId as ChartPaletteId)
    ? (s.paletteId as ChartPaletteId)
    : DEFAULT_CHART_STYLE.paletteId;
  const refRaw = s.referenceLine && typeof s.referenceLine === 'object' ? (s.referenceLine as Record<string, unknown>) : null;
  return {
    paletteId,
    curve: s.curve === 'linear' || s.curve === 'step' ? s.curve : 'monotone',
    fillStyle: s.fillStyle === 'solid' || s.fillStyle === 'none' ? s.fillStyle : 'gradient',
    barRadius: typeof s.barRadius === 'number' && Number.isFinite(s.barRadius) ? Math.max(0, Math.min(16, Math.round(s.barRadius))) : 4,
    strokeWidth: typeof s.strokeWidth === 'number' && Number.isFinite(s.strokeWidth) ? Math.max(1, Math.min(6, s.strokeWidth)) : 2.5,
    showGrid: typeof s.showGrid === 'boolean' ? s.showGrid : true,
    showValues: typeof s.showValues === 'boolean' ? s.showValues : false,
    legendPosition: s.legendPosition === 'bottom' || s.legendPosition === 'hidden' ? s.legendPosition : 'top',
    donutThickness: s.donutThickness === 'thin' || s.donutThickness === 'thick' ? s.donutThickness : 'normal',
    topN: typeof s.topN === 'number' && Number.isFinite(s.topN) ? Math.max(3, Math.min(20, Math.round(s.topN))) : 6,
    showComparison: typeof s.showComparison === 'boolean' ? s.showComparison : true,
    ...(refRaw && typeof refRaw.enabled === 'boolean' && typeof refRaw.value === 'number' && Number.isFinite(refRaw.value)
      ? {
        referenceLine: {
          enabled: refRaw.enabled,
          value: refRaw.value,
          label: typeof refRaw.label === 'string' ? refRaw.label.slice(0, 60) : 'Meta',
          color: typeof refRaw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(refRaw.color) ? refRaw.color : '#dc2626',
        },
      }
      : {}),
  };
}

function sanitizeWidget(raw: unknown, idx: number): ChartWidgetConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const series = Array.isArray(w.series)
    ? w.series.map((item, i) => sanitizeSeries(item, i)).filter((item): item is ChartSeriesConfig => Boolean(item))
    : [];
  if (!series.length) return null;
  const chartType = typeof w.chartType === 'string' && VALID_TYPES.has(w.chartType as ChartType)
    ? (w.chartType as ChartType)
    : 'bar';
  const dimension = typeof w.dimension === 'string' && VALID_DIMENSIONS.has(w.dimension as ChartDimension)
    ? (w.dimension as ChartDimension)
    : 'timeline';
  const periodRaw = w.periodOverride && typeof w.periodOverride === 'object' ? (w.periodOverride as Record<string, unknown>) : null;
  return {
    id: typeof w.id === 'string' && w.id.trim() ? w.id.trim() : `w-${idx + 1}`,
    title: typeof w.title === 'string' && w.title.trim() ? w.title.trim().slice(0, 120) : 'Gráfico personalizado',
    description: typeof w.description === 'string' ? w.description.trim().slice(0, 240) : '',
    chartType,
    dimension,
    size: w.size === 'full' ? 'full' : 'half',
    height: w.height === 'compact' || w.height === 'tall' ? w.height : 'normal',
    series,
    style: sanitizeStyle(w.style),
    ...(periodRaw && typeof periodRaw.enabled === 'boolean'
      && typeof periodRaw.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(periodRaw.from)
      && typeof periodRaw.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(periodRaw.to)
      ? { periodOverride: { enabled: periodRaw.enabled, from: periodRaw.from, to: periodRaw.to } }
      : {}),
  };
}

export function normalizeDashboardsConfig(raw: unknown): ReportDashboardsConfig {
  if (!raw || typeof raw !== 'object') return createDefaultConfig();
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.dashboards) || obj.dashboards.length === 0) return createDefaultConfig();
  const dashboards: ReportDashboardTab[] = [];
  for (let i = 0; i < obj.dashboards.length; i++) {
    const tab = obj.dashboards[i] as Record<string, unknown> | null;
    if (!tab || typeof tab !== 'object') continue;
    const id = typeof tab.id === 'string' && tab.id.trim() ? tab.id.trim() : `painel-${i + 1}`;
    const name = typeof tab.name === 'string' && tab.name.trim() ? tab.name.trim().slice(0, 60) : `Painel ${i + 1}`;
    const widgets = Array.isArray(tab.widgets)
      ? tab.widgets.map((w, wi) => sanitizeWidget(w, wi)).filter((w): w is ChartWidgetConfig => Boolean(w))
      : [];
    dashboards.push({ id, name, widgets });
  }
  if (dashboards.length === 0) return createDefaultConfig();
  const activeDashboardId = typeof obj.activeDashboardId === 'string' && dashboards.some((d) => d.id === obj.activeDashboardId)
    ? obj.activeDashboardId
    : dashboards[0].id;
  return {
    version: 1,
    activeDashboardId,
    dashboards,
    ...(typeof obj.updatedAt === 'string' ? { updatedAt: obj.updatedAt } : {}),
  };
}

export function requiredSourcesForDashboard(dashboard: ReportDashboardTab | undefined): Set<OperationalSourceKey> {
  if (!dashboard) return new Set();
  const metricIds = dashboard.widgets.flatMap((w) => w.series.map((s) => s.metricId));
  return requiredSourcesForMetrics(metricIds);
}

function readLocalCache(): ReportDashboardsConfig | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) return null;
    return normalizeDashboardsConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeLocalCache(config: ReportDashboardsConfig): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage quota errors
  }
}

export function subscribeReportDashboards(
  onChange: (config: ReportDashboardsConfig) => void,
  onError?: (error: Error) => void,
): () => void {
  const cached = readLocalCache();
  if (cached) onChange(cached);
  return onValue(
    ref(db, CONFIG_PATH),
    (snapshot) => {
      const val = snapshot.val();
      const normalized = val ? normalizeDashboardsConfig(val) : (readLocalCache() ?? createDefaultConfig());
      writeLocalCache(normalized);
      onChange(normalized);
    },
    (error) => {
      onChange(readLocalCache() ?? createDefaultConfig());
      onError?.(error);
    },
  );
}

export async function saveReportDashboards(config: ReportDashboardsConfig): Promise<ReportDashboardsConfig> {
  const normalized: ReportDashboardsConfig = {
    ...normalizeDashboardsConfig(config),
    updatedAt: new Date().toISOString(),
  };
  writeLocalCache(normalized);
  await set(ref(db, CONFIG_PATH), normalized);
  return normalized;
}

export async function resetReportDashboards(): Promise<ReportDashboardsConfig> {
  const fresh = createDefaultConfig();
  return saveReportDashboards(fresh);
}
