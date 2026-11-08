import type { CardStatement, FinanceData, FinanceExpense, FinancePaymentEvent } from '../types/finance';
import { expensePaymentEvents, financeCents, financeDateKeyFromTimestamp, isFinanceDateKey, paymentEventTotals } from './financePayments';

export function cardPurchasePending(expense: FinanceExpense): number {
  return (financeCents(expense.plannedAmount) - expensePaymentEvents(expense).reduce((sum, event) => sum + financeCents(event.amount), 0)) / 100;
}

export function unassignedCardPurchases(data: FinanceData) {
  return Object.values(data.expenses).filter((expense) => expense.purchaseMethod === 'card' && expense.cardCategory
    && !expense.cardStatementId && !data.suppressed[expense.id] && cardPurchasePending(expense) > 0);
}

export function cardStatementPending(data: FinanceData, statement: CardStatement) {
  return Object.keys(statement.originalDueDates).reduce((sum, id) => {
    const expense = data.expenses[id];
    return sum + (expense ? financeCents(cardPurchasePending(expense)) : 0);
  }, 0) / 100;
}

function saveStatement(data: FinanceData, statement: CardStatement, expenses: FinanceData['expenses']): FinanceData {
  return { ...data, expenses, cardStatements: { ...data.cardStatements, [statement.id]: statement } };
}

export function groupCardPurchases(data: FinanceData, input: {
  id: string; cardCategory: string; dueDate: string; expenseIds: string[]; expectedAmount: number;
}, stamp: string): FinanceData {
  const { id, cardCategory, dueDate, expenseIds, expectedAmount } = input;
  if (!isFinanceDateKey(dueDate) || !cardCategory || !expenseIds.length || new Set(expenseIds).size !== expenseIds.length) {
    throw new Error('Selecione as compras de um cartão e informe o vencimento da fatura.');
  }
  if (data.cardStatements?.[id]) throw new Error('Esta fatura já foi registrada.');
  const statement: CardStatement = { id, cardCategory, dueDate, originalDueDates: {} };
  const expenses = { ...data.expenses };
  let pending = 0;
  for (const expenseId of expenseIds) {
    const expense = expenses[expenseId];
    if (!expense || data.suppressed[expenseId] || expense.cardStatementId || expense.purchaseMethod !== 'card'
      || expense.cardCategory !== cardCategory || cardPurchasePending(expense) <= 0) {
      throw new Error('Uma das compras mudou ou já está em outra fatura. Confira a seleção.');
    }
    statement.originalDueDates[expenseId] = expense.dueDate;
    pending += financeCents(cardPurchasePending(expense));
    // Mantém a data usada pelos pagamentos antigos ao trocar o vencimento.
    const payments = Object.fromEntries(expensePaymentEvents(expense).map((event) => [event.id, event]));
    expenses[expenseId] = { ...expense, cardStatementId: id, dueDate, payments, updatedAt: stamp };
  }
  if (pending !== financeCents(expectedAmount)) throw new Error('O valor das compras mudou. Confira o total antes de salvar.');
  return saveStatement(data, statement, expenses);
}

function withEvents(expense: FinanceExpense, events: FinancePaymentEvent[], stamp: string): FinanceExpense {
  const totals = paymentEventTotals(events);
  const next = { ...expense, payments: Object.fromEntries(events.map((event) => [event.id, event])),
    paidCash: totals.cash, paidBank: totals.bank, paidOyo: totals.oyo, updatedAt: stamp };
  const last = events.map((event) => event.date).sort().at(-1);
  if (last) next.paidDate = last;
  else delete next.paidDate;
  return next;
}

export function payCardStatement(data: FinanceData, id: string, payment: NonNullable<CardStatement['payment']>, stamp: string): FinanceData {
  const statement = data.cardStatements?.[id];
  if (!statement || statement.payment) throw new Error('Esta fatura já está paga ou foi desagrupada.');
  if (!isFinanceDateKey(payment.date) || payment.date > financeDateKeyFromTimestamp(stamp) || !['cash', 'bank'].includes(payment.wallet)) {
    throw new Error('Informe a carteira e a data efetiva do pagamento.');
  }
  const amount = cardStatementPending(data, statement);
  if (amount <= 0 || financeCents(amount) !== financeCents(payment.amount)) throw new Error('O saldo da fatura mudou. Confira as compras.');
  const expenses = { ...data.expenses };
  for (const expenseId of Object.keys(statement.originalDueDates)) {
    const expense = expenses[expenseId];
    if (!expense || data.suppressed[expenseId] || expense.cardStatementId !== id) throw new Error('Há uma compra sem vínculo com a fatura.');
    const events = expensePaymentEvents(expense);
    const pending = cardPurchasePending(expense);
    if (pending <= 0 || events.some((event) => event.date > payment.date)) throw new Error('Confira a data e os pagamentos anteriores das compras.');
    events.push({ id: 'card-statement-' + id, cardStatementId: id, date: payment.date, wallet: payment.wallet, amount: pending, dateSource: 'informed' });
    expenses[expenseId] = withEvents(expense, events, stamp);
  }
  return saveStatement(data, { ...statement, payment: { ...payment, amount } }, expenses);
}

