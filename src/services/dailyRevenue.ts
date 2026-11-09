import { incomeItems, isOyoFeeItem, type FinanceIncome } from '../types/finance';
import { stayBreakfastDays, stayDailyAmount, type GuestStay } from '../types/reception';
import { financeCents as toCents, financeDateBuckets, type FinanceGranularity } from './financePayments';

export interface DailyRevenueRow {
  incomeId: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  prepaid: number;
  spread: boolean;
  note: string;
  paidOn: string;
  methods: { method: string; amount: number }[];
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function distribute(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((weight) => Math.floor(sum > 0 ? (total * weight) / sum : total / weights.length));
  let rest = total - shares.reduce((a, b) => a + b, 0);
  for (let index = shares.length - 1; rest > 0; index = (index - 1 + shares.length) % shares.length, rest -= 1) shares[index] += 1;
  return shares;
}

function stayOfIncome(income: FinanceIncome, stays: GuestStay[]): GuestStay | undefined {
  return stays.find((stay) => income.id.startsWith(`recepcao-${stay.id}-`) || Boolean(stay.receipts?.[income.id]));
}

/**
 * Regime de competência: diárias e café de hospedagens com várias noites são
 * rateados em cada dia de estadia, mesmo quando foram pagos de uma só vez
 * (inclui pré-pagos). Os demais lançamentos ficam na data do próprio lançamento.
 */
export function dailyRevenueRows(incomes: Record<string, FinanceIncome>, stays: Record<string, GuestStay>, suppressed: Record<string, boolean> = {}): DailyRevenueRow[] {
  const list = Object.values(stays);
  const rows: DailyRevenueRow[] = [];
  for (const income of Object.values(incomes)) {
    if (suppressed[income.id]) continue;
    const items = incomeItems(income).filter((item) => !isOyoFeeItem(income, item));
    const total = items.reduce((sum, item) => sum + toCents(item.amount), 0);
    if (total <= 0) continue;
    const prepaidTotal = items.filter((item) => item.paymentMethod === 'prepaid').reduce((sum, item) => sum + toCents(item.amount), 0);
    const note = income.note ?? '';
    const methodTotals = new Map<string, number>();
    items.forEach((item) => methodTotals.set(item.paymentMethod, (methodTotals.get(item.paymentMethod) ?? 0) + toCents(item.amount)));
    const methodShares = (fraction: number) => [...methodTotals].map(([method, cents]) => ({ method, amount: Math.round(cents * fraction) / 100 }));
    const description = items.map((item) => item.description).filter(Boolean).join(' | ');
    const stay = income.category === 'Diária' || income.category === 'Café' ? stayOfIncome(income, list) : undefined;
    let dates: string[] = [];
    let weights: number[] = [];
    if (stay && stay.kind !== 'periodo' && stay.nights > 1) {
      if (income.category === 'Diária') {
        dates = Array.from({ length: stay.nights }, (_, index) => addDays(stay.checkInDate, index));
        const rates = stay.nightlyRates;
        weights = rates && rates.length === stay.nights && stayDailyAmount(stay) > 0 ? rates.map(toCents) : dates.map(() => 1);
      } else {
        const days = stayBreakfastDays(stay);
        dates = Array.from({ length: days }, (_, index) => addDays(stay.checkInDate, index + 1));
        weights = dates.map(() => 1);
      }
    }
    if (dates.length <= 1) {
      rows.push({ incomeId: income.id, date: income.date, category: income.category, description, amount: total / 100, prepaid: prepaidTotal / 100, spread: false, note, paidOn: income.date, methods: methodShares(1) });
      continue;
    }
    const shares = distribute(total, weights);
    const prepaidShares = distribute(prepaidTotal, weights);
    dates.forEach((date, index) => rows.push({ incomeId: income.id, date, category: income.category, description: `${description} · dia ${index + 1}/${dates.length}`, amount: shares[index] / 100, prepaid: prepaidShares[index] / 100, spread: true, note, paidOn: income.date, methods: methodShares(total > 0 ? shares[index] / total : 0) }));
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category));
}

export function revenueTimeline(rows: DailyRevenueRow[], range: { from: string; to: string }, granularity?: FinanceGranularity) {
  const { periods, indexOf } = financeDateBuckets(range.from, range.to, granularity);
  const points = periods.map((period) => ({ ...period, revenue: 0 }));
  let total = 0;
  for (const { date, amount } of rows) {
    if (date < range.from || date > range.to) continue;
    const point = points[indexOf(date)];
    if (!point) continue;
    const cents = toCents(amount);
    point.revenue += cents;
    total += cents;
  }
  return { points: points.map((point) => ({ ...point, revenue: point.revenue / 100 })), total: total / 100 };
}
