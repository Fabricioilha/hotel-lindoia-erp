export type ChartType =
  | 'area'
  | 'line'
  | 'bar'
  | 'stacked_bar'
  | 'horizontal_bar'
  | 'composed'
  | 'donut'
  | 'pie'
  | 'breakdown'
  | 'kpi';

export type ChartDimension =
  | 'timeline'
  | 'expense_category'
  | 'income_category'
  | 'payment_method'
  | 'wallet'
  | 'channel'
  | 'housekeeper'
  | 'fridge_product'
  | 'stock_destination';

export type MetricUnit = 'currency' | 'percent' | 'count' | 'minutes';

export type MetricGroupId =
  | 'geral'
  | 'oyo'
  | 'categorias'
  | 'cafe'
  | 'geladeira'
  | 'camareiras'
  | 'estoque';

export type OperationalSourceKey =
  | 'cleaning'
  | 'cleaningLogs'
  | 'inventory'
  | 'frigobar'
  | 'outputs';

export type ChartPaletteId =
  | 'hotel'
  | 'ocean'
  | 'emerald'
  | 'terracotta'
  | 'contrast'
  | 'executive';

export interface ChartPalette {
  id: ChartPaletteId;
  name: string;
  colors: string[];
}

export const CHART_PALETTES: ChartPalette[] = [
  { id: 'hotel', name: 'Hotel Lindoia', colors: ['#4c60cf', '#147d6b', '#bd624a', '#a37a36', '#7b5cb8', '#2f82a6'] },
  { id: 'ocean', name: 'Oceano', colors: ['#2563eb', '#0891b2', '#0d9488', '#4f46e5', '#0284c7', '#6366f1'] },
  { id: 'emerald', name: 'Esmeralda', colors: ['#059669', '#10b981', '#0f766e', '#65a30d', '#14b8a6', '#d97706'] },
  { id: 'terracotta', name: 'Terracota', colors: ['#c2410c', '#d97706', '#b91c1c', '#a16207', '#be185d', '#4d7c0f'] },
  { id: 'contrast', name: 'Alto contraste', colors: ['#1d4ed8', '#dc2626', '#15803d', '#9333ea', '#ea580c', '#0e7490'] },
  { id: 'executive', name: 'Executivo', colors: ['#334155', '#0f766e', '#b45309', '#4338ca', '#9f1239', '#475569'] },
];

export const QUICK_COLOR_SWATCHES = [
  '#4c60cf', '#2563eb', '#0891b2', '#147d6b', '#059669', '#65a30d',
  '#d97706', '#bd624a', '#dc2626', '#be185d', '#7b5cb8', '#334155',
];

export function paletteColors(paletteId: ChartPaletteId): string[] {
  return CHART_PALETTES.find((p) => p.id === paletteId)?.colors ?? CHART_PALETTES[0].colors;
}

export interface ChartSeriesConfig {
  id: string;
  metricId: string;
  label?: string;
  color: string;
  /** Categorias selecionadas (para métricas dinâmicas de categoria); vazio = todas. */
  categories?: string[];
  /** Base de apuração para despesas/receitas: competência (accrual) ou caixa (cash). */
  basis?: 'accrual' | 'cash';
  /** Filtro opcional por carteira. */
  wallet?: 'all' | 'cash' | 'bank' | 'oyo';
  /** Filtro opcional por canal de hospedagem. */
  channel?: 'all' | 'oyo' | 'balcao' | 'rotativo';
  /** Estilo individual quando o gráfico é 'composed'. */
  visualType?: 'bar' | 'line' | 'area';
  /** Eixo Y quando o gráfico combina unidades diferentes. */
  yAxis?: 'left' | 'right';
}

export interface ChartReferenceLineConfig {
  enabled: boolean;
  value: number;
  label: string;
  color: string;
}

export interface ChartStyleConfig {
  paletteId: ChartPaletteId;
  curve: 'monotone' | 'linear' | 'step';
  fillStyle: 'gradient' | 'solid' | 'none';
  barRadius: number;
  strokeWidth: number;
  showGrid: boolean;
  showValues: boolean;
  legendPosition: 'top' | 'bottom' | 'hidden';
  donutThickness: 'thin' | 'normal' | 'thick';
  topN: number;
  showComparison: boolean;
  referenceLine?: ChartReferenceLineConfig;
}

export interface ChartPeriodOverride {
  enabled: boolean;
  from: string;
  to: string;
}

