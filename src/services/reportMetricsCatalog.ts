import type {
  ChartDimension,
  MetricGroupId,
  MetricUnit,
  OperationalSourceKey,
} from '../types/reportCharts';

export interface ReportMetricDefinition {
  id: string;
  group: MetricGroupId;
  label: string;
  shortLabel: string;
  description: string;
  unit: MetricUnit;
  defaultColor: string;
  supportedDimensions: ChartDimension[];
  supportsCategoryFilter?: 'expense' | 'income';
  supportsBasis?: boolean;
  requiredSources?: OperationalSourceKey[];
  /** True when lower values are better (e.g. expenses, cleaning time, cancellations). */
  lessIsBetter?: boolean;
}

export const METRIC_GROUPS: { id: MetricGroupId; label: string }[] = [
  { id: 'geral', label: 'Financeiro geral' },
  { id: 'oyo', label: 'OYO & Taxas' },
  { id: 'categorias', label: 'Categorias específicas' },
  { id: 'cafe', label: 'Café da manhã' },
  { id: 'geladeira', label: 'Geladeira / Frigobar' },
  { id: 'camareiras', label: 'Desempenho das camareiras' },
  { id: 'estoque', label: 'Ocupação & Estoque' },
];

export const REPORT_METRICS: ReportMetricDefinition[] = [
  // --- Financeiro geral ---
  {
    id: 'revenue',
    group: 'geral',
    label: 'Faturamento total',
    shortLabel: 'Faturamento',
    description: 'Receita do hotel pela data do serviço (inclui pré-pagos do hotel; exclui taxas da OYO).',
    unit: 'currency',
    defaultColor: '#4c60cf',
    supportedDimensions: ['timeline', 'income_category', 'payment_method', 'channel'],
  },
  {
    id: 'received',
    group: 'geral',
    label: 'Entradas em caixa e banco',
    shortLabel: 'Entradas',
    description: 'Recebimentos diretos no hotel somados aos repasses recebidos da OYO.',
    unit: 'currency',
    defaultColor: '#147d6b',
    supportedDimensions: ['timeline', 'payment_method', 'wallet'],
  },
  {
    id: 'expenses_registered',
    group: 'geral',
    label: 'Despesas registradas (competência)',
    shortLabel: 'Despesas registradas',
    description: 'Compras no cartão pela data da compra; demais despesas e folha pelo vencimento.',
    unit: 'currency',
    defaultColor: '#bd624a',
    supportedDimensions: ['timeline', 'expense_category'],
    lessIsBetter: true,
  },
  {
    id: 'expenses_paid',
    group: 'geral',
    label: 'Despesas pagas (caixa)',
    shortLabel: 'Despesas pagas',
    description: 'Pagamentos efetivamente realizados no período (inclui folha e compensações OYO).',
    unit: 'currency',
    defaultColor: '#c2410c',
    supportedDimensions: ['timeline', 'expense_category', 'wallet'],
    lessIsBetter: true,
  },
  {
    id: 'profit_estimated',
    group: 'geral',
    label: 'Lucro líquido estimado',
    shortLabel: 'Lucro estimado',
    description: 'Faturamento total menos despesas e folha registradas no período.',
    unit: 'currency',
    defaultColor: '#059669',
    supportedDimensions: ['timeline'],
  },
  {
    id: 'cash_result',
    group: 'geral',
    label: 'Resultado de caixa',
    shortLabel: 'Resultado caixa',
    description: 'Entradas em caixa e banco menos saídas, somando ajustes de caixa físico.',
    unit: 'currency',
    defaultColor: '#0891b2',
    supportedDimensions: ['timeline'],
  },
  {
    id: 'payroll_cost',
    group: 'geral',
    label: 'Folha de pagamento',
    shortLabel: 'Folha',
    description: 'Total de folha salarial registrada ou paga no período.',
    unit: 'currency',
    defaultColor: '#7b5cb8',
    supportedDimensions: ['timeline', 'wallet'],
    supportsBasis: true,
    lessIsBetter: true,
  },
  {
    id: 'card_fees',
    group: 'geral',
    label: 'Taxas da máquina de cartão',
    shortLabel: 'Taxas cartão',
    description: 'Descontos de taxa sobre recebimentos de crédito e débito.',
    unit: 'currency',
    defaultColor: '#d97706',
    supportedDimensions: ['timeline', 'payment_method'],
    lessIsBetter: true,
  },
  {
    id: 'wallet_balance_cash',
    group: 'geral',
    label: 'Saldo acumulado — Caixa físico',
    shortLabel: 'Saldo caixa',
    description: 'Evolução do saldo acumulado em dinheiro ao final de cada intervalo.',
    unit: 'currency',
    defaultColor: '#059669',
    supportedDimensions: ['timeline', 'wallet'],
  },
  {
    id: 'wallet_balance_bank',
    group: 'geral',
    label: 'Saldo acumulado — Banco',
    shortLabel: 'Saldo banco',
    description: 'Evolução do saldo acumulado em banco ao final de cada intervalo.',
    unit: 'currency',
    defaultColor: '#2563eb',
    supportedDimensions: ['timeline', 'wallet'],
  },

  // --- OYO & Taxas ---
  {
    id: 'oyo_retained',
    group: 'oyo',
    label: 'Valor retido pela OYO (pré-pagos)',
    shortLabel: 'Retido OYO',
    description: 'Pagamentos de hóspedes feitos diretamente à OYO (carteira pré-pago) no período.',
    unit: 'currency',
    defaultColor: '#4f46e5',
    supportedDimensions: ['timeline', 'income_category'],
  },
  {
    id: 'oyo_counter_fees',
    group: 'oyo',
    label: 'Taxa OYO paga no balcão',
    shortLabel: 'Taxa no balcão',
    description: 'Taxas OYO recebidas no balcão do hotel (dinheiro, Pix ou cartão) que geram repasse à OYO.',
    unit: 'currency',
    defaultColor: '#ea580c',
    supportedDimensions: ['timeline', 'payment_method'],
  },
  {
    id: 'oyo_compensated',
    group: 'oyo',
    label: 'Despesas compensadas pela OYO',
    shortLabel: 'Compensado OYO',
    description: 'Despesas e taxas quitadas diretamente com saldo retido na OYO.',
    unit: 'currency',
    defaultColor: '#a37a36',
    supportedDimensions: ['timeline', 'expense_category'],
    lessIsBetter: true,
  },
  {
    id: 'oyo_repasses',
    group: 'oyo',
    label: 'Repasses recebidos da OYO',
    shortLabel: 'Repasses OYO',
    description: 'Transferências enviadas pela OYO para o banco ou caixa do hotel.',
    unit: 'currency',
    defaultColor: '#147d6b',
    supportedDimensions: ['timeline', 'wallet'],
  },
  {
    id: 'oyo_sent',
    group: 'oyo',
    label: 'Pagamentos enviados à OYO',
    shortLabel: 'Enviado à OYO',
    description: 'Transferências feitas pelo hotel para quitar taxas ou saldo devedor com a OYO.',
    unit: 'currency',
    defaultColor: '#be185d',
    supportedDimensions: ['timeline', 'wallet'],
    lessIsBetter: true,
  },

  // --- Categorias específicas (dinâmicas) ---
  {
    id: 'expense_by_category',
    group: 'categorias',
    label: 'Gasto por categoria de despesa',
    shortLabel: 'Despesa (categoria)',
    description: 'Selecione uma ou mais categorias (ex.: Material de limpeza, Manutenção, Energia, Estoque) em competência ou caixa.',
    unit: 'currency',
    defaultColor: '#bd624a',
    supportedDimensions: ['timeline', 'expense_category', 'wallet'],
    supportsCategoryFilter: 'expense',
    supportsBasis: true,
    lessIsBetter: true,
  },
  {
    id: 'income_by_category',
    group: 'categorias',
    label: 'Receita por categoria de entrada',
    shortLabel: 'Receita (categoria)',
    description: 'Selecione uma ou mais categorias de entrada (ex.: Diária, Rotativo, Café, Consumo, Taxas, Extras).',
    unit: 'currency',
    defaultColor: '#2563eb',
    supportedDimensions: ['timeline', 'income_category', 'payment_method', 'wallet', 'channel'],
    supportsCategoryFilter: 'income',
  },

  // --- Café da manhã ---
  {
    id: 'breakfast_revenue',
    group: 'cafe',
    label: 'Receita do café da manhã',
    shortLabel: 'Receita café',
    description: 'Valor atribuído aos recebimentos classificados como café da manhã.',
    unit: 'currency',
    defaultColor: '#4c60cf',
    supportedDimensions: ['timeline'],
  },
  {
    id: 'breakfast_cost',
    group: 'cafe',
    label: 'Custo do café da manhã (Insumos + I9)',
    shortLabel: 'Custo café',
    description: 'Compras de suprimentos do café pela data de registro somadas aos pagamentos efetuados à I9.',
    unit: 'currency',
    defaultColor: '#bd624a',
    supportedDimensions: ['timeline'],
    lessIsBetter: true,
  },
  {
    id: 'breakfast_profit',
    group: 'cafe',
    label: 'Lucro do café da manhã',
    shortLabel: 'Lucro café',
    description: 'Receita do café da manhã menos custos de insumos e I9.',
    unit: 'currency',
    defaultColor: '#147d6b',
    supportedDimensions: ['timeline'],
  },
  {
    id: 'breakfast_margin',
    group: 'cafe',
    label: 'Margem do café da manhã (%)',
    shortLabel: 'Margem café %',
    description: 'Percentual de lucro sobre a receita do café da manhã.',
    unit: 'percent',
    defaultColor: '#059669',
    supportedDimensions: ['timeline'],
  },

  // --- Geladeira / Frigobar ---
  {
    id: 'fridge_revenue',
    group: 'geladeira',
    label: 'Receita da geladeira',
    shortLabel: 'Receita geladeira',
    description: 'Total vendido na geladeira da recepção (inclui vendas diretas e bebidas lançadas em quartos).',
    unit: 'currency',
    defaultColor: '#2563eb',
    supportedDimensions: ['timeline', 'fridge_product', 'payment_method'],
    requiredSources: ['frigobar', 'inventory'],
  },
  {
    id: 'fridge_cogs',
    group: 'geladeira',
    label: 'Custo dos produtos vendidos (CMV geladeira)',
    shortLabel: 'CMV geladeira',
    description: 'Custo unitário médio cadastrado no estoque multiplicado pela quantidade vendida.',
    unit: 'currency',
    defaultColor: '#bd624a',
    supportedDimensions: ['timeline', 'fridge_product'],
    requiredSources: ['frigobar', 'inventory'],
    lessIsBetter: true,
  },
  {
    id: 'fridge_profit',
    group: 'geladeira',
    label: 'Lucro da geladeira (Receita − CMV)',
    shortLabel: 'Lucro geladeira',
    description: 'Margem de contribuição estimada das vendas da geladeira descontando o CMV do estoque.',
    unit: 'currency',
    defaultColor: '#059669',
    supportedDimensions: ['timeline', 'fridge_product'],
    requiredSources: ['frigobar', 'inventory'],
  },
  {
    id: 'fridge_margin',
    group: 'geladeira',
    label: 'Margem da geladeira (%)',
    shortLabel: 'Margem geladeira %',
    description: 'Percentual de lucro sobre as vendas da geladeira.',
    unit: 'percent',
    defaultColor: '#0d9488',
    supportedDimensions: ['timeline', 'fridge_product'],
    requiredSources: ['frigobar', 'inventory'],
  },
  {
    id: 'fridge_restock_cost',
    group: 'geladeira',
    label: 'Compras de reposição da geladeira',
    shortLabel: 'Reposição geladeira',
    description: 'Entradas de estoque de produtos da categoria Geladeira / Frigobar registradas no período.',
    unit: 'currency',
    defaultColor: '#d97706',
    supportedDimensions: ['timeline', 'fridge_product'],
    requiredSources: ['inventory'],
    lessIsBetter: true,
  },
  {
    id: 'fridge_units',
    group: 'geladeira',
    label: 'Unidades vendidas na geladeira',
    shortLabel: 'Unidades geladeira',
    description: 'Quantidade total de itens vendidos na geladeira.',
    unit: 'count',
    defaultColor: '#7b5cb8',
    supportedDimensions: ['timeline', 'fridge_product'],
    requiredSources: ['frigobar'],
  },

  // --- Desempenho das camareiras ---
  {
    id: 'cleaning_completed',
    group: 'camareiras',
    label: 'Quartos limpos concluídos',
    shortLabel: 'Quartos limpos',
    description: 'Total de limpezas concluídas pelas camareiras no período.',
    unit: 'count',
    defaultColor: '#4c60cf',
    supportedDimensions: ['housekeeper', 'timeline'],
    requiredSources: ['cleaning'],
  },
  {
    id: 'cleaning_avg_minutes',
    group: 'camareiras',
    label: 'Tempo médio de limpeza (min)',
    shortLabel: 'Tempo médio (min)',
    description: 'Duração média entre designação e conclusão da limpeza (ignora durações atípicas > 8h).',
    unit: 'minutes',
    defaultColor: '#d97706',
    supportedDimensions: ['housekeeper', 'timeline'],
    requiredSources: ['cleaning'],
    lessIsBetter: true,
  },
  {
    id: 'cleaning_canceled',
    group: 'camareiras',
    label: 'Limpezas canceladas',
    shortLabel: 'Canceladas',
    description: 'Tarefas de limpeza canceladas antes da conclusão.',
    unit: 'count',
    defaultColor: '#dc2626',
    supportedDimensions: ['housekeeper', 'timeline'],
    requiredSources: ['cleaning'],
    lessIsBetter: true,
  },
  {
    id: 'cleaning_doors_windows',
    group: 'camareiras',
    label: 'Limpezas com portas e janelas',
    shortLabel: 'Portas/janelas',
    description: 'Registros de limpeza completa incluindo conferência de portas e janelas.',
    unit: 'count',
    defaultColor: '#147d6b',
    supportedDimensions: ['housekeeper', 'timeline'],
    requiredSources: ['cleaningLogs'],
  },
  {
    id: 'cleaning_concerns',
    group: 'camareiras',
    label: 'Ocorrências de uso relatadas',
    shortLabel: 'Ocorrências',
    description: 'Quartos finalizados com alerta de dano, mal uso ou necessidade de verificação.',
    unit: 'count',
    defaultColor: '#be185d',
    supportedDimensions: ['housekeeper', 'timeline'],
    requiredSources: ['cleaningLogs'],
    lessIsBetter: true,
  },

  // --- Ocupação & Estoque ---
  {
    id: 'occupancy_rate',
    group: 'estoque',
    label: 'Taxa de ocupação (%)',
    shortLabel: 'Ocupação %',
    description: 'Percentual de diárias ocupadas sobre o total de quartos disponíveis.',
    unit: 'percent',
    defaultColor: '#0891b2',
    supportedDimensions: ['timeline'],
  },
  {
    id: 'occupied_nights',
    group: 'estoque',
    label: 'Diárias ocupadas',
    shortLabel: 'Diárias ocupadas',
    description: 'Soma de noites ocupadas em quartos de hospedagem.',
    unit: 'count',
    defaultColor: '#4f46e5',
    supportedDimensions: ['timeline'],
  },
  {
    id: 'stock_outputs_cost',
    group: 'estoque',
    label: 'Custo estimado de saídas internas de estoque',
    shortLabel: 'Saídas estoque (R$)',
    description: 'Valor estimado de insumos retirados do almoxarifado por destino (Camareiras, Manutenção, Lavanderia, etc.).',
    unit: 'currency',
    defaultColor: '#a37a36',
    supportedDimensions: ['stock_destination', 'timeline'],
    requiredSources: ['outputs', 'inventory'],
    lessIsBetter: true,
  },
  {
    id: 'stock_outputs_qty',
    group: 'estoque',
    label: 'Itens retirados do estoque (saídas internas)',
    shortLabel: 'Saídas estoque (un.)',
    description: 'Quantidade de unidades retiradas para uso interno por setor.',
    unit: 'count',
    defaultColor: '#334155',
    supportedDimensions: ['stock_destination', 'timeline'],
    requiredSources: ['outputs'],
  },
];

export const METRICS_BY_ID: Record<string, ReportMetricDefinition> = Object.fromEntries(
  REPORT_METRICS.map((m) => [m.id, m]),
);

export function getMetricDefinition(metricId: string): ReportMetricDefinition | undefined {
  return METRICS_BY_ID[metricId];
}

export function metricsForDimension(dimension: ChartDimension): ReportMetricDefinition[] {
  return REPORT_METRICS.filter((m) => m.supportedDimensions.includes(dimension));
}

export function requiredSourcesForMetrics(metricIds: string[]): Set<OperationalSourceKey> {
  const needed = new Set<OperationalSourceKey>();
  for (const id of metricIds) {
    const def = METRICS_BY_ID[id];
    def?.requiredSources?.forEach((src) => needed.add(src));
  }
  return needed;
}
