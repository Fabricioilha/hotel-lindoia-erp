import type { CleaningTask } from '../types/cleaning';
import {
  PAYMENT_METHOD_LABELS,
  WALLET_LABELS,
  financeReceiptItems,
  incomePaymentWallet,
  isOyoFeeItem,
  payrollNet,
  type FinanceData,
  type FinanceIncome,
  type FinancePaymentMethod,
} from '../types/finance';
import type { FrigobarSale } from '../types/frigobar';
import type { RoomCleaningLog } from '../types/housekeeping';
import { SALES_CATEGORY_ID, type StockMovement, type StockProduct } from '../types/inventory';
import type { OutputRecord } from '../types/outputs';
import type {
  ChartSeriesConfig,
  ChartWidgetConfig,
  MetricUnit,
} from '../types/reportCharts';
import { expenseRegistrationDate } from './cardStatements';
import { dailyRevenueRows } from './dailyRevenue';
import { balancesAtDate, registeredExpenses } from './financeAnalytics';
import { breakfastCostRows, financeOverview, type FinanceRange } from './financeOverview';
import {
  expensePaymentEvents,
  financeCents,
  financeDateBuckets,
  financeDateKeyFromTimestamp,
  financeDateLabel,
  payrollPaymentEvents,
  type FinanceGranularity,
} from './financePayments';
import { previousReportRange, reportChange, reportOccupancy } from './financeReports';
import { inventoryUnitCost } from './inventoryCost';
import { getMetricDefinition } from './reportMetricsCatalog';

export interface CustomReportContext {
  data: FinanceData;
  range: FinanceRange;
  today: string;
  granularity: FinanceGranularity;
  roomNumbers?: Set<string> | null;
  cleaningTasks?: Record<string, CleaningTask>;
  cleaningLogs?: Record<string, RoomCleaningLog>;
  frigobarSales?: Record<string, FrigobarSale>;
  inventoryProducts?: Record<string, StockProduct>;
  inventoryMovements?: Record<string, StockMovement>;
  stockOutputs?: Record<string, OutputRecord>;
}

export interface EvaluatedChartRow {
  key: string;
  label: string;
  fullLabel: string;
  values: Record<string, number>;
  previousValues?: Record<string, number>;
}

export interface EvaluatedSeriesMeta {
  id: string;
  metricId: string;
  label: string;
  color: string;
  unit: MetricUnit;
  visualType: 'bar' | 'line' | 'area';
  yAxis: 'left' | 'right';
  total: number;
  previousTotal: number | null;
  changePct: number | null;
  lessIsBetter: boolean;
}

export interface EvaluatedChartResult {
  effectiveRange: FinanceRange;
  comparisonLabel: string | null;
  rows: EvaluatedChartRow[];
  series: EvaluatedSeriesMeta[];
  hasRightAxis: boolean;
  leftUnit: MetricUnit;
  rightUnit: MetricUnit;
  dataNotes: string[];
}

const MIN_CLEANING_MINUTES = 1;
const MAX_CLEANING_MINUTES = 480; // 8h cap to avoid forgotten checkoffs skewing averages

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase('pt-BR');
}

function seriesDisplayLabel(series: ChartSeriesConfig): string {
  if (series.label?.trim()) return series.label.trim();
  const def = getMetricDefinition(series.metricId);
  if (series.categories && series.categories.length === 1) {
    return series.categories[0];
  }
  if (series.categories && series.categories.length > 1) {
    return `${series.categories.slice(0, 2).join(' + ')}${series.categories.length > 2 ? ` (+${series.categories.length - 2})` : ''}`;
  }
  return def?.shortLabel ?? series.metricId;
}

function inferIncomeChannel(entry: FinanceIncome, data: FinanceData): string {
  const items = financeReceiptItems(entry);
  if (items.some((it) => it.paymentMethod === 'prepaid')) return 'OYO';
  if (entry.category === 'Rotativo') return 'Rotativo';
  if (entry.id.startsWith('recepcao-')) {
    const stay = Object.values(data.stays ?? {}).find((s) => entry.id.startsWith(`recepcao-${s.id}-`));
    if (stay) {
      if (stay.kind === 'periodo') return 'Rotativo';
      if (stay.taxAmount > 0 || stay.dailyMethod === 'prepaid' || stay.dailySplit?.method === 'prepaid') return 'OYO';
      return 'Balcão / Direto';
    }
  }
  if (entry.id.startsWith('reservation-')) {
    const res = Object.values(data.reservations ?? {}).find((r) => entry.id.startsWith(`reservation-${r.id}-`));
    if (res) {
      if (res.channel === 'oyo') return 'OYO';
      if (res.channel === 'rotativo') return 'Rotativo';
      return 'Balcão / Direto';
    }
  }
  return 'Balcão / Direto';
}

function paymentMethodLabel(method: string): string {
  if (method in PAYMENT_METHOD_LABELS) {
    return PAYMENT_METHOD_LABELS[method as FinancePaymentMethod];
  }
  if (method === 'dinheiro') return 'Dinheiro';
  if (method === 'pix') return 'Pix';
  if (method === 'cartao_credito') return 'Cartão de crédito';
  if (method === 'cartao_debito') return 'Cartão de débito';
  return 'Outros';
}

function resolveProductCost(
  productId: string,
  productName: string,
  products: Record<string, StockProduct> | undefined,
): number | null {
  if (!products) return null;
  const direct = products[productId];
  if (direct) {
    const cost = inventoryUnitCost(direct);
    if (Number.isFinite(cost) && cost >= 0) return cost;
  }
  const norm = normalizeText(productName);
  const byName = Object.values(products).find((p) => normalizeText(p.name) === norm);
  if (byName) {
    const cost = inventoryUnitCost(byName);
    if (Number.isFinite(cost) && cost >= 0) return cost;
  }
  return null;
}

interface BucketComputation {
  values: number[];
  total: number;
  note?: string;
}