export interface ChartWidgetConfig {
  id: string;
  title: string;
  description: string;
  chartType: ChartType;
  dimension: ChartDimension;
  size: 'half' | 'full';
  height: 'compact' | 'normal' | 'tall';
  series: ChartSeriesConfig[];
  style: ChartStyleConfig;
  periodOverride?: ChartPeriodOverride;
}

export interface ReportDashboardTab {
  id: string;
  name: string;
  widgets: ChartWidgetConfig[];
}

export interface ReportDashboardsConfig {
  version: 1;
  activeDashboardId?: string;
  dashboards: ReportDashboardTab[];
  updatedAt?: string;
}

export const DEFAULT_CHART_STYLE: ChartStyleConfig = {
  paletteId: 'hotel',
  curve: 'monotone',
  fillStyle: 'gradient',
  barRadius: 4,
  strokeWidth: 2.5,
  showGrid: true,
  showValues: false,
  legendPosition: 'top',
  donutThickness: 'normal',
  topN: 6,
  showComparison: true,
};

export interface ChartTypeMeta {
  id: ChartType;
  label: string;
  shortHint: string;
  supportsMultiSeries: boolean;
  supportsTimeline: boolean;
  supportsCategory: boolean;
}

export const CHART_TYPES: ChartTypeMeta[] = [
  { id: 'area', label: 'Área', shortHint: 'Tendência suave preenchida', supportsMultiSeries: true, supportsTimeline: true, supportsCategory: false },
  { id: 'line', label: 'Linha', shortHint: 'Evolução limpa e comparativa', supportsMultiSeries: true, supportsTimeline: true, supportsCategory: true },
  { id: 'bar', label: 'Barras', shortHint: 'Comparação lado a lado', supportsMultiSeries: true, supportsTimeline: true, supportsCategory: true },
  { id: 'stacked_bar', label: 'Barras empilhadas', shortHint: 'Composição somada por período', supportsMultiSeries: true, supportsTimeline: true, supportsCategory: true },
  { id: 'horizontal_bar', label: 'Barras horizontais', shortHint: 'Ideal para rankings e nomes longos', supportsMultiSeries: true, supportsTimeline: false, supportsCategory: true },
  { id: 'composed', label: 'Composto', shortHint: 'Barras + linha (aceita eixo duplo)', supportsMultiSeries: true, supportsTimeline: true, supportsCategory: true },
  { id: 'donut', label: 'Rosca', shortHint: 'Participação percentual com total central', supportsMultiSeries: false, supportsTimeline: false, supportsCategory: true },
  { id: 'pie', label: 'Pizza', shortHint: 'Divisão proporcional clássica', supportsMultiSeries: false, supportsTimeline: false, supportsCategory: true },
  { id: 'breakdown', label: 'Ranking', shortHint: 'Lista ordenada com barra proporcional', supportsMultiSeries: false, supportsTimeline: false, supportsCategory: true },
  { id: 'kpi', label: 'Cartões KPI', shortHint: 'Números em destaque com variação', supportsMultiSeries: true, supportsTimeline: true, supportsCategory: true },
];

export interface ChartDimensionMeta {
  id: ChartDimension;
  label: string;
  description: string;
}

export const CHART_DIMENSIONS: ChartDimensionMeta[] = [
  { id: 'timeline', label: 'Ao longo do tempo', description: 'Evolução diária ou mensal no período escolhido' },
  { id: 'expense_category', label: 'Por categoria de despesa', description: 'Compara gastos por categoria (limpeza, manutenção, etc.)' },
  { id: 'income_category', label: 'Por categoria de receita', description: 'Compara receitas por categoria (diária, café, taxas, etc.)' },
  { id: 'payment_method', label: 'Por forma de pagamento', description: 'Dinheiro, Pix, crédito, débito, transferência e pré-pago OYO' },
  { id: 'wallet', label: 'Por carteira', description: 'Caixa físico, Banco e OYO' },
  { id: 'channel', label: 'Por canal de hospedagem', description: 'OYO, Balcão e Rotativo' },
  { id: 'housekeeper', label: 'Por camareira', description: 'Quartos limpos, tempo médio e conferências por profissional' },
  { id: 'fridge_product', label: 'Por produto da geladeira', description: 'Receita, CMV, lucro e unidades vendidas por item' },
  { id: 'stock_destination', label: 'Por destino do estoque', description: 'Saídas internas para Camareiras, Lavanderia, Manutenção, etc.' },
];
