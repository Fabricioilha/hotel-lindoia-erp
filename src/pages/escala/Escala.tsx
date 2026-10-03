import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ScheduleData, Shift, ShiftType, UserRole } from '../../types';
import { scheduleStorageMode, subscribeSchedule, updateSchedule, withShift, type ScheduleStoreData } from '../../services/scheduleStore';
import './escala.css';

const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const weekdays = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const shortWeekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const shiftTypes: { value: ShiftType; label: string }[] = [
	{ value: 'normal', label: 'Trabalho' },
	{ value: 'folga', label: 'Folga' },
	{ value: 'feriado', label: 'Feriado' },
	{ value: 'ferias', label: 'Férias' },
	{ value: 'atestado', label: 'Atestado' },
	{ value: 'falta', label: 'Falta' },
];

const statusText: Record<ShiftType, string> = {
	normal: '', folga: 'Folga', feriado: 'Feriado', ferias: 'Férias', atestado: 'Atestado', falta: 'Falta',
};

function dateKey(year: number, month: number, day: number) {
	return `${year}-${month}-${day}`;
}

function getShiftTime(shift: Shift) {
	if (shift.type === 'normal') return shift.time;
	if (shift.type === 'falta') return shift.time ? `Falta · ${shift.time}` : 'Falta';
	return statusText[shift.type];
}

function shiftColor(name: string) {
	const colors: Record<string, string> = {
		tatiana: '#3478a8', luana: '#a65058', cevani: '#a65e32', felipe: '#3c8062', paulo: '#397f7c',
		julya: '#bf5263', juliana: '#9c7730', amanda: '#536878', bianca: '#a64b36', márcia: '#755f8c',
	};
	return colors[name.trim().toLocaleLowerCase('pt-BR')] ?? '#526f83';
}

function getShiftHours(time: string) {
	const plainTime = time.replace(/^Falta · /, '');
	const [start = '', end = ''] = plainTime.split(' às ');
	return { start, end };
}

