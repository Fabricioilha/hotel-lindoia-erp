import { outstandingAccounts, accountsInScope, type AccountScope } from '../../services/outstandingAccounts';
import { CardFeeSettings, OutstandingAccounts } from '../../components/finance/FinanceControls';
import { FinanceMetric as Metric } from '../../components/finance/FinanceMetric';
import { FinanceOverviewCards } from '../../components/finance/FinanceOverviewCards';
import { FinancePeriodFilter } from '../../components/finance/FinancePeriodFilter';
import { CardStatements } from '../../components/finance/CardStatements';
import { cardPurchasePending, expenseCashMovements, expenseRegistrationDate, scheduleCardPurchase } from '../../services/cardStatements';
import { OyoReconciliation } from '../../components/finance/OyoReconciliation';
import { latestOyoClosing, oyoClosingBalance, oyoEstimatedPosition, oyoMonthPendingCash, subscribeOyoClosings, type OyoClosingRecord, type OyoClosingRecords } from '../../services/oyoReconciliation';
import { CashOutForm } from '../../components/finance/CashOutForm';
import { CARD_FEE_CATEGORY, cardReceiptSummary } from '../../services/cardFees';
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
import { dailyRevenueRows } from '../../services/dailyRevenue';
import { financeOverview } from '../../services/financeOverview';
import { financeDataIssues } from '../../services/financeValidation';
import { expensePaymentEvents, financeDateKeyFromTimestamp, financeMonthRange, isFinanceDateKey, patchPaymentDates, paymentEventTotals, paymentsInRange, payrollPaymentEvents, withExpensePaymentTotals } from '../../services/financePayments';
import { isPendingCardPurchase, purchaseImmediatePayment } from '../../services/purchases';
import {
	DAILY_INCOME_ITEMS,
	cardCategoryName,
	isCardCategory,
	INCOME_CATEGORIES,
	PAYMENT_METHOD_LABELS,
	PURCHASE_METHOD_LABELS,
	type PurchaseMethod,
	WALLET_LABELS,
	type CashAdjustment,
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

type Tab = 'resumo' | 'faturamento' | 'entradas' | 'prepagos' | 'saidas' | 'transferencias' | 'categorias' | 'pendencias' | 'faturas';
type Modal = 'entrada' | 'entrada-prepaga' | 'saida' | 'transferencia' | 'repasse' | 'pagamento-oyo' | 'saldo' | 'ajuste' | null;
type TransactionRange = { from: string; to: string };
// Categorias usadas por lançamentos automáticos (hospedagem, venda, estoque, OYO).
const SALARY_ADVANCE_CATEGORY = 'Adiantamento de salário';
const LOCKED_CATEGORIES = { income: INCOME_CATEGORIES, expense: [CARD_FEE_CATEGORY, 'Estoque', 'OYO', SALARY_ADVANCE_CATEGORY, ...CASH_OUT_REASONS] };
type Activity = { id: string; date: string; periodPaid?: number; title: string; detail: string; amount: number; paid: number; type: 'entrada' | 'saida' | 'folha'; wallet: string; transfer?: boolean };

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const localDateKey = () => financeDateKeyFromTimestamp(new Date().toISOString());
const localMonth = () => localDateKey().slice(0, 7);
const monthDueDate = (month: string) => {
	const day = Math.min(Number(localDateKey().slice(8, 10)), new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate());
	return `${month}-${String(day).padStart(2, '0')}`;
};
const monthLabel = (value: string) => value.split('-').reverse().join('/');
const oyoBalanceLabel = (value: number) => value < 0 ? 'A pagar à OYO' : value > 0 ? 'A receber da OYO' : 'Sem saldo';
const dateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR');
const dateWithinRange = (date: string, range: TransactionRange) => date >= range.from && date <= range.to;
const id = () => crypto.randomUUID();
const paymentItemTotal = (items: { amount: number }[]) => items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100;
const newIncomeItem = (description: string, paymentMethod: FinancePaymentMethod = 'cash'): FinanceIncomeItem => ({ id: id(), description, amount: 0, paymentMethod });

function incomePaymentSummary(entry: FinanceIncome) {
	const totals = new Map<FinancePaymentMethod, number>();
	incomeItems(entry).forEach((item) => totals.set(item.paymentMethod, (totals.get(item.paymentMethod) ?? 0) + item.amount));
	const fees = cardReceiptSummary(entry);
  return [...totals].map(([method, amount]) => `${money(amount)} ${PAYMENT_METHOD_LABELS[method]}`).join(' · ') + (fees.fee ? ` · taxa ${money(fees.fee)} · líquido ${money(fees.net)}` : '');
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
	const [summaryRange, setSummaryRange] = useState(() => financeMonthRange(localMonth()));
	const [tab, setTab] = useState<Tab>('resumo');
	const [search, setSearch] = useState('');
	const [walletFilter, setWalletFilter] = useState<FinanceWallet | 'all'>('all');
	const [exportingMonth, setExportingMonth] = useState('');
	const [rangeFromDraft, setRangeFromDraft] = useState(localDateKey);
	const [rangeToDraft, setRangeToDraft] = useState(localDateKey);
	const [transactionRange, setTransactionRange] = useState<TransactionRange>(() => ({ from: localDateKey(), to: localDateKey() }));
	const [modal, setModal] = useState<Modal>(null);
	const [editingId, setEditingId] = useState('');
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [oyoClosings, setOyoClosings] = useState<OyoClosingRecords | null>(null);
	const [oyoReadError, setOyoReadError] = useState('');
	const isMovementTab = tab === 'entradas' || tab === 'saidas';
	const isOyoTab = tab === 'prepagos';
	const rangeTab = isMovementTab || tab === 'transferencias' || tab === 'faturamento';
  const [summaryOpen, setSummaryOpen] = useState(() => localStorage.getItem('cash-summary-open') !== 'false');
  const positionDate = localDateKey();
  const monthEnd = financeMonthRange(month).to;
  const summaryEnd = summaryRange.to < positionDate ? summaryRange.to : positionDate;
  const [debtScope, setDebtScope] = useState<AccountScope>('all');
  const openDebts = (scope: AccountScope) => { setDebtScope(scope); setTab('pendencias'); };
  const debts = outstandingAccounts(data, positionDate);
  const totalPending = paymentItemTotal(debts.map((entry) => ({ amount: entry.pending })));
  const overdueTotal = accountsInScope(debts, 'overdue', positionDate, summaryRange.to).reduce((sum, entry) => sum + Math.round(entry.pending * 100), 0) / 100;
  const futureTotal = accountsInScope(debts, 'future', positionDate, summaryRange.to).reduce((sum, entry) => sum + Math.round(entry.pending * 100), 0) / 100;
  const upcomingTotal = accountsInScope(debts, 'upcoming', positionDate, summaryRange.to).reduce((sum, entry) => sum + Math.round(entry.pending * 100), 0) / 100;
  const unassignedCardTotal = paymentItemTotal(accountsInScope(debts, 'unassignedCards', positionDate, summaryRange.to).map((entry) => ({ amount: entry.pending })));

	// Saldos acumulados e consultas por intervalo precisam dos movimentos operacionais antigos.
	useEffect(() => subscribeFinance((next) => { setData(next); setLoading(false); setError(''); },
		(cause) => { setError(cause.message); setLoading(false); }), []);

	useEffect(() => subscribeOyoClosings((records) => {
		setOyoClosings(records);
		setOyoReadError('');
	}, () => setOyoReadError('Não foi possível consultar os fechamentos da OYO.')), []);

	const oyoAsOf = monthEnd < positionDate ? monthEnd : positionDate;
	const currentOyoClosing = oyoClosings && latestOyoClosing(oyoClosings, oyoAsOf.slice(0, 7));
	const monthOyoBalance = oyoClosings ? oyoClosingBalance(oyoClosings, month) : null;
  const currentOyoPosition = currentOyoClosing ? oyoEstimatedPosition(data, currentOyoClosing, oyoAsOf) : null;
  const currentOyoTransferIds = new Set(currentOyoPosition?.transfers.map((item) => item.id));
  const oyoTransfers = isOyoTab ? Object.values(data.transfers).filter((item) => (item.from === 'oyo' || item.to === 'oyo')
    && (item.date.startsWith(month) || item.oyoRecomMonth === month || currentOyoTransferIds.has(item.id)))
    .sort((a, b) => b.date.localeCompare(a.date)) : [];
	function onOyoClosingSaved(month: string, record: OyoClosingRecord) {
		setOyoClosings((current) => ({ ...current, [month]: record }));
	}

	const activeRange = tab === 'resumo' ? { from: summaryRange.from, to: summaryEnd } : rangeTab ? transactionRange : financeMonthRange(month);
	const term = rangeTab ? search.trim().toLocaleLowerCase('pt-BR') : '';
	const matchesText = (...values: (string | undefined)[]) => !term || values.some((value) => value?.toLocaleLowerCase('pt-BR').includes(term));
	const registeredIncomes = Object.values(data.incomes).filter((entry) => dateWithinRange(entry.date, activeRange) && matchesText(entry.category, entry.note, ...incomeItems(entry).map((item) => item.description))).sort((a, b) => b.date.localeCompare(a.date));
	const incomes = registeredIncomes.flatMap((entry) => {
		const hotel = hotelIncomeView(entry);
		if (!hotel) return [];
		if (!isMovementTab || walletFilter === 'all') return [hotel];
		const items = incomeItems(hotel).filter((item) => incomePaymentWallet(item.paymentMethod) === walletFilter);
		return items.length ? [{ ...hotel, items, amount: paymentItemTotal(items) }] : [];
	});
	const incomingTransfers = tab === 'entradas' ? Object.values(data.transfers).filter((entry) => entry.from === 'oyo' && entry.to !== 'oyo'
		&& dateWithinRange(entry.date, activeRange) && (walletFilter === 'all' || entry.to === walletFilter)
		&& matchesText('Repasse da OYO', entry.note, WALLET_LABELS[entry.to])) : [];
	const expenses = Object.values(data.expenses).filter((entry) => {
		const payments = expensePaymentEvents(entry);
		return (dateWithinRange(entry.dueDate, activeRange) || dateWithinRange(expenseRegistrationDate(data, entry), activeRange)
			|| paymentsInRange(payments, activeRange.from, activeRange.to).length > 0)
			&& matchesText(entry.category, entry.employee, entry.note, entry.cardCategory)
			&& (!isMovementTab || walletFilter === 'all' || paymentsInRange(payments, activeRange.from, activeRange.to).some((payment) => payment.wallet === walletFilter));
	}).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
	const payroll = Object.values(data.payroll).filter((entry) => {
		const payments = payrollPaymentEvents(entry);
		return (dateWithinRange(entry.dueDate, activeRange) || (!isMovementTab && entry.month === month) || paymentsInRange(payments, activeRange.from, activeRange.to).length > 0)
			&& matchesText(entry.employee, entry.position, entry.note)
			&& (!isMovementTab || walletFilter === 'all' || paymentsInRange(payments, activeRange.from, activeRange.to).some((payment) => payment.wallet === walletFilter));
	});
	const transfers = Object.values(data.transfers).filter((item) => (tab === 'transferencias' || tab === 'resumo' ? dateWithinRange(item.date, activeRange) : item.date.startsWith(month)) && (tab !== 'transferencias' || !term || [item.note, WALLET_LABELS[item.from], WALLET_LABELS[item.to]].some((value) => value?.toLocaleLowerCase('pt-BR').includes(term)))).sort((a, b) => b.date.localeCompare(a.date));
	const revenueRows = useMemo(() => dailyRevenueRows(data.incomes, data.stays ?? {}, data.suppressed), [data.incomes, data.stays, data.suppressed]);
	const summaryRevenue = paymentItemTotal(revenueRows.filter((row) => dateWithinRange(row.date, summaryRange)));
	const periodRevenue = revenueRows.filter((row) => dateWithinRange(row.date, transactionRange) && matchesText(row.category, row.description));
	const revenueByDay = [...periodRevenue.reduce((map, row) => { const day = map.get(row.date) ?? { date: row.date, diaria: 0, cafe: 0, outros: 0, prepaid: 0, total: 0 }; const value = Math.round(row.amount * 100); if (row.category === 'Diária' || row.category === 'Rotativo') day.diaria += value; else if (row.category === 'Café') day.cafe += value; else day.outros += value; day.prepaid += Math.round(row.prepaid * 100); day.total += value; return map.set(row.date, day); }, new Map<string, { date: string; diaria: number; cafe: number; outros: number; prepaid: number; total: number }>()).values()].sort((a, b) => a.date.localeCompare(b.date));
	const financeIssues = useMemo(() => financeDataIssues(data), [data]);
	const monthSummary = useMemo(() => monthlyFinanceSummary(data, month), [data, month]);
	const { receipts, oyoPaidExpenses } = monthSummary;
	const prepaidEntries = useMemo(() => prepaidEntriesAt(data.incomes, month, data.suppressed), [data.incomes, month, data.suppressed]);
	const visiblePrepaid = prepaidEntries.filter((entry) => entry.income.date.startsWith(month));
	const prepaidTotal = prepaidEntriesTotal(prepaidEntries);
	const oyoPendingCash = oyoMonthPendingCash(monthOyoBalance, month, data.transfers, receipts.prepaid, oyoPaidExpenses);
	const oyoDebt = currentOyoPosition !== null && currentOyoPosition.balance < 0;
	const oyoBalanceMetric = <Metric label="Saldo estimado com a OYO" value={currentOyoPosition ? money(currentOyoPosition.balance) : '—'}
		detail={currentOyoPosition && currentOyoClosing
			? `${oyoBalanceLabel(currentOyoPosition.balance)} · base RECOM ${monthLabel(currentOyoClosing.month)}`
			: oyoReadError ? 'Consulta indisponível' : oyoClosings ? 'Sem RECOM de referência' : 'Carregando RECOM'}
		help={`Posição até ${dateLabel(oyoAsOf)}. Parte do saldo oficial da RECOM, que já considera a dívida anterior, comissões e ajustes do relatório. Soma os pré-pagos do hotel e os pagamentos à OYO ainda fora do fechamento. Deduz taxas e despesas compensadas e repasses já recebidos fora do fechamento. O próximo relatório confirma o valor.`}
		tone={oyoDebt ? 'coral' : 'navy'} negative={oyoDebt} />;
	const visibleIncomeTotal = paymentItemTotal([...incomes, ...incomingTransfers]);
	const periodPayments = paymentsInRange([...expenses.flatMap(expensePaymentEvents), ...payroll.flatMap(payrollPaymentEvents)], activeRange.from, activeRange.to).filter((payment) => !isMovementTab || walletFilter === 'all' || payment.wallet === walletFilter);
	const periodPaid = paymentEventTotals(periodPayments);
	const periodPaidTotal = Math.round((periodPaid.cash + periodPaid.bank + periodPaid.oyo) * 100) / 100;
	const pendingAtEnd = (planned: number, events: ReturnType<typeof expensePaymentEvents>) => Math.max(0, Math.round((planned - events.filter((payment) => payment.date <= activeRange.to).reduce((sum, payment) => sum + payment.amount, 0)) * 100) / 100);
	const periodPending = expenses.filter((entry) => (entry.purchaseMethod !== 'card' || entry.cardStatementId) && dateWithinRange(entry.dueDate, activeRange)).reduce((sum, entry) => sum + pendingAtEnd(entry.plannedAmount, expensePaymentEvents(entry)), 0) + payroll.filter((entry) => dateWithinRange(entry.dueDate, activeRange)).reduce((sum, entry) => sum + pendingAtEnd(payrollNet(entry), payrollPaymentEvents(entry)), 0);
	const expenseCategories = useMemo(() => [...new Set([...data.expenseCategories, SALARY_ADVANCE_CATEGORY])], [data.expenseCategories]);

	function selectMonth(value: string) {
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
		const range = financeMonthRange(value);
		setMonth(value); setSummaryRange(range); setTransactionRange(range); setRangeFromDraft(range.from); setRangeToDraft(range.to); setSearch(''); setWalletFilter('all');
	}
	function changeSummaryPeriod(range: TransactionRange) {
		setSummaryRange(range);
		setMonth(range.to.slice(0, 7));
	}
	function openSummaryRevenue() {
		setTransactionRange(summaryRange);
		setRangeFromDraft(summaryRange.from);
		setRangeToDraft(summaryRange.to);
		setSearch('');
		selectTab('faturamento');
		document.getElementById('finance-tab-faturamento')?.focus();
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
		if (next === 'pendencias') setDebtScope('all');
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
			const rows = [
				...incomes.map((item) => [item.date, item.category, incomeItems(item).map((line) => `${line.description}: ${money(line.amount)}`).join(' | '), incomePaymentSummary(item), item.amount, item.note] as const),
				...incomingTransfers.map((item) => [item.date, 'Repasse da OYO', '', WALLET_LABELS[item.to], item.amount, item.note] as const),
			].sort((a, b) => b[0].localeCompare(a[0]));
			exportCsv(`entradas-${fileRange}.csv`, [['Data', 'Origem', 'Itens', 'Pagamentos', 'Valor total', 'Observação'], ...rows.map((row) => [...row])]);
			return;
		}
		exportCsv(`pagamentos-${fileRange}.csv`, [['Data do movimento', 'Vencimento', 'Tipo', 'Categoria', 'Funcionário', 'Carteira', 'Valor pago ou correção', 'Referência', 'Origem da data', 'Observação'],
			...expenseCashMovements(data, expenses).filter(({ payment }) => dateWithinRange(payment.date, transactionRange)
        && (walletFilter === 'all' || payment.wallet === walletFilter)).map((movement) => {
        if (movement.statement) {
          const { statement, payment } = movement;
          return [payment.date, statement.dueDate, 'Pagamento de fatura', statement.cardCategory, '', WALLET_LABELS[payment.wallet], payment.amount, statement.id, 'Data informada', ''];
        }
        const { expense, payment } = movement;
        return [payment.date, expense.dueDate, payment.amount < 0 ? 'Correção de despesa' : 'Despesa', expense.category, expense.employee ?? '', WALLET_LABELS[payment.wallet], payment.amount, `${expense.id}/${payment.id}`, payment.dateSource === 'legacy_due_date' ? 'Vencimento de registro antigo' : 'Data informada', expense.note];
      }),
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
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível salvar os dados financeiros.');
			return false;
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
    if (kind === 'saida' && data.expenses[recordId]?.cardStatementId) {
      selectTab('faturas');
      setNotice('Esta compra está vinculada a uma fatura. Consulte o pagamento na aba Faturas.');
      return;
    }
    if (kind === 'saida' && data.expenses[recordId]?.generatedFromIncome) { setNotice('Taxa calculada automaticamente. Confira ou corrija o recebimento de origem na aba Entradas.'); return; }
		setEditingId(recordId);
		setError('');
		setModal(kind);
	}

	function saveIncome(event: FormEvent<HTMLFormElement>, category: string, items: FinanceIncomeItem[]) {
		const form = new FormData(event.currentTarget);
		const date = String(form.get('date'));
		if (!isFinanceDateKey(date) || date > localDateKey()) {
			setError('Informe a data em que o valor foi recebido, até hoje.');
			return;
		}
		const amount = items.reduce((sum, item) => sum + item.amount, 0);
		if (!category || items.length === 0 || items.some((item) => !item.description.trim() || !Number.isFinite(item.amount) || item.amount <= 0) || !Number.isFinite(amount)) {
			setError('Informe a origem e um valor maior que zero para cada item.');
			return;
		}
		const current = data.incomes[editingId];
		const timestamp = new Date().toISOString();
		const item: FinanceIncome = {
			id: current?.id ?? id(),
			date,
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
		const paymentMethodField = String(form.get('purchaseMethod') ?? '');
		const purchaseMethod = (['cash', 'pix', 'card'] as const).find((method) => method === paymentMethodField);
		const cardCategory = String(form.get('cardCategory') ?? '').trim();
		const purchaseDate = String(form.get('purchaseDate') ?? '');
		if (purchaseMethod === 'card' && !expenseCategories.some((name) => isCardCategory(name) && name === cardCategory) && cardCategory !== original?.cardCategory) { setError('Selecione o cartão utilizado na compra.'); return; }
		if (purchaseMethod === 'card' && (!isFinanceDateKey(purchaseDate) || purchaseDate > localDateKey() || dueDate < purchaseDate)) { setError('Informe a data da compra e um vencimento da fatura igual ou posterior.'); return; }
		if (!original && purchaseMethod && paidOyo !== 0) { setError('Compras em cartão, Pix ou dinheiro não podem usar retidos OYO.'); return; }
		const timestamp = new Date().toISOString();
		const recordId = original?.id ?? id();
		const operationId = id();
		const advanceMonth = String(form.get('advanceMonth') ?? '');
    if (category === SALARY_ADVANCE_CATEGORY && !/^\d{4}-(0[1-9]|1[0-2])$/.test(advanceMonth)) { setError('Informe a competência do adiantamento.'); return; }
		const immediate = !original && purchaseMethod ? purchaseImmediatePayment(purchaseMethod, plannedAmount) : undefined;
		if (immediate && (immediate.paidCash || immediate.paidBank) && dueDate > localDateKey()) { setError('Compras em dinheiro ou Pix são debitadas no dia da compra, que não pode ser futuro. Use cartão ou deixe a compra a pagar.'); return; }
    const item: FinanceExpense = { id: recordId, ...(category === SALARY_ADVANCE_CATEGORY ? { advanceMonth, ...(staffMembers(staff).find((member) => member.name === employee) ? { employeeId: staffMembers(staff).find((member) => member.name === employee)!.id } : {}) } : {}), dueDate, category, ...(employee && category === SALARY_ADVANCE_CATEGORY ? { employee } : {}), ...(purchaseMethod ? { purchaseMethod, ...(purchaseMethod === 'card' ? { cardCategory, purchaseDate } : {}) } : {}), plannedAmount, paidCash: immediate?.paidCash ?? paidCash, paidBank: immediate?.paidBank ?? paidBank, paidOyo, note: String(form.get('note') ?? '').trim(), createdAt: original?.createdAt ?? timestamp, updatedAt: timestamp, ...(original ? { operationalOverride: true } : {}) };
		void commit((latest) => {
			const current = latest.expenses[recordId];
			if (original && (!current || current.updatedAt !== original.updatedAt)) throw new Error('A despesa mudou enquanto você editava. Reabra o lançamento para atualizar os dados.');
			if (current?.cardStatementId) throw new Error('Esta compra está vinculada a uma fatura. Abra a aba Faturas.');
			const next = withExpensePaymentTotals(current, item, immediate ? dueDate : paymentDate, operationId);
			const events = { ...next.payments };
			const datePatches: Record<string, string> = {};
			const originalEvents = original ? Object.fromEntries(expensePaymentEvents(original).map((payment) => [payment.id, payment])) : {};
			eventIds.forEach((eventId, index) => {
				const payment = events[eventId];
				if (!payment) throw new Error('Uma parcela foi alterada ou excluída enquanto você editava. Reabra o lançamento.');
				if (eventDates[index] !== originalEvents[eventId]?.date || confirmedDates.has(eventId)) datePatches[eventId] = eventDates[index];
			});
			const expense = { ...next, payments: patchPaymentDates(events, datePatches) };
			if (expense.purchaseMethod === 'card' && cardPurchasePending(expense) > 0) return scheduleCardPurchase(latest, expense, operationId, timestamp);
			return { ...latest, expenses: { ...latest.expenses, [recordId]: expense } };
		}, purchaseMethod === 'card' && plannedAmount > item.paidCash + item.paidBank + paidOyo ? 'Compra registrada na fatura do cartão.' : original ? 'Despesa e pagamentos atualizados.' : item.paidCash + item.paidBank + paidOyo ? 'Despesa e pagamento registrados.' : 'Conta a pagar registrada.');
	}

	function saveTransfer(event: FormEvent<HTMLFormElement>, current?: FinanceTransfer) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const amount = Number(form.get('amount'));
		const from = String(form.get('from')) as FinanceWallet;
		const to = String(form.get('to')) as FinanceWallet;
		if (!Number.isFinite(amount) || amount <= 0 || !WALLET_LABELS[from] || !WALLET_LABELS[to] || from === to) { setError('Informe um valor positivo e carteiras diferentes.'); return; }
    const date = String(form.get('date') ?? '');
    if ((from === 'oyo' || to === 'oyo') && date > localDateKey()) { setError('Informe a data em que o pagamento ou repasse aconteceu.'); return; }
    const oyoRecomMonth = from === 'oyo' || to === 'oyo' ? String(form.get('oyoRecomMonth') ?? '') : '';
		const item: FinanceTransfer = {
			id: current?.id ?? id(),
			date,
			from,
			to,
			amount,
			note: String(form.get('note') ?? '').trim(),
			createdAt: current?.createdAt ?? new Date().toISOString(),
      ...(oyoRecomMonth ? { oyoRecomMonth } : {}),
		};
		void commit((latest) => {
      if (current && JSON.stringify(latest.transfers[item.id]) !== JSON.stringify(current)) throw new Error('Esta transferência mudou. Reabra o lançamento.');
      return { ...latest, transfers: { ...latest.transfers, [item.id]: item } };
    }, current ? 'Transferência atualizada.' : 'Transferência registrada.');
	}

  function saveCashAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const adjustmentId = String(form.get('id'));
    const previous = data.cashAdjustments?.[adjustmentId];
    const amount = Math.round(Number(form.get('amount')) * 100) / 100;
    const date = String(form.get('date'));
    const note = String(form.get('note')).trim();
    if (!isFinanceDateKey(date) || !Number.isFinite(amount) || amount === 0 || !note) { setError('Informe a data, o motivo e um valor positivo ou negativo diferente de zero.'); return; }
    const stamp = new Date().toISOString();
    const record: CashAdjustment = { id: adjustmentId, date, amount, note, createdAt: previous?.createdAt ?? stamp, updatedAt: stamp };
    void commit((latest) => {
      if (JSON.stringify(latest.cashAdjustments?.[adjustmentId]) !== JSON.stringify(previous)) throw new Error('Este ajuste mudou em outra sessão. Reabra o formulário.');
      return { ...latest, cashAdjustments: { ...latest.cashAdjustments, [adjustmentId]: record } };
    }, 'Ajuste salvo. O saldo foi atualizado desde a data informada e em todos os meses seguintes.');
  }

  function removeCashAdjustment(record: CashAdjustment) {
    if (!window.confirm('Excluir este ajuste? O saldo será recalculado desde a data do ajuste até os meses seguintes.')) return;
    void commit((latest) => {
      if (JSON.stringify(latest.cashAdjustments?.[record.id]) !== JSON.stringify(record)) throw new Error('Este ajuste mudou. Atualize a tela antes de excluir.');
      const cashAdjustments = { ...latest.cashAdjustments }; delete cashAdjustments[record.id];
      return { ...latest, cashAdjustments };
    }, 'Ajuste excluído e saldos recalculados.');
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
        [records]: Object.fromEntries(Object.entries(latest[records]).map(([id, entry]) => {
          const expense = kind === 'expense' ? latest.expenses[id] : undefined;
          if (entry.category !== from && expense?.cardCategory !== from) return [id, entry];
          return [id, { ...entry, ...(entry.category === from ? { category } : {}), ...(expense?.cardCategory === from ? { cardCategory: category } : {}), updatedAt: new Date().toISOString() }];
        })) };
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
	const compensatedAdvances = new Map(Object.values(data.payroll).flatMap((entry) => Object.keys(entry.advances ?? {}).map((advanceId) => [advanceId, entry] as const)));
	const activities: Activity[] = [
		...incomes.map((item) => ({ id: item.id, date: item.date, title: item.category, detail: `${item.note}${item.note ? ' · ' : ''}${incomeItems(item).map((line) => line.description).join(', ')}`, amount: item.amount, paid: item.amount, type: 'entrada' as const, wallet: incomePaymentSummary(item) })),
		...incomingTransfers.map((item) => ({ id: item.id, date: item.date, title: 'Repasse da OYO', detail: item.note, amount: item.amount, paid: item.amount,
			type: 'entrada' as const, wallet: WALLET_LABELS[item.to], transfer: true })),
		...expenses.map((item) => {
			const payments = paymentsInRange(expensePaymentEvents(item), activeRange.from, activeRange.to).filter((payment) => !isMovementTab || walletFilter === 'all' || payment.wallet === walletFilter);
			const onCard = item.purchaseMethod === 'card';
			const registeredOn = expenseRegistrationDate(data, item);
			const movementDate = onCard && dateWithinRange(registeredOn, activeRange) && walletFilter === 'all'
				? registeredOn : payments.map((payment) => payment.date).sort().at(-1) || item.dueDate;
			return { id: item.id, date: movementDate, title: item.category, detail: [
				onCard ? `Compra em ${dateLabel(registeredOn)}` : '',
				!onCard || item.cardStatementId ? `Vencimento ${dateLabel(item.dueDate)}` : '',
				item.purchaseMethod ? `${PURCHASE_METHOD_LABELS[item.purchaseMethod]}${item.cardCategory ? ` (${item.cardCategory})` : ''}` : '',
				isPendingCardPurchase(item) ? 'Aguardando pagamento da fatura' : '',
				item.employee ? `Para: ${item.employee}` : '',
				compensatedAdvances.has(item.id) ? `Compensado na folha ${compensatedAdvances.get(item.id)!.month.slice(5)}/${compensatedAdvances.get(item.id)!.month.slice(0, 4)}` : '',
				item.note,
			].filter(Boolean).join(' · '), amount: item.plannedAmount, paid: item.paidCash + item.paidBank + (item.paidOyo ?? 0), periodPaid: paymentItemTotal(payments), type: 'saida' as const, wallet: `${money(item.paidCash)} em caixa · ${money(item.paidBank)} em banco · ${money(item.paidOyo ?? 0)} retidos OYO` };
		}),
		...payroll.map((item) => { const payments = paymentsInRange(payrollPaymentEvents(item), activeRange.from, activeRange.to).filter((payment) => !isMovementTab || walletFilter === 'all' || payment.wallet === walletFilter); return { id: item.id, date: payments.map((payment) => payment.date).sort().at(-1) || item.dueDate, title: item.employee, detail: [`Vencimento ${dateLabel(item.dueDate)}`, item.position || 'Folha de pagamento', Object.keys(item.advances ?? {}).length ? `Vales compensados: ${money(Object.values(item.advances ?? {}).reduce((sum, amount) => sum + amount, 0))} (já saíram do caixa)` : ''].filter(Boolean).join(' · '), amount: payrollNet(item), paid: item.paidCash + item.paidBank, periodPaid: paymentItemTotal(payments), type: 'folha' as const, wallet: `${money(item.paidCash)} em caixa · ${money(item.paidBank)} em banco` }; }),
	].sort((a, b) => b.date.localeCompare(a.date));
	const financeActions = <>
		<button type="button" className="finance-button finance-button-soft finance-export-button" title="Baixar a planilha contábil do mês de referência completo" disabled={Boolean(exportingMonth) || saving} onClick={() => void exportMonthlyReport()}>{exportingMonth ? `Gerando ${monthLabel(exportingMonth)}...` : `↓ Planilha mensal · ${monthLabel(month)}`}</button>
		<button type="button" className="finance-button finance-button-soft" disabled={loading || saving} onClick={() => openModal('ajuste')}>Ajuste de caixa (+ / −)</button>
		<button type="button" className="finance-text-button" disabled={loading || saving} onClick={() => openModal('saldo')}>Saldos iniciais</button>
	</>;

	return (
		<div className="finance-page cash-flow-page">
			<header className="finance-header">
				<Link to="/" className="finance-brand"><span className="finance-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>GESTÃO FINANCEIRA</small></span></Link>
				<nav aria-label="Módulos financeiros"><Link className="finance-nav-active" to="/financeiro/caixa">Fluxo de caixa</Link><Link to="/financeiro/folha">Folha de pagamento</Link><Link to="/">Painel</Link></nav>
			</header>

			<main className="finance-content">
				<div className="finance-page-heading">
					<div><p className="finance-eyebrow">FINANCEIRO <span>/</span> CONTROLE</p><h1>Fluxo de caixa</h1><p>Consulte recebimentos, pagamentos e contas em aberto.</p></div>
					<div className="finance-heading-actions"><button className="finance-button finance-button-dark" disabled={loading || saving} onClick={() => openModal('entrada')}>+ Entrada</button><button className="finance-button finance-button-primary" disabled={loading || saving} onClick={() => openModal('saida')}>+ Despesa</button></div>
				</div>
				{tab !== 'resumo' && <section className="finance-report-toolbar" aria-label="Mês para consultar ou lançar">
					<div className="finance-month-navigation"><button type="button" className="finance-month-arrow" onClick={() => changeMonth(-1)} aria-label="Mês anterior">‹</button><label className="finance-month"><span>Mês de referência e da planilha</span><input type="month" value={month} onChange={(event) => selectMonth(event.target.value)} /></label><button type="button" className="finance-month-arrow" onClick={() => changeMonth(1)} aria-label="Mês seguinte">›</button></div>
					<div className="finance-heading-actions finance-reference-actions">{financeActions}</div>
				</section>}

				{error && <div className="finance-alert" role="alert">{error}<button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
				{notice && <div className="finance-notice" role="status">{notice}</div>}
				{financeStorageMode === 'PocketBase' && <p className="finance-storage-notice">Dados compartilhados pelo PocketBase</p>}
				{!loading && financeIssues.length > 0 && <details className="finance-validation-notice"><summary>{financeIssues.length} informação(ões) precisam de correção no histórico financeiro</summary><ul>{financeIssues.map((issue, index) => <li key={`${issue.kind}-${issue.recordId}-${index}`}><span>{issue.message} <small>Registro {issue.recordId}</small></span>{issue.kind === 'payroll' ? <Link to="/financeiro/folha">Abrir folha</Link> : <button type="button" className="finance-text-button" onClick={() => openModal(issue.kind === 'income' ? 'entrada' : issue.kind === 'expense' ? 'saida' : 'transferencia', issue.recordId)}>Corrigir lançamento</button>}</li>)}</ul></details>}

				{loading ? <div className="finance-empty">Carregando lançamentos...</div> : <>
					<div className="finance-tabs" role="tablist" aria-label="Visões do fluxo de caixa" onKeyDown={(event) => {
							const tabs: Tab[] = ['resumo', 'faturamento', 'entradas', 'prepagos', 'saidas', 'transferencias', 'pendencias', 'faturas', 'categorias'];
							if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
							event.preventDefault();
							const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
							selectTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#finance-tab-${next}`)?.focus();
						}}>
						{([['resumo', 'Resumo'], ['faturamento', 'Faturamento diário'], ['entradas', 'Entradas'], ['prepagos', 'OYO'], ['saidas', 'Despesas'], ['transferencias', 'Transferências'], ['pendencias', 'Contas a pagar'], ['faturas', 'Faturas'], ['categorias', 'Configurações']] as [Tab, string][]).map(([idTab, label]) => <button key={idTab} id={`finance-tab-${idTab}`} role="tab" aria-controls={`finance-view-${idTab}`} tabIndex={tab === idTab ? 0 : -1} aria-selected={tab === idTab} className={tab === idTab ? 'selected' : ''} onClick={() => selectTab(idTab)}>{label}</button>)}
					</div>

					<div className="finance-tab-content" role="tabpanel" tabIndex={0} id={`finance-view-${tab}`} aria-labelledby={`finance-tab-${tab}`}>
					{tab === 'resumo' && <>
					<FinancePeriodFilter key={`${summaryRange.from}:${summaryRange.to}`} range={summaryRange} today={positionDate} onChange={changeSummaryPeriod} />
					<div className="finance-revenue-highlight">
						<Metric label="Faturamento do período" value={loading ? '—' : money(summaryRevenue)} tone="blue" detail="Clique no valor para consultar o faturamento por dia"
							help="Soma o faturamento do hotel na faixa selecionada. Diárias e cafés de estadias longas são distribuídos pelos dias do serviço. Inclui a parte do hotel nos pré-pagos e exclui as taxas da OYO."
							onOpen={openSummaryRevenue} actionLabel="Ver faturamento diário" />
					</div>
					<div className="finance-summary-toggle">
						<div className="finance-heading-actions">
							<button type="button" className="finance-button finance-button-soft" aria-expanded={summaryOpen} onClick={() => setSummaryOpen((value) => { localStorage.setItem('cash-summary-open', String(!value)); return !value; })}>{summaryOpen ? 'Recolher indicadores' : 'Mostrar indicadores'}</button>
							<Link className="finance-button finance-button-soft" to={`/financeiro/relatorios?de=${summaryRange.from}&ate=${summaryRange.to}`}>Abrir relatórios e gráficos</Link>
						</div>
						<div className="finance-heading-actions">{financeActions}</div>
					</div>
					{summaryOpen && <FinanceOverviewCards data={data} overview={financeOverview(data, summaryRange, positionDate)} closings={oyoClosings} oyoReadError={oyoReadError} />}

					<section className="finance-summary-section" aria-labelledby="debt-summary-heading">
						<h2 id="debt-summary-heading">Contas a pagar</h2>
						<div className="finance-metrics">
							<Metric label="Total em aberto hoje" value={money(totalPending)} tone="navy" onOpen={() => openDebts('all')}
								detail="Todos os vencimentos e compras sem fatura" help="Soma todas as pendências registradas até hoje, incluindo contas de outros meses e compras no cartão que ainda aguardam o agrupamento em uma fatura." />
							<Metric label="Contas vencidas" value={money(overdueTotal)} tone="coral" onOpen={() => openDebts('overdue')}
								detail={`Com vencimento até ${dateLabel(summaryRange.to)}`} help="Soma das contas ainda em aberto vencidas antes de hoje, considerando vencimentos até o fim do período selecionado." />
							<Metric label="A vencer" value={money(upcomingTotal)} tone="gold" onOpen={() => openDebts('upcoming')}
								detail={`Com vencimento até ${dateLabel(summaryRange.to)}`} help="Valores em aberto com vencimento entre hoje e a data final do período selecionado." />
						</div>
					</section>
          <p className="finance-form-hint"><button type="button" className="finance-text-button" onClick={() => openDebts('future')}>Vencimentos após {dateLabel(summaryRange.to)}: {money(futureTotal)}</button>
            {' · '}<button type="button" className="finance-text-button" onClick={() => openDebts('unassignedCards')}>Compras sem fatura: {money(unassignedCardTotal)}</button>
            {' · '}Pagamentos considerados até {dateLabel(positionDate)}.</p></>}
					{rangeTab && <form className="finance-range-form" onSubmit={applyTransactionRange}>
						<div className="finance-range-dates"><label className="finance-month"><span>De</span><input type="date" value={rangeFromDraft} onChange={(event) => setRangeFromDraft(event.target.value)} required /></label><label className="finance-month"><span>Até</span><input type="date" value={rangeToDraft} onChange={(event) => setRangeToDraft(event.target.value)} required /></label><button className="finance-button finance-button-dark" type="submit">Aplicar período</button><button className="finance-button finance-button-soft" type="button" onClick={() => setQuickRange('today')}>Hoje</button><button className="finance-button finance-button-soft" type="button" onClick={() => setQuickRange('month')}>Mês selecionado</button></div>
						<div className="finance-query-controls"><label className="finance-field"><span>Buscar lançamento</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Categoria, hóspede, funcionário ou observação" /></label>{isMovementTab && <label className="finance-field"><span>Carteira</span><select value={walletFilter} onChange={(event) => setWalletFilter(event.target.value as FinanceWallet | 'all')}><option value="all">Todas as carteiras</option><option value="cash">Caixa físico</option><option value="bank">Banco</option>{tab === 'saidas' && <option value="oyo">Retidos OYO</option>}</select></label>}{isMovementTab && <button className="finance-button finance-button-soft" type="button" onClick={exportTransactionPeriod}>Baixar consulta (.csv)</button>}</div>
						<p className="finance-range-caption" role="status">Exibindo {transactionRange.from === transactionRange.to ? dateLabel(transactionRange.from) : `${dateLabel(transactionRange.from)} a ${dateLabel(transactionRange.to)}`}{search || (isMovementTab && walletFilter !== 'all') ? ' · busca ou carteira filtrada' : ''}{rangeFromDraft !== transactionRange.from || rangeToDraft !== transactionRange.to ? ' · alterações de data aguardam aplicar' : ''}</p>
					</form>}

          {tab === 'pendencias' && <OutstandingAccounts key={`${month}:${debtScope}`} monthEnd={summaryRange.to} initialScope={debtScope}
            data={data} asOf={positionDate} onEdit={(entry) => openModal('saida', entry.id)} onCards={() => selectTab('faturas')} />}
          {tab === 'faturas' && <CardStatements data={data} month={month} today={positionDate} saving={saving} onCommit={commit} />}
          {tab === 'faturamento' && <section className="finance-panel">
            <div className="finance-panel-heading"><div>
              <h2>Faturamento por dia</h2>
              <p>Diárias e cafés de estadias longas são distribuídos pelos dias do serviço, inclusive quando pré-pagos. As taxas da OYO ficam no acerto com a OYO. Total do período <strong>{money(revenueByDay.reduce((sum, day) => sum + day.total, 0) / 100)}</strong></p>
            </div></div>
            {revenueByDay.length === 0 ? <div className="finance-empty">Nenhum faturamento no período.</div> : <div className="finance-table-wrap"><table className="finance-table">
              <thead><tr><th>Dia</th><th className="numeric">Diárias/Rotativo</th><th className="numeric">Café</th><th className="numeric">Outros</th><th className="numeric">Parte pré-paga</th><th className="numeric">Faturado no dia</th></tr></thead>
              <tbody>{revenueByDay.map((day) => <tr key={day.date}><td>{dateLabel(day.date)}</td><td className="numeric">{money(day.diaria / 100)}</td><td className="numeric">{money(day.cafe / 100)}</td><td className="numeric">{money(day.outros / 100)}</td><td className="numeric">{money(day.prepaid / 100)}</td><td className="numeric"><strong>{money(day.total / 100)}</strong></td></tr>)}</tbody>
            </table></div>}
            <div className="finance-revenue-days">{revenueByDay.map((day) => <details key={day.date} className="finance-revenue-day">
              <summary><strong>{dateLabel(day.date)}</strong> · {money(day.total / 100)} faturados{day.prepaid > 0 ? ` · ${money(day.prepaid / 100)} pré-pagos` : ''}</summary>
              <div className="finance-table-wrap"><table className="finance-table">
                <thead><tr><th>Categoria</th><th>Origem</th><th>Descrição</th><th>Pagamento</th><th>Recebido em</th><th className="numeric">Valor do dia</th></tr></thead>
                <tbody>{periodRevenue.filter((row) => row.date === day.date).map((row, index) => <tr key={`${row.incomeId}-${index}`}><td>{row.category}</td><td>{row.note.replace(/ · Plantão.*$/, '') || '—'}</td><td>{row.description}{row.spread ? ' (rateado)' : ''}</td><td>{row.methods.filter((item) => item.amount > 0).map((item) => `${PAYMENT_METHOD_LABELS[item.method as FinancePaymentMethod] ?? item.method}: ${money(item.amount)}`).join(' · ')}</td><td>{row.paidOn === row.date ? 'No próprio dia' : dateLabel(row.paidOn)}</td><td className="numeric">{money(row.amount)}</td></tr>)}</tbody>
              </table></div>
            </details>)}</div>
          </section>}
          {tab === 'categorias' && <CardFeeSettings data={data} saving={saving} onSave={(credit, debit) => void commit((latest) => ({ ...latest, cardFeeSchedule: { ...latest.cardFeeSchedule, [id()]: { effectiveAt: new Date().toISOString(), credit, debit } } }), 'Taxas salvas. Os recebimentos anteriores foram preservados.')} />}
          {isOyoTab && <>
            <section className="finance-oyo-metrics" aria-label="Indicadores da OYO">
              <Metric label="Pré-pagos do hotel na OYO" value={money(receipts.prepaid)}
                detail="Hóspedes pagaram diretamente à OYO" tone="navy"
                help="Soma a parte do hotel nos pagamentos dos hóspedes à OYO, excluída a taxa própria da OYO." />
              <Metric label="Taxas OYO recebidas no balcão" value={money(receipts.counterFees)}
                detail="Taxas do mês que pertencem à OYO" tone="green"
                help="Entram no caixa ou banco na cobrança ao hóspede. A despesa correspondente é compensada no acerto com a OYO." />
              <Metric label="Despesas compensadas pela OYO" value={money(oyoPaidExpenses)}
                detail="Abatimentos registrados no mês" tone="coral"
                help="Soma os pagamentos registrados com valores retidos pela OYO. Inclui as taxas de balcão e outras despesas lançadas nessa carteira." />
              {oyoBalanceMetric}
            </section>
            <OyoReconciliation key={month} month={month} balance={monthOyoBalance}
              pendingCash={oyoClosings ? oyoPendingCash : null} readError={oyoReadError} onSaved={onOyoClosingSaved} />
            <section className="finance-panel">
              <div className="finance-panel-heading">
                <div><h2>Pagamentos e repasses da OYO</h2><p>Vincule cada movimento à RECOM que o inclui. Sem vínculo, o cálculo usa o mês da transferência.</p></div>
                <div className="finance-heading-actions">
                  <button className="finance-button finance-button-soft" onClick={() => openModal('repasse')}>Registrar repasse recebido</button>
                  <button className="finance-button finance-button-dark" onClick={() => openModal('pagamento-oyo')}>Registrar pagamento à OYO</button>
                </div>
              </div>
              {oyoTransfers.length === 0 ? <p className="finance-empty-inline">Nenhum movimento no mês selecionado ou pendente de conciliação.</p> :
                <div className="finance-table-wrap"><table className="finance-table">
                  <thead><tr><th>Data</th><th>Movimento</th><th className="numeric">Valor</th><th>RECOM</th><th>Saldo atualizado</th><th>Ação</th></tr></thead>
                  <tbody>{oyoTransfers.map((item) => <tr key={item.id}>
                    <td>{dateLabel(item.date)}</td><td>{item.to === 'oyo' ? 'Pagamento à OYO' : 'Repasse recebido'}</td>
                    <td className="numeric">{money(item.amount)}</td>
                    <td>{monthLabel(item.oyoRecomMonth ?? item.date.slice(0, 7))}{!item.oyoRecomMonth && <small>Mês da transferência</small>}</td>
                    <td>{item.date > oyoAsOf ? 'Posterior à data do saldo' : currentOyoTransferIds.has(item.id) ? 'Incluído na estimativa' : currentOyoClosing ? 'Coberto pelo fechamento' : 'Aguardando fechamento'}</td>
                    <td><button type="button" className="finance-text-button" onClick={() => openModal('transferencia', item.id)}>Editar vínculo</button></td>
                  </tr>)}</tbody>
                </table></div>}
            </section>
            <details className="finance-panel">
              <summary>Histórico de pré-pagos</summary>
              <div className="finance-panel-heading">
                <div><h2>Pré-pagos do mês</h2><p>Pagamentos feitos pelos hóspedes diretamente à OYO.</p></div>
                <div className="finance-heading-actions">
                  <button className="finance-button finance-button-soft" onClick={exportPrepaidHistory}>Exportar histórico</button>
                  <button className="finance-button finance-button-dark" onClick={() => openModal('entrada-prepaga')}>+ Registrar pré-pago</button>
                </div>
              </div>
              <p className="finance-form-hint">Pré-pagos registrados até o mês: <strong>{money(prepaidTotal)}</strong>.</p>
              <p className="finance-form-hint">Repasses recebidos da OYO no mês: {money(receipts.repasses)} · Pagamentos enviados à OYO até este mês: {money(oyoPaymentsAt(data, month))}.</p>
              <PrepaidTable entries={visiblePrepaid} onEdit={(entry) => openModal('entrada-prepaga', entry.income.id)} onDelete={(entry) => void removeRecord('entrada', entry.income.id)} />
            </details>
          </>}

					{tab === 'resumo' && <details className="finance-panel"><summary>Detalhes do resumo, ajustes e auditoria</summary>
            <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Ajustes do caixa físico</h2><p>Valores positivos ou negativos lançados no período selecionado. Cada ajuste afeta o saldo a partir da sua data e segue acumulado nos meses seguintes.</p></div><button className="finance-text-button" disabled={saving} onClick={() => openModal('ajuste')}>+ Ajuste</button></div>
              {Object.values(data.cashAdjustments ?? {}).filter((item) => dateWithinRange(item.date, activeRange)).length === 0 ? <p className="finance-empty-inline">Nenhum ajuste neste período. Ajustes anteriores já estão incluídos no saldo acumulado.</p> : <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Data</th><th>Motivo</th><th className="numeric">Valor (+ / −)</th><th>Ações</th></tr></thead><tbody>{Object.values(data.cashAdjustments ?? {}).filter((item) => dateWithinRange(item.date, activeRange)).sort((a, b) => a.date.localeCompare(b.date)).map((item) => <tr key={item.id}><td>{dateLabel(item.date)}</td><td>{item.note}</td><td className="numeric">{item.amount > 0 ? '+' : ''}{money(item.amount)}</td><td><div className="finance-row-actions"><button disabled={saving} onClick={() => openModal('ajuste', item.id)}>Editar</button><button className="danger" disabled={saving} onClick={() => removeCashAdjustment(item)}>Excluir</button></div></td></tr>)}</tbody></table></div>}
            </section>
						<section className="finance-summary-grid">
							<CategorySummary title="Recebimentos diretos por origem" items={incomes.map((item) => [item.category, item.amount] as [string, number])} empty="Nenhuma entrada nesta competência." />
							  <CategorySummary title="Despesas por categoria" items={[...expenses.map((item) => [item.category, paymentItemTotal(paymentsInRange(expensePaymentEvents(item), activeRange.from, activeRange.to))] as [string, number]), ...payroll.map((item) => ['Folha de pagamento', paymentItemTotal(paymentsInRange(payrollPaymentEvents(item), activeRange.from, activeRange.to))] as [string, number])]} empty="Nenhuma despesa nesta competência." />
							<section className="finance-panel finance-wallet-panel"><div className="finance-panel-heading"><div><h2>Movimento entre carteiras</h2><p>Movimentos entre caixa e banco são internos. Repasses movem valores entre carteiras; taxas de balcão podem ser compensadas com valores retidos pela OYO.</p></div><button className="finance-text-button" onClick={() => openModal('transferencia')}>+ Registrar</button></div>{transfers.length === 0 ? <p className="finance-empty-inline">Sem transferências neste período.</p> : transfers.slice(0, 5).map((item) => <div className="finance-transfer-row" key={item.id}><span>{dateLabel(item.date)}</span><strong>{WALLET_LABELS[item.from]} → {WALLET_LABELS[item.to]}</strong><b>{money(item.amount)}</b></div>)}</section>
						</section>
						<ActivityTable activities={activities.slice(0, 10)} onEdit={(activity) => activity.type === 'entrada' ? openModal('entrada', activity.id) : activity.type === 'saida' ? openModal('saida', activity.id) : undefined} onDelete={(activity) => activity.type !== 'folha' && void removeRecord(activity.type, activity.id)} title="Lançamentos recentes" />
						<AuditTable onDelete={(eventId) => { if (window.confirm('Excluir este registro de auditoria?')) void commit((current) => { const auditLog = { ...current.auditLog }; delete auditLog[eventId]; return { ...current, auditLog }; }, 'Registro de auditoria excluído.'); }} events={Object.values(data.auditLog).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 20)} />
					</details>}

					{tab === 'entradas' && <section className="finance-panel">
						<div className="finance-panel-heading"><div><h2>Entradas do período</h2><p>{incomes.length + incomingTransfers.length} registros · recebido em caixa e banco {money(visibleIncomeTotal)}. Inclui repasses da OYO. Pré-pagos retidos ficam na aba OYO.</p></div>
							<div className="finance-heading-actions"><button className="finance-button finance-button-dark" onClick={() => openModal('entrada')}>+ Entrada</button></div>
						</div>
						<ActivityTable activities={activities.filter((item) => item.type === 'entrada')}
							onEdit={(activity) => openModal(activity.transfer ? 'transferencia' : 'entrada', activity.id)}
							onDelete={(activity) => void removeRecord(activity.transfer ? 'transferencia' : 'entrada', activity.id)} title="" />
					</section>}

					{tab === 'saidas' && <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Despesas {isMovementTab ? 'do período' : 'da competência'}</h2><p>{expenses.length + payroll.length} registros · {money(periodPaidTotal)} pagos no período · {money(periodPending)} pendentes com vencimento no período</p></div><div className="finance-heading-actions"><button className="finance-button finance-button-primary" onClick={() => openModal('saida')}>+ Despesa</button></div></div><ActivityTable activities={[...activities.filter((item) => item.type !== 'entrada')]} onEdit={(activity) => activity.type === 'saida' && openModal('saida', activity.id)} onDelete={(activity) => activity.type === 'saida' && void removeRecord('saida', activity.id)} title="" /></section>}

					  {tab === 'transferencias' && <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Transferências da competência</h2><p>{transfers.length} registros · transferências internas e repasses da OYO</p></div><div className="finance-heading-actions"><button className="finance-button finance-button-soft" onClick={() => exportCsv(`transferencias-${month}.csv`, [['Data', 'Origem', 'Destino', 'Valor', 'Observação'], ...transfers.map((item) => [item.date, WALLET_LABELS[item.from], WALLET_LABELS[item.to], item.amount, item.note])])}>Exportar CSV</button><button className="finance-button finance-button-dark" onClick={() => openModal('transferencia')}>+ Transferência</button></div></div>{transfers.length === 0 ? <div className="finance-empty">Nenhuma transferência neste mês.</div> : <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Data</th><th>Origem</th><th>Destino</th><th>Observação</th><th className="numeric">Valor</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{transfers.map((item) => <tr key={item.id}><td>{dateLabel(item.date)}</td><td>{WALLET_LABELS[item.from]}</td><td>{WALLET_LABELS[item.to]}</td><td>{item.note || '—'}</td><td className="numeric">{money(item.amount)}</td><td><div className="finance-row-actions"><button onClick={() => openModal('transferencia', item.id)}>Editar</button><button className="danger" onClick={() => void removeRecord('transferencia', item.id)}>Excluir</button></div></td></tr>)}</tbody></table></div>}</section>}

					  {tab === 'categorias' && <div className="finance-category-grid"><CategoryManager title="Categorias de entrada" categories={data.incomeCategories} locked={LOCKED_CATEGORIES.income} onRename={(from, to) => void renameCategory('income', from, to)} onAdd={(category) => void addCategory('income', category)} onRemove={(category) => void removeCategory('income', category)} /><CategoryManager title="Categorias de despesa" card categories={data.expenseCategories} locked={LOCKED_CATEGORIES.expense} onRename={(from, to) => void renameCategory('expense', from, to)} onAdd={(category) => void addCategory('expense', category)} onRemove={(category) => void removeCategory('expense', category)} /></div>}
					</div>
				</>}

				<footer className="finance-page-footer"><span>Armazenamento: {financeStorageMode}</span><span>Fluxo de caixa · Hotel Lindoia</span></footer>
			</main>

			{modal && <div className={`finance-modal-backdrop${modal === 'saida' ? ' finance-expense-backdrop' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget && !saving && !(modal === 'saida' && selectedExpense?.id.startsWith('caixa-'))) setModal(null); }}><section className={`finance-modal finance-modal-${modal}${modal === 'saida' ? ' finance-expense-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="finance-modal-title">
				{(modal === 'entrada' || modal === 'entrada-prepaga') && <IncomeForm record={selectedEntry} month={month} categories={data.incomeCategories} initialPaymentMethod={modal === 'entrada-prepaga' ? 'prepaid' : 'cash'} saving={saving} onClose={() => { if (!saving) setModal(null); }} onSubmit={saveIncome} />}
				{modal === 'saida' && (selectedExpense?.id.startsWith('caixa-') ? <CashOutForm key={editingId} id={editingId.slice('caixa-'.length)} onClose={() => setModal(null)} onSaved={() => { setModal(null); setNotice('Saída corrigida no plantão e no financeiro.'); }} /> : <ExpenseForm key={editingId || 'new-expense'} record={selectedExpense} month={month} categories={expenseCategories} employees={staffMembers(staff).map((member) => member.name)} saving={saving} onClose={() => setModal(null)} onSubmit={saveExpense} />)}
				{(modal === 'transferencia' || modal === 'repasse' || modal === 'pagamento-oyo') && <TransferForm record={selectedTransfer} initialFrom={modal === 'repasse' ? 'oyo' : modal === 'pagamento-oyo' ? 'bank' : 'cash'} initialTo={modal === 'pagamento-oyo' ? 'oyo' : 'bank'} month={month} saving={saving} onClose={() => setModal(null)} onSubmit={saveTransfer} />}
				{modal === 'ajuste' && <CashAdjustmentForm key={editingId || 'new-adjustment'} record={data.cashAdjustments?.[editingId]} month={month} saving={saving} error={error} onClose={() => setModal(null)} onSubmit={saveCashAdjustment} />}
				{modal === 'saldo' && <BalancesForm balances={data.openingBalances} saving={saving} onClose={() => setModal(null)} onSubmit={saveOpeningBalances} />}
			</section></div>}
		</div>
	);
}

function CategorySummary({ title, items, empty }: { title: string; items: [string, number][]; empty: string }) {
	const totals = items.reduce<Record<string, number>>((result, [category, amount]) => { result[category] = (result[category] ?? 0) + amount; return result; }, {});
	const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
	return <section className="finance-panel"><div className="finance-panel-heading"><div><h2>{title}</h2><p>{rows.length} categorias</p></div></div>{rows.length === 0 ? <p className="finance-empty-inline">{empty}</p> : rows.slice(0, 7).map(([category, amount]) => <div className="finance-category-row" key={category}><span>{category}</span><strong>{money(amount)}</strong></div>)}</section>;
}

function CategoryManager({ title, categories, locked, card = false, onAdd, onRename, onRemove }: { title: string; card?: boolean; categories: string[]; locked: string[]; onAdd: (category: string) => void; onRename: (from: string, to: string) => void; onRemove: (category: string) => void }) {
	const [category, setCategory] = useState('');
	const [editing, setEditing] = useState('');
	const [draft, setDraft] = useState('');
	const [cardBank, setCardBank] = useState('');
	const [cardHolder, setCardHolder] = useState('');
	function submitCard(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!cardBank.trim() || !cardHolder.trim()) return;
		onAdd(cardCategoryName(cardBank, cardHolder));
		setCardBank('');
		setCardHolder('');
	}
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!category.trim()) return;
		onAdd(category);
		setCategory('');
	}
	return <section className="finance-panel finance-category-manager"><div className="finance-panel-heading"><div><h2>{title}</h2><p>{categories.length} categorias disponíveis nos lançamentos</p></div></div><form className="finance-category-form" onSubmit={submit}><label className="finance-field"><span>Nova categoria</span><input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={50} placeholder="Digite um nome" /></label><button className="finance-button finance-button-dark" type="submit" disabled={!category.trim()}>Adicionar</button></form>{card && <form className="finance-category-form" onSubmit={submitCard}><label className="finance-field"><span>Cartão · banco *</span><input value={cardBank} onChange={(event) => setCardBank(event.target.value)} maxLength={30} placeholder="Ex.: Nubank" required /></label><label className="finance-field"><span>Cartão · titular *</span><input value={cardHolder} onChange={(event) => setCardHolder(event.target.value)} maxLength={30} placeholder="Nome do titular" required /></label><button className="finance-button finance-button-dark" type="submit" disabled={!cardBank.trim() || !cardHolder.trim()}>Adicionar cartão</button></form>}{categories.length === 0 ? <p className="finance-empty-inline">Nenhuma categoria cadastrada.</p> : <ul className="finance-category-list">{categories.map((item) => <li key={item}>{editing === item ? <><input value={draft} maxLength={50} autoFocus aria-label={`Novo nome de ${item}`} onChange={(event) => setDraft(event.target.value)} /><button type="button" title="Salvar" aria-label="Salvar nome" disabled={!draft.trim()} onClick={() => { onRename(item, draft); setEditing(''); }}>✓</button><button type="button" title="Cancelar" aria-label="Cancelar edição" onClick={() => setEditing('')}>↶</button></> : <><span>{item}{locked.includes(item) ? ' · automática' : ''}{isCardCategory(item) ? ' · cartão (débito só no pagamento)' : ''}</span>{<button type="button" title={`Editar categoria ${item}`} aria-label={`Editar categoria ${item}`} onClick={() => { setEditing(item); setDraft(item); }}>✎</button>}{<button type="button" title={`Remover categoria ${item}`} aria-label={`Remover categoria ${item}`} onClick={() => onRemove(item)}>×</button>}</>}</li>)}</ul>}</section>;
}

