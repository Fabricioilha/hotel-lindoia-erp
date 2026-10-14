import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEvent } from '../../types/audit';
import { CASH_OUT_REASONS } from '../../types/reception';
import { DateInput } from '../../components/ui/DateInput';
import { emptyFinance, financeStorageMode, loadFinanceForMonth, subscribeFinance, updateFinance } from '../../services/financeStore';
import { deleteFinancialExpense, deleteFinancialIncome } from '../../services/financeDeletion';
import { useStaff } from '../../services/staffStore';
import { hotelIncomeView, monthlyFinanceSummary, oyoPaymentsAt, prepaidEntriesAt, prepaidEntriesTotal, type PrepaidIncomeEntry } from '../../services/financeAnalytics';
import { staffMembers } from '../../types/staff';
import { financeDataIssues } from '../../services/financeValidation';
import { expensePaymentEvents, financeDateKeyFromTimestamp, financeMonthRange, isFinanceDateKey, patchPaymentDates, paymentEventTotals, paymentsInRange, payrollPaymentEvents, withExpensePaymentTotals } from '../../services/financePayments';
import {
	DAILY_INCOME_ITEMS,
	INCOME_CATEGORIES,
	PAYMENT_METHOD_LABELS,
	WALLET_LABELS,
	type FinanceBalances,
	type FinanceData,
	type FinanceExpense,
	type FinanceIncome,
	type FinanceIncomeItem,
	type FinancePaymentMethod,
	type FinanceTransfer,
	type FinanceWallet,
	incomeItems,
	incomePaymentWallet,
	payrollNet,
} from '../../types/finance';
import './financeiro.css';

type Tab = 'resumo' | 'entradas' | 'prepagos' | 'saidas' | 'transferencias' | 'categorias';
type Modal = 'entrada' | 'entrada-prepaga' | 'saida' | 'transferencia' | 'repasse' | 'saldo' | null;
type TransactionRange = { from: string; to: string };
// Categorias usadas por lançamentos automáticos (hospedagem, venda, estoque, OYO).
const SALARY_ADVANCE_CATEGORY = 'Adiantamento de salário';
const LOCKED_CATEGORIES = { income: INCOME_CATEGORIES, expense: ['Estoque', 'OYO', SALARY_ADVANCE_CATEGORY, ...CASH_OUT_REASONS] };
type Activity = { id: string; date: string; periodPaid?: number; title: string; detail: string; amount: number; paid: number; type: 'entrada' | 'saida' | 'folha'; wallet: string };

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const localDateKey = () => financeDateKeyFromTimestamp(new Date().toISOString());
const localMonth = () => localDateKey().slice(0, 7);
const monthDueDate = (month: string) => {
	const day = Math.min(Number(localDateKey().slice(8, 10)), new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate());
	return `${month}-${String(day).padStart(2, '0')}`;
};
const dateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR');
const dateWithinRange = (date: string, range: TransactionRange) => date >= range.from && date <= range.to;
const id = () => crypto.randomUUID();
const paymentItemTotal = (items: { amount: number }[]) => items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100;
const newIncomeItem = (description: string, paymentMethod: FinancePaymentMethod = 'cash'): FinanceIncomeItem => ({ id: id(), description, amount: 0, paymentMethod });

function incomePaymentSummary(entry: FinanceIncome) {
	const totals = new Map<FinancePaymentMethod, number>();
	incomeItems(entry).forEach((item) => totals.set(item.paymentMethod, (totals.get(item.paymentMethod) ?? 0) + item.amount));
	return [...totals].map(([method, amount]) => `${money(amount)} ${PAYMENT_METHOD_LABELS[method]}`).join(' · ');
}

