import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEvent } from '../../types/audit';
import { DateInput } from '../../components/ui/DateInput';
import { emptyFinance, financeStorageMode, subscribeFinance, updateFinance } from '../../services/financeStore';
import {
	DAILY_INCOME_ITEMS,
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

type Tab = 'resumo' | 'entradas' | 'saidas' | 'transferencias' | 'categorias';
type Modal = 'entrada' | 'saida' | 'transferencia' | 'saldo' | null;
// Categorias usadas por lançamentos automáticos (hospedagem, venda, estoque, OYO).
const LOCKED_CATEGORIES = { income: ['Diária', 'Rotativo', 'Consumo'], expense: ['Estoque', 'OYO'] };
type Activity = { id: string; date: string; title: string; detail: string; amount: number; paid: number; type: 'entrada' | 'saida' | 'folha'; wallet: string };

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const localMonth = () => {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};
const monthDueDate = (month: string) => {
	const day = Math.min(new Date().getDate(), new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate());
	return `${month}-${String(day).padStart(2, '0')}`;
};
const dateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR');
const id = () => crypto.randomUUID();
const newIncomeItem = (description: string): FinanceIncomeItem => ({ id: id(), description, amount: 0, paymentMethod: 'cash' });

function incomePaymentSummary(entry: FinanceIncome) {
	const totals = new Map<FinancePaymentMethod, number>();
	incomeItems(entry).forEach((item) => totals.set(item.paymentMethod, (totals.get(item.paymentMethod) ?? 0) + item.amount));
	return [...totals].map(([method, amount]) => `${money(amount)} ${PAYMENT_METHOD_LABELS[method]}`).join(' · ');
}

function balancesAt(data: FinanceData, month: string): FinanceBalances {
	const endDate = `${month}-31`;
	const balances = { ...data.openingBalances };
	Object.values(data.incomes).filter((item) => item.date <= endDate).forEach((item) => {
		incomeItems(item).forEach((line) => {
			const wallet = incomePaymentWallet(line.paymentMethod);
			if (wallet) balances[wallet] += line.amount;
		});
	});
	Object.values(data.expenses).filter((item) => item.dueDate <= endDate).forEach((item) => {
		balances.cash -= item.paidCash;
		balances.bank -= item.paidBank;
	});
	Object.values(data.payroll).filter((item) => item.dueDate <= endDate).forEach((item) => {
		balances.cash -= item.paidCash;
		balances.bank -= item.paidBank;
	});
	Object.values(data.transfers).filter((item) => item.date <= endDate).forEach((item) => {
		balances[item.from] -= item.amount;
		balances[item.to] += item.amount;
	});
	return balances;
}

function exportCsv(filename: string, rows: (string | number)[][]) {
	const content = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(';')).join('\r\n');
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
	const [data, setData] = useState<FinanceData>(emptyFinance());
	const [month, setMonth] = useState(localMonth);
	const [tab, setTab] = useState<Tab>('resumo');
	const [modal, setModal] = useState<Modal>(null);
	const [editingId, setEditingId] = useState('');
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');

	useEffect(() => subscribeFinance((next) => { setData(next); setLoading(false); setError(''); }, (cause) => { setError(cause.message); setLoading(false); }), []);

	const incomes = useMemo(() => Object.values(data.incomes).filter((item) => item.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date)), [data.incomes, month]);
	const expenses = useMemo(() => Object.values(data.expenses).filter((item) => item.dueDate.startsWith(month)).sort((a, b) => a.dueDate.localeCompare(b.dueDate)), [data.expenses, month]);
	const payroll = useMemo(() => Object.values(data.payroll).filter((item) => item.month === month), [data.payroll, month]);
	const transfers = useMemo(() => Object.values(data.transfers).filter((item) => item.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date)), [data.transfers, month]);
	const totalIncome = incomes.reduce((sum, item) => sum + item.amount, 0);
	const paidExpenses = expenses.reduce((sum, item) => sum + item.paidCash + item.paidBank, 0) + payroll.reduce((sum, item) => sum + item.paidCash + item.paidBank, 0);
	const pendingExpenses = expenses.reduce((sum, item) => sum + Math.max(0, item.plannedAmount - item.paidCash - item.paidBank), 0)
		+ payroll.reduce((sum, item) => sum + Math.max(0, payrollNet(item) - item.paidCash - item.paidBank), 0);
	const balances = balancesAt(data, month);

	function exportMonthlyReport() {
		const incomeRows = incomes.map((item) => {
			const payments = incomeItems(item);
			const cash = payments.filter((line) => line.paymentMethod === 'cash').reduce((sum, line) => sum + line.amount, 0);
			const bank = payments.filter((line) => line.paymentMethod !== 'cash' && line.paymentMethod !== 'prepaid').reduce((sum, line) => sum + line.amount, 0);
			const receivable = payments.filter((line) => line.paymentMethod === 'prepaid').reduce((sum, line) => sum + line.amount, 0);
			return ['Entrada', item.date, item.category, payments.map((line) => `${line.description}: ${money(line.amount)}`).join(' | '), '', '', '', item.amount, cash, bank, receivable, 0, incomePaymentSummary(item), item.note];
		});
		const expenseRows = expenses.map((item) => ['Despesa', item.dueDate, item.category, item.note, '', '', item.plannedAmount, item.paidCash + item.paidBank, item.paidCash, item.paidBank, 0, Math.max(0, item.plannedAmount - item.paidCash - item.paidBank), '', item.note]);
		const payrollRows = payroll.map((item) => ['Folha', item.dueDate, 'Folha de pagamento', `${item.employee}${item.position ? ` · ${item.position}` : ''}`, '', '', payrollNet(item), item.paidCash + item.paidBank, item.paidCash, item.paidBank, 0, Math.max(0, payrollNet(item) - item.paidCash - item.paidBank), '', item.note]);
		const transferRows = transfers.map((item) => ['Transferência', item.date, 'Entre carteiras', item.note, WALLET_LABELS[item.from], WALLET_LABELS[item.to], '', item.amount, 0, 0, 0, 0, '', item.note]);
		exportCsv(`financeiro-${month}.csv`, [
			['Tipo', 'Data', 'Categoria', 'Detalhes', 'Origem', 'Destino', 'Previsto', 'Valor registrado', 'Pago em caixa', 'Pago em banco', 'A receber', 'Pendente', 'Forma de pagamento', 'Observação'],
			...incomeRows,
			...expenseRows,
			...payrollRows,
			...transferRows,
		]);
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
		};
		void commit((latest) => ({ ...latest, incomes: { ...latest.incomes, [item.id]: item } }), current ? 'Entrada atualizada.' : 'Entrada registrada.');
	}

	function saveExpense(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const category = String(form.get('category') ?? '').trim();
		const plannedAmount = Number(form.get('plannedAmount'));
		const paidCash = Number(form.get('paidCash'));
		const paidBank = Number(form.get('paidBank'));
		if (!category || [plannedAmount, paidCash, paidBank].some((value) => !Number.isFinite(value) || value < 0)) { setError('Confira a categoria e os valores da despesa.'); return; }
		const current = data.expenses[editingId];
		const timestamp = new Date().toISOString();
		const item: FinanceExpense = {
			id: current?.id ?? id(),
			dueDate: String(form.get('dueDate')),
			category,
			plannedAmount,
			paidCash,
			paidBank,
			note: String(form.get('note') ?? '').trim(),
			createdAt: current?.createdAt ?? timestamp,
			updatedAt: timestamp,
		};
		void commit((latest) => ({ ...latest, expenses: { ...latest.expenses, [item.id]: item } }), current ? 'Despesa atualizada.' : 'Despesa registrada.');
	}

	function saveTransfer(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const amount = Number(form.get('amount'));
		const from = String(form.get('from')) as FinanceWallet;
		const to = String(form.get('to')) as FinanceWallet;
		if (!Number.isFinite(amount) || amount <= 0 || from === to) { setError('Informe um valor positivo e carteiras diferentes.'); return; }
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
		const openingBalances = {
			cash: Number(form.get('cash')) || 0,
			bank: Number(form.get('bank')) || 0,
			oyo: Number(form.get('oyo')) || 0,
		};
		void commit((latest) => ({ ...latest, openingBalances }), 'Saldos iniciais atualizados.');
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

	async function removeCategory(kind: 'income' | 'expense', category: string) {
		if (LOCKED_CATEGORIES[kind].includes(category)) { setError(`"${category}" é usada automaticamente pelo sistema e não pode ser removida.`); return; }
		if (!window.confirm(`Remover a categoria "${category}"? Os lançamentos existentes serão preservados.`)) return;
		await commit((latest) => kind === 'income'
			? { ...latest, incomeCategories: latest.incomeCategories.filter((item) => item !== category) }
			: { ...latest, expenseCategories: latest.expenseCategories.filter((item) => item !== category) }, 'Categoria removida. Lançamentos existentes preservados.');
	}

	async function renameCategory(kind: 'income' | 'expense', from: string, to: string) {
		const normalized = to.trim();
		const key = normalized.toLocaleLowerCase('pt-BR');
		if (!normalized || normalized === from) return;
		if (LOCKED_CATEGORIES[kind].includes(from)) { setError(`"${from}" é usada automaticamente pelo sistema e não pode ser renomeada.`); return; }
		if (kind === 'income' && key === 'oyo') { setError('OYO é uma categoria de despesa e não pode ser cadastrada como entrada.'); return; }
		const categories = kind === 'income' ? data.incomeCategories : data.expenseCategories;
		if (categories.some((item) => item !== from && item.toLocaleLowerCase('pt-BR') === key)) { setError('Essa categoria já existe.'); return; }
		const timestamp = new Date().toISOString();
		await commit((latest) => kind === 'income'
			? { ...latest, incomeCategories: latest.incomeCategories.map((item) => item === from ? normalized : item), incomes: Object.fromEntries(Object.entries(latest.incomes).map(([key, entry]) => [key, entry.category === from ? { ...entry, category: normalized, updatedAt: timestamp } : entry])) }
			: { ...latest, expenseCategories: latest.expenseCategories.map((item) => item === from ? normalized : item), expenses: Object.fromEntries(Object.entries(latest.expenses).map(([key, entry]) => [key, entry.category === from ? { ...entry, category: normalized, updatedAt: timestamp } : entry])) }, 'Categoria renomeada; os lançamentos existentes foram atualizados.');
	}

	async function removeRecord(kind: 'entrada' | 'saida' | 'transferencia', recordId: string) {
		if (!window.confirm('Excluir este lançamento? Esta ação não pode ser desfeita.')) return;
		await commit((latest) => {
			if (kind === 'entrada') { const next = { ...latest.incomes }; delete next[recordId]; return { ...latest, incomes: next }; }
			if (kind === 'saida') { const next = { ...latest.expenses }; delete next[recordId]; return { ...latest, expenses: next }; }
			const next = { ...latest.transfers }; delete next[recordId]; return { ...latest, transfers: next };
		}, 'Lançamento excluído.');
	}

	const selectedEntry = modal === 'entrada' ? data.incomes[editingId] : undefined;
	const selectedExpense = modal === 'saida' ? data.expenses[editingId] : undefined;
	const selectedTransfer = modal === 'transferencia' ? data.transfers[editingId] : undefined;
	const activities: Activity[] = [
		...incomes.map((item) => ({ id: item.id, date: item.date, title: item.category, detail: `${item.note}${item.note ? ' · ' : ''}${incomeItems(item).map((line) => line.description).join(', ')}`, amount: item.amount, paid: item.amount, type: 'entrada' as const, wallet: incomePaymentSummary(item) })),
		...expenses.map((item) => ({ id: item.id, date: item.dueDate, title: item.category, detail: item.note, amount: item.plannedAmount, paid: item.paidCash + item.paidBank, type: 'saida' as const, wallet: `${money(item.paidCash)} em caixa · ${money(item.paidBank)} em banco` })),
		...payroll.map((item) => ({ id: item.id, date: item.dueDate, title: item.employee, detail: item.position || 'Folha de pagamento', amount: payrollNet(item), paid: item.paidCash + item.paidBank, type: 'folha' as const, wallet: `${money(item.paidCash)} em caixa · ${money(item.paidBank)} em banco` })),
	].sort((a, b) => b.date.localeCompare(a.date));

	return (
		<div className="finance-page">
			<header className="finance-header">
				<Link to="/" className="finance-brand"><span className="finance-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>GESTÃO FINANCEIRA</small></span></Link>
				<nav aria-label="Módulos financeiros"><Link className="finance-nav-active" to="/financeiro/caixa">Fluxo de caixa</Link><Link to="/financeiro/folha">Folha de pagamento</Link><Link to="/">Painel</Link></nav>
			</header>

			<main className="finance-content">
				<div className="finance-page-heading">
					<div><p className="finance-eyebrow">FINANCEIRO <span>/</span> CONTROLE</p><h1>Fluxo de caixa</h1><p>Entradas, despesas e saldos por carteira.</p></div>
					<div className="finance-heading-actions"><label className="finance-month"><span>Competência</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><button className="finance-button finance-button-soft" onClick={exportMonthlyReport}>Exportar competência</button><button className="finance-button finance-button-soft" onClick={() => openModal('saldo')}>Saldos iniciais</button><button className="finance-button finance-button-dark" onClick={() => openModal('entrada')}>+ Entrada</button><button className="finance-button finance-button-primary" onClick={() => openModal('saida')}>+ Despesa</button></div>
				</div>

				{error && <div className="finance-alert" role="alert">{error}<button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
				{notice && <div className="finance-notice" role="status">{notice}</div>}
				{financeStorageMode === 'Firebase' && <p className="finance-storage-notice">Dados compartilhados pelo Firebase</p>}

				{loading ? <div className="finance-empty">Carregando lançamentos...</div> : <>
					<section className="finance-metrics" aria-label="Resumo financeiro do mês">
						<Metric label="Entradas" value={money(totalIncome)} detail={`${incomes.length} lançamentos`} tone="green" />
						<Metric label="Saídas pagas" value={money(paidExpenses)} detail={`${money(pendingExpenses)} pendentes de pagamento`} tone="coral" />
						<Metric label="Resultado do mês" value={money(totalIncome - paidExpenses)} detail="Entradas menos pagamentos realizados" tone="blue" />
						<Metric label="Caixa físico" value={money(balances.cash)} detail="Saldo acumulado até o mês" tone="gold" />
						<Metric label="Banco" value={money(balances.bank)} detail="Saldo acumulado até o mês" tone="navy" />
						<Metric label="OYO a receber" value={money(balances.oyo)} detail="Saldo pendente de repasse" tone="gray" />
					</section>

					<div className="finance-tabs" role="tablist" aria-label="Visões do fluxo de caixa">
						{([['resumo', 'Resumo'], ['entradas', 'Entradas'], ['saidas', 'Despesas'], ['transferencias', 'Transferências'], ['categorias', 'Categorias']] as [Tab, string][]).map(([idTab, label]) => <button key={idTab} role="tab" aria-selected={tab === idTab} className={tab === idTab ? 'selected' : ''} onClick={() => setTab(idTab)}>{label}</button>)}
					</div>

					{tab === 'resumo' && <>
						<section className="finance-summary-grid">
							<CategorySummary title="Entradas por origem" items={incomes.map((item) => [item.category, item.amount] as [string, number])} empty="Nenhuma entrada nesta competência." />
							  <CategorySummary title="Despesas por categoria" items={[...expenses.map((item) => [item.category, item.paidCash + item.paidBank] as [string, number]), ...payroll.map((item) => ['Folha de pagamento', item.paidCash + item.paidBank] as [string, number])]} empty="Nenhuma despesa nesta competência." />
							<section className="finance-panel finance-wallet-panel"><div className="finance-panel-heading"><div><h2>Movimento entre carteiras</h2><p>Transferências não alteram o resultado financeiro.</p></div><button className="finance-text-button" onClick={() => openModal('transferencia')}>+ Registrar</button></div>{transfers.length === 0 ? <p className="finance-empty-inline">Sem transferências no mês.</p> : transfers.slice(0, 5).map((item) => <div className="finance-transfer-row" key={item.id}><span>{dateLabel(item.date)}</span><strong>{WALLET_LABELS[item.from]} → {WALLET_LABELS[item.to]}</strong><b>{money(item.amount)}</b></div>)}</section>
						</section>
						<ActivityTable activities={activities.slice(0, 10)} onEdit={(activity) => activity.type === 'entrada' ? openModal('entrada', activity.id) : activity.type === 'saida' ? openModal('saida', activity.id) : undefined} onDelete={(activity) => activity.type !== 'folha' && void removeRecord(activity.type, activity.id)} title="Lançamentos recentes" />
						<AuditTable events={Object.values(data.auditLog).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 20)} />
					</>}

					  {tab === 'entradas' && <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Entradas da competência</h2><p>{incomes.length} registros · total {money(totalIncome)}</p></div><div className="finance-heading-actions"><button className="finance-button finance-button-soft" onClick={() => exportCsv(`entradas-${month}.csv`, [['Data', 'Origem', 'Itens', 'Pagamentos', 'Valor total', 'Observação'], ...incomes.map((item) => [item.date, item.category, incomeItems(item).map((line) => `${line.description}: ${money(line.amount)}`).join(' | '), incomePaymentSummary(item), item.amount, item.note])])}>Exportar CSV</button><button className="finance-button finance-button-dark" onClick={() => openModal('entrada')}>+ Entrada</button></div></div><ActivityTable activities={incomes.map((item) => ({ id: item.id, date: item.date, title: item.category, detail: `${item.note}${item.note ? ' · ' : ''}${incomeItems(item).map((line) => line.description).join(', ')}`, amount: item.amount, paid: item.amount, type: 'entrada', wallet: incomePaymentSummary(item) }))} onEdit={(activity) => openModal('entrada', activity.id)} onDelete={(activity) => void removeRecord('entrada', activity.id)} title="" /></section>}

					{tab === 'saidas' && <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Despesas da competência</h2><p>{expenses.length + payroll.length} registros · {money(paidExpenses)} pagos · {money(pendingExpenses)} pendentes</p></div><div className="finance-heading-actions"><button className="finance-button finance-button-soft" onClick={() => exportCsv(`despesas-${month}.csv`, [['Vencimento', 'Categoria', 'Previsto', 'Pago em caixa', 'Pago em banco', 'Pendente', 'Observação'], ...expenses.map((item) => [item.dueDate, item.category, item.plannedAmount, item.paidCash, item.paidBank, Math.max(0, item.plannedAmount - item.paidCash - item.paidBank), item.note]), ...payroll.map((item) => [item.dueDate, `Folha · ${item.employee}`, payrollNet(item), item.paidCash, item.paidBank, Math.max(0, payrollNet(item) - item.paidCash - item.paidBank), item.note])])}>Exportar CSV</button><button className="finance-button finance-button-primary" onClick={() => openModal('saida')}>+ Despesa</button></div></div><ActivityTable activities={[...activities.filter((item) => item.type !== 'entrada')]} onEdit={(activity) => activity.type === 'saida' && openModal('saida', activity.id)} onDelete={(activity) => activity.type === 'saida' && void removeRecord('saida', activity.id)} title="" /></section>}

					  {tab === 'transferencias' && <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Transferências da competência</h2><p>{transfers.length} registros · sem impacto no resultado</p></div><div className="finance-heading-actions"><button className="finance-button finance-button-soft" onClick={() => exportCsv(`transferencias-${month}.csv`, [['Data', 'Origem', 'Destino', 'Valor', 'Observação'], ...transfers.map((item) => [item.date, WALLET_LABELS[item.from], WALLET_LABELS[item.to], item.amount, item.note])])}>Exportar CSV</button><button className="finance-button finance-button-dark" onClick={() => openModal('transferencia')}>+ Transferência</button></div></div>{transfers.length === 0 ? <div className="finance-empty">Nenhuma transferência neste mês.</div> : <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Data</th><th>Origem</th><th>Destino</th><th>Observação</th><th className="numeric">Valor</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{transfers.map((item) => <tr key={item.id}><td>{dateLabel(item.date)}</td><td>{WALLET_LABELS[item.from]}</td><td>{WALLET_LABELS[item.to]}</td><td>{item.note || '—'}</td><td className="numeric">{money(item.amount)}</td><td><div className="finance-row-actions"><button onClick={() => openModal('transferencia', item.id)}>Editar</button><button className="danger" onClick={() => void removeRecord('transferencia', item.id)}>Excluir</button></div></td></tr>)}</tbody></table></div>}</section>}

					  {tab === 'categorias' && <div className="finance-category-grid"><CategoryManager title="Categorias de entrada" categories={data.incomeCategories} locked={LOCKED_CATEGORIES.income} onRename={(from, to) => void renameCategory('income', from, to)} onAdd={(category) => void addCategory('income', category)} onRemove={(category) => void removeCategory('income', category)} /><CategoryManager title="Categorias de despesa" categories={data.expenseCategories} locked={LOCKED_CATEGORIES.expense} onRename={(from, to) => void renameCategory('expense', from, to)} onAdd={(category) => void addCategory('expense', category)} onRemove={(category) => void removeCategory('expense', category)} /></div>}
				</>}

				<footer className="finance-page-footer"><span>Armazenamento: {financeStorageMode}</span><span>Fluxo de caixa · Hotel Lindoia</span></footer>
			</main>

			{modal && <div className="finance-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}><section className="finance-modal" role="dialog" aria-modal="true" aria-labelledby="finance-modal-title">
				{modal === 'entrada' && <IncomeForm record={selectedEntry} month={month} categories={data.incomeCategories} saving={saving} onClose={() => setModal(null)} onSubmit={saveIncome} />}
				{modal === 'saida' && <ExpenseForm record={selectedExpense} month={month} categories={data.expenseCategories} saving={saving} onClose={() => setModal(null)} onSubmit={saveExpense} />}
				{modal === 'transferencia' && <TransferForm record={selectedTransfer} month={month} saving={saving} onClose={() => setModal(null)} onSubmit={saveTransfer} />}
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
	return <section className="finance-panel finance-category-manager"><div className="finance-panel-heading"><div><h2>{title}</h2><p>{categories.length} categorias disponíveis nos lançamentos</p></div></div><form className="finance-category-form" onSubmit={submit}><label className="finance-field"><span>Nova categoria</span><input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={50} placeholder="Digite um nome" /></label><button className="finance-button finance-button-dark" type="submit" disabled={!category.trim()}>Adicionar</button></form>{categories.length === 0 ? <p className="finance-empty-inline">Nenhuma categoria cadastrada.</p> : <ul className="finance-category-list">{categories.map((item) => <li key={item}>{editing === item ? <><input value={draft} maxLength={50} autoFocus aria-label={`Novo nome de ${item}`} onChange={(event) => setDraft(event.target.value)} /><button type="button" title="Salvar" aria-label="Salvar nome" disabled={!draft.trim()} onClick={() => { onRename(item, draft); setEditing(''); }}>✓</button><button type="button" title="Cancelar" aria-label="Cancelar edição" onClick={() => setEditing('')}>↶</button></> : <><span>{item}{locked.includes(item) ? ' · automática' : ''}</span>{!locked.includes(item) && <button type="button" title={`Editar categoria ${item}`} aria-label={`Editar categoria ${item}`} onClick={() => { setEditing(item); setDraft(item); }}>✎</button>}{!locked.includes(item) && <button type="button" title={`Remover categoria ${item}`} aria-label={`Remover categoria ${item}`} onClick={() => onRemove(item)}>×</button>}</>}</li>)}</ul>}</section>;
}

function ActivityTable({ activities, onEdit, onDelete, title }: { activities: Activity[]; onEdit: (activity: Activity) => void; onDelete: (activity: Activity) => void; title: string }) {
	return <section className="finance-panel finance-activity-panel">{title && <div className="finance-panel-heading"><div><h2>{title}</h2><p>Registros da competência selecionada</p></div></div>}{activities.length === 0 ? <div className="finance-empty">Nenhum lançamento nesta competência.</div> : <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Data / vencimento</th><th>Origem / categoria</th><th>Carteira / pagamentos</th><th className="numeric">Valor</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{activities.map((item) => <tr key={`${item.type}-${item.id}`}><td>{dateLabel(item.date)}</td><td><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}{item.type === 'folha' && <small>Folha de pagamento</small>}</td><td>{item.wallet}</td><td className={`numeric ${item.type === 'entrada' ? 'positive-value' : ''}`}>{item.type === 'entrada' ? money(item.amount) : <>{money(item.amount)}<small>Previsto</small><small>Pago {money(item.paid)}</small><small>Falta {money(Math.max(0, item.amount - item.paid))}</small></>}</td><td><div className="finance-row-actions">{item.type !== 'folha' && <><button onClick={() => onEdit(item)}>Editar</button><button className="danger" onClick={() => onDelete(item)}>Excluir</button></>}</div></td></tr>)}</tbody></table></div>}</section>;
}

function AuditTable({ events }: { events: AuditEvent[] }) {
	const actionLabels: Record<AuditEvent['action'], string> = { criado: 'Criado', alterado: 'Alterado', excluido: 'Excluído' };
	return <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Auditoria recente</h2><p>Ações sobre lançamentos e configurações financeiras</p></div></div>{events.length === 0 ? <p className="finance-empty-inline">Nenhuma alteração registrada ainda.</p> : <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Data</th><th>Ação</th><th>Registro</th><th>Usuário</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td>{new Date(event.occurredAt).toLocaleString('pt-BR')}</td><td>{actionLabels[event.action]}</td><td>{event.entity} · {event.recordId}</td><td>{event.actorUid}</td></tr>)}</tbody></table></div>}</section>;
}

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
	return <div className="finance-modal-header"><div><p className="finance-eyebrow">FLUXO DE CAIXA</p><h2 id="finance-modal-title">{title}</h2></div><button type="button" className="finance-close" onClick={onClose} aria-label="Fechar">×</button></div>;
}