export function Escala({ userRole }: { userRole: UserRole }) {
	const today = new Date();
	const [year, setYear] = useState(today.getFullYear());
	const [month, setMonth] = useState(today.getMonth());
	const [data, setData] = useState<ScheduleStoreData>({ days: {}, employees: [] });
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [storageError, setStorageError] = useState('');
	const [notice, setNotice] = useState('');
	const [employee, setEmployee] = useState('');
	const [shiftType, setShiftType] = useState<ShiftType>('normal');
	const [timeStart, setTimeStart] = useState('08:00');
	const [timeEnd, setTimeEnd] = useState('16:00');
	const [filter, setFilter] = useState('');
	const [editing, setEditing] = useState<{ date: string; shift?: Shift } | null>(null);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const isAdmin = userRole === 'admin';
	const navigationItems = [
		{ route: '/', label: 'Painel principal', shortLabel: 'P' },
		{ route: '/vendas', label: 'Vendas', shortLabel: 'V' },
		{ route: '/recepcao', label: 'Caixa - Recepção', shortLabel: 'C' },
		...(isAdmin ? [
			{ route: '/estoque', label: 'Estoque', shortLabel: 'E' },
			{ route: '/quartos', label: 'Serviço de quarto', shortLabel: 'Q' },
			{ route: '/reservas', label: 'Reservas', shortLabel: 'R' },
		] : []),
		{ route: '/escala', label: 'Escala', shortLabel: 'ES' },
		...(isAdmin ? [{ route: '/financeiro/caixa', label: 'Financeiro', shortLabel: 'F' }] : []),
	];

	useEffect(() => subscribeSchedule((next) => {
		setData(next);
		setLoading(false);
		setStorageError('');
	}, (error) => {
		setLoading(false);
		setStorageError(`Não foi possível carregar a escala: ${error.message}`);
	}), []);

	const daysInMonth = new Date(year, month + 1, 0).getDate();
	const firstWeekday = new Date(year, month, 1).getDay();
	const calendarCells = Array.from({ length: Math.ceil((firstWeekday + daysInMonth) / 7) * 7 }, (_, index) => {
		const day = index - firstWeekday + 1;
		return day > 0 && day <= daysInMonth ? day : null;
	});
	const monthPrefix = `${year}-${month}-`;
	const monthShifts = useMemo(() => Object.entries(data.days)
		.filter(([key]) => key.startsWith(monthPrefix))
		.flatMap(([, shifts]) => shifts), [data.days, monthPrefix]);
	const counts = useMemo(() => ({
		shifts: monthShifts.length,
		staff: new Set(monthShifts.map((shift) => shift.name)).size,
		absences: monthShifts.filter((shift) => ['folga', 'ferias', 'atestado', 'falta'].includes(shift.type)).length,
	}), [monthShifts]);

	async function changeData(update: (current: ScheduleStoreData) => ScheduleStoreData, successMessage = '') {
		setSaving(true);
		setStorageError('');
		setNotice('');
		try {
			await updateSchedule(update);
			if (successMessage) setNotice(successMessage);
		} catch (error) {
			setStorageError(error instanceof Error ? `Erro ao salvar: ${error.message}` : 'Erro ao salvar a escala.');
		} finally {
			setSaving(false);
		}
	}

	function moveMonth(direction: number) {
		const nextDate = new Date(year, month + direction, 1);
		setYear(nextDate.getFullYear());
		setMonth(nextDate.getMonth());
	}

	function openNewShift(day: number) {
		if (!isAdmin) return;
		setEditing({ date: dateKey(year, month, day) });
	}

	function openEditShift(date: string, shift: Shift) {
		if (!isAdmin) return;
		setEmployee(shift.name);
		setShiftType(shift.type);
		const hours = getShiftHours(shift.time);
		setTimeStart(hours.start || '08:00');
		setTimeEnd(hours.end || '16:00');
		setEditing({ date, shift });
	}

	function saveShift(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!employee) {
			setStorageError('Selecione um funcionário para registrar o turno.');
			return;
		}
		if ((shiftType === 'normal' || shiftType === 'falta') && (!timeStart || !timeEnd)) {
			setStorageError('Preencha o horário do turno.');
			return;
		}
		const time = shiftType === 'normal' || shiftType === 'falta' ? `${timeStart} às ${timeEnd}` : statusText[shiftType];
		const nextShift: Shift = { id: editing?.shift?.id ?? Date.now(), name: employee, type: shiftType, time };
		const currentEditing = editing;
		if (!currentEditing) return;

		void changeData((current) => {
			const days: ScheduleData = { ...current.days };
			if (currentEditing.shift) {
				days[currentEditing.date] = (days[currentEditing.date] ?? []).map((shift) => shift.id === currentEditing.shift?.id ? nextShift : shift);
			} else {
				Object.assign(days, withShift(days, currentEditing.date, nextShift));
			}
			return { ...current, days };
		}, 'Turno salvo.');
		setEditing(null);
	}

	function deleteShift() {
		if (!editing?.shift || !window.confirm(`Excluir o turno de ${editing.shift.name}?`)) return;
		const currentEditing = editing;
		void changeData((current) => {
			const days = { ...current.days };
			const remaining = (days[currentEditing.date] ?? []).filter((shift) => shift.id !== currentEditing.shift?.id);
			if (remaining.length) days[currentEditing.date] = remaining;
			else delete days[currentEditing.date];
			return { ...current, days };
		}, 'Turno excluído.');
		setEditing(null);
	}

	function addEmployee() {
		const enteredName = window.prompt('Nome do novo funcionário:')?.trim();
		if (!enteredName) return;
		const normalizedName = enteredName.toLocaleLowerCase('pt-BR');
		const name = normalizedName.charAt(0).toLocaleUpperCase('pt-BR') + normalizedName.slice(1);
		setEmployee(name);
		void changeData((current) => ({
			...current,
			employees: current.employees.some((item) => item.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))
				? current.employees
				: [...current.employees, name].sort((a, b) => a.localeCompare(b, 'pt-BR')),
		}), 'Funcionário cadastrado.');
	}

	function copyToNextMonth() {
		if (!window.confirm(`Copiar os turnos de ${monthNames[month]} para o próximo mês?`)) return;
		const nextMonth = new Date(year, month + 1, 1);
		const nextMonthDays = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();
		void changeData((current) => {
			const days = { ...current.days };
			for (let day = 1; day <= Math.min(daysInMonth, nextMonthDays); day++) {
				const source = current.days[dateKey(year, month, day)] ?? [];
				if (!source.length) continue;
				const targetKey = dateKey(nextMonth.getFullYear(), nextMonth.getMonth(), day);
				const target = [...(days[targetKey] ?? [])];
				source.forEach((shift) => {
					if (!target.some((existing) => existing.name === shift.name && existing.type === shift.type && existing.time === shift.time)) {
						target.push({ ...shift, id: Date.now() + Math.floor(Math.random() * 100000) });
					}
				});
				days[targetKey] = target;
			}
			return { ...current, days };
		}, 'Escala copiada para o próximo mês.');
	}

	function clearMonth() {
		if (!window.confirm(`Apagar todos os turnos de ${monthNames[month]} de ${year}? Esta ação não pode ser desfeita.`)) return;
		void changeData((current) => {
			const days = { ...current.days };
			for (let day = 1; day <= daysInMonth; day++) delete days[dateKey(year, month, day)];
			return { ...current, days };
		}, 'Todos os turnos do mês foram removidos.');
	}

	return (
		<div className={`stock-app schedule-app ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
			<aside className="stock-sidebar">
				<div className="schedule-sidebar-header">
					<Link to="/" className="stock-brand" aria-label="Hotel Lindoia, painel principal" title="Painel principal">
						<span className="brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>OPERAÇÃO</small></span>
					</Link>
					<button className="schedule-sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}>
						<span aria-hidden="true">{sidebarCollapsed ? '›' : '‹'}</span>
					</button>
				</div>
				<div className="sidebar-label">EQUIPE</div>
				<nav className="stock-nav schedule-nav" aria-label="Navegação do hotel">
					{navigationItems.map((item) => <Link key={item.route} className={`nav-item ${item.route === '/escala' ? 'selected' : ''}`} to={item.route} title={item.label} aria-label={item.label}>
						<span className="nav-indicator" /><span className="schedule-nav-icon" aria-hidden="true">{item.shortLabel}</span><span className="schedule-nav-label">{item.label}</span>
					</Link>)}
				</nav>
				<div className="sidebar-footer" title={`Salvo ${scheduleStorageMode}`}><span className="connection-dot" /><span>Salvo {scheduleStorageMode}</span></div>
			</aside>

			<main className="stock-main">
				<header className="stock-topbar">
					<div className="breadcrumb"><Link to="/">Painel</Link><span>/</span><strong>Escala</strong></div>
					<div className="topbar-actions"><span className="user-chip">{isAdmin ? 'Gerência' : 'Equipe'}</span><Link className="back-link" to="/">Voltar ao painel</Link></div>
				</header>

				<div className="stock-content schedule-content">
					<section className="page-heading">
						<div><p className="eyebrow">GESTÃO DE PESSOAS</p><h1>Escala de funcionários</h1><p className="page-description">Turnos, folgas e ausências da equipe do hotel.</p></div>
						{isAdmin && <div className="heading-actions"><button className="button button-soft" onClick={copyToNextMonth} disabled={saving}>Copiar próximo mês</button><button className="button button-danger" onClick={clearMonth} disabled={saving}>Limpar mês</button></div>}
					</section>

					{storageError && <div className="notice notice-error" role="alert">{storageError}<button onClick={() => setStorageError('')} aria-label="Fechar aviso">×</button></div>}
					{notice && <div className="notice notice-success" role="status">{notice}</div>}

					<section className="schedule-summary" aria-label="Resumo mensal">
						<article><span>Turnos registrados</span><strong>{counts.shifts}</strong></article>
						<article><span>Funcionários na escala</span><strong>{counts.staff}</strong></article>
						<article><span>Folgas e ausências</span><strong>{counts.absences}</strong></article>
						<div className="schedule-month-control">
							<button className="schedule-month-arrow" onClick={() => moveMonth(-1)} title="Mês anterior" aria-label="Mês anterior">‹</button>
							<strong>{monthNames[month]} {year}</strong>
							<button className="schedule-month-arrow" onClick={() => moveMonth(1)} title="Próximo mês" aria-label="Próximo mês">›</button>
						</div>
					</section>

					{isAdmin && <section className="schedule-tools" aria-label="Ferramentas da escala">
						<label className="schedule-field schedule-filter"><span>Filtrar por funcionário</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Buscar nome" /></label>
						<label className="schedule-field"><span>Funcionário</span><span className="schedule-employee-select"><select value={employee} onChange={(event) => setEmployee(event.target.value)}><option value="">Selecione...</option>{data.employees.map((name) => <option key={name} value={name}>{name}</option>)}</select><button className="schedule-add-employee" onClick={addEmployee} title="Cadastrar funcionário" aria-label="Cadastrar funcionário">+</button></span></label>
						<label className="schedule-field"><span>Status do turno</span><select value={shiftType} onChange={(event) => setShiftType(event.target.value as ShiftType)}>{shiftTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
						{(shiftType === 'normal' || shiftType === 'falta') && <div className="schedule-time-fields"><label className="schedule-field"><span>Entrada</span><input type="time" value={timeStart} onChange={(event) => setTimeStart(event.target.value)} /></label><label className="schedule-field"><span>Saída</span><input type="time" value={timeEnd} onChange={(event) => setTimeEnd(event.target.value)} /></label></div>}
					</section>}

					<section className="schedule-calendar-section" aria-label={`Calendário de ${monthNames[month]} de ${year}`}>
						{loading ? <div className="loading-state">Carregando escala...</div> : <div className="schedule-table-scroll"><table className={`schedule-calendar ${isAdmin ? '' : 'schedule-readonly'}`}><thead><tr>{weekdays.map((weekday) => <th key={weekday}><span>{weekday}</span><abbr title={weekday}>{shortWeekdays[weekdays.indexOf(weekday)]}</abbr></th>)}</tr></thead><tbody>
							{Array.from({ length: calendarCells.length / 7 }, (_, rowIndex) => <tr key={rowIndex}>{calendarCells.slice(rowIndex * 7, rowIndex * 7 + 7).map((day, columnIndex) => {
								const key = day ? dateKey(year, month, day) : '';
								const shifts = day ? [...(data.days[key] ?? [])].sort((a, b) => (a.time || '24:00').localeCompare(b.time || '24:00')) : [];
								const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
								return <td key={`${rowIndex}-${columnIndex}`} className={`${day ? 'has-day' : 'empty-day'} ${isToday ? 'is-today' : ''}`} onClick={() => day && openNewShift(day)}>
									  {day && <><div className="schedule-day-number"><strong>{day}</strong><span>{shortWeekdays[columnIndex]}</span></div><div className="schedule-day-shifts">{shifts.filter((shift) => !filter || shift.name.toLocaleLowerCase('pt-BR').includes(filter.toLocaleLowerCase('pt-BR'))).map((shift) => <button key={shift.id} className={`schedule-shift shift-${shift.type}`} style={{ '--shift-color': shiftColor(shift.name) } as React.CSSProperties} disabled={!isAdmin} onClick={(event) => { event.stopPropagation(); openEditShift(key, shift); }} title={isAdmin ? 'Editar turno' : `${shift.name}: ${getShiftTime(shift)}`}><strong>{shift.name}</strong><span>{getShiftTime(shift)}</span></button>)}</div></>}
								</td>;
							})}</tr>)}
						</tbody></table></div>}
						<div className={`schedule-cloud-status ${storageError ? 'is-error' : ''}`} role="status"><span className="connection-dot" />{saving ? 'Salvando alterações...' : storageError ? 'Falha de sincronização' : `Sincronizado com ${scheduleStorageMode}`}</div>
					</section>
				</div>
			</main>

			{editing && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}>
				<section className="stock-modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title">
					<form onSubmit={saveShift}>
						<div className="schedule-modal-heading"><div><p className="eyebrow">{editing.shift ? 'ATUALIZAR REGISTRO' : 'NOVO REGISTRO'}</p><h2 id="schedule-modal-title">{editing.shift ? 'Editar turno' : 'Adicionar turno'}</h2></div><button type="button" className="schedule-modal-close" onClick={() => setEditing(null)} aria-label="Fechar">×</button></div>
						<p className="schedule-modal-date">{new Date(Number(editing.date.split('-')[0]), Number(editing.date.split('-')[1]), Number(editing.date.split('-')[2])).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
						<label className="schedule-field"><span>Funcionário</span><select required value={employee} onChange={(event) => setEmployee(event.target.value)}><option value="">Selecione...</option>{data.employees.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<label className="schedule-field"><span>Status</span><select value={shiftType} onChange={(event) => setShiftType(event.target.value as ShiftType)}>{shiftTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
						{(shiftType === 'normal' || shiftType === 'falta') && <div className="schedule-time-fields modal-times"><label className="schedule-field"><span>Entrada</span><input type="time" value={timeStart} onChange={(event) => setTimeStart(event.target.value)} /></label><label className="schedule-field"><span>Saída</span><input type="time" value={timeEnd} onChange={(event) => setTimeEnd(event.target.value)} /></label></div>}
						<div className="schedule-modal-actions">{editing.shift && <button type="button" className="button button-danger" onClick={deleteShift}>Excluir</button>}<button type="button" className="button button-plain" onClick={() => setEditing(null)}>Cancelar</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : 'Salvar turno'}</button></div>
					</form>
				</section>
			</div>}
		</div>
	);
}
