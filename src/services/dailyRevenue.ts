import { incomeItems, type FinanceIncome } from '../types/finance';
import { stayBreakfastDays, stayDailyAmount, type GuestStay } from '../types/reception';

export interface DailyRevenueRow {
  incomeId: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  prepaid: number;
  spread: boolean;
}

const toCents = (value: number) => Math.round(value * 100);

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
export function dailyRevenueRows(incomes: Record<string, FinanceIncome>, stays: Record<string, GuestStay>): DailyRevenueRow[] {
  const list = Object.values(stays);
  const rows: DailyRevenueRow[] = [];
  for (const income of Object.values(incomes)) {
    const items = incomeItems(income);
    const total = items.reduce((sum, item) => sum + toCents(item.amount), 0);
    if (total <= 0) continue;
    const prepaidTotal = items.filter((item) => item.paymentMethod === 'prepaid').reduce((sum, item) => sum + toCents(item.amount), 0);
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
      rows.push({ incomeId: income.id, date: income.date, category: income.category, description, amount: total / 100, prepaid: prepaidTotal / 100, spread: false });
      continue;
    }
    const shares = distribute(total, weights);
    const prepaidShares = distribute(prepaidTotal, weights);
    dates.forEach((date, index) => rows.push({ incomeId: income.id, date, category: income.category, description: `${description} · dia ${index + 1}/${dates.length}`, amount: shares[index] / 100, prepaid: prepaidShares[index] / 100, spread: true }));
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category));
}
