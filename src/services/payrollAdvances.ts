import type { FinanceData, PayrollEntry } from '../types/finance';
import { expensePaymentEvents, paymentEventTotals } from './financePayments';

export const SALARY_ADVANCE_CATEGORY = 'Adiantamento de salário';
export function availablePayrollAdvances(data: FinanceData, entry: Pick<PayrollEntry, 'id' | 'employee' | 'employeeId' | 'month'>): Record<string, number> {
  const used = new Set(Object.values(data.payroll).filter((payroll) => payroll.id !== entry.id).flatMap((payroll) => Object.keys(payroll.advances ?? {})));
  return Object.fromEntries(Object.values(data.expenses).filter((expense) => !data.suppressed[expense.id]
    && expense.category === SALARY_ADVANCE_CATEGORY && expense.advanceMonth === entry.month
    && (expense.employeeId && entry.employeeId ? expense.employeeId === entry.employeeId : expense.employee === entry.employee)
    && !used.has(expense.id)).flatMap((expense) => {
      const paid = paymentEventTotals(expensePaymentEvents(expense));
      const amount = Math.round((paid.cash + paid.bank) * 100) / 100;
      return amount > 0 ? [[expense.id, amount]] : [];
    }));
}

export function validatePayrollAdvances(data: FinanceData) {
  for (const entry of Object.values(data.payroll)) {
    if (!Object.keys(entry.advances ?? {}).length) continue;
    const available = availablePayrollAdvances(data, entry);
    for (const [id, amount] of Object.entries(entry.advances ?? {})) {
      if (!Number.isFinite(amount) || amount <= 0 || Math.round((available[id] ?? 0) * 100) !== Math.round(amount * 100)) {
        throw new Error(`O adiantamento vinculado à folha de ${entry.employee} mudou ou já foi utilizado. Revise o vínculo na folha antes de alterar ou excluir o adiantamento.`);
      }
    }
    const total = Object.values(entry.advances ?? {}).reduce((sum, amount) => sum + amount, 0);
    if (Math.round((entry.deductions + total) * 100) > Math.round((entry.basePay + entry.additions) * 100)) throw new Error('Descontos e adiantamentos superam o valor da folha.');
  }
}
