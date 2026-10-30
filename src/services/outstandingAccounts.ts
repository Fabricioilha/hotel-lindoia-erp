import { payrollNet, type FinanceData } from '../types/finance';
import { expensePaymentEvents, payrollPaymentEvents, financeCents } from './financePayments';
export function outstandingAccounts(data: FinanceData, asOf: string) {
  return [
    ...Object.values(data.expenses).filter((entry) => !data.suppressed[entry.id]).map((entry) => ({ id: entry.id, dueDate: entry.dueDate, title: entry.category, detail: entry.employee || entry.note, planned: entry.plannedAmount, payments: expensePaymentEvents(entry), expense: entry })),
    ...Object.values(data.payroll).map((entry) => ({ id: entry.id, dueDate: entry.dueDate, title: 'Folha · ' + entry.employee, detail: entry.month, planned: payrollNet(entry), payments: payrollPaymentEvents(entry), expense: undefined })),
  ].map((entry) => ({ ...entry, pending: Math.max(0, financeCents(entry.planned) - entry.payments.filter((payment) => payment.date <= asOf).reduce((sum, payment) => sum + financeCents(payment.amount), 0)) / 100 }))
    .filter((entry) => entry.pending > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

