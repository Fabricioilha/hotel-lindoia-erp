import { payrollNet, type FinanceData } from '../types/finance';
import { expensePaymentEvents, payrollPaymentEvents, financeCents } from './financePayments';
export function outstandingAccounts(data: FinanceData, asOf: string) {
  const rows = [
    ...Object.values(data.expenses).filter((entry) => !data.suppressed[entry.id]).map((entry) => ({ id: entry.id, dueDate: entry.dueDate, title: entry.category, detail: entry.employee || entry.note, planned: entry.plannedAmount, payments: expensePaymentEvents(entry), expense: entry })),
    ...Object.values(data.payroll).map((entry) => ({ id: entry.id, dueDate: entry.dueDate, title: 'Folha · ' + entry.employee, detail: entry.month, planned: payrollNet(entry), payments: payrollPaymentEvents(entry), expense: undefined })),
  ].map((entry) => ({ ...entry, pending: Math.max(0, financeCents(entry.planned) - entry.payments.filter((payment) => payment.date <= asOf).reduce((sum, payment) => sum + financeCents(payment.amount), 0)) / 100 }))
    .filter((entry) => entry.pending > 0);
  const statements = new Map<string, typeof rows[number] & { statementId: string; unassignedCard: boolean }>();
  const accounts = rows.flatMap((row) => {
    const statementId = row.expense?.cardStatementId ?? '';
    const statement = data.cardStatements?.[statementId];
    if (!statement) return [{ ...row, statementId: '', unassignedCard: row.expense?.purchaseMethod === 'card' }];
    const grouped = statements.get(statementId);
    if (grouped) {
      grouped.pending = (financeCents(grouped.pending) + financeCents(row.pending)) / 100;
      grouped.detail = [grouped.detail, row.detail].filter(Boolean).join(' · ');
    } else {
      statements.set(statementId, { ...row, id: statementId, title: 'Fatura · ' + statement.cardCategory, expense: undefined, statementId, unassignedCard: false });
    }
    return [];
  });
  return [...accounts, ...statements.values()].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}


export type AccountScope = 'all' | 'throughMonth' | 'overdue' | 'upcoming' | 'future' | 'unassignedCards';

export function accountsInScope(rows: ReturnType<typeof outstandingAccounts>, scope: AccountScope, asOf: string, monthEnd: string) {
  return rows.filter((entry) => {
    if (scope === 'all') return true;
    if (scope === 'unassignedCards') return entry.unassignedCard;
    if (entry.unassignedCard) return false;
    if (scope === 'throughMonth') return entry.dueDate <= monthEnd;
    if (scope === 'overdue') return entry.dueDate < asOf && entry.dueDate <= monthEnd;
    if (scope === 'upcoming') return entry.dueDate >= asOf && entry.dueDate <= monthEnd;
    if (scope === 'future') return entry.dueDate > monthEnd;
    return false;
  });
}