function exportCsv(filename: string, rows: (string | number)[][]) {
	const content = rows.map((row) => row.map((value) => `"${(typeof value === 'string' && /^[=+@\t\r-]/.test(value) ? `'${value}` : String(value)).replaceAll('"', '""')}"`).join(';')).join('\r\n');
	const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FluxoDeCaixa() {
	const { data: staff } = useStaff();
	const [data, setData] = useState<FinanceData>(emptyFinance());
	const [month, setMonth] = useState(localMonth);
	const [tab, setTab] = useState<Tab>('resumo');
	const [search, setSearch] = useState('');
	const [walletFilter, setWalletFilter] = useState<FinanceWallet | 'all'>('all');
	const [exportingMonth, setExportingMonth] = useState('');
	const [rangeFromDraft, setRangeFromDraft] = useState(localDateKey);
	const [rangeToDraft, setRangeToDraft] = useState(localDateKey);
	const [transactionRange, setTransactionRange] = useState<TransactionRange>(() => ({ from: localDateKey(), to: localDateKey() }));
	const [modal, setModal] = useState<Modal>(null);
	const [editingId, setEditingId] = useState('');
	const [loadedFinanceScope, setLoadedFinanceScope] = useState('');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const isMovementTab = tab === 'entradas' || tab === 'saidas';
	const financeScope = 'full';
	const loading = loadedFinanceScope !== financeScope;

	useEffect(() => {
		let active = true;
		const stop = subscribeFinance((next) => { if (!active) return; setData(next); setLoadedFinanceScope(financeScope); setError(''); }, (cause) => { if (!active) return; setError(cause.message); setLoadedFinanceScope(financeScope); });
		return () => { active = false; stop(); };
	}, []);

	const activeRange = isMovementTab ? transactionRange : financeMonthRange(month);
	const term = isMovementTab ? search.trim().toLocaleLowerCase('pt-BR') : '';
	const matchesText = (...values: (string | undefined)[]) => !term || values.some((value) => value?.toLocaleLowerCase('pt-BR').includes(term));
	const registeredIncomes = Object.values(data.incomes).filter((entry) => dateWithinRange(entry.date, activeRange) && matchesText(entry.category, entry.note, ...incomeItems(entry).map((item) => item.description))).sort((a, b) => b.date.localeCompare(a.date));
	const incomes = registeredIncomes.flatMap((entry) => {
		const hotel = hotelIncomeView(entry);
		if (!hotel) return [];
		if (!isMovementTab || walletFilter === 'all') return [hotel];
		const items = incomeItems(hotel).filter((item) => incomePaymentWallet(item.paymentMethod) === walletFilter);
		return items.length ? [{ ...hotel, items, amount: paymentItemTotal(items) }] : [];
	});
	const expenses = Object.values(data.expenses).filter((entry) => {
		const payments = expensePaymentEvents(entry);
		return (dateWithinRange(entry.dueDate, activeRange) || paymentsInRange(payments, activeRange.from, activeRange.to).length > 0)
			&& matchesText(entry.category, entry.employee, entry.note)
			&& (!isMovementTab || walletFilter === 'all' || paymentsInRange(payments, activeRange.from, activeRange.to).some((payment) => payment.wallet === walletFilter));
	}).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
	const payroll = Object.values(data.payroll).filter((entry) => {
		const payments = payrollPaymentEvents(entry);
		return (dateWithinRange(entry.dueDate, activeRange) || (!isMovementTab && entry.month === month) || paymentsInRange(payments, activeRange.from, activeRange.to).length > 0)
			&& matchesText(entry.employee, entry.position, entry.note)
			&& (!isMovementTab || walletFilter === 'all' || paymentsInRange(payments, activeRange.from, activeRange.to).some((payment) => payment.wallet === walletFilter));
	});
	const transfers = useMemo(() => Object.values(data.transfers).filter((item) => item.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date)), [data.transfers, month]);
	const financeIssues = useMemo(() => financeDataIssues(data), [data]);
	const monthSummary = monthlyFinanceSummary(data, month);
	const { receipts, cashPaidExpenses, oyoPaidExpenses, paidExpenses, cashResult, closingBalances: balances } = monthSummary;
	const pendingExpenses = monthSummary.pendingExpenses + monthSummary.pendingPayroll;
	const prepaidEntries = useMemo(() => prepaidEntriesAt(data.incomes, month), [data.incomes, month]);
	const prepaidTotal = prepaidEntriesTotal(prepaidEntries);
	const prepaidMonthTotal = prepaidEntriesTotal(prepaidEntries.filter((entry) => entry.income.date.startsWith(month)));
	const visibleIncomeTotal = paymentItemTotal(incomes.map((entry) => ({ amount: entry.amount })));
	const periodPayments = paymentsInRange([...expenses.flatMap(expensePaymentEvents), ...payroll.flatMap(payrollPaymentEvents)], activeRange.from, activeRange.to).filter((payment) => !isMovementTab || walletFilter === 'all' || payment.wallet === walletFilter);
	const periodPaid = paymentEventTotals(periodPayments);
	const periodPaidTotal = Math.round((periodPaid.cash + periodPaid.bank + periodPaid.oyo) * 100) / 100;
	const pendingAtEnd = (planned: number, events: ReturnType<typeof expensePaymentEvents>) => Math.max(0, Math.round((planned - events.filter((payment) => payment.date <= activeRange.to).reduce((sum, payment) => sum + payment.amount, 0)) * 100) / 100);
	const periodPending = expenses.filter((entry) => dateWithinRange(entry.dueDate, activeRange)).reduce((sum, entry) => sum + pendingAtEnd(entry.plannedAmount, expensePaymentEvents(entry)), 0) + payroll.filter((entry) => dateWithinRange(entry.dueDate, activeRange)).reduce((sum, entry) => sum + pendingAtEnd(payrollNet(entry), payrollPaymentEvents(entry)), 0);
	const expenseCategories = useMemo(() => [...new Set([...data.expenseCategories, SALARY_ADVANCE_CATEGORY])], [data.expenseCategories]);

	function selectMonth(value: string) {
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
		const range = financeMonthRange(value);
		setMonth(value); setTransactionRange(range); setRangeFromDraft(range.from); setRangeToDraft(range.to); setSearch(''); setWalletFilter('all');
	}
	function changeMonth(offset: number) {
		const date = new Date(`${month}-01T12:00:00`); date.setMonth(date.getMonth() + offset);
		selectMonth(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
	}
	function setQuickRange(kind: 'today' | 'month') {
		const range = kind === 'today' ? { from: localDateKey(), to: localDateKey() } : financeMonthRange(month);
		setTransactionRange(range); setRangeFromDraft(range.from); setRangeToDraft(range.to); setError('');
	}
	function selectTab(next: Tab) {
		setTab(next);
		if (next === 'entradas' && walletFilter === 'oyo') setWalletFilter('all');
	}

	function applyTransactionRange(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!isFinanceDateKey(rangeFromDraft) || !isFinanceDateKey(rangeToDraft) || rangeFromDraft > rangeToDraft) {
			setError('Informe um período válido: a data inicial deve ser anterior ou igual à final.');
			return;
		}
		setError('');
		if (transactionRange.from === rangeFromDraft && transactionRange.to === rangeToDraft) return;
		setTransactionRange({ from: rangeFromDraft, to: rangeToDraft });
	}

	function exportTransactionPeriod() {
		const fileRange = `${transactionRange.from}-${transactionRange.to}`;
		if (tab === 'entradas') {
			exportCsv(`entradas-${fileRange}.csv`, [['Data', 'Origem', 'Itens', 'Pagamentos', 'Valor total', 'Observação'], ...incomes.map((item) => [item.date, item.category, incomeItems(item).map((line) => `${line.description}: ${money(line.amount)}`).join(' | '), incomePaymentSummary(item), item.amount, item.note])]);
			return;
		}
		exportCsv(`pagamentos-${fileRange}.csv`, [['Data do movimento', 'Vencimento', 'Tipo', 'Categoria', 'Funcionário', 'Carteira', 'Valor pago ou correção', 'Referência', 'Origem da data', 'Observação'],
			...expenses.flatMap((entry) => paymentsInRange(expensePaymentEvents(entry), transactionRange.from, transactionRange.to).filter((payment) => walletFilter === 'all' || payment.wallet === walletFilter).map((payment) => [payment.date, entry.dueDate, payment.amount < 0 ? 'Correção de despesa' : 'Despesa', entry.category, entry.employee ?? '', WALLET_LABELS[payment.wallet], payment.amount, `${entry.id}/${payment.id}`, payment.dateSource === 'legacy_due_date' ? 'Vencimento de registro antigo' : 'Data informada', entry.note])),
			...payroll.flatMap((entry) => paymentsInRange(payrollPaymentEvents(entry), transactionRange.from, transactionRange.to).filter((payment) => walletFilter === 'all' || payment.wallet === walletFilter).map((payment) => [payment.date, entry.dueDate, payment.amount < 0 ? 'Correção de folha' : 'Folha', 'Folha de pagamento', entry.employee, WALLET_LABELS[payment.wallet], payment.amount, `${entry.id}/${payment.id}`, payment.dateSource === 'legacy_due_date' ? 'Vencimento de registro antigo' : 'Data informada', entry.note])),
		]);
	}

	async function exportMonthlyReport() {
		const selectedMonth = month;
		setExportingMonth(selectedMonth); setError('');
		try {
			const snapshot = await loadFinanceForMonth(selectedMonth);
			const { downloadMonthlyAccounting } = await import('../../services/accounting/financeWorkbook');
			await downloadMonthlyAccounting(snapshot, selectedMonth);
			setNotice(`Planilha mensal de ${selectedMonth.slice(5, 7)}/${selectedMonth.slice(0, 4)} exportada com entradas, saídas, contas, folha e conciliação.`);
		} catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível gerar a planilha mensal.'); }
		finally { setExportingMonth(''); }
	}

	async function commit(update: (current: FinanceData) => FinanceData, message: string) {
		setSaving(true);
		setError('');
		try {
			await updateFinance(update);
			setModal(null);
			setEditingId('');
			setNotice(message);
			window.setTimeout(() => setNotice(''), 4000);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível salvar os dados financeiros.');
		} finally {
			setSaving(false);
		}
	}

	function exportPrepaidHistory() {
		exportCsv(`prepagos-oyo-ate-${month}.csv`, [
			['Data', 'Categoria', 'Itens pré-pagos', 'Pago diretamente à OYO', 'Observação'],
			...prepaidEntries.map(({ income, items, amount }) => [income.date, income.category, items.map((item) => `${item.description}: ${money(item.amount)}`).join(' | '), amount, income.note]),
		]);
	}

	function openModal(kind: Modal, recordId = '') {
		setEditingId(recordId);
		setError('');
		setModal(kind);
	}

	function saveIncome(event: FormEvent<HTMLFormElement>, category: string, items: FinanceIncomeItem[]) {
		const form = new FormData(event.currentTarget);
		const amount = items.reduce((sum, item) => sum + item.amount, 0);
		if (!category || items.length === 0 || items.some((item) => !item.description.trim() || !Number.isFinite(item.amount) || item.amount <= 0) || !Number.isFinite(amount)) {
			setError('Informe a origem e um valor maior que zero para cada item.');
			return;
		}
		const current = data.incomes[editingId];
		const timestamp = new Date().toISOString();
		const item: FinanceIncome = {
			id: current?.id ?? id(),
			date: String(form.get('date')),
			category,
			amount,
			wallet: incomePaymentWallet(items[0].paymentMethod) ?? 'oyo',
			items,
			note: String(form.get('note') ?? '').trim(),
			createdAt: current?.createdAt ?? timestamp,
			updatedAt: timestamp,
			...(current ? { operationalOverride: true } : {}),
		};
		void commit((latest) => ({ ...latest, incomes: { ...latest.incomes, [item.id]: item } }), current ? 'Entrada atualizada.' : 'Entrada registrada.');
	}

	function saveExpense(event: FormEvent<HTMLFormElement>, original?: FinanceExpense) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const category = String(form.get('category') ?? '').trim();
		const plannedAmount = Number(form.get('plannedAmount'));
		const paidCash = Number(form.get('paidCash') || 0);
		const paidBank = Number(form.get('paidBank') || 0);
		const paidOyo = Number(form.get('paidOyo') || 0);
		const paymentDate = String(form.get('paymentDate') ?? '');
		const dueDate = String(form.get('dueDate') ?? '');
		const employee = String(form.get('employee') ?? '').trim();
		const eventIds = form.getAll('paymentEventId').map(String);
		const eventDates = form.getAll('paymentEventDate').map(String);
		const confirmedDates = new Set(form.getAll('paymentEventConfirmed').map(String));
		if (!category || !isFinanceDateKey(dueDate) || !Number.isFinite(plannedAmount) || plannedAmount <= 0 || [paidCash, paidBank, paidOyo].some((amount) => !Number.isFinite(amount) || amount < 0) || paidCash + paidBank + paidOyo > plannedAmount + 0.001 || (category === SALARY_ADVANCE_CATEGORY && !employee) || eventDates.some((date) => !isFinanceDateKey(date))) {
			setError('Confira o vencimento, o valor previsto e os totais pagos. O pagamento não pode ultrapassar o valor da despesa.'); return;
		}
		const timestamp = new Date().toISOString();
		const recordId = original?.id ?? id();
		const operationId = id();
		const item: FinanceExpense = { id: recordId, dueDate, category, ...(employee && category === SALARY_ADVANCE_CATEGORY ? { employee } : {}), plannedAmount, paidCash, paidBank, paidOyo, note: String(form.get('note') ?? '').trim(), createdAt: original?.createdAt ?? timestamp, updatedAt: timestamp, ...(original ? { operationalOverride: true } : {}) };
		void commit((latest) => {
			const current = latest.expenses[recordId];
			if (original && (!current || current.updatedAt !== original.updatedAt)) throw new Error('A despesa mudou enquanto você editava. Reabra o lançamento para atualizar os dados.');
			const next = withExpensePaymentTotals(current, item, paymentDate, operationId);
			const events = { ...next.payments };
			const datePatches: Record<string, string> = {};
			const originalEvents = original ? Object.fromEntries(expensePaymentEvents(original).map((payment) => [payment.id, payment])) : {};
			eventIds.forEach((eventId, index) => {
				const payment = events[eventId];
				if (!payment) throw new Error('Uma parcela foi alterada ou excluída enquanto você editava. Reabra o lançamento.');
				if (eventDates[index] !== originalEvents[eventId]?.date || confirmedDates.has(eventId)) datePatches[eventId] = eventDates[index];
			});
			return { ...latest, expenses: { ...latest.expenses, [recordId]: { ...next, payments: patchPaymentDates(events, datePatches) } } };
		}, original ? 'Despesa e pagamentos atualizados.' : paidCash + paidBank + paidOyo ? 'Despesa e pagamento registrados.' : 'Conta a pagar registrada.');
	}

	function saveTransfer(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const amount = Number(form.get('amount'));
		const from = String(form.get('from')) as FinanceWallet;
		const to = String(form.get('to')) as FinanceWallet;
		if (!Number.isFinite(amount) || amount <= 0 || !WALLET_LABELS[from] || !WALLET_LABELS[to] || from === to) { setError('Informe um valor positivo e carteiras diferentes.'); return; }
		const current = data.transfers[editingId];
		const item: FinanceTransfer = {
			id: current?.id ?? id(),
			date: String(form.get('date')),
			from,
			to,
			amount,
			note: String(form.get('note') ?? '').trim(),
			createdAt: current?.createdAt ?? new Date().toISOString(),
		};
		void commit((latest) => ({ ...latest, transfers: { ...latest.transfers, [item.id]: item } }), current ? 'Transferência atualizada.' : 'Transferência registrada.');
	}

	function saveOpeningBalances(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const cash = Number(form.get('cash')) || 0;
		const bank = Number(form.get('bank')) || 0;
		const oyo = Number(form.get('oyo')) || 0;
		if (![cash, bank, oyo].every(Number.isFinite)) { setError('Informe saldos válidos.'); return; }
		void commit((latest) => ({ ...latest, openingBalances: { ...latest.openingBalances, cash, bank, oyo } }), 'Saldos iniciais atualizados.');
	}

	async function addCategory(kind: 'income' | 'expense', category: string) {
		const normalized = category.trim();
		const key = normalized.toLocaleLowerCase('pt-BR');
		const categories = kind === 'income' ? data.incomeCategories : data.expenseCategories;
		if (!normalized) return;
		if (kind === 'income' && key === 'oyo') {
			setError('OYO é uma categoria de despesa e não pode ser cadastrada como entrada.');
			return;
		}
		if (categories.some((item) => item.toLocaleLowerCase('pt-BR') === key)) {
			setError('Essa categoria já existe.');
			return;
		}
		await commit((latest) => kind === 'income'
			? { ...latest, incomeCategories: [...latest.incomeCategories, normalized] }
			: { ...latest, expenseCategories: [...latest.expenseCategories, normalized] }, 'Categoria adicionada.');
	}

	async function changeCategory(kind: 'income' | 'expense', from: string, to: string) {
    const category = to.trim();
    if (!category || category === from) return;
    await commit((latest) => {
      const aliases = latest.categoryAliases ?? { income: {}, expense: {} };
      const mapping = Object.fromEntries(Object.entries(aliases[kind]).map(([key, value]) => [key, value === from ? category : value]));
      // Renaming a category back to a previously used name removes its old alias.
      delete mapping[category];
      mapping[from] = category;
      const key = kind === 'income' ? 'incomeCategories' : 'expenseCategories';
      const records = kind === 'income' ? 'incomes' : 'expenses';
      return { ...latest, categoryAliases: { ...aliases, [kind]: mapping }, [key]: [...new Set([...latest[key].filter((item) => item !== from), category])],
        [records]: Object.fromEntries(Object.entries(latest[records]).map(([id, entry]) => [id, entry.category === from ? { ...entry, category, updatedAt: new Date().toISOString() } : entry])) };
    }, 'Categoria atualizada; valores preservados.');
  }

  async function removeCategory(kind: 'income' | 'expense', category: string) {
    if (!window.confirm(`Excluir a categoria "${category}"? Os registros e valores serão preservados em “Sem categoria”.`)) return;
    await changeCategory(kind, category, category === 'Sem categoria' ? 'Não classificado' : 'Sem categoria');
  }

  async function renameCategory(kind: 'income' | 'expense', from: string, to: string) {
    if (to.trim().toLocaleLowerCase('pt-BR') === 'oyo' && kind === 'income') { setError('Use o controle de pré-pagos para pagamentos à OYO.'); return; }
    await changeCategory(kind, from, to);
  }

	async function removeRecord(kind: 'entrada' | 'saida' | 'transferencia', recordId: string) {
		const payments = kind === 'entrada' && data.incomes[recordId] ? incomeItems(data.incomes[recordId]) : [];
    const mixedPrepaid = payments.some((item) => item.paymentMethod === 'prepaid') && payments.some((item) => item.paymentMethod !== 'prepaid');
    const message = mixedPrepaid ? 'Este registro tem parcelas recebidas no hotel e pré-pagas. Excluir remove todas as parcelas. Para retirar somente uma parcela, use Editar.' : recordId.startsWith('frigobar-') ? 'Excluir esta venda? Os produtos voltarão ao estoque e o financeiro será recalculado.' : 'Excluir este lançamento? Os valores relacionados serão recalculados. Em hospedagens, excluir o pagamento mantém o cadastro do hóspede e dos serviços.';
		if (!window.confirm(message)) return;
		if (kind !== 'transferencia') {
			setSaving(true); setError('');
			try {
				if (kind === 'entrada') await deleteFinancialIncome(data.incomes[recordId]);
				else await deleteFinancialExpense(data.expenses[recordId]);
				setNotice('Lançamento excluído e valores relacionados atualizados.');
			} catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível excluir.'); }
			finally { setSaving(false); }
			return;
		}
		await commit((latest) => {
			const next = { ...latest.transfers }; delete next[recordId]; return { ...latest, transfers: next };
		}, 'Lançamento excluído.');
	}

	const selectedEntry = modal === 'entrada' || modal === 'entrada-prepaga' ? data.incomes[editingId] : undefined;
	const selectedExpense = modal === 'saida' ? data.expenses[editingId] : undefined;
	const selectedTransfer = modal === 'transferencia' || modal === 'repasse' ? data.transfers[editingId] : undefined;
	const activities: Activity[] = [
		...incomes.map((item) => ({ id: item.id, date: item.date, title: item.category, detail: `${item.note}${item.note ? ' · ' : ''}${incomeItems(item).map((line) => line.description).join(', ')}`, amount: item.amount, paid: item.amount, type: 'entrada' as const, wallet: incomePaymentSummary(item) })),
		...expenses.map((item) => { const payments = paymentsInRange(expensePaymentEvents(item), activeRange.from, activeRange.to).filter((payment) => !isMovementTab || walletFilter === 'all' || payment.wallet === walletFilter); const movementDate = payments.map((payment) => payment.date).sort().at(-1) || item.dueDate; return { id: item.id, date: movementDate, title: item.category, detail: [`Vencimento ${dateLabel(item.dueDate)}`, item.employee ? `Para: ${item.employee}` : '', item.note].filter(Boolean).join(' · '), amount: item.plannedAmount, paid: item.paidCash + item.paidBank + (item.paidOyo ?? 0), periodPaid: paymentItemTotal(payments), type: 'saida' as const, wallet: `${money(item.paidCash)} em caixa · ${money(item.paidBank)} em banco · ${money(item.paidOyo ?? 0)} retidos OYO` }; }),
		...payroll.map((item) => { const payments = paymentsInRange(payrollPaymentEvents(item), activeRange.from, activeRange.to).filter((payment) => !isMovementTab || walletFilter === 'all' || payment.wallet === walletFilter); return { id: item.id, date: payments.map((payment) => payment.date).sort().at(-1) || item.dueDate, title: item.employee, detail: [`Vencimento ${dateLabel(item.dueDate)}`, item.position || 'Folha de pagamento'].join(' · '), amount: payrollNet(item), paid: item.paidCash + item.paidBank, periodPaid: paymentItemTotal(payments), type: 'folha' as const, wallet: `${money(item.paidCash)} em caixa · ${money(item.paidBank)} em banco` }; }),
	].sort((a, b) => b.date.localeCompare(a.date));

	return (
		<div className="finance-page">
			<header className="finance-header">
				<Link to="/" className="finance-brand"><span className="finance-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>GESTÃO FINANCEIRA</small></span></Link>
				<nav aria-label="Módulos financeiros"><Link className="finance-nav-active" to="/financeiro/caixa">Fluxo de caixa</Link><Link to="/financeiro/folha">Folha de pagamento</Link><Link to="/">Painel</Link></nav>
			</header>

			<main className="finance-content">
				<div className="finance-page-heading">
					<div><p className="finance-eyebrow">FINANCEIRO <span>/</span> CONTROLE</p><h1>Fluxo de caixa</h1><p>Consulte recebimentos, pagamentos e contas em aberto.</p></div>
					<div className="finance-heading-actions"><button className="finance-button finance-button-dark" disabled={loading || saving} onClick={() => openModal('entrada')}>+ Entrada</button><button className="finance-button finance-button-primary" disabled={loading || saving} onClick={() => openModal('saida')}>+ Despesa</button></div>
				</div>
				<section className="finance-report-toolbar" aria-label="Mês do resumo e da planilha">
					<div className="finance-month-navigation"><button type="button" className="finance-month-arrow" onClick={() => changeMonth(-1)} aria-label="Mês anterior">‹</button><label className="finance-month"><span>Mês do resumo e da planilha</span><input type="month" value={month} onChange={(event) => selectMonth(event.target.value)} /></label><button type="button" className="finance-month-arrow" onClick={() => changeMonth(1)} aria-label="Mês seguinte">›</button></div>
					<div className="finance-report-action"><button className="finance-button finance-button-dark" disabled={Boolean(exportingMonth) || saving} onClick={() => void exportMonthlyReport()}>{exportingMonth ? `Gerando ${exportingMonth.slice(5, 7)}/${exportingMonth.slice(0, 4)}...` : 'Baixar planilha mensal (.xlsx)'}</button><small>O mês completo para o contador, com todas as entradas e saídas.</small></div>
					<button className="finance-text-button" disabled={loading || saving} onClick={() => openModal('saldo')}>Saldos iniciais</button>
				</section>

				{error && <div className="finance-alert" role="alert">{error}<button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
				{notice && <div className="finance-notice" role="status">{notice}</div>}
				{financeStorageMode === 'Firebase' && <p className="finance-storage-notice">Dados compartilhados pelo Firebase</p>}
				{!loading && financeIssues.length > 0 && <details className="finance-validation-notice"><summary>{financeIssues.length} informação(ões) precisam de correção no histórico financeiro</summary><ul>{financeIssues.map((issue, index) => <li key={`${issue.kind}-${issue.recordId}-${index}`}><span>{issue.message} <small>Registro {issue.recordId}</small></span>{issue.kind === 'payroll' ? <Link to="/financeiro/folha">Abrir folha</Link> : <button type="button" className="finance-text-button" onClick={() => openModal(issue.kind === 'income' ? 'entrada' : issue.kind === 'expense' ? 'saida' : 'transferencia', issue.recordId)}>Corrigir lançamento</button>}</li>)}</ul></details>}

				{loading ? <div className="finance-empty">Carregando lançamentos...</div> : <>
					{!isMovementTab && <section className="finance-metrics" aria-label="Resumo financeiro do mês">
						<Metric label="Entradas no hotel" value={money(receipts.received)} detail={`${money(receipts.direct)} diretos · ${money(receipts.repasses)} de repasses OYO`} tone="green" />
						<Metric label="Saídas pagas" value={money(paidExpenses)} detail={`${money(cashPaidExpenses)} caixa/banco · ${money(oyoPaidExpenses)} retidos OYO · ${money(pendingExpenses)} pendentes`} tone="coral" />
						<Metric label="Resultado de caixa" value={money(cashResult)} detail="Variação do caixa e banco no mês" tone="blue" />
						<Metric label="Caixa físico" value={money(balances.cash)} detail="Saldo acumulado até o mês" tone="gold" />
						<Metric label="Banco" value={money(balances.bank)} detail="Saldo acumulado até o mês" tone="navy" />
						<Metric label={WALLET_LABELS.oyo} value={money(balances.oyo)} detail="Pré-pagos menos repasses e taxas de balcão compensadas" tone="gray" />
					</section>}

					<div className="finance-tabs" role="tablist" aria-label="Visões do fluxo de caixa" onKeyDown={(event) => {
							const tabs: Tab[] = ['resumo', 'entradas', 'prepagos', 'saidas', 'transferencias', 'categorias'];
							if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
							event.preventDefault();
							const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
							selectTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#finance-tab-${next}`)?.focus();
						}}>
						{([['resumo', 'Resumo'], ['entradas', 'Entradas'], ['prepagos', 'Retidos OYO'], ['saidas', 'Despesas'], ['transferencias', 'Transferências'], ['categorias', 'Categorias']] as [Tab, string][]).map(([idTab, label]) => <button key={idTab} id={`finance-tab-${idTab}`} role="tab" aria-controls={`finance-view-${idTab}`} tabIndex={tab === idTab ? 0 : -1} aria-selected={tab === idTab} className={tab === idTab ? 'selected' : ''} onClick={() => selectTab(idTab)}>{label}</button>)}
					</div>

					<div role="tabpanel" id={`finance-view-${tab}`} aria-labelledby={`finance-tab-${tab}`}>
					{isMovementTab && <form className="finance-range-form" onSubmit={applyTransactionRange}>
						<div className="finance-range-dates"><label className="finance-month"><span>De</span><input type="date" value={rangeFromDraft} onChange={(event) => setRangeFromDraft(event.target.value)} required /></label><label className="finance-month"><span>Até</span><input type="date" value={rangeToDraft} onChange={(event) => setRangeToDraft(event.target.value)} required /></label><button className="finance-button finance-button-dark" type="submit">Aplicar período</button><button className="finance-button finance-button-soft" type="button" onClick={() => setQuickRange('today')}>Hoje</button><button className="finance-button finance-button-soft" type="button" onClick={() => setQuickRange('month')}>Mês selecionado</button></div>
						<div className="finance-query-controls"><label className="finance-field"><span>Buscar lançamento</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Categoria, hóspede, funcionário ou observação" /></label><label className="finance-field"><span>Carteira</span><select value={walletFilter} onChange={(event) => setWalletFilter(event.target.value as FinanceWallet | 'all')}><option value="all">Todas as carteiras</option><option value="cash">Caixa físico</option><option value="bank">Banco</option>{tab === 'saidas' && <option value="oyo">Retidos OYO</option>}</select></label><button className="finance-button finance-button-soft" type="button" onClick={exportTransactionPeriod}>Baixar consulta (.csv)</button></div>
						<p className="finance-range-caption" role="status">Exibindo {transactionRange.from === transactionRange.to ? dateLabel(transactionRange.from) : `${dateLabel(transactionRange.from)} a ${dateLabel(transactionRange.to)}`}{search || walletFilter !== 'all' ? ' · busca ou carteira filtrada' : ''}{rangeFromDraft !== transactionRange.from || rangeToDraft !== transactionRange.to ? ' · alterações de data aguardam aplicar' : ''}</p>
					</form>}

					{tab === 'prepagos' && <section className="finance-panel">
						<div className="finance-panel-heading">
							<div><h2>{WALLET_LABELS.oyo}</h2><p>{money(balances.oyo)} em pré-pagos menos repasses e taxas de balcão · {money(prepaidMonthTotal)} pré-pagos no mês · {money(prepaidTotal)} no histórico</p></div>
							<div className="finance-heading-actions">
								<button className="finance-button finance-button-soft" onClick={exportPrepaidHistory}>Exportar histórico</button>
								<button className="finance-button finance-button-soft" onClick={() => openModal('repasse')}>Registrar repasse da OYO</button>
								<button className="finance-button finance-button-dark" onClick={() => openModal('entrada-prepaga')}>+ Registrar pré-pago</button>
							</div>
						</div>
						<p className="finance-form-hint">Os hóspedes pagaram estes valores diretamente à OYO antes da chegada. Eles não entram no caixa ou banco do hotel. Esta lista discrimina os pré-pagos de hospedagem, café e extras, inclusive parcelas de pagamentos combinados. Taxas pré-pagas ficam fora do fluxo; taxas cobradas no balcão são compensadas nesta carteira. Comissões e o acerto final continuam sob controle da gerência.</p>
                        <p>Transferências enviadas pelo hotel à OYO até o mês: <strong>{money(oyoPaymentsAt(data, month))}</strong>. Esses pagamentos ficam separados dos pré-pagos dos hóspedes.</p>
						<PrepaidTable entries={prepaidEntries} onEdit={(entry) => openModal('entrada-prepaga', entry.income.id)} onDelete={(entry) => void removeRecord('entrada', entry.income.id)} />
					</section>}

					{tab === 'resumo' && <>
						<section className="finance-summary-grid">
							<CategorySummary title="Recebimentos diretos por origem" items={incomes.map((item) => [item.category, item.amount] as [string, number])} empty="Nenhuma entrada nesta competência." />
							  <CategorySummary title="Despesas por categoria" items={[...expenses.map((item) => [item.category, paymentItemTotal(paymentsInRange(expensePaymentEvents(item), activeRange.from, activeRange.to))] as [string, number]), ...payroll.map((item) => ['Folha de pagamento', paymentItemTotal(paymentsInRange(payrollPaymentEvents(item), activeRange.from, activeRange.to))] as [string, number])]} empty="Nenhuma despesa nesta competência." />
							<section className="finance-panel finance-wallet-panel"><div className="finance-panel-heading"><div><h2>Movimento entre carteiras</h2><p>Movimentos entre caixa e banco são internos. Repasses movem valores entre carteiras; taxas de balcão podem ser compensadas com valores retidos pela OYO.</p></div><button className="finance-text-button" onClick={() => openModal('transferencia')}>+ Registrar</button></div>{transfers.length === 0 ? <p className="finance-empty-inline">Sem transferências neste mês.</p> : transfers.slice(0, 5).map((item) => <div className="finance-transfer-row" key={item.id}><span>{dateLabel(item.date)}</span><strong>{WALLET_LABELS[item.from]} → {WALLET_LABELS[item.to]}</strong><b>{money(item.amount)}</b></div>)}</section>
						</section>
						<ActivityTable activities={activities.slice(0, 10)} onEdit={(activity) => activity.type === 'entrada' ? openModal('entrada', activity.id) : activity.type === 'saida' ? openModal('saida', activity.id) : undefined} onDelete={(activity) => activity.type !== 'folha' && void removeRecord(activity.type, activity.id)} title="Lançamentos recentes" />
						<AuditTable onDelete={(eventId) => { if (window.confirm('Excluir este registro de auditoria?')) void commit((current) => { const auditLog = { ...current.auditLog }; delete auditLog[eventId]; return { ...current, auditLog }; }, 'Registro de auditoria excluído.'); }} events={Object.values(data.auditLog).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 20)} />
					</>}

					  {tab === 'entradas' && <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Entradas {isMovementTab ? 'do período' : 'da competência'}</h2><p>{incomes.length} registros · recebidos no hotel {money(visibleIncomeTotal)}. Pré-pagos estão no controle da OYO.</p></div><div className="finance-heading-actions"><button className="finance-button finance-button-dark" onClick={() => openModal('entrada')}>+ Entrada</button></div></div><ActivityTable activities={incomes.map((item) => ({ id: item.id, date: item.date, title: item.category, detail: `${item.note}${item.note ? ' · ' : ''}${incomeItems(item).map((line) => line.description).join(', ')}`, amount: item.amount, paid: item.amount, type: 'entrada', wallet: incomePaymentSummary(item) }))} onEdit={(activity) => openModal('entrada', activity.id)} onDelete={(activity) => void removeRecord('entrada', activity.id)} title="" /></section>}

					{tab === 'saidas' && <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Despesas {isMovementTab ? 'do período' : 'da competência'}</h2><p>{expenses.length + payroll.length} registros · {money(periodPaidTotal)} pagos no período · {money(periodPending)} pendentes com vencimento no período</p></div><div className="finance-heading-actions"><button className="finance-button finance-button-primary" onClick={() => openModal('saida')}>+ Despesa</button></div></div><ActivityTable activities={[...activities.filter((item) => item.type !== 'entrada')]} onEdit={(activity) => activity.type === 'saida' && openModal('saida', activity.id)} onDelete={(activity) => activity.type === 'saida' && void removeRecord('saida', activity.id)} title="" /></section>}

					  {tab === 'transferencias' && <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Transferências da competência</h2><p>{transfers.length} registros · transferências internas e repasses da OYO</p></div><div className="finance-heading-actions"><button className="finance-button finance-button-soft" onClick={() => exportCsv(`transferencias-${month}.csv`, [['Data', 'Origem', 'Destino', 'Valor', 'Observação'], ...transfers.map((item) => [item.date, WALLET_LABELS[item.from], WALLET_LABELS[item.to], item.amount, item.note])])}>Exportar CSV</button><button className="finance-button finance-button-dark" onClick={() => openModal('transferencia')}>+ Transferência</button></div></div>{transfers.length === 0 ? <div className="finance-empty">Nenhuma transferência neste mês.</div> : <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Data</th><th>Origem</th><th>Destino</th><th>Observação</th><th className="numeric">Valor</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{transfers.map((item) => <tr key={item.id}><td>{dateLabel(item.date)}</td><td>{WALLET_LABELS[item.from]}</td><td>{WALLET_LABELS[item.to]}</td><td>{item.note || '—'}</td><td className="numeric">{money(item.amount)}</td><td><div className="finance-row-actions"><button onClick={() => openModal('transferencia', item.id)}>Editar</button><button className="danger" onClick={() => void removeRecord('transferencia', item.id)}>Excluir</button></div></td></tr>)}</tbody></table></div>}</section>}

					  {tab === 'categorias' && <div className="finance-category-grid"><CategoryManager title="Categorias de entrada" categories={data.incomeCategories} locked={LOCKED_CATEGORIES.income} onRename={(from, to) => void renameCategory('income', from, to)} onAdd={(category) => void addCategory('income', category)} onRemove={(category) => void removeCategory('income', category)} /><CategoryManager title="Categorias de despesa" categories={data.expenseCategories} locked={LOCKED_CATEGORIES.expense} onRename={(from, to) => void renameCategory('expense', from, to)} onAdd={(category) => void addCategory('expense', category)} onRemove={(category) => void removeCategory('expense', category)} /></div>}
					</div>
				</>}

				<footer className="finance-page-footer"><span>Armazenamento: {financeStorageMode}</span><span>Fluxo de caixa · Hotel Lindoia</span></footer>
			</main>

			{modal && <div className={`finance-modal-backdrop${modal === 'saida' ? ' finance-expense-backdrop' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}><section className={`finance-modal${modal === 'saida' ? ' finance-expense-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="finance-modal-title">
				{(modal === 'entrada' || modal === 'entrada-prepaga') && <IncomeForm record={selectedEntry} month={month} categories={data.incomeCategories} initialPaymentMethod={modal === 'entrada-prepaga' ? 'prepaid' : 'cash'} saving={saving} onClose={() => setModal(null)} onSubmit={saveIncome} />}
				{modal === 'saida' && <ExpenseForm key={editingId || 'new-expense'} record={selectedExpense} month={month} categories={expenseCategories} employees={staffMembers(staff).map((member) => member.name)} saving={saving} onClose={() => setModal(null)} onSubmit={saveExpense} />}
				{(modal === 'transferencia' || modal === 'repasse') && <TransferForm record={selectedTransfer} initialFrom={modal === 'repasse' ? 'oyo' : 'cash'} month={month} saving={saving} onClose={() => setModal(null)} onSubmit={saveTransfer} />}
				{modal === 'saldo' && <BalancesForm balances={data.openingBalances} saving={saving} onClose={() => setModal(null)} onSubmit={saveOpeningBalances} />}
			</section></div>}
		</div>
	);
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
	return <article className={`finance-metric metric-${tone}`}><span className="metric-rule" /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function CategorySummary({ title, items, empty }: { title: string; items: [string, number][]; empty: string }) {
	const totals = items.reduce<Record<string, number>>((result, [category, amount]) => { result[category] = (result[category] ?? 0) + amount; return result; }, {});
	const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
	return <section className="finance-panel"><div className="finance-panel-heading"><div><h2>{title}</h2><p>{rows.length} categorias</p></div></div>{rows.length === 0 ? <p className="finance-empty-inline">{empty}</p> : rows.slice(0, 7).map(([category, amount]) => <div className="finance-category-row" key={category}><span>{category}</span><strong>{money(amount)}</strong></div>)}</section>;
}

function CategoryManager({ title, categories, locked, onAdd, onRename, onRemove }: { title: string; categories: string[]; locked: string[]; onAdd: (category: string) => void; onRename: (from: string, to: string) => void; onRemove: (category: string) => void }) {
	const [category, setCategory] = useState('');
	const [editing, setEditing] = useState('');
	const [draft, setDraft] = useState('');
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!category.trim()) return;
		onAdd(category);
		setCategory('');
	}
	return <section className="finance-panel finance-category-manager"><div className="finance-panel-heading"><div><h2>{title}</h2><p>{categories.length} categorias disponíveis nos lançamentos</p></div></div><form className="finance-category-form" onSubmit={submit}><label className="finance-field"><span>Nova categoria</span><input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={50} placeholder="Digite um nome" /></label><button className="finance-button finance-button-dark" type="submit" disabled={!category.trim()}>Adicionar</button></form>{categories.length === 0 ? <p className="finance-empty-inline">Nenhuma categoria cadastrada.</p> : <ul className="finance-category-list">{categories.map((item) => <li key={item}>{editing === item ? <><input value={draft} maxLength={50} autoFocus aria-label={`Novo nome de ${item}`} onChange={(event) => setDraft(event.target.value)} /><button type="button" title="Salvar" aria-label="Salvar nome" disabled={!draft.trim()} onClick={() => { onRename(item, draft); setEditing(''); }}>✓</button><button type="button" title="Cancelar" aria-label="Cancelar edição" onClick={() => setEditing('')}>↶</button></> : <><span>{item}{locked.includes(item) ? ' · automática' : ''}</span>{<button type="button" title={`Editar categoria ${item}`} aria-label={`Editar categoria ${item}`} onClick={() => { setEditing(item); setDraft(item); }}>✎</button>}{<button type="button" title={`Remover categoria ${item}`} aria-label={`Remover categoria ${item}`} onClick={() => onRemove(item)}>×</button>}</>}</li>)}</ul>}</section>;
}

