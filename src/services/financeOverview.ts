import { financeReceiptItems, isOyoFeeItem, payrollNet, type FinanceData, type FinanceIncome, type FinanceIncomeItem, type FinancePaymentMethod, type FinancePaymentEvent } from '../types/finance';
import { balancesAtDate } from './financeAnalytics';
import { expensePaymentEvents, financeCents, financeDateBuckets, payrollPaymentEvents } from './financePayments';

export type FinanceRange = { from: string; to: string };

const extraLabels = new Set(['Extras', 'Cama extra', 'Colchão extra', 'Adicional de hóspede', 'Adicional de troca de quarto', 'Check-in antecipado', 'Checkout tardio', 'Modificação de reserva']);

function saleGroup(entry: FinanceIncome, item: FinanceIncomeItem) {
  const description = (item.description ?? '').split(' · ')[0];
  if (/^(frigobar|minibar)-/.test(entry.id)
    || (entry.category === 'Consumo' && (entry.id.startsWith('room-charge-') || /geladeira|frigobar/i.test(item.description + ' ' + entry.note)))
    || /^(Geladeira|Frigobar)$/.test(entry.category)) return 'geladeira';
  if (entry.category === 'Café' || entry.category === 'Café da manhã' || description === 'Café da manhã') return 'breakfast';
  if (extraLabels.has(entry.category) || extraLabels.has(description)) return 'extras';
}

export function financeOverview(data: FinanceData, range: FinanceRange, today: string) {
  const asOf = range.to < today ? range.to : today;
  const { periods, indexOf } = financeDateBuckets(range.from, asOf);
  const timeline = periods.map((period) => ({ ...period, incoming: 0, outgoing: 0 }));
  const inPeriod = (date: string) => date >= range.from && date <= asOf;
  const dueInPeriod = (date: string) => date >= range.from && date <= range.to;
  const bucket = (date: string) => timeline[indexOf(date)];
  const methods: Record<FinancePaymentMethod, number> = { cash: 0, credit: 0, debit: 0, pix: 0, bank_transfer: 0, prepaid: 0 };
  const sales = { geladeira: 0, breakfast: 0, extras: 0 };
  let counterFees = 0;
  let cardFees = 0;
  let repasses = 0;
  let cashRepasses = 0;
  let sentToOyo = 0;
  let plannedExpenses = 0;
  const paid = { cash: 0, bank: 0, oyo: 0 };
  const categories = new Map<string, number>();

  for (const [id, sale] of Object.entries(data.geladeiraSales ?? {})) {
    if (!data.suppressed[id] && inPeriod(sale.date)) sales.geladeira += financeCents(sale.amount);
  }
  for (const entry of Object.values(data.incomes)) {
    if (data.suppressed[entry.id] || !inPeriod(entry.date)) continue;
    const day = bucket(entry.date);
    if (!day) continue;
    for (const item of financeReceiptItems(entry)) {
      if (!Object.hasOwn(methods, item.paymentMethod) || !Number.isFinite(item.amount)) continue;
      const amount = financeCents(item.amount);
      const oyoFee = isOyoFeeItem(entry, item);
      methods[item.paymentMethod] += amount;
      if (item.paymentMethod !== 'prepaid') {
        day.incoming += amount;
        if (oyoFee) counterFees += amount;
      }
      if (item.paymentMethod === 'credit' || item.paymentMethod === 'debit') cardFees += financeCents(item.cardFeeAmount ?? 0);
      const group = oyoFee ? undefined : saleGroup(entry, item);
      if (group && (group !== 'geladeira' || !data.geladeiraSales?.[entry.id])) sales[group] += amount;
    }
  }
  for (const transfer of Object.values(data.transfers)) {
    if (!inPeriod(transfer.date) || !Number.isFinite(transfer.amount)) continue;
    const day = bucket(transfer.date);
    if (!day) continue;
    const amount = financeCents(transfer.amount);
    if (transfer.from === 'oyo' && transfer.to !== 'oyo') {
      repasses += amount;
      if (transfer.to === 'cash') cashRepasses += amount;
      day.incoming += amount;
    } else if (transfer.to === 'oyo' && transfer.from !== 'oyo') {
      sentToOyo += amount;
      day.outgoing += amount;
    }
  }

  function collectPayments(category: string, events: FinancePaymentEvent[]) {
    for (const event of events) {
      if (!inPeriod(event.date) || !Object.hasOwn(paid, event.wallet) || !Number.isFinite(event.amount)) continue;
      const day = bucket(event.date);
      if (!day) continue;
      const amount = financeCents(event.amount);
      paid[event.wallet] += amount;
      if (event.wallet !== 'oyo') day.outgoing += amount;
      categories.set(category, (categories.get(category) ?? 0) + amount);
    }
  }
  for (const entry of Object.values(data.expenses)) {
    if (data.suppressed[entry.id]) continue;
    const statement = entry.cardStatementId ? data.cardStatements?.[entry.cardStatementId] : undefined;
    if (dueInPeriod(statement?.dueDate ?? entry.dueDate)) plannedExpenses += financeCents(entry.plannedAmount);
    collectPayments(entry.category, expensePaymentEvents(entry));
  }
  for (const entry of Object.values(data.payroll)) {
    if (dueInPeriod(entry.dueDate)) plannedExpenses += financeCents(payrollNet(entry));
    collectPayments('Folha de pagamento', payrollPaymentEvents(entry));
  }

  return {
    asOf,
    balances: balancesAtDate(data, asOf),
    methods: { cash: methods.cash / 100, credit: methods.credit / 100, debit: methods.debit / 100, pix: methods.pix / 100, bankTransfer: methods.bank_transfer / 100 },
    incomingCash: (methods.cash + cashRepasses) / 100,
    cardGross: (methods.credit + methods.debit) / 100,
    cardNet: (methods.credit + methods.debit - cardFees) / 100,
    sales: { geladeira: sales.geladeira / 100, breakfast: sales.breakfast / 100, extras: sales.extras / 100 },
    expenses: plannedExpenses / 100,
    expensesPaid: (paid.cash + paid.bank + paid.oyo) / 100,
    compensated: paid.oyo / 100,
    received: (methods.cash + methods.credit + methods.debit + methods.pix + methods.bank_transfer + repasses) / 100,
    outflow: (paid.cash + paid.bank + sentToOyo) / 100,
    counterFees: counterFees / 100,
    prepaid: methods.prepaid / 100,
    repasses: repasses / 100,
    timeline: timeline.map((point) => ({ ...point, incoming: point.incoming / 100, outgoing: point.outgoing / 100 })),
    expenseCategories: [...categories].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([label, cents]) => ({ label, value: cents / 100 })),
  };
}
