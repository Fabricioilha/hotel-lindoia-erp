import { dailyRevenueRows, revenueTimeline } from './dailyRevenue';
import { registeredExpenses } from './financeAnalytics';
import { financeOverview, type FinanceRange } from './financeOverview';
import { financeCents, financeDateBuckets, financeDateKeyFromTimestamp, financeMonthRange, isFinanceDateKey, type FinanceGranularity } from './financePayments';
import { stayCheckOutDate } from './reservationAnalytics';
import type { FinanceData } from '../types/finance';

export type ReportMode = 'performance' | 'cash';

const DAY_MS = 86_400_000;
const dayTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
export const reportDays = ({ from, to }: FinanceRange) => Math.max(0, (dayTime(to) - dayTime(from)) / DAY_MS + 1);

export function shiftReportDay(date: string, days: number) {
  return new Date(dayTime(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function previousReportMonth(date: string): FinanceRange {
  return financeMonthRange(shiftReportDay(date.slice(0, 7) + '-01', -1).slice(0, 7));
}

export function previousReportRange(range: FinanceRange): { range: FinanceRange; label: string } | null {
  const days = reportDays(range);
  if (!days) return null;
  if (range.from.slice(0, 7) === range.to.slice(0, 7)) {
    const month = previousReportMonth(range.from);
    const fullMonth = financeMonthRange(range.from.slice(0, 7));
    const dateInMonth = (date: string) => month.from.slice(0, 8) + String(Math.min(Number(date.slice(8)), Number(month.to.slice(8)))).padStart(2, '0');
    return {
      range: { from: dateInMonth(range.from), to: range.from === fullMonth.from && range.to === fullMonth.to ? month.to : dateInMonth(range.to) },
      label: 'vs. mês anterior',
    };
  }
  return { range: { from: shiftReportDay(range.from, -days), to: shiftReportDay(range.from, -1) }, label: 'vs. período anterior' };
}

export function reportChange(value: number, previous: number | null) {
  if (previous === null) return null;
  if (previous === 0) return value === 0 ? 0 : null;
  return (value - previous) / Math.abs(previous) * 100;
}

export function reportOccupancy(data: FinanceData, roomNumbers: Set<string>, range: FinanceRange) {
  const available = roomNumbers.size * reportDays(range);
  if (!available) return { rate: null, occupied: 0, available: 0 };

  const byRoom = new Map<string, { from: number; until: number }[]>();
  const rangeEnd = dayTime(range.to) + DAY_MS;
  const addStay = (room: string, arrival: string, departure: string) => {
    const number = room.trim();
    if (!roomNumbers.has(number) || !isFinanceDateKey(arrival) || !isFinanceDateKey(departure)) return;
    const from = Math.max(dayTime(range.from), dayTime(arrival));
    const until = Math.min(rangeEnd, dayTime(departure));
    if (from >= until) return;
    const stays = byRoom.get(number) ?? [];
    stays.push({ from, until });
    byRoom.set(number, stays);
  };

  for (const stay of Object.values(data.stays ?? {})) {
    if (stay.kind !== 'hospede' || stay.awaitingArrival || !['hospedado', 'encerrado'].includes(stay.status)) continue;
    if (stay.checkedOutAt && !Number.isFinite(Date.parse(stay.checkedOutAt))) continue;
    addStay(stay.roomNumber, stay.checkInDate, stayCheckOutDate(stay));
  }
  for (const reservation of Object.values(data.reservations ?? {})) {
    if (reservation.channel === 'rotativo' || !['hospedado', 'encerrada'].includes(reservation.status)) continue;
    const departure = reservation.checkedOutAt && financeDateKeyFromTimestamp(reservation.checkedOutAt);
    addStay(reservation.roomNumber, reservation.checkInDate, departure || reservation.checkOutDate);
  }

  let occupied = 0;
  for (const stays of byRoom.values()) {
    let end = -Infinity;
    for (const { from, until } of stays.sort((a, b) => a.from - b.from)) {
      occupied += Math.max(0, until - Math.max(from, end)) / DAY_MS;
      end = Math.max(end, until);
    }
  }
  return { rate: occupied / available * 100, occupied, available };
}

export interface ReportPoint extends FinanceRange {
  revenue: number;
  expenses: number;
  incoming: number;
  outgoing: number;
}

export interface ReportCategory {
  label: string;
  value: number;
}

function reportPeriod(data: FinanceData, rows: ReturnType<typeof dailyRevenueRows>, expenses: ReturnType<typeof registeredExpenses>,
  range: FinanceRange, granularity: FinanceGranularity, today: string) {
  const overview = financeOverview(data, range, today, granularity);
  const revenue = revenueTimeline(rows, range, granularity);
  const { indexOf } = financeDateBuckets(range.from, range.to, granularity);
  const expensesByPoint = Array<number>(revenue.points.length).fill(0);
  const categories = new Map<string, number>();
  for (const { date, category, amount } of expenses) {
    if (date < range.from || date > range.to || !Number.isFinite(amount)) continue;
    const value = financeCents(amount);
    expensesByPoint[indexOf(date)] += value;
    categories.set(category, (categories.get(category) ?? 0) + value);
  }
  const adjustments = Object.values(data.cashAdjustments ?? {}).reduce((sum, { date, amount }) =>
    date >= range.from && date <= range.to && Number.isFinite(amount) ? sum + financeCents(amount) : sum, 0);
  const points: ReportPoint[] = revenue.points.map((point, index) => ({
    ...point, expenses: expensesByPoint[index] / 100, incoming: overview.timeline[index]?.incoming ?? 0, outgoing: overview.timeline[index]?.outgoing ?? 0,
  }));
  return {
    overview, points, revenue: revenue.total,
    profit: (financeCents(revenue.total) - financeCents(overview.expenses)) / 100,
    cashResult: (financeCents(overview.received) - financeCents(overview.outflow) + adjustments) / 100,
    registeredCategories: [...categories].map(([label, cents]) => ({ label, value: cents / 100 })),
  };
}

export function financeReport(data: FinanceData, range: FinanceRange, today: string, granularity: FinanceGranularity) {
  const effective = { from: range.from, to: range.to < today ? range.to : today };
  const comparison = previousReportRange(effective);
  const rows = dailyRevenueRows(data.incomes, data.stays ?? {}, data.suppressed);
  const expenses = registeredExpenses(data);
  return {
    effective, comparison,
    current: reportPeriod(data, rows, expenses, effective, granularity, today),
    previous: comparison ? reportPeriod(data, rows, expenses, comparison.range, granularity, today) : null,
  };
}

export function reportCategorySlices(rows: ReportCategory[], previous: ReportCategory[]) {
  const sorted = rows.filter(({ value }) => value > 0).sort((a, b) => b.value - a.value);
  const previousByName = new Map(previous.map(({ label, value }) => [label, value]));
  const slices = sorted.slice(0, sorted.length > 6 ? 5 : 6).map(({ label, value }) => ({ label, value, previous: previousByName.get(label) ?? 0 }));
  if (sorted.length > 6) {
    const rest = sorted.slice(5);
    slices.push({ label: 'Demais categorias',
      value: rest.reduce((sum, row) => sum + financeCents(row.value), 0) / 100,
      previous: rest.reduce((sum, row) => sum + financeCents(previousByName.get(row.label) ?? 0), 0) / 100,
    });
  }
  return slices;
}
