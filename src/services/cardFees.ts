import { incomeItems, type FinanceData, type FinanceIncome, type FinanceIncomeItem } from '../types/finance';

export const CARD_FEE_CATEGORY = 'Taxas da máquina de cartão';

// Versions are append-only: a new rate never changes a receipt recorded before it.
export function withCardFees(data: FinanceData): FinanceData {
  const incomes = { ...data.incomes };
  const expenses = Object.fromEntries(Object.entries(data.expenses).filter(([, entry]) => !entry.generatedFromIncome));
  const schedule = Object.values(data.cardFeeSchedule ?? {}).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt));
  for (const entry of Object.values(incomes)) {
    if (data.suppressed[entry.id]) continue;
    const rates = schedule.find((rate) => rate.effectiveAt <= entry.createdAt);
    const items: FinanceIncomeItem[] = incomeItems(entry).map((item) => {
      if (item.paymentMethod !== 'credit' && item.paymentMethod !== 'debit') {
        const { cardFeeRate: _rate, cardFeeAmount: _fee, netAmount: _net, ...original } = item;
        void _rate; void _fee; void _net;
        return original;
      }
      const rate = item.cardFeeRate ?? rates?.[item.paymentMethod] ?? 0;
      const grossCents = Math.round(item.amount * 100);
      const feeCents = Math.round(grossCents * rate / 100);
      return { ...item, cardFeeRate: rate, cardFeeAmount: feeCents / 100, netAmount: (grossCents - feeCents) / 100 };
    });
    // Preserve legacy records without configured fees.
    if (!rates && !items.some((item) => item.cardFeeRate !== undefined && item.cardFeeRate > 0)) continue;
    incomes[entry.id] = { ...entry, items };
    const fee = items.reduce((sum, item) => sum + Math.round((item.cardFeeAmount ?? 0) * 100), 0) / 100;
    if (!fee) continue;
    const id = `card-fee-${entry.id}`;
    expenses[id] = { id, generatedFromIncome: entry.id, dueDate: entry.date, category: CARD_FEE_CATEGORY,
      plannedAmount: fee, paidCash: 0, paidBank: fee, paidDate: entry.date,
      payments: { [id]: { id, date: entry.date, wallet: 'bank', amount: fee, dateSource: 'informed' } },
      note: `Taxa descontada do recebimento ${entry.id}. ${items.filter((item) => item.cardFeeAmount).map((item) => `${item.paymentMethod === 'credit' ? 'Crédito' : 'Débito'}: ${item.cardFeeRate}%`).join(' · ')}`,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }
  return { ...data, incomes, expenses };
}

export function cardReceiptSummary(entry: FinanceIncome) {
  const fee = incomeItems(entry).reduce((sum, item) => sum + Math.round((item.cardFeeAmount ?? 0) * 100), 0) / 100;
  return { gross: entry.amount, fee, net: Math.round((entry.amount - fee) * 100) / 100 };
}