function ActivityTable({ activities, onEdit, onDelete, title }: { activities: Activity[]; onEdit: (activity: Activity) => void; onDelete: (activity: Activity) => void; title: string }) {
	return <section className="finance-panel finance-activity-panel">{title && <div className="finance-panel-heading"><div><h2>{title}</h2><p>Registros do mês selecionado</p></div></div>}{activities.length === 0 ? <div className="finance-empty">Nenhum lançamento nesta consulta.</div> : <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Data / vencimento</th><th>Origem / categoria</th><th>Carteira / pagamentos</th><th className="numeric">Valor</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{activities.map((item) => <tr key={`${item.type}-${item.id}`}><td>{dateLabel(item.date)}</td><td><strong>{item.title}</strong>{item.detail && <small title={item.detail}>{item.detail}</small>}{item.type === 'folha' && <small>Folha de pagamento</small>}</td><td>{item.wallet}</td><td className={`numeric ${item.type === 'entrada' ? 'positive-value' : ''}`}>{item.type === 'entrada' ? money(item.amount) : <>{money(item.amount)}<small>{item.type === 'saida' ? 'Despesa' : 'Previsto'}</small><small>Pago acumulado {money(item.paid)}</small>{item.periodPaid !== undefined && <small>No período {money(item.periodPaid)}</small>}<small>Falta {money(Math.max(0, item.amount - item.paid))}</small></>}</td><td><div className="finance-row-actions">{item.type !== 'folha' && <><button onClick={() => onEdit(item)}>Editar</button><button className="danger" onClick={() => onDelete(item)}>Excluir</button></>}</div></td></tr>)}</tbody></table></div>}</section>;
}