export function reopenCardStatement(data: FinanceData, expected: CardStatement, stamp: string): FinanceData {
  const statement = data.cardStatements?.[expected.id];
  if (!statement?.payment || JSON.stringify(statement) !== JSON.stringify(expected)) throw new Error('A fatura foi alterada. Atualize a consulta.');
  const expenses = { ...data.expenses };
  for (const expenseId of Object.keys(statement.originalDueDates)) {
    const expense = expenses[expenseId];
    if (!expense || expense.cardStatementId !== statement.id) throw new Error('Há uma compra sem vínculo com a fatura.');
    expenses[expenseId] = withEvents(expense, expensePaymentEvents(expense).filter((event) => event.cardStatementId !== statement.id), stamp);
  }
  const reopened = { ...statement };
  delete reopened.payment;
  return saveStatement(data, reopened, expenses);
}

export function ungroupCardStatement(data: FinanceData, id: string, stamp: string): FinanceData {
  const statement = data.cardStatements?.[id];
  if (!statement || statement.payment) throw new Error('Apenas faturas em aberto podem ser desagrupadas.');
  const expenses = { ...data.expenses };
  for (const [expenseId, dueDate] of Object.entries(statement.originalDueDates)) {
    const expense = expenses[expenseId];
    if (!expense || expense.cardStatementId !== id) throw new Error('Há uma compra sem vínculo com a fatura.');
    const restored = { ...expense, dueDate, updatedAt: stamp };
    delete restored.cardStatementId;
    expenses[expenseId] = restored;
  }
  const cardStatements = { ...data.cardStatements };
  delete cardStatements[id];
  return { ...data, expenses, cardStatements };
}

export function validateCardStatements(data: FinanceData) {
  const members = new Set<string>();
  for (const statement of Object.values(data.cardStatements ?? {})) {
    let paid = 0;
    for (const expenseId of Object.keys(statement.originalDueDates)) {
      const expense = data.expenses[expenseId];
      if (members.has(expenseId) || !expense || data.suppressed[expenseId] || expense.cardStatementId !== statement.id
        || expense.purchaseMethod !== 'card' || expense.cardCategory !== statement.cardCategory || expense.dueDate !== statement.dueDate) {
        throw new Error('A compra está vinculada a uma fatura. Corrija o vínculo na aba Faturas.');
      }
      members.add(expenseId);
      const events = expensePaymentEvents(expense).filter((event) => event.cardStatementId === statement.id);
      if (statement.payment ? events.length !== 1 || events[0].amount <= 0 || cardPurchasePending(expense) !== 0
        || events[0].wallet !== statement.payment.wallet || events[0].date !== statement.payment.date : events.length || cardPurchasePending(expense) <= 0) {
        throw new Error('Os pagamentos das compras precisam corresponder à fatura.');
      }
      paid += events.reduce((total, event) => total + financeCents(event.amount), 0);
    }
    if (paid !== financeCents(statement.payment?.amount ?? 0)) throw new Error('O total pago diverge do valor da fatura.');
  }
  if (Object.values(data.expenses).some((expense) => expense.cardStatementId && !members.has(expense.id))) {
    throw new Error('Há compra vinculada a uma fatura que não foi encontrada.');
  }
}

type ExpenseCashMovement =
  | { expense: FinanceExpense; payment: FinancePaymentEvent; statement?: undefined }
  | { statement: CardStatement; payment: NonNullable<CardStatement['payment']>; expense?: undefined };

// A fatura é uma única saída nos extratos. Os rateios ficam nas compras para dar baixa nas obrigações.
export function expenseCashMovements(data: FinanceData, expenses = Object.values(data.expenses)): ExpenseCashMovement[] {
  const rows: ExpenseCashMovement[] = [];
  const seen = new Set<string>();
  for (const expense of expenses) {
    if (data.suppressed[expense.id]) continue;
    for (const payment of expensePaymentEvents(expense)) {
      const statement = payment.cardStatementId ? data.cardStatements?.[payment.cardStatementId] : undefined;
      if (!statement?.payment) rows.push({ expense, payment });
      else if (!seen.has(statement.id)) {
        rows.push({ statement, payment: statement.payment });
        seen.add(statement.id);
      }
    }
  }
  return rows;
}