function ModalFooter({ saving, onClose, submit }: { saving: boolean; onClose: () => void; submit: string }) {
	return <div className="finance-modal-footer"><button type="button" className="finance-button finance-button-soft" onClick={onClose}>Cancelar</button><button className="finance-button finance-button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : submit}</button></div>;
}

function IncomeForm({ record, month, categories, saving, onClose, onSubmit }: { record?: FinanceIncome; month: string; categories: string[]; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>, category: string, items: FinanceIncomeItem[]) => void }) {
	const [category, setCategory] = useState(record?.category ?? categories[0] ?? 'Diária');
	const [items, setItems] = useState<FinanceIncomeItem[]>(() => {
		if (record) return incomeItems(record).map((item) => ({ ...item }));
		return [newIncomeItem(category === 'Diária' ? 'Diária' : category)];
	});
	const total = items.reduce((sum, item) => sum + (Number.isFinite(item.amount) ? item.amount : 0), 0);
	const isDaily = category === 'Diária';
	const nextDailyItem = DAILY_INCOME_ITEMS.slice(1).find((part) => !items.some((item) => item.description === part));

	function changeCategory(value: string) {
		setCategory(value);
		setItems([newIncomeItem(value === 'Diária' ? 'Diária' : value)]);
	}

	function updateItem(itemId: string, patch: Partial<FinanceIncomeItem>) {
		setItems((current) => current.map((item) => item.id === itemId ? { ...item, ...patch } : item));
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		onSubmit(event, category, items);
	}

	return <form onSubmit={submit}><ModalHeader title={record ? 'Editar entrada' : 'Nova entrada'} onClose={onClose} /><div className="finance-modal-body">
		<label className="finance-field"><span>Data *</span><DateInput name="date" required defaultValue={record?.date ?? monthDueDate(month)} /></label>
		<label className="finance-field"><span>Tipo de entrada *</span><select value={category} onChange={(event) => changeCategory(event.target.value)} required>{record && !categories.includes(record.category) && <option value={record.category}>{record.category} (histórica)</option>}{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
		<div className="finance-income-section finance-field-wide"><div className="finance-income-section-heading"><div><strong>{isDaily ? 'Composição da diária' : 'Itens recebidos'}</strong><small>Defina o valor e o pagamento de cada item.</small></div><button type="button" className="finance-button finance-button-soft" disabled={isDaily && !nextDailyItem} onClick={() => setItems((current) => [...current, newIncomeItem(isDaily ? nextDailyItem ?? DAILY_INCOME_ITEMS[1] : category)])}>{isDaily ? '+ Adicional' : '+ Dividir recebimento'}</button></div>
			<div className="finance-income-lines">{items.map((item, index) => <div className="finance-income-line" key={item.id}>
				<label className="finance-field"><span>{isDaily && index === 0 ? 'Diária' : 'Item'}</span>{isDaily && index === 0 ? <input value="Diária" readOnly aria-label="Item Diária" /> : isDaily ? <select value={item.description} onChange={(event) => updateItem(item.id, { description: event.target.value })}>{DAILY_INCOME_ITEMS.slice(1).map((part) => <option key={part} value={part}>{part}</option>)}</select> : <input value={item.description} readOnly aria-label={`Item ${item.description}`} />}</label>
				<label className="finance-field"><span>Forma de pagamento</span><select value={item.paymentMethod} onChange={(event) => updateItem(item.id, { paymentMethod: event.target.value as FinancePaymentMethod })}>{(Object.entries(PAYMENT_METHOD_LABELS) as [FinancePaymentMethod, string][]).map(([method, label]) => <option key={method} value={method}>{label}</option>)}</select></label>
				<label className="finance-field"><span>Valor (R$)</span><input type="number" min="0.01" step="0.01" required value={item.amount || ''} onChange={(event) => updateItem(item.id, { amount: Number(event.target.value) })} aria-label={`Valor de ${item.description}`} /></label>
				{items.length > 1 && !(isDaily && index === 0) && <button type="button" className="finance-remove-line" title={`Remover ${item.description}`} aria-label={`Remover ${item.description}`} onClick={() => setItems((current) => current.filter((line) => line.id !== item.id))}>×</button>}
			</div>)}</div>
			<div className="finance-entry-total"><span>Total da entrada</span><strong>{money(total)}</strong></div>
		</div>
		<label className="finance-field finance-field-wide"><span>Observação</span><textarea name="note" rows={2} defaultValue={record?.note} /></label>
		<p className="finance-form-hint finance-field-wide">Pré-pago compõe a receita, mas não altera o caixa nem o banco no momento do lançamento.</p>
	</div><ModalFooter saving={saving} onClose={onClose} submit={record ? 'Salvar entrada' : 'Registrar entrada'} /></form>;
}

function ExpenseForm({ record, month, categories, saving, onClose, onSubmit }: { record?: FinanceExpense; month: string; categories: string[]; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
	return <form onSubmit={onSubmit}><ModalHeader title={record ? 'Editar despesa' : 'Nova despesa'} onClose={onClose} /><div className="finance-modal-body">
		<label className="finance-field"><span>Vencimento *</span><DateInput name="dueDate" required defaultValue={record?.dueDate ?? monthDueDate(month)} /></label>
		<label className="finance-field"><span>Categoria *</span><select name="category" required defaultValue={record?.category ?? ''}><option value="" disabled>Selecione uma categoria</option>{record && !categories.includes(record.category) && <option value={record.category}>{record.category} (histórica)</option>}{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
		<label className="finance-field"><span>Valor previsto</span><input name="plannedAmount" type="number" min="0" step="0.01" defaultValue={record?.plannedAmount ?? 0} /></label>
		<label className="finance-field"><span>Pago em dinheiro</span><input name="paidCash" type="number" min="0" step="0.01" defaultValue={record?.paidCash ?? 0} /></label>
		<label className="finance-field"><span>Pago pelo banco</span><input name="paidBank" type="number" min="0" step="0.01" defaultValue={record?.paidBank ?? 0} /></label>
		<label className="finance-field finance-field-wide"><span>Observação</span><textarea name="note" rows={2} defaultValue={record?.note} /></label>
		<p className="finance-form-hint finance-field-wide">Pagamentos parciais podem ser divididos entre dinheiro e banco. A diferença entre o previsto e o pago aparece como pendência.</p>
	</div><ModalFooter saving={saving} onClose={onClose} submit={record ? 'Salvar despesa' : 'Registrar despesa'} /></form>;
}

function TransferForm({ record, month, saving, onClose, onSubmit }: { record?: FinanceTransfer; month: string; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
	return <form onSubmit={onSubmit}><ModalHeader title={record ? 'Editar transferência' : 'Nova transferência'} onClose={onClose} /><div className="finance-modal-body">
		<label className="finance-field"><span>Data *</span><DateInput name="date" required defaultValue={record?.date ?? monthDueDate(month)} /></label>
		<label className="finance-field"><span>Valor *</span><input name="amount" type="number" min="0.01" step="0.01" required defaultValue={record?.amount} /></label>
		<label className="finance-field"><span>Origem *</span><select name="from" defaultValue={record?.from ?? 'cash'}>{(Object.entries(WALLET_LABELS) as [FinanceWallet, string][]).map(([wallet, label]) => <option key={wallet} value={wallet}>{label}</option>)}</select></label>
		<label className="finance-field"><span>Destino *</span><select name="to" defaultValue={record?.to ?? 'bank'}>{(Object.entries(WALLET_LABELS) as [FinanceWallet, string][]).map(([wallet, label]) => <option key={wallet} value={wallet}>{label}</option>)}</select></label>
		<label className="finance-field finance-field-wide"><span>Observação</span><textarea name="note" rows={2} defaultValue={record?.note} /></label>
	</div><ModalFooter saving={saving} onClose={onClose} submit={record ? 'Salvar transferência' : 'Registrar transferência'} /></form>;
}

function BalancesForm({ balances, saving, onClose, onSubmit }: { balances: FinanceBalances; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
	return <form onSubmit={onSubmit}><ModalHeader title="Saldos iniciais" onClose={onClose} /><div className="finance-modal-body">
		<p className="finance-form-hint finance-field-wide">Informe os saldos existentes antes do primeiro lançamento financeiro. Eles são a base do fechamento acumulado.</p>
		<label className="finance-field"><span>Caixa físico</span><input name="cash" type="number" step="0.01" defaultValue={balances.cash} /></label>
		<label className="finance-field"><span>Banco</span><input name="bank" type="number" step="0.01" defaultValue={balances.bank} /></label>
		<label className="finance-field"><span>OYO a receber</span><input name="oyo" type="number" step="0.01" defaultValue={balances.oyo} /></label>
	</div><ModalFooter saving={saving} onClose={onClose} submit="Salvar saldos" /></form>;
}