function ActivityTable({ activities, onEdit, onDelete, title }: { activities: Activity[]; onEdit: (activity: Activity) => void; onDelete: (activity: Activity) => void; title: string }) {
	return <section className="finance-panel finance-activity-panel">{title && <div className="finance-panel-heading"><div><h2>{title}</h2><p>Registros do período selecionado</p></div></div>}{activities.length === 0 ? <div className="finance-empty">Nenhum lançamento nesta consulta.</div> : <div className="finance-table-wrap"><table className="finance-table finance-mobile-table"><thead><tr><th>Data / vencimento</th><th>Origem / categoria</th><th>Carteira / pagamentos</th><th className="numeric">Valor</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{activities.map((item) => <tr key={`${item.transfer ? 'transferencia' : item.type}-${item.id}`}><td data-label="Data">{dateLabel(item.date)}</td><td data-label="Categoria"><strong>{item.title}</strong>{item.detail && <small title={item.detail}>{item.detail}</small>}{item.type === 'folha' && <small>Folha de pagamento</small>}</td><td data-label="Pagamento">{item.wallet}</td><td data-label="Valor" className={`numeric ${item.type === 'entrada' ? 'positive-value' : ''}`}>{item.type === 'entrada' ? money(item.amount) : <>{money(item.amount)}<small>{item.type === 'saida' ? 'Despesa' : 'Previsto'}</small><small>Pago acumulado {money(item.paid)}</small>{item.periodPaid !== undefined && <small>No período {money(item.periodPaid)}</small>}<small>Falta {money(Math.max(0, item.amount - item.paid))}</small></>}</td><td data-label="Ações"><div className="finance-row-actions">{item.type !== 'folha' && <><button onClick={() => onEdit(item)}>Editar</button><details className="finance-row-menu"><summary>Mais</summary><button className="danger" onClick={() => onDelete(item)}>Excluir lançamento</button></details></>}</div></td></tr>)}</tbody></table></div>}</section>;
}

