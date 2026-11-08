import { availablePayrollAdvances, payrollAdvanceDetails, payrollLaunchIssue, payrollLaunchTotals } from '../../services/payrollAdvances';
import { useStaff } from '../../services/staffStore';
import { findStaff, staffBaseSalary, staffMembers } from '../../types/staff';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { emptyFinance, financeStorageMode, subscribeFinance, updateFinance } from '../../services/financeStore';
import { DateInput } from '../../components/ui/DateInput';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { formatBRL } from '../../services/money';
import { payrollNet, payrollRegistered, WALLET_LABELS, type FinanceData, type PayrollEntry } from '../../types/finance';
import { financeDateKeyFromTimestamp, financeMonthRange, isFinanceDateKey, patchPaymentDates, payrollPaymentEvents, withPayrollPaymentTotals } from '../../services/financePayments';
import './financeiro.css';

type PaymentOrigin = 'cash' | 'bank' | 'split';

const money = formatBRL;
const roundMoney = (value: number) => Math.round(value * 100) / 100;
const sumAmounts = (values: Record<string, number> | undefined) => roundMoney(Object.values(values ?? {}).reduce((sum, value) => sum + value, 0));
const localMonth = () => {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};
const monthDueDate = (month: string) => {
	const day = Math.min(new Date().getDate(), new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate());
	return `${month}-${String(day).padStart(2, '0')}`;
};
const dateLabel = (value: string) => value ? new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR') : 'Data não informada';
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

const ORIGIN_OPTIONS: { value: PaymentOrigin; label: string }[] = [
	{ value: 'cash', label: 'Caixa físico' },
	{ value: 'bank', label: 'Banco / Pix' },
	{ value: 'split', label: 'Dividir entre caixa e banco' },
];

