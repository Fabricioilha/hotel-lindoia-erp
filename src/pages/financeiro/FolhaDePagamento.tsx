import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { emptyFinance, financeStorageMode, subscribeFinance, updateFinance } from '../../services/financeStore';
import { payrollNet, type FinanceData, type PayrollEntry } from '../../types/finance';
import './financeiro.css';

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
const createId = () => crypto.randomUUID();
const exportCsv = (filename: string, rows: (string | number)[][]) => {
	const content = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(';')).join('\r\n');
	const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function FolhaDePagamento() {
	const [data, setData] = useState<FinanceData>(emptyFinance());
	const [month, setMonth] = useState(localMonth);
	const [loading, setLoading] = useState(true);
	const [modal, setModal] = useState(false);
	const [editingId, setEditingId] = useState('');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');

	useEffect(() => subscribeFinance((next) => { setData(next); setLoading(false); setError(''); }, (cause) => { setError(cause.message); setLoading(false); }), []);

	const entries = useMemo(() => Object.values(data.payroll).filter((item) => item.month === month).sort((a, b) => a.employee.localeCompare(b.employee, 'pt-BR')), [data.payroll, month]);
	const planned = entries.reduce((sum, item) => sum + payrollNet(item), 0);
	const paid = entries.reduce((sum, item) => sum + item.paidCash + item.paidBank, 0);
	const pending = Math.max(0, planned - paid);
	const selected = data.payroll[editingId];

	async function commit(update: (current: FinanceData) => FinanceData, message: string) {
		setSaving(true);
		setError('');
		try {
			await updateFinance(update);
			setModal(false);
			setEditingId('');
			setNotice(message);
			window.setTimeout(() => setNotice(''), 4000);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a folha.');
		} finally {
			setSaving(false);
		}
	}

	function saveEntry(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const employee = String(form.get('employee') ?? '').trim();
		const basePay = Number(form.get('basePay')) || 0;
		const additions = Number(form.get('additions')) || 0;
		const deductions = Number(form.get('deductions')) || 0;
		const paidCash = Number(form.get('paidCash')) || 0;
		const paidBank = Number(form.get('paidBank')) || 0;
		if (!employee || [basePay, additions, deductions, paidCash, paidBank].some((value) => !Number.isFinite(value) || value < 0)) { setError('Informe o funcionário e valores válidos, iguais ou maiores que zero.'); return; }
		if (deductions > basePay + additions) { setError('Os descontos não podem superar o salário-base somado aos acréscimos.'); return; }
		const current = data.payroll[editingId];
		const timestamp = new Date().toISOString();
		const item: PayrollEntry = {
			id: current?.id ?? createId(),
			month: String(form.get('dueDate')).slice(0, 7),
			dueDate: String(form.get('dueDate')),
			employee,
			position: String(form.get('position') ?? '').trim(),
			basePay,
			additions,
			deductions,
			paidCash,
			paidBank,
			note: String(form.get('note') ?? '').trim(),
			createdAt: current?.createdAt ?? timestamp,
			updatedAt: timestamp,
		};
		void commit((latest) => ({ ...latest, payroll: { ...latest.payroll, [item.id]: item } }), current ? 'Lançamento da folha atualizado.' : 'Lançamento da folha registrado.');
	}

	async function removeEntry(entry: PayrollEntry) {
		if (!window.confirm(`Excluir a folha de ${entry.employee} desta competência?`)) return;
		await commit((latest) => {
			const next = { ...latest.payroll };
			delete next[entry.id];
			return { ...latest, payroll: next };
		}, 'Lançamento excluído.');
	}

	function openEntry(entryId = '') {
		setEditingId(entryId);
		setError('');
		setModal(true);
	}

	function exportPayroll() {
		exportCsv(`folha-${month}.csv`, [
			['Competência', 'Vencimento', 'Funcionário', 'Função', 'Salário-base', 'Acréscimos', 'Descontos', 'Líquido', 'Pago em caixa', 'Pago em banco', 'Total pago', 'Pendente', 'Observação'],
			...entries.map((entry) => {
				const net = payrollNet(entry);
				const paidTotal = entry.paidCash + entry.paidBank;
				return [month, entry.dueDate, entry.employee, entry.position, entry.basePay, entry.additions, entry.deductions, net, entry.paidCash, entry.paidBank, paidTotal, Math.max(0, net - paidTotal), entry.note];
			}),
		]);
	}

	return (
		<div className="finance-page">
			<header className="finance-header">
				<Link to="/" className="finance-brand"><span className="finance-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>GESTÃO FINANCEIRA</small></span></Link>
				<nav aria-label="Módulos financeiros"><Link to="/financeiro/caixa">Fluxo de caixa</Link><Link className="finance-nav-active" to="/financeiro/folha">Folha de pagamento</Link><Link to="/">Painel</Link></nav>
			</header>

			<main className="finance-content">
				<div className="finance-page-heading">
					<div><p className="finance-eyebrow">FINANCEIRO <span>/</span> PESSOAL</p><h1>Folha de pagamento</h1><p>Valores e pagamentos por funcionário e competência.</p></div>
					<div className="finance-heading-actions"><label className="finance-month"><span>Competência</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><button className="finance-button finance-button-soft" onClick={exportPayroll}>Exportar CSV</button><button className="finance-button finance-button-primary" onClick={() => openEntry()}>+ Lançar folha</button></div>
				</div>

				{error && <div className="finance-alert" role="alert">{error}<button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
				{notice && <div className="finance-notice" role="status">{notice}</div>}

				{loading ? <div className="finance-empty">Carregando folha...</div> : <>
					<section className="finance-metrics" aria-label="Resumo da folha">
						<Metric label="Funcionários" value={String(entries.length)} detail="Lançamentos nesta competência" tone="navy" />
						<Metric label="Valor líquido previsto" value={money(planned)} detail="Base + acréscimos - descontos" tone="blue" />
						<Metric label="Total pago" value={money(paid)} detail={`${money(entries.reduce((sum, item) => sum + item.paidCash, 0))} em dinheiro · ${money(entries.reduce((sum, item) => sum + item.paidBank, 0))} em banco`} tone="green" />
						<Metric label="Pendente" value={money(pending)} detail="Saldo líquido a pagar" tone={pending > 0 ? 'coral' : 'gray'} />
					</section>

					<section className="finance-panel">
						<div className="finance-panel-heading"><div><h2>Pagamentos por funcionário</h2><p>Descontos e acréscimos são informados manualmente.</p></div><span className="record-count">{entries.length} registros</span></div>
						{entries.length === 0 ? <div className="finance-empty"><strong>Nenhum lançamento nesta competência</strong><p>Inclua os valores de cada funcionário para acompanhar pagamentos e pendências.</p><button className="finance-button finance-button-primary" onClick={() => openEntry()}>+ Lançar folha</button></div> : <div className="finance-table-wrap"><table className="finance-table payroll-table"><thead><tr><th>Funcionário</th><th>Vencimento</th><th className="numeric">Salário-base</th><th className="numeric">Acréscimos</th><th className="numeric">Descontos</th><th className="numeric">Líquido</th><th className="numeric">Pago</th><th>Situação</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{entries.map((entry) => {
							const net = payrollNet(entry);
							const paidTotal = entry.paidCash + entry.paidBank;
							const status = paidTotal >= net ? 'Pago' : paidTotal > 0 ? 'Parcial' : 'Pendente';
							return <tr key={entry.id}><td><strong>{entry.employee}</strong>{entry.position && <small>{entry.position}</small>}{entry.note && <small>{entry.note}</small>}</td><td>{dateLabel(entry.dueDate)}</td><td className="numeric">{money(entry.basePay)}</td><td className="numeric">{money(entry.additions)}</td><td className="numeric">{money(entry.deductions)}</td><td className="numeric"><strong>{money(net)}</strong></td><td className="numeric">{money(paidTotal)}<small>{money(entry.paidCash)} caixa · {money(entry.paidBank)} banco</small></td><td><span className={`payroll-status status-${status.toLowerCase()}`}>{status}</span></td><td><div className="finance-row-actions"><button onClick={() => openEntry(entry.id)}>Editar</button><button className="danger" onClick={() => void removeEntry(entry)}>Excluir</button></div></td></tr>;
						})}</tbody><tfoot><tr><th colSpan={5}>Total da competência</th><th className="numeric">{money(planned)}</th><th className="numeric">{money(paid)}</th><th colSpan={2}>{money(pending)} pendentes</th></tr></tfoot></table></div>}
					</section>
				</>}
				<footer className="finance-page-footer"><span>Armazenamento: {financeStorageMode}</span><span>Folha · valores informados manualmente</span></footer>
			</main>

			{modal && <div className="finance-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(false); }}><section className="finance-modal" role="dialog" aria-modal="true" aria-labelledby="finance-modal-title"><form onSubmit={saveEntry}>
				<div className="finance-modal-header"><div><p className="finance-eyebrow">FOLHA DE PAGAMENTO</p><h2 id="finance-modal-title">{selected ? 'Editar lançamento' : 'Novo lançamento'}</h2></div><button type="button" className="finance-close" onClick={() => setModal(false)} aria-label="Fechar">×</button></div>
				<div className="finance-modal-body">
					<label className="finance-field"><span>Funcionário *</span><input name="employee" required defaultValue={selected?.employee} placeholder="Nome completo" /></label>
					<label className="finance-field"><span>Função</span><input name="position" defaultValue={selected?.position} placeholder="Cargo / setor" /></label>
					<label className="finance-field"><span>Vencimento *</span><input name="dueDate" type="date" required defaultValue={selected?.dueDate ?? monthDueDate(month)} /></label>
					<label className="finance-field"><span>Salário-base *</span><input name="basePay" type="number" min="0" step="0.01" required defaultValue={selected?.basePay ?? 0} /></label>
					<label className="finance-field"><span>Acréscimos</span><input name="additions" type="number" min="0" step="0.01" defaultValue={selected?.additions ?? 0} /></label>
					<label className="finance-field"><span>Descontos</span><input name="deductions" type="number" min="0" step="0.01" defaultValue={selected?.deductions ?? 0} /></label>
					<label className="finance-field"><span>Pago em dinheiro</span><input name="paidCash" type="number" min="0" step="0.01" defaultValue={selected?.paidCash ?? 0} /></label>
					<label className="finance-field"><span>Pago pelo banco</span><input name="paidBank" type="number" min="0" step="0.01" defaultValue={selected?.paidBank ?? 0} /></label>
					<label className="finance-field finance-field-wide"><span>Observação</span><textarea name="note" rows={2} defaultValue={selected?.note} /></label>
					<p className="finance-form-hint finance-field-wide">Líquido = salário-base + acréscimos - descontos. Informe manualmente encargos e descontos conforme a folha oficial.</p>
				</div>
				<div className="finance-modal-footer"><button type="button" className="finance-button finance-button-soft" onClick={() => setModal(false)}>Cancelar</button><button className="finance-button finance-button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : selected ? 'Salvar alterações' : 'Registrar folha'}</button></div>
			</form></section></div>}
		</div>
	);
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
	return <article className={`finance-metric metric-${tone}`}><span className="metric-rule" /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}