function PrepaidTable({ entries, onEdit, onDelete }: { entries: PrepaidIncomeEntry[]; onEdit: (entry: PrepaidIncomeEntry) => void; onDelete: (entry: PrepaidIncomeEntry) => void }) {
	if (entries.length === 0) return <div className="finance-empty">Nenhum pré-pago externo registrado até esta competência.</div>;
	return <div className="finance-table-wrap"><table className="finance-table">
		<thead><tr><th>Data</th><th>Categoria</th><th>Referência</th><th className="numeric">Pago à OYO</th><th>Ações</th></tr></thead>
		<tbody>{entries.map((entry) => { const { income, items, amount } = entry; return <tr key={income.id}>
			<td>{dateLabel(income.date)}</td>
			<td>{income.category}</td>
			<td>{items.map((item) => <small key={item.id}>{item.description} · {money(item.amount)}</small>)}{income.note && <small>{income.note}</small>}</td>
			<td className="numeric">{money(amount)}</td><td><button onClick={() => onEdit(entry)}>Editar</button> <button onClick={() => onDelete(entry)}>Excluir</button></td>
		</tr>; })}</tbody>
	</table></div>;
}

function AuditTable({ events, onDelete }: { events: AuditEvent[]; onDelete: (id: string) => void }) {
	const actionLabels: Record<AuditEvent['action'], string> = { criado: 'Criado', alterado: 'Alterado', excluido: 'Excluído' };
	return <details className="finance-panel finance-audit"><summary className="finance-panel-heading"><div><h2>Auditoria recente</h2><p>Ações sobre lançamentos e configurações financeiras</p></div></summary>{events.length === 0 ? <p className="finance-empty-inline">Nenhuma alteração registrada ainda.</p> : <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Data</th><th>Ação</th><th>Registro</th><th>Usuário</th><th>Ações</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td>{new Date(event.occurredAt).toLocaleString('pt-BR')}</td><td>{actionLabels[event.action]}</td><td>{event.entity} · {event.recordId}</td><td>{event.actorUid}</td><td><button onClick={() => onDelete(event.id)}>Excluir</button></td></tr>)}</tbody></table></div>}</details>;
}

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
	return <div className="finance-modal-header"><div><p className="finance-eyebrow">FLUXO DE CAIXA</p><h2 id="finance-modal-title">{title}</h2></div><button type="button" className="finance-close" onClick={onClose} aria-label="Fechar">×</button></div>;
}

