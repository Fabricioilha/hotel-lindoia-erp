import type { FinanceData, PayrollEntry } from '../types/finance';
import type { StaffMember } from '../types/staff';
import { expensePaymentEvents, financeCents, paymentEventTotals } from './financePayments';

export const SALARY_ADVANCE_CATEGORY = 'Adiantamento de salário';

// Vales são despesas já pagas no caixa; a folha só os vincula e nunca gera nova saída por eles.
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

export interface PayrollAdvanceDetail {
  id: string;
  amount: number;
  /** Data em que o vale saiu do caixa ou do banco. */
  date: string;
  note: string;
}

// Detalhes dos vales (data e observação) para exibir na folha; o valor vem do vínculo ou da lista de disponíveis.
export function payrollAdvanceDetails(data: FinanceData, advances: Record<string, number>): PayrollAdvanceDetail[] {
  return Object.entries(advances).flatMap(([id, amount]) => {
    const expense = data.expenses[id];
    if (!expense) return [{ id, amount, date: '', note: '' }];
    const dates = expensePaymentEvents(expense).map((event) => event.date).sort();
    return [{ id, amount, date: dates[0] ?? expense.dueDate, note: expense.note }];
  }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export interface PendingAdvanceSummary { total: number; count: number }

// Vales do mês ainda não compensados em nenhuma folha, por funcionário.
export function pendingAdvancesByEmployee(data: FinanceData, members: StaffMember[], month: string): Record<string, PendingAdvanceSummary> {
  const summary: Record<string, PendingAdvanceSummary> = {};
  for (const member of members) {
    const advances = Object.values(availablePayrollAdvances(data, { id: '', employee: member.name, employeeId: member.id, month }));
    if (advances.length) summary[member.id] = { count: advances.length, total: advances.reduce((sum, amount) => sum + financeCents(amount), 0) / 100 };
  }
  return summary;
}

export interface PayrollLaunchInput {
  /** Folha em edição do mesmo funcionário: seus ajustes são preservados quando o total registrado não muda. */
  previous?: Pick<PayrollEntry, 'basePay' | 'additions' | 'deductions'>;
  /** Salário base de referência: cadastro do funcionário ou o valor já salvo na folha. */
  baseSalary: number;
  /** Vales do período compensados nesta folha. Já saíram do caixa quando foram pagos. */
  advances: Record<string, number>;
  /** Totais efetivamente pagos no contracheque, por carteira. */
  paidCash: number;
  paidBank: number;
  /** Pagamento parcial: mantém o líquido previsto e deixa o restante como pendente. */
  keepBalance?: boolean;
}

export interface PayrollLaunchTotals {
  basePay: number;
  additions: number;
  deductions: number;
  advancesTotal: number;
  paidTotal: number;
  /** Líquido do contracheque (a única saída de caixa ou banco da folha). */
  net: number;
  /** Remuneração registrada na folha: contracheque + vales já adiantados. */
  registered: number;
  /** Remuneração registrada menos o salário base de referência (0 sem referência). */
  difference: number;
  pending: number;
  /** Verdadeiro quando o valor pago fecha a folha (sem pagamento parcial). */
  closing: boolean;
}

// Com pagamento informado, a folha fecha no valor do contracheque: remuneração = pago + vales, e a diferença
// para o salário base vira acréscimo ou desconto. O líquido (base + acréscimos − descontos − vales) é sempre
// igual ao que saiu do caixa, e os vales nunca entram de novo como saída.
export function payrollLaunchTotals(input: PayrollLaunchInput): PayrollLaunchTotals {
  const advances = Object.values(input.advances).reduce((sum, amount) => sum + financeCents(amount), 0);
  const paid = financeCents(input.paidCash) + financeCents(input.paidBank);
  const reference = financeCents(input.baseSalary);
  const closing = paid > 0 && !input.keepBalance;
  let basePay = reference;
  let additions = input.previous ? financeCents(input.previous.additions) : 0;
  let deductions = input.previous ? financeCents(input.previous.deductions) : 0;
  if (closing) {
    const registered = paid + advances;
    const unchanged = input.previous && financeCents(input.previous.basePay) + financeCents(input.previous.additions) - financeCents(input.previous.deductions) === registered;
    if (unchanged) basePay = financeCents(input.previous!.basePay);
    else if (reference > 0) { additions = Math.max(0, registered - reference); deductions = Math.max(0, reference - registered); }
    else { basePay = registered; additions = 0; deductions = 0; }
  }
  const registered = basePay + additions - deductions;
  const net = Math.max(0, registered - advances);
  return {
    basePay: basePay / 100, additions: additions / 100, deductions: deductions / 100,
    advancesTotal: advances / 100, paidTotal: paid / 100, net: net / 100, registered: registered / 100,
    difference: reference > 0 ? (registered - reference) / 100 : 0, pending: Math.max(0, net - paid) / 100, closing,
  };
}

// Mensagem de erro para lançamentos que a folha não pode registrar; vazio quando está tudo certo.
export function payrollLaunchIssue(totals: PayrollLaunchTotals): string {
  if (totals.registered <= 0) return 'Informe o valor pago no contracheque ou cadastre o salário base do funcionário.';
  if (financeCents(totals.advancesTotal) > financeCents(totals.registered)) return 'Os vales superam a remuneração registrada. Confira o salário base e o valor pago.';
  if (financeCents(totals.paidTotal) > financeCents(totals.net)) return 'O valor pago supera o líquido previsto da folha. Desmarque o pagamento parcial para fechar a folha no valor pago.';
  return '';
}
