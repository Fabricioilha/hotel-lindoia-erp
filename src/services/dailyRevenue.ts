import { incomeItems, isOyoFeeItem, type FinanceIncome } from '../types/finance';
import { stayBaseNights, type GuestStay } from '../types/reception';
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

function serviceDates(stay: GuestStay, income: FinanceIncome): string[] {
  if (stay.kind === 'periodo') return [];
  const receipt = stay.receipts?.[income.id];
  const lineId = receipt?.billingLineId ?? income.id.replace(/-p\d+$/, '');
  const renewalMatch = new RegExp(`^recepcao-${stay.id}-renovacao-(.+)-(diaria|cafe)$`).exec(lineId);
  const renewal = renewalMatch ? stay.renewals?.[renewalMatch[1]] : undefined;
  if (renewal) {
    if (income.category === 'Diária') return Array.from({ length: renewal.nights }, (_, index) => addDays(renewal.startDate, index));
    if (income.category === 'Café' && renewal.hasBreakfast) return Array.from({ length: renewal.breakfastDays }, (_, index) => addDays(renewal.startDate, index + 1));
    return [];
  }
  if (income.category === 'Diária') {
    const nights = stayBaseNights(stay);
    return Array.from({ length: nights }, (_, index) => addDays(stay.checkInDate, index));
  }
  if (income.category === 'Café' && stay.hasBreakfast) {
    const renewalBreakfastDays = Object.values(stay.renewals ?? {}).reduce((sum, item) => sum + (item.hasBreakfast ? item.breakfastDays : 0), 0);
    const days = Math.max(0, Math.floor(stay.baseBreakfastDays ?? ((stay.breakfastDays ?? stay.nights) - renewalBreakfastDays)));
    return Array.from({ length: days }, (_, index) => addDays(stay.checkInDate, index + 1));
  }
  return [];
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
    const dates = stay ? serviceDates(stay, income) : [];
    let weights = dates.map(() => 1);
    if (stay && income.category === 'Diária' && dates.length) {
      const lineId = stay.receipts?.[income.id]?.billingLineId ?? income.id.replace(/-p\d+$/, '');
      const renewalLine = new RegExp(`^recepcao-${stay.id}-renovacao-(.+)-diaria$`).test(lineId);
      if (!renewalLine && stay.nightlyRates?.length === dates.length) weights = stay.nightlyRates.map(toCents);
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