export function FolhaDePagamento() {
	const { data: staff } = useStaff();
	const [data, setData] = useState<FinanceData>(emptyFinance());
	const [month, setMonth] = useState(localMonth);
	const [loading, setLoading] = useState(true);
	const [modal, setModal] = useState(false);
	const [editingId, setEditingId] = useState('');
	const [editingRecord, setEditingRecord] = useState<PayrollEntry | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [draftEmployee, setDraftEmployee] = useState('');
	const [draftMonth, setDraftMonth] = useState(month);
	const [draftPosition, setDraftPosition] = useState('');
	const [paidNow, setPaidNow] = useState(0);
	const [origin, setOrigin] = useState<PaymentOrigin>('cash');
	const [splitCash, setSplitCash] = useState(0);
	const [keepBalance, setKeepBalance] = useState(false);
	const [advanceChoice, setAdvanceChoice] = useState<Record<string, boolean>>({});

	useEffect(() => subscribeFinance((next) => { setData(next); setLoading(false); setError(''); }, (cause) => { setError(cause.message); setLoading(false); }, { includeOperations: false }), []);

	const entries = useMemo(() => Object.values(data.payroll).map((entry) => ({ ...entry, employee: findStaff(staff, entry.employee, entry.employeeId)?.name ?? entry.employee })).filter((item) => item.month === month).sort((a, b) => a.employee.localeCompare(b.employee, 'pt-BR')), [data.payroll, month, staff]);
	const planned = entries.reduce((sum, item) => sum + payrollNet(item), 0);
	const paid = entries.reduce((sum, item) => sum + item.paidCash + item.paidBank, 0);
	const pending = entries.reduce((sum, entry) => sum + Math.max(0, payrollNet(entry) - entry.paidCash - entry.paidBank), 0);
	const advancesInPayroll = entries.reduce((sum, entry) => sum + sumAmounts(entry.advances), 0);
	const registeredTotal = entries.reduce((sum, entry) => sum + payrollRegistered(entry), 0);
	const selected = editingRecord ?? undefined;
	const selectedPayments = selected ? payrollPaymentEvents(selected) : [];

	// Resumo financeiro do modal: tudo derivado do rascunho, sem gravar nada até confirmar.
	const draftMember = findStaff(staff, draftEmployee);
	const sameEmployee = Boolean(selected) && draftEmployee === selected?.employee;
	const baseReference = sameEmployee ? selected!.basePay : staffBaseSalary(draftMember);
	const registeredBase = staffBaseSalary(draftMember);
	const eligibleAdvances = availablePayrollAdvances(data, { id: editingId, employee: draftEmployee, employeeId: draftMember?.id, month: draftMonth });
	const advanceDetails = payrollAdvanceDetails(data, eligibleAdvances);
	const isAdvanceSelected = (id: string) => advanceChoice[id] ?? (selected ? Boolean(selected.advances?.[id]) : true);
	const chosenAdvances = Object.fromEntries(Object.entries(eligibleAdvances).filter(([id]) => isAdvanceSelected(id)));
	const paidCash = origin === 'cash' ? paidNow : origin === 'bank' ? 0 : Math.min(splitCash, paidNow);
	const paidBank = roundMoney(paidNow - paidCash);
	const launchInput = { previous: sameEmployee ? selected : undefined, baseSalary: baseReference, advances: chosenAdvances, paidCash, paidBank };
	const launch = payrollLaunchTotals({ ...launchInput, keepBalance });
	const plan = payrollLaunchTotals({ ...launchInput, keepBalance: true });
	const launchIssue = payrollLaunchIssue(launch);

	async function commit(update: (current: FinanceData) => FinanceData, message: string) {
		setSaving(true);
		setError('');
		try {
			await updateFinance(update);
			setModal(false);
			setEditingId('');
			setEditingRecord(null);
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
		const employee = draftEmployee.trim();
		const competence = draftMonth;
		const dueDate = String(form.get('dueDate') ?? '');
		const paymentDate = String(form.get('paidDate') ?? '');
		if (!employee) { setError('Selecione o funcionário da folha.'); return; }
		if (!isFinanceDateKey(dueDate) || !isFinanceDateKey(paymentDate)) { setError('Confira o vencimento e a data do pagamento ou correção.'); return; }
		try { financeMonthRange(competence); } catch { setError('Informe a competência da folha.'); return; }
		if (origin === 'split' && splitCash > paidNow) { setError('A parte paga em dinheiro não pode superar o valor pago.'); return; }
		if (launchIssue) { setError(launchIssue); return; }
		const current = selected;
		const timestamp = new Date().toISOString();
		const next: PayrollEntry = {
			advances: chosenAdvances,
			id: current?.id ?? editingId,
			month: competence,
			dueDate,
			employee,
			...(draftMember ? { employeeId: draftMember.id } : {}),
			position: draftPosition.trim(),
			basePay: launch.basePay,
			additions: launch.additions,
			deductions: launch.deductions,
			paidCash,
			paidBank,
			note: String(form.get('note') ?? '').trim(),
			createdAt: current?.createdAt ?? timestamp,
			updatedAt: timestamp,
		};
		let item: PayrollEntry;
		try {
			item = withPayrollPaymentTotals(current, next, paymentDate, createId());
			const dates: Record<string, string> = {};
			for (const payment of selectedPayments) {
				const date = String(form.get(`paymentDate-${payment.id}`) ?? payment.date);
				if (!isFinanceDateKey(date)) throw new Error('Confira a data de cada pagamento registrado.');
				if (date !== payment.date || form.get(`confirmDate-${payment.id}`) === 'on') dates[payment.id] = date;
			}
			item = { ...item, payments: patchPaymentDates(item.payments ?? {}, dates) };
		} catch (cause) { setError(cause instanceof Error ? cause.message : 'Confira os pagamentos da folha.'); return; }
		void commit((latest) => {
			const latestRecord = latest.payroll[item.id];
			if (current && (!latestRecord || latestRecord.updatedAt !== current.updatedAt)) throw new Error('A folha mudou enquanto você editava. Reabra o lançamento para consultar os valores atuais.');
			if (!current && latestRecord) throw new Error('Este lançamento já foi salvo. Reabra a folha para consultar o registro.');
			return { ...latest, payroll: { ...latest.payroll, [item.id]: item } };
		}, current ? 'Lançamento da folha atualizado.' : 'Lançamento da folha registrado.');
	}

	async function removeEntry(entry: PayrollEntry) {
		if (!window.confirm(`Excluir a folha de ${entry.employee} desta competência? Os vales vinculados voltam a ficar pendentes.`)) return;
		await commit((latest) => {
			const next = { ...latest.payroll };
			delete next[entry.id];
			return { ...latest, payroll: next };
		}, 'Lançamento excluído.');
	}

	function openEntry(entryId = '') {
		const record = entries.find((entry) => entry.id === entryId);
		const savedCash = record?.paidCash ?? 0;
		const savedBank = record?.paidBank ?? 0;
		setDraftEmployee(record?.employee ?? '');
		setDraftMonth(record?.month ?? month);
		setDraftPosition(record?.position ?? '');
		setPaidNow(roundMoney(savedCash + savedBank));
		setOrigin(savedCash > 0 && savedBank > 0 ? 'split' : savedBank > 0 ? 'bank' : 'cash');
		setSplitCash(savedCash);
		// Folha parcialmente paga continua parcial ao reabrir, em vez de virar um desconto sem querer.
		setKeepBalance(Boolean(record) && Math.round((savedCash + savedBank) * 100) > 0 && Math.round((savedCash + savedBank) * 100) < Math.round(payrollNet(record!) * 100));
		setAdvanceChoice({});
		setEditingId(entryId || createId());
		setEditingRecord(record ?? null);
		setError('');
		setModal(true);
	}

	function changeEmployee(name: string) {
		setDraftEmployee(name);
		setAdvanceChoice({});
		if (!selected || name !== selected.employee) {
			const member = findStaff(staff, name);
			setDraftPosition(member ? staff.categories[member.categoryId]?.name ?? '' : '');
		}
	}

	function changeOrigin(value: PaymentOrigin) {
		if (value === 'split' && splitCash === 0) setSplitCash(roundMoney(paidNow / 2));
		setOrigin(value);
	}

	function exportPayroll() {
		exportCsv(`folha-${month}.csv`, [
			['Competência', 'Vencimento', 'Funcionário', 'Função', 'Salário-base', 'Acréscimos', 'Outros descontos', 'Vales compensados (já pagos no caixa)', 'Remuneração registrada (contracheque + vales)', 'Líquido (contracheque)', 'Pago em caixa', 'Pago em banco', 'Total pago', 'Pendente', 'Observação'],
			...entries.map((entry) => {
				const net = payrollNet(entry);
				const paidTotal = entry.paidCash + entry.paidBank;
				return [month, entry.dueDate, entry.employee, entry.position, entry.basePay, entry.additions, entry.deductions, sumAmounts(entry.advances), payrollRegistered(entry), net, entry.paidCash, entry.paidBank, paidTotal, Math.max(0, net - paidTotal), entry.note];
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
					<div><p className="finance-eyebrow">FINANCEIRO <span>/</span> PESSOAL</p><h1>Folha de pagamento</h1><p>Contracheque pago, vales já adiantados e remuneração por funcionário e competência.</p></div>
					<div className="finance-heading-actions"><label className="finance-month"><span>Competência</span><input type="month" value={month} onChange={(event) => { if (event.target.value) setMonth(event.target.value); }} /></label><button className="finance-button finance-button-soft" onClick={exportPayroll} disabled={loading}>Exportar CSV</button><button className="finance-button finance-button-primary" onClick={() => openEntry()} disabled={loading}>+ Lançar folha</button></div>
				</div>

				{error && !modal && <div className="finance-alert" role="alert">{error}<button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
				{notice && <div className="finance-notice" role="status">{notice}</div>}

				{loading ? <div className="finance-empty">Carregando folha...</div> : <>
					<section className="finance-metrics payroll-metrics" aria-label="Resumo da folha">
						<Metric label="Funcionários" value={String(entries.length)} detail="Lançamentos nesta competência" tone="navy" />
						<Metric label="Líquido do contracheque" value={money(planned)} detail="Base + acréscimos − descontos − vales" tone="blue" />
						<Metric label="Total pago" value={money(paid)} detail={`${money(entries.reduce((sum, item) => sum + item.paidCash, 0))} em dinheiro · ${money(entries.reduce((sum, item) => sum + item.paidBank, 0))} em banco`} tone="green" />
						<Metric label="Vales na folha" value={money(advancesInPayroll)} detail="Já saíram do caixa · não debitam de novo" tone="gold" />
						<Metric label="Pendente" value={money(pending)} detail="Saldo líquido a pagar" tone={pending > 0 ? 'coral' : 'gray'} />
					</section>

					<section className="finance-panel">
						<div className="finance-panel-heading"><div><h2>Pagamentos por funcionário</h2><p>O caixa desconta apenas o valor pago no contracheque; os vales constam na folha sem nova saída.</p></div><span className="record-count">{entries.length} registros</span></div>
						{entries.length === 0 ? <div className="finance-empty"><strong>Nenhum lançamento nesta competência</strong><p>Inclua os valores de cada funcionário para acompanhar pagamentos e pendências.</p><button className="finance-button finance-button-primary" onClick={() => openEntry()}>+ Lançar folha</button></div> : <div className="finance-table-wrap"><table className="finance-table payroll-table"><thead><tr><th>Funcionário</th><th>Vencimento</th><th className="numeric">Salário-base</th><th className="numeric">Vales (já pagos)</th><th className="numeric">Líquido</th><th className="numeric">Pago</th><th className="numeric">Remuneração total</th><th>Situação</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{entries.map((entry) => {
							const net = payrollNet(entry);
							const paidTotal = entry.paidCash + entry.paidBank;
							const status = paidTotal >= net ? 'Pago' : paidTotal > 0 ? 'Parcial' : 'Pendente';
							const advances = payrollAdvanceDetails(data, entry.advances ?? {});
							return <tr key={entry.id}><td><strong>{entry.employee}</strong>{entry.position && <small>{entry.position}</small>}{entry.note && <small>{entry.note}</small>}</td><td>{dateLabel(entry.dueDate)}</td><td className="numeric">{money(entry.basePay)}{entry.additions > 0 && <small>+ {money(entry.additions)} acréscimos</small>}{entry.deductions > 0 && <small>− {money(entry.deductions)} descontos</small>}</td><td className="numeric">{money(sumAmounts(entry.advances))}{advances.length > 0 && <small>{advances.map((advance) => `${advance.date ? dateLabel(advance.date).slice(0, 5) : '--/--'} ${money(advance.amount)}`).join(' · ')}</small>}{advances.length > 0 && <small>Consta na folha · sem nova saída</small>}</td><td className="numeric"><strong>{money(net)}</strong></td><td className="numeric">{money(paidTotal)}<small>{money(entry.paidCash)} caixa · {money(entry.paidBank)} banco</small></td><td className="numeric">{money(payrollRegistered(entry))}</td><td><span className={`payroll-status status-${status.toLowerCase()}`}>{status}</span></td><td><div className="finance-row-actions"><button onClick={() => openEntry(entry.id)}>Editar</button><button className="danger" onClick={() => void removeEntry(entry)}>Excluir</button></div></td></tr>;
						})}</tbody><tfoot><tr><th colSpan={3}>Total da competência</th><th className="numeric">{money(advancesInPayroll)}</th><th className="numeric">{money(planned)}</th><th className="numeric">{money(paid)}</th><th className="numeric">{money(registeredTotal)}</th><th colSpan={2}>{money(pending)} pendentes</th></tr></tfoot></table></div>}
					</section>
				</>}
				<footer className="finance-page-footer"><span>Armazenamento: {financeStorageMode}</span><span>Folha · valores informados manualmente</span></footer>
			</main>

			{modal && <div className="finance-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setModal(false); }}><section className="finance-modal finance-modal-folha" role="dialog" aria-modal="true" aria-labelledby="finance-modal-title"><form data-guard-unsaved onSubmit={saveEntry}>
				<div className="finance-modal-header"><div><p className="finance-eyebrow">FOLHA DE PAGAMENTO</p><h2 id="finance-modal-title">{selected ? 'Editar lançamento' : 'Novo lançamento'}</h2></div><button type="button" className="finance-close" onClick={() => setModal(false)} aria-label="Fechar" disabled={saving}>×</button></div>
				{error && <p className="finance-alert" role="alert">{error}</p>}
				<fieldset className="finance-modal-body" disabled={saving}>
					<label className="finance-field"><span>Funcionário *</span><select name="employee" required value={draftEmployee} onChange={(event) => changeEmployee(event.target.value)}><option value="">Selecione...</option>{[...new Set([...staffMembers(staff).map((member) => member.name), ...(selected ? [selected.employee] : [])])].map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
					<label className="finance-field"><span>Função</span><input name="position" value={draftPosition} onChange={(event) => setDraftPosition(event.target.value)} placeholder="Cargo / setor" /></label>
					<label className="finance-field"><span>Competência da folha *</span><input name="competence" type="month" required value={draftMonth} onChange={(event) => { setDraftMonth(event.target.value); setAdvanceChoice({}); }} /></label>
					<label className="finance-field"><span>Vencimento *</span><DateInput name="dueDate" required defaultValue={selected?.dueDate ?? monthDueDate(month)} /></label>

					<section className="payroll-summary finance-field-wide" aria-labelledby="payroll-summary-title">
						<div className="payroll-summary-heading"><h3 id="payroll-summary-title">Resumo financeiro da folha</h3><small>Confira os valores antes de confirmar</small></div>

						<div className="payroll-line">
							<div className="payroll-line-label"><strong>Salário base (referência)</strong>{baseReference > 0 ? <small>{sameEmployee && registeredBase > 0 && Math.round(registeredBase * 100) !== Math.round(baseReference * 100) ? `Valor desta folha · cadastro atual: ${money(registeredBase)}` : 'Salário base mensal cadastrado'}</small> : <small>Não cadastrado · <Link to="/funcionarios">informe em Funcionários</Link></small>}</div>
							<div className="payroll-line-value">{baseReference > 0 ? money(baseReference) : '—'}</div>
						</div>

						<div className="payroll-line payroll-line-advances">
							<div className="payroll-line-label"><strong>Vales adiantados no período</strong><small>Já pagos pelo caixa anteriormente</small></div>
							<div className="payroll-line-value"><span>{money(launch.advancesTotal)}</span>{launch.advancesTotal > 0 && <span className="payroll-badge">Consta na folha • Não debita do caixa novamente</span>}</div>
						</div>
						{advanceDetails.length > 0 ? <ul className="payroll-advance-list" aria-label="Vales do período">{advanceDetails.map((advance) => <li key={advance.id}><label className="modal-check-row"><input type="checkbox" checked={isAdvanceSelected(advance.id)} onChange={(event) => setAdvanceChoice((choice) => ({ ...choice, [advance.id]: event.target.checked }))} /><span>Vale de {dateLabel(advance.date)}{advance.note ? ` · ${advance.note}` : ''}</span><strong>{money(advance.amount)}</strong></label></li>)}</ul> : draftEmployee && <p className="payroll-line-hint">Nenhum vale pendente deste funcionário em {draftMonth.slice(5)}/{draftMonth.slice(0, 4)}.</p>}

						<div className="payroll-line payroll-line-paid">
							<div className="payroll-line-label"><label htmlFor="payroll-paid-now"><strong>Valor pago agora</strong></label><small>{selectedPayments.length > 0 ? 'Total já pago no contracheque · ajustes viram novas parcelas datadas' : 'Conforme contracheque · saída real do caixa hoje'}</small></div>
							<div className="payroll-line-value"><MoneyInput id="payroll-paid-now" value={paidNow} onValueChange={setPaidNow} aria-describedby="payroll-paid-hint" /></div>
						</div>
						<p className="payroll-line-hint" id="payroll-paid-hint">{paidNow === 0 && plan.net > 0 ? <>Sem valor pago, a folha fica pendente. <button type="button" className="payroll-fill" onClick={() => setPaidNow(plan.net)}>Preencher com {money(plan.net)} (base − vales)</button></> : 'Somente este valor sai do caixa ou do banco. Os vales listados acima já saíram quando foram pagos.'}</p>
						<div className="payroll-origin" role="radiogroup" aria-labelledby="payroll-origin-label"><span id="payroll-origin-label">Saiu de</span>{ORIGIN_OPTIONS.map((option) => <label key={option.value} className="modal-check-row"><input type="radio" name="payrollOrigin" value={option.value} checked={origin === option.value} onChange={() => changeOrigin(option.value)} />{option.label}</label>)}</div>
						{origin === 'split' && <div className="payroll-split"><label className="finance-field"><span>Parte paga em dinheiro</span><MoneyInput value={splitCash} onValueChange={setSplitCash} /></label><div className="finance-field"><span>Parte paga pelo banco</span><strong>{money(paidBank)}</strong></div></div>}
						{plan.net > 0 && <label className="modal-check-row payroll-partial"><input type="checkbox" checked={keepBalance} onChange={(event) => setKeepBalance(event.target.checked)} /><span><strong>Pagamento parcial</strong><small>Mantém o líquido previsto de {money(plan.net)} e deixa o restante como pendente.</small></span></label>}

						<div className="payroll-line payroll-line-total">
							<div className="payroll-line-label"><strong>Total remuneração registrada na folha</strong><small>Contracheque + vales já adiantados</small></div>
							<div className="payroll-line-value"><strong>{money(launch.registered)}</strong><small>{money(launch.net)} contracheque{launch.closing ? '' : ' (previsto)'} + {money(launch.advancesTotal)} vales</small></div>
						</div>
						{!launch.closing && launch.pending > 0 && <p className="payroll-line-hint">Saldo pendente do contracheque: <strong>{money(launch.pending)}</strong></p>}
						{baseReference > 0 && launch.difference !== 0 && <p className="payroll-line-hint">{launch.difference > 0 ? `Acima do salário base em ${money(launch.difference)} · registrado como acréscimo.` : `Abaixo do salário base em ${money(-launch.difference)} · registrado como desconto.`}</p>}
					</section>

					<label className="finance-field"><span>Data do pagamento ou correção *</span><DateInput name="paidDate" required defaultValue={financeDateKeyFromTimestamp(new Date().toISOString())} /></label>
					<label className="finance-field"><span>Observação</span><textarea name="note" rows={2} defaultValue={selected?.note} /></label>
					<p className="finance-form-hint finance-field-wide">A diferença em relação ao total já pago é registrada na data acima, preservando os pagamentos anteriores.</p>
					{selectedPayments.length > 0 && <fieldset className="finance-field-wide finance-payment-history"><legend>Pagamentos registrados</legend><p className="finance-form-hint">Corrija a data de uma parcela somente quando necessário. Os outros pagamentos mantêm suas datas.</p>{selectedPayments.map((payment, index) => <div key={payment.id} className="finance-payment-event"><div><strong>Parcela {index + 1} · {money(payment.amount)}</strong><small>{WALLET_LABELS[payment.wallet]}{payment.dateSource === 'legacy_due_date' ? ' · registro antigo sem data de pagamento' : ''}</small></div><label className="finance-field"><span>Data da parcela {index + 1}</span><DateInput name={`paymentDate-${payment.id}`} required defaultValue={payment.date} /></label>{payment.dateSource === 'legacy_due_date' && <label className="finance-confirm-date modal-check-row"><input type="checkbox" name={`confirmDate-${payment.id}`} />Confirmar esta data de pagamento</label>}</div>)}</fieldset>}
				</fieldset>
				<div className="finance-modal-footer"><button type="button" className="finance-button finance-button-soft" onClick={() => setModal(false)} disabled={saving}>Cancelar</button><button className="finance-button finance-button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : selected ? 'Salvar alterações' : 'Registrar folha'}</button></div>
			</form></section></div>}
		</div>
	);
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
	return <article className={`finance-metric metric-${tone}`}><span className="metric-rule" /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}