function ModalFooter({ saving, onClose, submit }: { saving: boolean; onClose: () => void; submit: string }) {
	return <div className="finance-modal-footer"><button type="button" className="finance-button finance-button-soft" onClick={onClose}>Cancelar</button><button className="finance-button finance-button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : submit}</button></div>;
}

function IncomeForm({ record, month, categories, initialPaymentMethod = 'cash', saving, onClose, onSubmit }: { record?: FinanceIncome; month: string; categories: string[]; initialPaymentMethod?: FinancePaymentMethod; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>, category: string, items: FinanceIncomeItem[]) => void }) {
	const [category, setCategory] = useState(record?.category ?? categories[0] ?? 'Diária');
	const [items, setItems] = useState<FinanceIncomeItem[]>(() => {
		if (record) return incomeItems(record).map((item) => ({ ...item }));
		return [newIncomeItem(category === 'Diária' ? 'Diária' : category, initialPaymentMethod)];
	});
	const total = items.reduce((sum, item) => sum + (Number.isFinite(item.amount) ? item.amount : 0), 0);
	const isDaily = category === 'Diária';
	const nextDailyItem = DAILY_INCOME_ITEMS.slice(1).find((part) => !items.some((item) => item.description === part));

	function changeCategory(value: string) {
		setCategory(value);
		setItems([newIncomeItem(value === 'Diária' ? 'Diária' : value, initialPaymentMethod)]);
	}

	function updateItem(itemId: string, patch: Partial<FinanceIncomeItem>) {
		setItems((current) => current.map((item) => item.id === itemId ? { ...item, ...patch } : item));
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		onSubmit(event, category, items);
	}

	return <form onSubmit={submit}><ModalHeader title={record ? 'Editar entrada' : initialPaymentMethod === 'prepaid' ? 'Registrar pré-pago externo à OYO' : 'Nova entrada'} onClose={onClose} /><div className="finance-modal-body">
		<label className="finance-field"><span>Data *</span><DateInput name="date" required defaultValue={record?.date ?? monthDueDate(month)} /></label>
		<label className="finance-field"><span>Tipo de entrada *</span><select value={category} onChange={(event) => changeCategory(event.target.value)} required>{record && !categories.includes(record.category) && <option value={record.category}>{record.category} (histórica)</option>}{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
		<div className="finance-income-section finance-field-wide"><div className="finance-income-section-heading"><div><strong>{isDaily ? 'Composição da diária' : 'Itens recebidos'}</strong><small>Defina o valor e o pagamento de cada item.</small></div><button type="button" className="finance-button finance-button-soft" disabled={isDaily && !nextDailyItem} onClick={() => setItems((current) => [...current, newIncomeItem(isDaily ? nextDailyItem ?? DAILY_INCOME_ITEMS[1] : category, initialPaymentMethod)])}>{isDaily ? '+ Adicional' : '+ Dividir recebimento'}</button></div>
			<div className="finance-income-lines">{items.map((item, index) => <div className="finance-income-line" key={item.id}>
				<label className="finance-field"><span>{isDaily && index === 0 ? 'Diária' : 'Item'}</span>{isDaily && index === 0 ? <input value="Diária" readOnly aria-label="Item Diária" /> : isDaily ? <select value={item.description} onChange={(event) => updateItem(item.id, { description: event.target.value })}>{DAILY_INCOME_ITEMS.slice(1).map((part) => <option key={part} value={part}>{part}</option>)}</select> : <input value={item.description} readOnly aria-label={`Item ${item.description}`} />}</label>
				<label className="finance-field"><span>Forma de pagamento</span><select value={item.paymentMethod} onChange={(event) => updateItem(item.id, { paymentMethod: event.target.value as FinancePaymentMethod })}>{(Object.entries(PAYMENT_METHOD_LABELS) as [FinancePaymentMethod, string][]).map(([method, label]) => <option key={method} value={method}>{label}</option>)}</select></label>
				<label className="finance-field"><span>Valor (R$)</span><input type="number" min="0.01" step="0.01" required value={item.amount || ''} onChange={(event) => updateItem(item.id, { amount: Number(event.target.value) })} aria-label={`Valor de ${item.description}`} /></label>
				{items.length > 1 && !(isDaily && index === 0) && <button type="button" className="finance-remove-line" title={`Remover ${item.description}`} aria-label={`Remover ${item.description}`} onClick={() => setItems((current) => current.filter((line) => line.id !== item.id))}>×</button>}
			</div>)}</div>
			<div className="finance-entry-total"><span>Total da entrada</span><strong>{money(total)}</strong></div>
		</div>
		<label className="finance-field finance-field-wide"><span>Observação</span><textarea name="note" rows={2} defaultValue={record?.note} /></label>
		<p className="finance-form-hint finance-field-wide">Pré-pago registra um valor que o hóspede já pagou à OYO antes da chegada; não é dinheiro recebido pelo hotel. Comissões não são calculadas.</p>
	</div><ModalFooter saving={saving} onClose={onClose} submit={record ? 'Salvar entrada' : 'Registrar entrada'} /></form>;
}

function ExpenseForm({ record, month, categories, employees, saving, onClose, onSubmit }: { record?: FinanceExpense; month: string; categories: string[]; employees: string[]; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>, original?: FinanceExpense) => void }) {
	const [original] = useState(record);
	const [category, setCategory] = useState(record?.category ?? '');
	const [planned, setPlanned] = useState(record ? String(record.plannedAmount) : '');
	const [cash, setCash] = useState(String(record?.paidCash ?? 0));
	const [bank, setBank] = useState(String(record?.paidBank ?? 0));
	const [oyo, setOyo] = useState(String(record?.paidOyo ?? 0));
	const [events] = useState(() => record ? expensePaymentEvents(record) : []);
	const [eventDates, setEventDates] = useState(() => Object.fromEntries(events.map((payment) => [payment.id, payment.date])));
	const employeeOptions = [...new Set([...employees, ...(record?.employee ? [record.employee] : [])])];
	const totalPaid = Number(cash || 0) + Number(bank || 0) + Number(oyo || 0);
	return <form onSubmit={(event) => onSubmit(event, original)}><ModalHeader title={record ? 'Editar despesa' : 'Nova despesa'} onClose={onClose} /><div className="finance-modal-body finance-expense-body">
		<section className="finance-expense-section" aria-labelledby="finance-expense-details-title">
			<div className="finance-expense-step"><span>1</span><div><strong id="finance-expense-details-title">Conta e vencimento</strong><small>O valor previsto fica separado dos pagamentos realizados.</small></div></div>
			<div className="finance-expense-grid">
				<label className="finance-field"><span>Vencimento *</span><DateInput name="dueDate" required defaultValue={record?.dueDate ?? monthDueDate(month)} /></label>
				<label className="finance-field"><span>Categoria *</span><select name="category" value={category} onChange={(event) => setCategory(event.target.value)} required><option value="" disabled>Selecione uma categoria</option>{record && !categories.includes(record.category) && <option value={record.category}>{record.category} (histórica)</option>}{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
				<label className="finance-field"><span>Valor previsto (R$) *</span><input name="plannedAmount" type="number" min="0.01" step="0.01" required value={planned} onChange={(event) => setPlanned(event.target.value)} /></label>
				<label className="finance-field"><span>Observação</span><textarea name="note" rows={2} defaultValue={record?.note} /></label>
			</div>
		</section>
		<section className="finance-expense-section" aria-labelledby="finance-expense-payments-title">
			<div className="finance-expense-step"><span>2</span><div><strong id="finance-expense-payments-title">Pagamentos realizados</strong><small>Informe o total já pago em cada carteira. Deixe zero para cadastrar uma conta a pagar.</small></div></div>
			<div className="finance-expense-grid">
				<label className="finance-field"><span>Pago em dinheiro (R$)</span><input name="paidCash" type="number" min="0" step="0.01" value={cash} onChange={(event) => setCash(event.target.value)} /></label>
				<label className="finance-field"><span>Pago pelo banco (R$)</span><input name="paidBank" type="number" min="0" step="0.01" value={bank} onChange={(event) => setBank(event.target.value)} /></label>
				<label className="finance-field"><span>Compensado com retidos OYO (R$)</span><input name="paidOyo" type="number" min="0" step="0.01" value={oyo} onChange={(event) => setOyo(event.target.value)} /></label>
				<label className="finance-field"><span>Data do novo pagamento ou correção</span><DateInput name="paymentDate" defaultValue={localDateKey()} max={localDateKey()} /></label>
			</div>
			<div className="finance-payment-shortcuts"><button type="button" className="finance-button finance-button-soft" disabled={!Number(planned)} onClick={() => setCash(String(Math.max(0, Number(planned) - Number(bank || 0) - Number(oyo || 0))))}>Quitar em dinheiro</button><button type="button" className="finance-button finance-button-soft" disabled={!Number(planned)} onClick={() => setBank(String(Math.max(0, Number(planned) - Number(cash || 0) - Number(oyo || 0))))}>Quitar pelo banco</button><span>Pago {money(totalPaid)} · falta {money(Math.max(0, Number(planned || 0) - totalPaid))}</span></div>
			<p className="finance-form-hint">Pagamentos anteriores conservam suas datas. Um novo pagamento ou ajuste utiliza a data acima.</p>
			{events.length > 0 && <div className="finance-payment-history"><h3>Histórico de parcelas</h3><p>Corrija a data de uma parcela sem alterar as demais.</p>{events.map((payment) => <div className="finance-payment-event" key={payment.id}><input type="hidden" name="paymentEventId" value={payment.id} /><div><strong>{money(payment.amount)} · {WALLET_LABELS[payment.wallet]}</strong>{payment.amount < 0 && <small>Correção / estorno</small>}{payment.dateSource === 'legacy_due_date' && <small>Data histórica ausente: vencimento utilizado</small>}</div><label className="finance-field"><span>Data desta parcela</span><DateInput name="paymentEventDate" required max={localDateKey()} value={eventDates[payment.id]} onValueChange={(date) => setEventDates((current) => ({ ...current, [payment.id]: date }))} /></label>{payment.dateSource === 'legacy_due_date' && <label className="finance-confirm-date"><input type="checkbox" name="paymentEventConfirmed" value={payment.id} />Confirmar esta data de pagamento</label>}</div>)}</div>}
		</section>
		{category === SALARY_ADVANCE_CATEGORY && <section className="finance-expense-section" aria-labelledby="finance-expense-employee-title"><div className="finance-expense-step"><span>3</span><div><strong id="finance-expense-employee-title">Beneficiário do adiantamento</strong><small>Selecione quem receberá o valor.</small></div></div><label className="finance-field"><span>Funcionário *</span><select name="employee" required defaultValue={record?.employee ?? ''}><option value="" disabled>Selecione um funcionário</option>{employeeOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>{employeeOptions.length === 0 && <p className="finance-form-hint">Nenhum funcionário ativo no quadro de funcionários.</p>}</section>}
	</div><ModalFooter saving={saving} onClose={onClose} submit={record ? 'Salvar despesa e pagamentos' : 'Registrar despesa'} /></form>;
}

function TransferForm({ record, month, initialFrom = 'cash', saving, onClose, onSubmit }: { record?: FinanceTransfer; month: string; initialFrom?: FinanceWallet; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const isRepasse = initialFrom === 'oyo' && !record;
  const wallets = Object.entries(WALLET_LABELS) as [FinanceWallet, string][];
	return <form onSubmit={onSubmit}><ModalHeader title={record ? 'Editar transferência' : initialFrom === 'oyo' ? 'Repasse da OYO' : 'Nova transferência'} onClose={onClose} /><div className="finance-modal-body">
		<label className="finance-field"><span>Data *</span><DateInput name="date" required defaultValue={record?.date ?? monthDueDate(month)} /></label>
		<label className="finance-field"><span>Valor *</span><input name="amount" type="number" min="0.01" step="0.01" required defaultValue={record?.amount} /></label>
		<label className="finance-field"><span>Origem *</span><select name="from" defaultValue={record?.from ?? initialFrom}>{wallets.filter(([wallet]) => !isRepasse || wallet === 'oyo').map(([wallet, label]) => <option key={wallet} value={wallet}>{label}</option>)}</select></label>
		<label className="finance-field"><span>Destino *</span><select name="to" defaultValue={record?.to ?? 'bank'}>{wallets.filter(([wallet]) => !isRepasse || wallet !== 'oyo').map(([wallet, label]) => <option key={wallet} value={wallet}>{label}</option>)}</select></label>
		<label className="finance-field finance-field-wide"><span>Observação</span><textarea name="note" rows={2} defaultValue={record?.note} /></label>
	</div><ModalFooter saving={saving} onClose={onClose} submit={record ? 'Salvar transferência' : 'Registrar transferência'} /></form>;
}

function BalancesForm({ balances, saving, onClose, onSubmit }: { balances: FinanceBalances; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
	return <form onSubmit={onSubmit}><ModalHeader title="Saldos iniciais" onClose={onClose} /><div className="finance-modal-body">
		<p className="finance-form-hint finance-field-wide">Informe os saldos existentes antes do primeiro lançamento financeiro. Eles são a base do fechamento acumulado.</p>
		<label className="finance-field"><span>Caixa físico</span><input name="cash" type="number" step="0.01" defaultValue={balances.cash} /></label>
		<label className="finance-field"><span>Banco</span><input name="bank" type="number" step="0.01" defaultValue={balances.bank} /></label>
		<label className="finance-field"><span>Pré-pagos retidos antes do histórico</span><input name="oyo" type="number" step="0.01" defaultValue={balances.oyo} /></label>
		<p className="finance-form-hint finance-field-wide">Informe somente valores anteriores ao histórico. Pré-pagos e repasses já registrados são calculados automaticamente.</p>
	</div><ModalFooter saving={saving} onClose={onClose} submit="Salvar saldos" /></form>;
}