function computeTimelineSeries(
  series: ChartSeriesConfig,
  range: FinanceRange,
  ctx: CustomReportContext,
  buckets: ReturnType<typeof financeDateBuckets>,
  shared: {
    revenueRows: ReturnType<typeof dailyRevenueRows>;
    regExpenses: ReturnType<typeof registeredExpenses>;
    overview: ReturnType<typeof financeOverview>;
    breakfastCosts: ReturnType<typeof breakfastCostRows>;
  },
): BucketComputation {
  const n = buckets.periods.length;
  const centsArr = Array<number>(n).fill(0);
  const { indexOf, periods } = buckets;
  const inRange = (d: string) => d >= range.from && d <= range.to;
  const metricId = series.metricId;
  const catSet = series.categories?.length ? new Set(series.categories.map(normalizeText)) : null;
  const basis = series.basis ?? 'accrual';
  const walletFilter = series.wallet ?? 'all';
  const channelFilter = series.channel ?? 'all';

  const sumToTotal = () => centsArr.reduce((s, c) => s + c, 0);

  switch (metricId) {
    case 'revenue': {
      for (const row of shared.revenueRows) {
        if (!inRange(row.date)) continue;
        const idx = indexOf(row.date);
        if (idx >= 0 && idx < n) centsArr[idx] += financeCents(row.amount);
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'received': {
      for (let i = 0; i < n; i++) {
        centsArr[i] = financeCents(shared.overview.timeline[i]?.incoming ?? 0);
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'expenses_registered': {
      for (const item of shared.regExpenses) {
        if (!inRange(item.date) || !Number.isFinite(item.amount)) continue;
        const idx = indexOf(item.date);
        if (idx >= 0 && idx < n) centsArr[idx] += financeCents(item.amount);
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'expenses_paid': {
      for (const exp of Object.values(ctx.data.expenses)) {
        if (ctx.data.suppressed[exp.id]) continue;
        for (const ev of expensePaymentEvents(exp)) {
          if (!inRange(ev.date)) continue;
          if (walletFilter !== 'all' && ev.wallet !== walletFilter) continue;
          const idx = indexOf(ev.date);
          if (idx >= 0 && idx < n) centsArr[idx] += financeCents(ev.amount);
        }
      }
      for (const pr of Object.values(ctx.data.payroll)) {
        for (const ev of payrollPaymentEvents(pr)) {
          if (!inRange(ev.date)) continue;
          if (walletFilter !== 'all' && ev.wallet !== walletFilter) continue;
          const idx = indexOf(ev.date);
          if (idx >= 0 && idx < n) centsArr[idx] += financeCents(ev.amount);
        }
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'profit_estimated': {
      const rev = Array<number>(n).fill(0);
      const exp = Array<number>(n).fill(0);
      for (const row of shared.revenueRows) {
        if (!inRange(row.date)) continue;
        const idx = indexOf(row.date);
        if (idx >= 0 && idx < n) rev[idx] += financeCents(row.amount);
      }
      for (const item of shared.regExpenses) {
        if (!inRange(item.date)) continue;
        const idx = indexOf(item.date);
        if (idx >= 0 && idx < n) exp[idx] += financeCents(item.amount);
      }
      for (let i = 0; i < n; i++) centsArr[i] = rev[i] - exp[i];
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'cash_result': {
      for (let i = 0; i < n; i++) {
        const inc = financeCents(shared.overview.timeline[i]?.incoming ?? 0);
        const out = financeCents(shared.overview.timeline[i]?.outgoing ?? 0);
        centsArr[i] = inc - out;
      }
      for (const adj of Object.values(ctx.data.cashAdjustments ?? {})) {
        if (!inRange(adj.date)) continue;
        const idx = indexOf(adj.date);
        if (idx >= 0 && idx < n) centsArr[idx] += financeCents(adj.amount);
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'payroll_cost': {
      if (basis === 'cash') {
        for (const pr of Object.values(ctx.data.payroll)) {
          for (const ev of payrollPaymentEvents(pr)) {
            if (!inRange(ev.date)) continue;
            if (walletFilter !== 'all' && ev.wallet !== walletFilter) continue;
            const idx = indexOf(ev.date);
            if (idx >= 0 && idx < n) centsArr[idx] += financeCents(ev.amount);
          }
        }
      } else {
        for (const pr of Object.values(ctx.data.payroll)) {
          if (!inRange(pr.dueDate)) continue;
          const idx = indexOf(pr.dueDate);
          if (idx >= 0 && idx < n) centsArr[idx] += financeCents(payrollNet(pr));
        }
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'card_fees': {
      for (const entry of Object.values(ctx.data.incomes)) {
        if (ctx.data.suppressed[entry.id] || !inRange(entry.date)) continue;
        const idx = indexOf(entry.date);
        if (idx < 0 || idx >= n) continue;
        for (const item of financeReceiptItems(entry)) {
          if (item.paymentMethod === 'credit' || item.paymentMethod === 'debit') {
            centsArr[idx] += financeCents(item.cardFeeAmount ?? 0);
          }
        }
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'wallet_balance_cash':
    case 'wallet_balance_bank': {
      const key = metricId === 'wallet_balance_cash' ? 'cash' : 'bank';
      const values = periods.map((p) => balancesAtDate(ctx.data, p.to)[key]);
      const latest = values.at(-1) ?? 0;
      return { values, total: latest };
    }
    case 'oyo_retained': {
      for (const entry of Object.values(ctx.data.incomes)) {
        if (ctx.data.suppressed[entry.id] || !inRange(entry.date)) continue;
        const idx = indexOf(entry.date);
        if (idx < 0 || idx >= n) continue;
        for (const item of financeReceiptItems(entry)) {
          if (item.paymentMethod === 'prepaid') centsArr[idx] += financeCents(item.amount);
        }
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'oyo_counter_fees': {
      for (const entry of Object.values(ctx.data.incomes)) {
        if (ctx.data.suppressed[entry.id] || !inRange(entry.date)) continue;
        const idx = indexOf(entry.date);
        if (idx < 0 || idx >= n) continue;
        for (const item of financeReceiptItems(entry)) {
          if (item.paymentMethod !== 'prepaid' && item.paymentMethod !== 'courtesy' && isOyoFeeItem(entry, item)) {
            centsArr[idx] += financeCents(item.amount);
          }
        }
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'oyo_compensated': {
      for (const exp of Object.values(ctx.data.expenses)) {
        if (ctx.data.suppressed[exp.id]) continue;
        for (const ev of expensePaymentEvents(exp)) {
          if (ev.wallet !== 'oyo' || !inRange(ev.date)) continue;
          const idx = indexOf(ev.date);
          if (idx >= 0 && idx < n) centsArr[idx] += financeCents(ev.amount);
        }
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'oyo_repasses': {
      for (const tr of Object.values(ctx.data.transfers)) {
        if (tr.from !== 'oyo' || tr.to === 'oyo' || !inRange(tr.date)) continue;
        const idx = indexOf(tr.date);
        if (idx >= 0 && idx < n) centsArr[idx] += financeCents(tr.amount);
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'oyo_sent': {
      for (const tr of Object.values(ctx.data.transfers)) {
        if (tr.to !== 'oyo' || tr.from === 'oyo' || !inRange(tr.date)) continue;
        const idx = indexOf(tr.date);
        if (idx >= 0 && idx < n) centsArr[idx] += financeCents(tr.amount);
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'expense_by_category': {
      if (basis === 'cash') {
        for (const exp of Object.values(ctx.data.expenses)) {
          if (ctx.data.suppressed[exp.id]) continue;
          if (catSet && !catSet.has(normalizeText(exp.category))) continue;
          for (const ev of expensePaymentEvents(exp)) {
            if (!inRange(ev.date)) continue;
            if (walletFilter !== 'all' && ev.wallet !== walletFilter) continue;
            const idx = indexOf(ev.date);
            if (idx >= 0 && idx < n) centsArr[idx] += financeCents(ev.amount);
          }
        }
        if (!catSet || catSet.has(normalizeText('Folha de pagamento'))) {
          for (const pr of Object.values(ctx.data.payroll)) {
            for (const ev of payrollPaymentEvents(pr)) {
              if (!inRange(ev.date)) continue;
              if (walletFilter !== 'all' && ev.wallet !== walletFilter) continue;
              const idx = indexOf(ev.date);
              if (idx >= 0 && idx < n) centsArr[idx] += financeCents(ev.amount);
            }
          }
        }
      } else {
        for (const exp of Object.values(ctx.data.expenses)) {
          if (ctx.data.suppressed[exp.id]) continue;
          if (catSet && !catSet.has(normalizeText(exp.category))) continue;
          const dt = expenseRegistrationDate(ctx.data, exp);
          if (!inRange(dt)) continue;
          const idx = indexOf(dt);
          if (idx >= 0 && idx < n) centsArr[idx] += financeCents(exp.plannedAmount);
        }
        if (!catSet || catSet.has(normalizeText('Folha de pagamento'))) {
          for (const pr of Object.values(ctx.data.payroll)) {
            if (!inRange(pr.dueDate)) continue;
            const idx = indexOf(pr.dueDate);
            if (idx >= 0 && idx < n) centsArr[idx] += financeCents(payrollNet(pr));
          }
        }
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'income_by_category': {
      for (const entry of Object.values(ctx.data.incomes)) {
        if (ctx.data.suppressed[entry.id] || !inRange(entry.date)) continue;
        if (catSet && !catSet.has(normalizeText(entry.category))) continue;
        if (channelFilter !== 'all') {
          const ch = inferIncomeChannel(entry, ctx.data);
          const wanted = channelFilter === 'oyo' ? 'OYO' : channelFilter === 'rotativo' ? 'Rotativo' : 'Balcão / Direto';
          if (ch !== wanted) continue;
        }
        const idx = indexOf(entry.date);
        if (idx < 0 || idx >= n) continue;
        for (const item of financeReceiptItems(entry)) {
          const w = incomePaymentWallet(item.paymentMethod);
          if (!w) continue;
          if (walletFilter !== 'all' && w !== walletFilter) continue;
          centsArr[idx] += financeCents(item.amount);
        }
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'breakfast_revenue': {
      for (const row of shared.revenueRows) {
        if (row.category !== 'Café' || !inRange(row.date)) continue;
        const idx = indexOf(row.date);
        if (idx >= 0 && idx < n) centsArr[idx] += financeCents(row.amount);
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'breakfast_cost': {
      for (const row of shared.breakfastCosts) {
        if (!inRange(row.date)) continue;
        const idx = indexOf(row.date);
        if (idx >= 0 && idx < n) centsArr[idx] += financeCents(row.amount);
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'breakfast_profit':
    case 'breakfast_margin': {
      const rev = Array<number>(n).fill(0);
      const cost = Array<number>(n).fill(0);
      for (const row of shared.revenueRows) {
        if (row.category !== 'Café' || !inRange(row.date)) continue;
        const idx = indexOf(row.date);
        if (idx >= 0 && idx < n) rev[idx] += financeCents(row.amount);
      }
      for (const row of shared.breakfastCosts) {
        if (!inRange(row.date)) continue;
        const idx = indexOf(row.date);
        if (idx >= 0 && idx < n) cost[idx] += financeCents(row.amount);
      }
      if (metricId === 'breakfast_profit') {
        for (let i = 0; i < n; i++) centsArr[i] = rev[i] - cost[i];
        return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
      }
      const values = rev.map((r, i) => (r > 0 ? Math.round(((r - cost[i]) / r) * 1000) / 10 : 0));
      const totR = rev.reduce((s, v) => s + v, 0);
      const totC = cost.reduce((s, v) => s + v, 0);
      const total = totR > 0 ? Math.round(((totR - totC) / totR) * 1000) / 10 : 0;
      return { values, total };
    }
    case 'fridge_revenue':
    case 'fridge_cogs':
    case 'fridge_profit':
    case 'fridge_margin':
    case 'fridge_units': {
      const rev = Array<number>(n).fill(0);
      const cogs = Array<number>(n).fill(0);
      const units = Array<number>(n).fill(0);
      let totalItems = 0;
      let costedItems = 0;
      for (const sale of Object.values(ctx.frigobarSales ?? {})) {
        if (ctx.data.suppressed[`frigobar-${sale.id}`]) continue;
        const dt = financeDateKeyFromTimestamp(sale.createdAt);
        if (!inRange(dt)) continue;
        const idx = indexOf(dt);
        if (idx < 0 || idx >= n) continue;
        for (const item of sale.items ?? []) {
          totalItems++;
          const lineRev = financeCents(item.quantity * item.unitPrice);
          rev[idx] += lineRev;
          units[idx] += item.quantity;
          const unitCost = resolveProductCost(item.productId, item.productName, ctx.inventoryProducts);
          if (unitCost !== null) {
            costedItems++;
            cogs[idx] += financeCents(item.quantity * unitCost);
          }
        }
      }
      const coverageNote = (metricId === 'fridge_cogs' || metricId === 'fridge_profit' || metricId === 'fridge_margin')
        && totalItems > 0 && costedItems < totalItems
        ? `CMV da geladeira calculado sobre ${costedItems} de ${totalItems} itens com custo cadastrado no estoque.`
        : undefined;
      if (metricId === 'fridge_revenue') {
        return { values: rev.map((c) => c / 100), total: rev.reduce((s, v) => s + v, 0) / 100 };
      }
      if (metricId === 'fridge_cogs') {
        return { values: cogs.map((c) => c / 100), total: cogs.reduce((s, v) => s + v, 0) / 100, note: coverageNote };
      }
      if (metricId === 'fridge_units') {
        return { values: units, total: units.reduce((s, v) => s + v, 0) };
      }
      if (metricId === 'fridge_profit') {
        const prof = rev.map((r, i) => r - cogs[i]);
        return { values: prof.map((c) => c / 100), total: prof.reduce((s, v) => s + v, 0) / 100, note: coverageNote };
      }
      const marginVals = rev.map((r, i) => (r > 0 ? Math.round(((r - cogs[i]) / r) * 1000) / 10 : 0));
      const totR = rev.reduce((s, v) => s + v, 0);
      const totC = cogs.reduce((s, v) => s + v, 0);
      const marginTotal = totR > 0 ? Math.round(((totR - totC) / totR) * 1000) / 10 : 0;
      return { values: marginVals, total: marginTotal, note: coverageNote };
    }
    case 'fridge_restock_cost': {
      for (const mov of Object.values(ctx.inventoryMovements ?? {})) {
        if (mov.type !== 'entrada' || mov.category !== SALES_CATEGORY_ID) continue;
        const dt = financeDateKeyFromTimestamp(mov.createdAt);
        if (!inRange(dt)) continue;
        const idx = indexOf(dt);
        if (idx >= 0 && idx < n) centsArr[idx] += financeCents(mov.quantity * mov.unitPrice);
      }
      return { values: centsArr.map((c) => c / 100), total: sumToTotal() / 100 };
    }
    case 'cleaning_completed':
    case 'cleaning_avg_minutes':
    case 'cleaning_canceled': {
      const counts = Array<number>(n).fill(0);
      const durSums = Array<number>(n).fill(0);
      const durCounts = Array<number>(n).fill(0);
      let totalCompleted = 0;
      let timedCompleted = 0;
      for (const task of Object.values(ctx.cleaningTasks ?? {})) {
        if (metricId === 'cleaning_canceled') {
          if (task.status !== 'cancelado') continue;
          const dt = task.date || financeDateKeyFromTimestamp(task.assignedAt);
          if (!inRange(dt)) continue;
          const idx = indexOf(dt);
          if (idx >= 0 && idx < n) counts[idx] += 1;
          continue;
        }
        if (task.status !== 'concluido') continue;
        const dt = task.completedAt ? financeDateKeyFromTimestamp(task.completedAt) : task.date;
        if (!inRange(dt)) continue;
        const idx = indexOf(dt);
        if (idx < 0 || idx >= n) continue;
        counts[idx] += 1;
        totalCompleted += 1;
        if (task.assignedAt && task.completedAt) {
          const mins = (Date.parse(task.completedAt) - Date.parse(task.assignedAt)) / 60_000;
          if (Number.isFinite(mins) && mins >= MIN_CLEANING_MINUTES && mins <= MAX_CLEANING_MINUTES) {
            durSums[idx] += mins;
            durCounts[idx] += 1;
            timedCompleted += 1;
          }
        }
      }
      if (metricId === 'cleaning_avg_minutes') {
        const avgVals = durSums.map((s, i) => (durCounts[i] > 0 ? Math.round((s / durCounts[i]) * 10) / 10 : 0));
        const totSum = durSums.reduce((s, v) => s + v, 0);
        const totCnt = durCounts.reduce((s, v) => s + v, 0);
        const avgTotal = totCnt > 0 ? Math.round((totSum / totCnt) * 10) / 10 : 0;
        const note = totalCompleted > 0 && timedCompleted < totalCompleted
          ? `Tempo médio calculado sobre ${timedCompleted} de ${totalCompleted} limpezas com duração válida (1 min a 8h).`
          : undefined;
        return { values: avgVals, total: avgTotal, note };
      }
      return { values: counts, total: counts.reduce((s, v) => s + v, 0) };
    }
    case 'cleaning_doors_windows':
    case 'cleaning_concerns': {
      const counts = Array<number>(n).fill(0);
      for (const log of Object.values(ctx.cleaningLogs ?? {})) {
        const dt = log.date || financeDateKeyFromTimestamp(log.completedAt);
        if (!inRange(dt)) continue;
        if (metricId === 'cleaning_doors_windows' && !log.doorsAndWindows) continue;
        if (metricId === 'cleaning_concerns' && !log.usageConcern) continue;
        const idx = indexOf(dt);
        if (idx >= 0 && idx < n) counts[idx] += 1;
      }
      return { values: counts, total: counts.reduce((s, v) => s + v, 0) };
    }
    case 'occupancy_rate':
    case 'occupied_nights': {
      const rooms = ctx.roomNumbers ?? new Set<string>();
      const values = periods.map((p) => {
        const occ = reportOccupancy(ctx.data, rooms, p);
        if (metricId === 'occupancy_rate') return occ.rate === null ? 0 : Math.round(occ.rate * 10) / 10;
        return Math.round(occ.occupied * 10) / 10;
      });
      const whole = reportOccupancy(ctx.data, rooms, range);
      const total = metricId === 'occupancy_rate'
        ? (whole.rate === null ? 0 : Math.round(whole.rate * 10) / 10)
        : Math.round(whole.occupied * 10) / 10;
      return { values, total };
    }
    case 'stock_outputs_cost':
    case 'stock_outputs_qty': {
      const vals = Array<number>(n).fill(0);
      for (const rec of Object.values(ctx.stockOutputs ?? {})) {
        const dt = financeDateKeyFromTimestamp(rec.createdAt);
        if (!inRange(dt)) continue;
        const idx = indexOf(dt);
        if (idx < 0 || idx >= n) continue;
        for (const item of rec.items ?? []) {
          if (metricId === 'stock_outputs_qty') {
            vals[idx] += item.quantity;
          } else {
            const unitCost = resolveProductCost(item.productId, item.productName, ctx.inventoryProducts) ?? 0;
            vals[idx] += financeCents(item.quantity * unitCost);
          }
        }
      }
      if (metricId === 'stock_outputs_cost') {
        return { values: vals.map((c) => c / 100), total: vals.reduce((s, v) => s + v, 0) / 100 };
      }
      return { values: vals, total: vals.reduce((s, v) => s + v, 0) };
    }
    default:
      return { values: Array<number>(n).fill(0), total: 0 };
  }
}

interface CategoricalMapResult {
  map: Map<string, number>;
  total: number;
  note?: string;
}

function computeCategoricalSeries(
  series: ChartSeriesConfig,
  dimension: ChartWidgetConfig['dimension'],
  range: FinanceRange,
  ctx: CustomReportContext,
): CategoricalMapResult {
  const map = new Map<string, number>();
  const add = (key: string, delta: number) => {
    const label = key.trim() || 'Sem identificação';
    map.set(label, (map.get(label) ?? 0) + delta);
  };
  const inRange = (d: string) => d >= range.from && d <= range.to;
  const catSet = series.categories?.length ? new Set(series.categories.map(normalizeText)) : null;
  const basis = series.basis ?? 'accrual';
  const walletFilter = series.wallet ?? 'all';
  const metricId = series.metricId;

  const finalizeCents = (note?: string): CategoricalMapResult => {
    const out = new Map<string, number>();
    let totalC = 0;
    for (const [k, v] of map.entries()) {
      out.set(k, v / 100);
      totalC += v;
    }
    return { map: out, total: totalC / 100, note };
  };

  if (dimension === 'expense_category') {
    const useCash = metricId === 'expenses_paid' || metricId === 'oyo_compensated' || (metricId === 'expense_by_category' && basis === 'cash');
    const onlyOyo = metricId === 'oyo_compensated';
    if (useCash) {
      for (const exp of Object.values(ctx.data.expenses)) {
        if (ctx.data.suppressed[exp.id]) continue;
        if (catSet && !catSet.has(normalizeText(exp.category))) continue;
        for (const ev of expensePaymentEvents(exp)) {
          if (!inRange(ev.date)) continue;
          if (onlyOyo && ev.wallet !== 'oyo') continue;
          if (!onlyOyo && walletFilter !== 'all' && ev.wallet !== walletFilter) continue;
          add(exp.category, financeCents(ev.amount));
        }
      }
      if (!onlyOyo && (!catSet || catSet.has(normalizeText('Folha de pagamento')))) {
        for (const pr of Object.values(ctx.data.payroll)) {
          for (const ev of payrollPaymentEvents(pr)) {
            if (!inRange(ev.date)) continue;
            if (walletFilter !== 'all' && ev.wallet !== walletFilter) continue;
            add('Folha de pagamento', financeCents(ev.amount));
          }
        }
      }
    } else {
      for (const exp of Object.values(ctx.data.expenses)) {
        if (ctx.data.suppressed[exp.id]) continue;
        if (catSet && !catSet.has(normalizeText(exp.category))) continue;
        const dt = expenseRegistrationDate(ctx.data, exp);
        if (!inRange(dt)) continue;
        add(exp.category, financeCents(exp.plannedAmount));
      }
      if (!catSet || catSet.has(normalizeText('Folha de pagamento'))) {
        for (const pr of Object.values(ctx.data.payroll)) {
          if (!inRange(pr.dueDate)) continue;
          add('Folha de pagamento', financeCents(payrollNet(pr)));
        }
      }
    }
    return finalizeCents();
  }

  if (dimension === 'income_category') {
    for (const entry of Object.values(ctx.data.incomes)) {
      if (ctx.data.suppressed[entry.id] || !inRange(entry.date)) continue;
      if (catSet && !catSet.has(normalizeText(entry.category))) continue;
      for (const item of financeReceiptItems(entry)) {
        if (metricId === 'oyo_retained' && item.paymentMethod !== 'prepaid') continue;
        if (metricId === 'revenue' && isOyoFeeItem(entry, item)) continue;
        const w = incomePaymentWallet(item.paymentMethod);
        if (!w) continue;
        if (walletFilter !== 'all' && w !== walletFilter) continue;
        add(entry.category, financeCents(item.amount));
      }
    }
    return finalizeCents();
  }

  if (dimension === 'payment_method') {
    if (metricId === 'fridge_revenue') {
      for (const sale of Object.values(ctx.frigobarSales ?? {})) {
        if (ctx.data.suppressed[`frigobar-${sale.id}`]) continue;
        const dt = financeDateKeyFromTimestamp(sale.createdAt);
        if (!inRange(dt)) continue;
        add(paymentMethodLabel(sale.paymentMethod || 'outros'), financeCents(sale.amount));
      }
      return finalizeCents();
    }
    for (const entry of Object.values(ctx.data.incomes)) {
      if (ctx.data.suppressed[entry.id] || !inRange(entry.date)) continue;
      if (catSet && !catSet.has(normalizeText(entry.category))) continue;
      for (const item of financeReceiptItems(entry)) {
        if (item.paymentMethod === 'courtesy') continue;
        if (metricId === 'card_fees') {
          if (item.paymentMethod === 'credit' || item.paymentMethod === 'debit') {
            add(paymentMethodLabel(item.paymentMethod), financeCents(item.cardFeeAmount ?? 0));
          }
          continue;
        }
        if (metricId === 'oyo_counter_fees') {
          if (item.paymentMethod !== 'prepaid' && isOyoFeeItem(entry, item)) {
            add(paymentMethodLabel(item.paymentMethod), financeCents(item.amount));
          }
          continue;
        }
        if (metricId === 'received' && item.paymentMethod === 'prepaid') continue;
        if (metricId === 'revenue' && isOyoFeeItem(entry, item)) continue;
        add(paymentMethodLabel(item.paymentMethod), financeCents(item.amount));
      }
    }
    if (metricId === 'received') {
      for (const tr of Object.values(ctx.data.transfers)) {
        if (tr.from === 'oyo' && tr.to !== 'oyo' && inRange(tr.date)) {
          add('Repasses da OYO', financeCents(tr.amount));
        }
      }
    }
    return finalizeCents();
  }

  if (dimension === 'wallet') {
    if (metricId === 'wallet_balance_cash' || metricId === 'wallet_balance_bank') {
      const b = balancesAtDate(ctx.data, range.to);
      add(WALLET_LABELS.cash, financeCents(b.cash));
      add(WALLET_LABELS.bank, financeCents(b.bank));
      add(WALLET_LABELS.oyo, financeCents(b.oyo));
      return finalizeCents();
    }
    if (metricId === 'expenses_paid' || metricId === 'expense_by_category' || metricId === 'payroll_cost') {
      if (metricId !== 'payroll_cost') {
        for (const exp of Object.values(ctx.data.expenses)) {
          if (ctx.data.suppressed[exp.id]) continue;
          if (catSet && !catSet.has(normalizeText(exp.category))) continue;
          for (const ev of expensePaymentEvents(exp)) {
            if (!inRange(ev.date)) continue;
            add(WALLET_LABELS[ev.wallet], financeCents(ev.amount));
          }
        }
      }
      if (metricId === 'payroll_cost' || !catSet || catSet.has(normalizeText('Folha de pagamento'))) {
        for (const pr of Object.values(ctx.data.payroll)) {
          for (const ev of payrollPaymentEvents(pr)) {
            if (!inRange(ev.date)) continue;
            add(WALLET_LABELS[ev.wallet], financeCents(ev.amount));
          }
        }
      }
      return finalizeCents();
    }
    if (metricId === 'oyo_repasses' || metricId === 'oyo_sent') {
      for (const tr of Object.values(ctx.data.transfers)) {
        if (!inRange(tr.date)) continue;
        if (metricId === 'oyo_repasses' && tr.from === 'oyo' && tr.to !== 'oyo') {
          add(WALLET_LABELS[tr.to], financeCents(tr.amount));
        } else if (metricId === 'oyo_sent' && tr.to === 'oyo' && tr.from !== 'oyo') {
          add(WALLET_LABELS[tr.from], financeCents(tr.amount));
        }
      }
      return finalizeCents();
    }
    for (const entry of Object.values(ctx.data.incomes)) {
      if (ctx.data.suppressed[entry.id] || !inRange(entry.date)) continue;
      if (catSet && !catSet.has(normalizeText(entry.category))) continue;
      for (const item of financeReceiptItems(entry)) {
        const w = incomePaymentWallet(item.paymentMethod);
        if (!w) continue;
        if (metricId === 'received' && w === 'oyo') continue;
        add(WALLET_LABELS[w], financeCents(item.amount));
      }
    }
    return finalizeCents();
  }

  if (dimension === 'channel') {
    for (const entry of Object.values(ctx.data.incomes)) {
      if (ctx.data.suppressed[entry.id] || !inRange(entry.date)) continue;
      if (catSet && !catSet.has(normalizeText(entry.category))) continue;
      const ch = inferIncomeChannel(entry, ctx.data);
      for (const item of financeReceiptItems(entry)) {
        if (metricId === 'revenue' && isOyoFeeItem(entry, item)) continue;
        if (!incomePaymentWallet(item.paymentMethod)) continue;
        add(ch, financeCents(item.amount));
      }
    }
    return finalizeCents();
  }

  if (dimension === 'housekeeper') {
    if (metricId === 'cleaning_doors_windows' || metricId === 'cleaning_concerns') {
      for (const log of Object.values(ctx.cleaningLogs ?? {})) {
        const dt = log.date || financeDateKeyFromTimestamp(log.completedAt);
        if (!inRange(dt)) continue;
        if (metricId === 'cleaning_doors_windows' && !log.doorsAndWindows) continue;
        if (metricId === 'cleaning_concerns' && !log.usageConcern) continue;
        add(log.attendant || 'Sem nome', 1);
      }
      const total = [...map.values()].reduce((s, v) => s + v, 0);
      return { map, total };
    }
    const durSum = new Map<string, number>();
    const durCount = new Map<string, number>();
    let totalCompleted = 0;
    let timedCompleted = 0;
    for (const task of Object.values(ctx.cleaningTasks ?? {})) {
      const name = task.camareira?.trim() || 'Sem nome';
      if (metricId === 'cleaning_canceled') {
        if (task.status !== 'cancelado') continue;
        const dt = task.date || financeDateKeyFromTimestamp(task.assignedAt);
        if (!inRange(dt)) continue;
        add(name, 1);
        continue;
      }
      if (task.status !== 'concluido') continue;
      const dt = task.completedAt ? financeDateKeyFromTimestamp(task.completedAt) : task.date;
      if (!inRange(dt)) continue;
      add(name, 1);
      totalCompleted++;
      if (task.assignedAt && task.completedAt) {
        const mins = (Date.parse(task.completedAt) - Date.parse(task.assignedAt)) / 60_000;
        if (Number.isFinite(mins) && mins >= MIN_CLEANING_MINUTES && mins <= MAX_CLEANING_MINUTES) {
          durSum.set(name, (durSum.get(name) ?? 0) + mins);
          durCount.set(name, (durCount.get(name) ?? 0) + 1);
          timedCompleted++;
        }
      }
    }
    if (metricId === 'cleaning_avg_minutes') {
      const out = new Map<string, number>();
      let allSum = 0;
      let allCnt = 0;
      for (const name of map.keys()) {
        const cnt = durCount.get(name) ?? 0;
        const sm = durSum.get(name) ?? 0;
        out.set(name, cnt > 0 ? Math.round((sm / cnt) * 10) / 10 : 0);
        allSum += sm;
        allCnt += cnt;
      }
      const note = totalCompleted > 0 && timedCompleted < totalCompleted
        ? `Tempo médio calculado sobre ${timedCompleted} de ${totalCompleted} limpezas com início e conclusão válidos.`
        : undefined;
      return { map: out, total: allCnt > 0 ? Math.round((allSum / allCnt) * 10) / 10 : 0, note };
    }
    const total = [...map.values()].reduce((s, v) => s + v, 0);
    return { map, total };
  }

  if (dimension === 'fridge_product') {
    if (metricId === 'fridge_restock_cost') {
      for (const mov of Object.values(ctx.inventoryMovements ?? {})) {
        if (mov.type !== 'entrada' || mov.category !== SALES_CATEGORY_ID) continue;
        const dt = financeDateKeyFromTimestamp(mov.createdAt);
        if (!inRange(dt)) continue;
        add(mov.productName || mov.productId, financeCents(mov.quantity * mov.unitPrice));
      }
      return finalizeCents();
    }
    const revMap = new Map<string, number>();
    const cogsMap = new Map<string, number>();
    const qtyMap = new Map<string, number>();
    let totalItems = 0;
    let costedItems = 0;
    for (const sale of Object.values(ctx.frigobarSales ?? {})) {
      if (ctx.data.suppressed[`frigobar-${sale.id}`]) continue;
      const dt = financeDateKeyFromTimestamp(sale.createdAt);
      if (!inRange(dt)) continue;
      for (const item of sale.items ?? []) {
        totalItems++;
        const name = item.productName?.trim() || item.productId;
        revMap.set(name, (revMap.get(name) ?? 0) + financeCents(item.quantity * item.unitPrice));
        qtyMap.set(name, (qtyMap.get(name) ?? 0) + item.quantity);
        const unitCost = resolveProductCost(item.productId, name, ctx.inventoryProducts);
        if (unitCost !== null) {
          costedItems++;
          cogsMap.set(name, (cogsMap.get(name) ?? 0) + financeCents(item.quantity * unitCost));
        }
      }
    }
    const note = (metricId === 'fridge_cogs' || metricId === 'fridge_profit' || metricId === 'fridge_margin')
      && totalItems > 0 && costedItems < totalItems
      ? `CMV calculado sobre ${costedItems} de ${totalItems} itens com custo cadastrado no estoque.`
      : undefined;
    if (metricId === 'fridge_units') {
      return { map: qtyMap, total: [...qtyMap.values()].reduce((s, v) => s + v, 0) };
    }
    if (metricId === 'fridge_revenue') {
      for (const [k, v] of revMap) map.set(k, v);
      return finalizeCents();
    }
    if (metricId === 'fridge_cogs') {
      for (const [k, v] of cogsMap) map.set(k, v);
      return finalizeCents(note);
    }
    if (metricId === 'fridge_profit') {
      for (const [k, r] of revMap) map.set(k, r - (cogsMap.get(k) ?? 0));
      return finalizeCents(note);
    }
    // fridge_margin
    const out = new Map<string, number>();
    let totR = 0;
    let totC = 0;
    for (const [k, r] of revMap) {
      const c = cogsMap.get(k) ?? 0;
      totR += r;
      totC += c;
      out.set(k, r > 0 ? Math.round(((r - c) / r) * 1000) / 10 : 0);
    }
    return { map: out, total: totR > 0 ? Math.round(((totR - totC) / totR) * 1000) / 10 : 0, note };
  }

  if (dimension === 'stock_destination') {
    for (const rec of Object.values(ctx.stockOutputs ?? {})) {
      const dt = financeDateKeyFromTimestamp(rec.createdAt);
      if (!inRange(dt)) continue;
      const dest = rec.destination?.trim() || 'Não informado';
      for (const item of rec.items ?? []) {
        if (metricId === 'stock_outputs_qty') {
          add(dest, item.quantity);
        } else {
          const unitCost = resolveProductCost(item.productId, item.productName, ctx.inventoryProducts) ?? 0;
          add(dest, financeCents(item.quantity * unitCost));
        }
      }
    }
    if (metricId === 'stock_outputs_cost') return finalizeCents();
    return { map, total: [...map.values()].reduce((s, v) => s + v, 0) };
  }

  return { map, total: 0 };
}

function tickDateLabel(date: string, granularity: FinanceGranularity): string {
  return granularity === 'day'
    ? `${date.slice(8)}/${date.slice(5, 7)}`
    : `${date.slice(5, 7)}/${date.slice(2, 4)}`;
}

function fullPeriodCaption(from: string, to: string): string {
  return from === to ? financeDateLabel(from) : `${financeDateLabel(from)} a ${financeDateLabel(to)}`;
}

export function evaluateChartWidget(
  widget: ChartWidgetConfig,
  ctx: CustomReportContext,
): EvaluatedChartResult {
  const activeRange: FinanceRange = widget.periodOverride?.enabled && widget.periodOverride.from <= widget.periodOverride.to
    ? { from: widget.periodOverride.from, to: widget.periodOverride.to }
    : ctx.range;
  const effectiveRange: FinanceRange = {
    from: activeRange.from,
    to: activeRange.to < ctx.today ? activeRange.to : ctx.today,
  };
  const comparison = widget.style.showComparison ? previousReportRange(effectiveRange) : null;
  const dataNotesSet = new Set<string>();

  // Determine Y-axis assignment: if multiple distinct units in composed/line/bar chart, put secondary unit on right axis!
  const firstUnit: MetricUnit = getMetricDefinition(widget.series[0]?.metricId ?? '')?.unit ?? 'currency';
  let rightUnit: MetricUnit = firstUnit;
  const resolvedAxes = widget.series.map((s) => {
    const unit: MetricUnit = getMetricDefinition(s.metricId)?.unit ?? 'currency';
    if (s.yAxis === 'right') {
      rightUnit = unit;
      return 'right' as const;
    }
    if (s.yAxis === 'left') return 'left' as const;
    if (unit !== firstUnit) {
      rightUnit = unit;
      return 'right' as const;
    }
    return 'left' as const;
  });
  const hasRightAxis = resolvedAxes.some((a) => a === 'right');

  if (widget.dimension === 'timeline') {
    const buckets = financeDateBuckets(effectiveRange.from, effectiveRange.to, ctx.granularity);
    const revenueRows = dailyRevenueRows(ctx.data.incomes, ctx.data.stays ?? {}, ctx.data.suppressed);
    const regExpenses = registeredExpenses(ctx.data);
    const overview = financeOverview(ctx.data, effectiveRange, ctx.today, ctx.granularity);
    const breakfastCosts = breakfastCostRows(ctx.data, effectiveRange);
    const shared = { revenueRows, regExpenses, overview, breakfastCosts };

    const prevBuckets = comparison ? financeDateBuckets(comparison.range.from, comparison.range.to, ctx.granularity) : null;
    const prevShared = comparison
      ? {
        revenueRows,
        regExpenses,
        overview: financeOverview(ctx.data, comparison.range, ctx.today, ctx.granularity),
        breakfastCosts: breakfastCostRows(ctx.data, comparison.range),
      }
      : null;

    const rows: EvaluatedChartRow[] = buckets.periods.map((p) => ({
      key: p.from,
      label: tickDateLabel(p.from, ctx.granularity),
      fullLabel: fullPeriodCaption(p.from, p.to),
      values: {},
    }));

    const seriesMeta: EvaluatedSeriesMeta[] = widget.series.map((s, idx) => {
      const def = getMetricDefinition(s.metricId);
      const cur = computeTimelineSeries(s, effectiveRange, ctx, buckets, shared);
      if (cur.note) dataNotesSet.add(cur.note);
      cur.values.forEach((v, i) => {
        if (rows[i]) rows[i].values[s.id] = v;
      });
      const prev = comparison && prevBuckets && prevShared
        ? computeTimelineSeries(s, comparison.range, ctx, prevBuckets, prevShared)
        : null;
      return {
        id: s.id,
        metricId: s.metricId,
        label: seriesDisplayLabel(s),
        color: s.color || def?.defaultColor || '#4c60cf',
        unit: def?.unit ?? 'currency',
        visualType: s.visualType ?? (idx === 0 ? 'bar' : 'line'),
        yAxis: resolvedAxes[idx],
        total: cur.total,
        previousTotal: prev ? prev.total : null,
        changePct: prev ? reportChange(cur.total, prev.total) : null,
        lessIsBetter: Boolean(def?.lessIsBetter),
      };
    });

    return {
      effectiveRange,
      comparisonLabel: comparison?.label ?? null,
      rows,
      series: seriesMeta,
      hasRightAxis,
      leftUnit: firstUnit,
      rightUnit,
      dataNotes: [...dataNotesSet],
    };
  }

  // Categorical dimensions (expense_category, income_category, payment_method, wallet, channel, housekeeper, fridge_product, stock_destination)
  const keySet = new Set<string>();
  const currentBySeries = widget.series.map((s) => {
    const res = computeCategoricalSeries(s, widget.dimension, effectiveRange, ctx);
    if (res.note) dataNotesSet.add(res.note);
    for (const k of res.map.keys()) keySet.add(k);
    return res;
  });
  const previousBySeries = comparison
    ? widget.series.map((s) => computeCategoricalSeries(s, widget.dimension, comparison.range, ctx))
    : null;

  const primarySeries = widget.series[0];
  let rows: EvaluatedChartRow[] = [...keySet].map((key) => {
    const values: Record<string, number> = {};
    const previousValues: Record<string, number> = {};
    widget.series.forEach((s, idx) => {
      values[s.id] = currentBySeries[idx].map.get(key) ?? 0;
      if (previousBySeries) previousValues[s.id] = previousBySeries[idx].map.get(key) ?? 0;
    });
    return {
      key,
      label: key,
      fullLabel: key,
      values,
      ...(previousBySeries ? { previousValues } : {}),
    };
  });

  // Sort descending by primary series absolute value
  if (primarySeries) {
    rows.sort((a, b) => Math.abs(b.values[primarySeries.id] ?? 0) - Math.abs(a.values[primarySeries.id] ?? 0));
  }

  // Group into "Demais" if donut/pie and exceeding topN
  const topN = Math.max(3, Math.min(20, widget.style.topN || 6));
  if ((widget.chartType === 'donut' || widget.chartType === 'pie') && rows.length > topN && primarySeries) {
    const positiveRows = rows.filter((r) => (r.values[primarySeries.id] ?? 0) > 0);
    if (positiveRows.length > topN) {
      const head = positiveRows.slice(0, topN - 1);
      const rest = positiveRows.slice(topN - 1);
      const groupedValues: Record<string, number> = {};
      const groupedPrev: Record<string, number> = {};
      widget.series.forEach((s) => {
        groupedValues[s.id] = rest.reduce((sum, r) => sum + financeCents(r.values[s.id] ?? 0), 0) / 100;
        if (previousBySeries) {
          groupedPrev[s.id] = rest.reduce((sum, r) => sum + financeCents(r.previousValues?.[s.id] ?? 0), 0) / 100;
        }
      });
      rows = [
        ...head,
        {
          key: '__others__',
          label: 'Demais itens',
          fullLabel: `Demais itens (${rest.length})`,
          values: groupedValues,
          ...(previousBySeries ? { previousValues: groupedPrev } : {}),
        },
      ];
    } else {
      rows = positiveRows;
    }
  } else if (widget.chartType === 'horizontal_bar' || widget.chartType === 'breakdown') {
    if (rows.length > topN && topN < 20) {
      rows = rows.slice(0, topN);
    }
  }

  const seriesMeta: EvaluatedSeriesMeta[] = widget.series.map((s, idx) => {
    const def = getMetricDefinition(s.metricId);
    const curTotal = currentBySeries[idx].total;
    const prevTotal = previousBySeries ? previousBySeries[idx].total : null;
    return {
      id: s.id,
      metricId: s.metricId,
      label: seriesDisplayLabel(s),
      color: s.color || def?.defaultColor || '#4c60cf',
      unit: def?.unit ?? 'currency',
      visualType: s.visualType ?? (idx === 0 ? 'bar' : 'line'),
      yAxis: resolvedAxes[idx],
      total: curTotal,
      previousTotal: prevTotal,
      changePct: prevTotal !== null ? reportChange(curTotal, prevTotal) : null,
      lessIsBetter: Boolean(def?.lessIsBetter),
    };
  });

  return {
    effectiveRange,
    comparisonLabel: comparison?.label ?? null,
    rows,
    series: seriesMeta,
    hasRightAxis,
    leftUnit: firstUnit,
    rightUnit,
    dataNotes: [...dataNotesSet],
  };
}