function PrepaidTable({ entries, onEdit, onDelete }: { entries: PrepaidIncomeEntry[]; onEdit: (entry: PrepaidIncomeEntry) => void; onDelete: (entry: PrepaidIncomeEntry) => void }) {
	if (entries.length === 0) return <div className="finance-empty">Nenhum pré-pago externo registrado nesta competência.</div>;
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
	return <div className="finance-modal-footer"><button disabled={saving} type="button" className="finance-button finance-button-soft" onClick={onClose}>Cancelar</button><button className="finance-button finance-button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : submit}</button></div>;
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

	return <form data-guard-unsaved onSubmit={submit}><ModalHeader title={record ? 'Editar entrada' : initialPaymentMethod === 'prepaid' ? 'Registrar pré-pago externo à OYO' : 'Nova entrada'} onClose={onClose} /><div className="finance-modal-body">
		<label className="finance-field"><span>Data *</span><DateInput name="date" required max={localDateKey()} defaultValue={record?.date ?? monthDueDate(month)} /></label>
		<label className="finance-field"><span>Tipo de entrada *</span><select value={category} onChange={(event) => changeCategory(event.target.value)} required>{record && !categories.includes(record.category) && <option value={record.category}>{record.category} (histórica)</option>}{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
		<div className="finance-income-section finance-field-wide"><div className="finance-income-section-heading"><div><strong>{isDaily ? 'Composição da diária' : 'Itens recebidos'}</strong><small>Defina o valor e o pagamento de cada item.</small></div><button type="button" className="finance-button finance-button-soft" disabled={isDaily && !nextDailyItem} onClick={() => setItems((current) => [...current, newIncomeItem(isDaily ? nextDailyItem ?? DAILY_INCOME_ITEMS[1] : category, initialPaymentMethod)])}>{isDaily ? '+ Adicional' : '+ Dividir recebimento'}</button></div>
			<div className="finance-income-lines">{items.map((item, index) => <div className="finance-income-line" key={item.id}>
				<label className="finance-field"><span>{isDaily && index === 0 ? 'Diária' : 'Item'}</span>{isDaily && index === 0 ? <input value="Diária" readOnly aria-label="Item Diária" /> : isDaily ? <select value={item.description} onChange={(event) => updateItem(item.id, { description: event.target.value })}>{DAILY_INCOME_ITEMS.slice(1).map((part) => <option key={part} value={part}>{part}</option>)}</select> : <input value={item.description} readOnly aria-label={`Item ${item.description}`} />}</label>
				<label className="finance-field"><span>Forma de pagamento</span><select value={item.paymentMethod} onChange={(event) => updateItem(item.id, { paymentMethod: event.target.value as FinancePaymentMethod, cardFeeRate: undefined, cardFeeAmount: undefined, netAmount: undefined })}>{(Object.entries(PAYMENT_METHOD_LABELS) as [FinancePaymentMethod, string][]).filter(([method]) => incomePaymentWallet(method)).map(([method, label]) => <option key={method} value={method}>{label}</option>)}</select></label>
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
	const [method, setMethod] = useState<PurchaseMethod | ''>(record?.purchaseMethod ?? '');
	const [purchaseDate, setPurchaseDate] = useState(record?.purchaseDate ?? record?.dueDate ?? monthDueDate(month));
	const onCard = method === 'card';
	const cards = categories.filter(isCardCategory);
	const chooseMethod = (next: PurchaseMethod | '') => {
		setMethod(next);
		if (!record && next) { setCash('0'); setBank('0'); setOyo('0'); }
	};
	const [events] = useState(() => record ? expensePaymentEvents(record) : []);
	const [eventDates, setEventDates] = useState(() => Object.fromEntries(events.map((payment) => [payment.id, payment.date])));
	const employeeOptions = [...new Set([...employees, ...(record?.employee ? [record.employee] : [])])];
	const immediate = !record && method ? purchaseImmediatePayment(method, Number(planned || 0)) : undefined;
	const shownCash = immediate ? String(immediate.paidCash) : cash;
	const shownBank = immediate ? String(immediate.paidBank) : bank;
	const totalPaid = Number(shownCash || 0) + Number(shownBank || 0) + Number(oyo || 0);
	return <form data-guard-unsaved onSubmit={(event) => onSubmit(event, original)}><ModalHeader title={record ? 'Editar despesa' : 'Nova despesa'} onClose={onClose} /><div className="finance-modal-body finance-expense-body">
		<section className="finance-expense-section" aria-labelledby="finance-expense-details-title">
			<div className="finance-expense-step"><span>1</span><div><strong id="finance-expense-details-title">Dados da despesa</strong><small>Informe a forma de pagamento e as datas do lançamento.</small></div></div>
			<div className="finance-expense-grid">
				<label className="finance-field"><span>Forma de pagamento da compra</span><select name="purchaseMethod" value={method} onChange={(event) => chooseMethod(event.target.value as PurchaseMethod | '')}><option value="">Não informada / a pagar</option>{(Object.keys(PURCHASE_METHOD_LABELS) as PurchaseMethod[]).map((key) => <option key={key} value={key}>{PURCHASE_METHOD_LABELS[key]}</option>)}</select></label>
				{method === 'card' && <label className="finance-field"><span>Cartão *</span><select name="cardCategory" required defaultValue={record?.cardCategory ?? ''}><option value="" disabled>{cards.length ? 'Selecione o cartão' : 'Nenhum cartão cadastrado'}</option>{record?.cardCategory && !cards.includes(record.cardCategory) && <option value={record.cardCategory}>{record.cardCategory} (histórico)</option>}{cards.map((card) => <option key={card} value={card}>{card}</option>)}</select></label>}
				{onCard && <label className="finance-field"><span>Data da compra *</span><DateInput name="purchaseDate" required value={purchaseDate} onValueChange={setPurchaseDate} max={localDateKey()} /></label>}
				<label className="finance-field"><span>{onCard ? 'Vencimento da fatura *' : method ? 'Data da compra *' : 'Vencimento *'}</span><DateInput key={onCard ? 'statement' : 'expense'} name="dueDate" required min={onCard ? purchaseDate : undefined} defaultValue={onCard ? (record && (record.purchaseDate || !isPendingCardPurchase(record)) ? record.dueDate : '') : record?.dueDate ?? monthDueDate(month)} /></label>
				<label className="finance-field"><span>Categoria *</span><select name="category" value={category} onChange={(event) => setCategory(event.target.value)} required><option value="" disabled>Selecione uma categoria</option>{record && !categories.includes(record.category) && <option value={record.category}>{record.category} (histórica)</option>}{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
				<label className="finance-field"><span>Valor previsto (R$) *</span><input name="plannedAmount" type="number" min="0.01" step="0.01" required value={planned} onChange={(event) => setPlanned(event.target.value)} /></label>
				<label className="finance-field"><span>Observação</span><textarea name="note" rows={2} defaultValue={record?.note} /></label>
			</div>
		</section>
		<section className="finance-expense-section" aria-labelledby="finance-expense-payments-title">
			<div className="finance-expense-step"><span>2</span><div><strong id="finance-expense-payments-title">Pagamentos realizados</strong><small>Pix e dinheiro debitam a carteira no dia da compra.</small></div></div>
			{onCard && <p className="finance-form-hint">A compra entra na fatura desse vencimento. Registre a saída da carteira na aba Faturas quando o pagamento for realizado.</p>}
			{!onCard && <><div className="finance-expense-grid">
				<label className="finance-field"><span>Pago em dinheiro (R$)</span><input name="paidCash" type="number" min="0" step="0.01" value={shownCash} readOnly={Boolean(immediate)} onChange={(event) => setCash(event.target.value)} /></label>
				<label className="finance-field"><span>Pago pelo banco (R$)</span><input name="paidBank" type="number" min="0" step="0.01" value={shownBank} readOnly={Boolean(immediate)} onChange={(event) => setBank(event.target.value)} /></label>
				<label className="finance-field"><span>Compensado com retidos OYO (R$)</span><input name="paidOyo" type="number" min="0" step="0.01" value={oyo} readOnly={Boolean(immediate)} onChange={(event) => setOyo(event.target.value)} /></label>
				<label className="finance-field"><span>Data do novo pagamento ou correção</span><DateInput name="paymentDate" defaultValue={month === localDateKey().slice(0, 7) ? localDateKey() : monthDueDate(month)} max={localDateKey()} /></label>
			</div>
			<div className="finance-payment-shortcuts"><button type="button" className="finance-button finance-button-soft" disabled={Boolean(immediate) || !Number(planned)} onClick={() => setCash(String(Math.max(0, Number(planned) - Number(bank || 0) - Number(oyo || 0))))}>Quitar em dinheiro</button><button type="button" className="finance-button finance-button-soft" disabled={Boolean(immediate) || !Number(planned)} onClick={() => setBank(String(Math.max(0, Number(planned) - Number(cash || 0) - Number(oyo || 0))))}>Quitar pelo banco</button><span>Pago {money(totalPaid)} · falta {money(Math.max(0, Number(planned || 0) - totalPaid))}</span></div>
			<p className="finance-form-hint">Pagamentos anteriores conservam suas datas. Um novo pagamento ou ajuste utiliza a data acima.</p></>}
			{onCard && record && <><input type="hidden" name="paidCash" value={record.paidCash} /><input type="hidden" name="paidBank" value={record.paidBank} /><input type="hidden" name="paidOyo" value={record.paidOyo ?? 0} /></>}
			{events.length > 0 && <div className="finance-payment-history"><h3>Histórico de parcelas</h3><p>Corrija a data de uma parcela sem alterar as demais.</p>{events.map((payment) => <div className="finance-payment-event" key={payment.id}><input type="hidden" name="paymentEventId" value={payment.id} /><div><strong>{money(payment.amount)} · {WALLET_LABELS[payment.wallet]}</strong>{payment.amount < 0 && <small>Correção / estorno</small>}{payment.dateSource === 'legacy_due_date' && <small>Data histórica ausente: vencimento utilizado</small>}</div><label className="finance-field"><span>Data desta parcela</span><DateInput name="paymentEventDate" required max={localDateKey()} value={eventDates[payment.id]} onValueChange={(date) => setEventDates((current) => ({ ...current, [payment.id]: date }))} /></label>{payment.dateSource === 'legacy_due_date' && <label className="finance-confirm-date"><input type="checkbox" name="paymentEventConfirmed" value={payment.id} />Confirmar esta data de pagamento</label>}</div>)}</div>}
		</section>
		{category === SALARY_ADVANCE_CATEGORY && <section className="finance-expense-section" aria-labelledby="finance-expense-employee-title"><div className="finance-expense-step"><span>3</span><div><strong id="finance-expense-employee-title">Beneficiário e compensação na folha</strong><small>Selecione quem receberá o valor.</small></div></div><label className="finance-field"><span>Competência para descontar na folha *</span><input name="advanceMonth" type="month" required defaultValue={record?.advanceMonth ?? month} /></label><label className="finance-field"><span>Funcionário *</span><select name="employee" required defaultValue={record?.employee ?? ''}><option value="" disabled>Selecione um funcionário</option>{employeeOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>{employeeOptions.length === 0 && <p className="finance-form-hint">Nenhum funcionário ativo no quadro de funcionários.</p>}</section>}
	</div><ModalFooter saving={saving} onClose={onClose} submit={record ? 'Salvar despesa e pagamentos' : 'Registrar despesa'} /></form>;
}

function TransferForm({ record, month, initialFrom = 'cash', initialTo = 'bank', saving, onClose, onSubmit }: { record?: FinanceTransfer; month: string; initialFrom?: FinanceWallet; initialTo?: FinanceWallet; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>, original?: FinanceTransfer) => void }) {
  const [original] = useState(record);
  const [from, setFrom] = useState<FinanceWallet>(record?.from ?? initialFrom);
  const [to, setTo] = useState<FinanceWallet>(record?.to ?? initialTo);
  const isRepasse = initialFrom === 'oyo' && !record;
  const isOyoPayment = initialTo === 'oyo' && !record;
  const hasOyo = (from === 'oyo') !== (to === 'oyo');
  const wallets = Object.entries(WALLET_LABELS) as [FinanceWallet, string][];
	return <form data-guard-unsaved onSubmit={(event) => onSubmit(event, original)}><ModalHeader title={record ? 'Editar transferência' : isRepasse ? 'Repasse da OYO' : isOyoPayment ? 'Pagamento à OYO' : 'Nova transferência'} onClose={onClose} /><div className="finance-modal-body">
		<label className="finance-field"><span>Data *</span><DateInput name="date" required max={hasOyo ? localDateKey() : undefined} defaultValue={record?.date ?? monthDueDate(month)} /></label>
		<label className="finance-field"><span>Valor *</span><input name="amount" type="number" min="0.01" step="0.01" required defaultValue={record?.amount} /></label>
		<label className="finance-field"><span>Origem *</span><select name="from" value={from} onChange={(event) => setFrom(event.target.value as FinanceWallet)}>{wallets.filter(([wallet]) => isRepasse ? wallet === 'oyo' : !isOyoPayment || wallet !== 'oyo').map(([wallet, label]) => <option key={wallet} value={wallet}>{label}</option>)}</select></label>
		<label className="finance-field"><span>Destino *</span><select name="to" value={to} onChange={(event) => setTo(event.target.value as FinanceWallet)}>{wallets.filter(([wallet]) => isOyoPayment ? wallet === 'oyo' : !isRepasse || wallet !== 'oyo').map(([wallet, label]) => <option key={wallet} value={wallet}>{label}</option>)}</select></label>
    {hasOyo && <label className="finance-field finance-field-wide"><span>RECOM que inclui este movimento (opcional)</span>
      <input type="month" name="oyoRecomMonth" defaultValue={record?.oyoRecomMonth} />
      <small>Informe o mês do relatório que já contabiliza este movimento. Em branco, vale o mês da transferência.</small>
    </label>}
		<label className="finance-field finance-field-wide"><span>Observação</span><textarea name="note" rows={2} defaultValue={record?.note} /></label>
	</div><ModalFooter saving={saving} onClose={onClose} submit={record ? 'Salvar transferência' : 'Registrar transferência'} /></form>;
}

function BalancesForm({ balances, saving, onClose, onSubmit }: { balances: FinanceBalances; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
	return <form data-guard-unsaved onSubmit={onSubmit}><ModalHeader title="Saldos iniciais" onClose={onClose} /><div className="finance-modal-body">
		<p className="finance-form-hint finance-field-wide">Informe os saldos existentes antes do primeiro lançamento financeiro. Eles são a base do fechamento acumulado.</p>
		<label className="finance-field"><span>Caixa físico</span><input name="cash" type="number" step="0.01" defaultValue={balances.cash} /></label>
		<label className="finance-field"><span>Banco</span><input name="bank" type="number" step="0.01" defaultValue={balances.bank} /></label>
		<label className="finance-field"><span>Pré-pagos retidos antes do histórico</span><input name="oyo" type="number" step="0.01" defaultValue={balances.oyo} /></label>
		<p className="finance-form-hint finance-field-wide">Informe somente valores anteriores ao histórico. Pré-pagos e repasses já registrados são calculados automaticamente.</p>
	</div><ModalFooter saving={saving} onClose={onClose} submit="Salvar saldos" /></form>;
}

function CashAdjustmentForm({ record, month, saving, error, onClose, onSubmit }: { record?: CashAdjustment; month: string; saving: boolean; error: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const [draftId] = useState(() => record?.id ?? id());
  return <form data-guard-unsaved onSubmit={onSubmit}><ModalHeader title={record ? 'Editar ajuste de caixa' : 'Ajuste de caixa por data'} onClose={onClose} /><div className="finance-modal-body">
    <input type="hidden" name="id" value={draftId} />
    <p className="finance-form-hint finance-field-wide">O valor será somado ao caixa físico a partir da data informada e levado aos meses seguintes. Use um valor negativo para diminuir o saldo. Exemplo: −500,00 em janeiro de 2025 reduz em R$ 500,00 os saldos de janeiro e dos meses seguintes.</p>
    <label className="finance-field"><span>Data do ajuste *</span><DateInput name="date" required defaultValue={record?.date ?? monthDueDate(month)} /></label>
    <label className="finance-field"><span>Valor do ajuste (R$, positivo ou negativo) *</span><input name="amount" type="number" step="0.01" required defaultValue={record?.amount} placeholder="Ex.: -500,00 ou 1000,00" /></label>
    <label className="finance-field finance-field-wide"><span>Motivo *</span><textarea name="note" rows={3} required maxLength={500} defaultValue={record?.note} placeholder="Ex.: acerto do caixa anterior à implantação do sistema" /></label>
    <p className="finance-form-hint finance-field-wide">Este valor é um acréscimo ou redução, não substitui o saldo total. Se o saldo já foi registrado em Saldos iniciais, não lance o mesmo valor novamente.</p>
    {error && <p className="finance-form-hint finance-field-wide" role="alert">{error}</p>}
  </div><ModalFooter saving={saving} onClose={onClose} submit="Salvar ajuste e recalcular saldos" /></form>;
}
