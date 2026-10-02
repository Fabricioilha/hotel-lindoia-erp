import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { UserRole } from '../../types';
import type {
	DailyCleaningRequest,
	HousekeepingData,
	HousekeepingRoom,
	RoomCleaningLog,
	RoomDayPlan,
	RoomMaintenanceStatus,
} from '../../types/housekeeping';
import { DEFAULT_EMPLOYEES } from '../../services/scheduleStore';
import {
	emptyHousekeeping,
	housekeepingStorageMode,
	subscribeHousekeeping,
	updateHousekeeping,
} from '../../services/housekeepingStore';
import { activeReservationForRoom } from '../../services/reservationAnalytics';
import './quartos.css';

type ModalState =
	| { type: 'room'; room?: HousekeepingRoom }
	| { type: 'cleaning'; room: HousekeepingRoom }
	| null;

const cleaningLabels = {
	sujo: 'Sujo',
	limpo: 'Limpo',
	em_limpeza: 'Em limpeza',
} as const;

const maintenanceLabels: Record<RoomMaintenanceStatus, string> = {
	normal: 'Sem manutenção',
	manutencao_necessaria: 'Manutenção necessária · liberado',
	em_manutencao: 'Em manutenção · indisponível',
};

const cleaningRequestLabels: Record<DailyCleaningRequest, string> = {
	pendente: 'Aguardando resposta',
	solicitada: 'Limpeza solicitada',
	dispensada: 'Limpeza dispensada',
};

function todayKey() {
	const today = new Date();
	return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function newId() {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dateDifference(from: string, to: string) {
	const fromDate = new Date(`${from}T12:00:00`);
	const toDate = new Date(`${to}T12:00:00`);
	return Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000);
}

function shortDate(date: string) {
	return new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR');
}

export function ListaQuartos({ userRole }: { userRole: UserRole }) {
	const today = todayKey();
	const isAdmin = userRole === 'admin';
	const [data, setData] = useState<HousekeepingData>(emptyHousekeeping());
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [search, setSearch] = useState('');
	const [statusFilter, setStatusFilter] = useState('todos');
	const [modal, setModal] = useState<ModalState>(null);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [intervalDraft, setIntervalDraft] = useState('5');

	useEffect(() => subscribeHousekeeping((next) => {
		setData(next);
		setIntervalDraft(String(next.settings.doorsAndWindowsIntervalDays));
		setLoading(false);
		setError('');
	}, (storageError) => {
		setLoading(false);
		setError(`Não foi possível carregar os quartos: ${storageError.message}`);
	}), []);

	const rooms = useMemo(() => Object.values(data.rooms).sort((a, b) =>
		a.number.localeCompare(b.number, 'pt-BR', { numeric: true }),
	), [data.rooms]);
	const filteredRooms = rooms.filter((room) => {
		const currentGuest = activeReservationForRoom(data, room.id)?.guestName ?? '';
		const matchesSearch = room.number.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))
			|| currentGuest.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'));
		const matchesStatus = statusFilter === 'todos'
			|| room.cleaningStatus === statusFilter
			|| (activeReservationForRoom(data, room.id) ? 'ocupado' : 'livre') === statusFilter
			|| room.maintenanceStatus === statusFilter;
		return matchesSearch && matchesStatus;
	});
	const todayLogs = Object.values(data.cleaningLogs).filter((log) => log.date === today);
	const attendantTotals = new Map<string, Set<string>>();
	todayLogs.forEach((log) => {
		const roomsCleaned = attendantTotals.get(log.attendant) ?? new Set<string>();
		roomsCleaned.add(log.roomId);
		attendantTotals.set(log.attendant, roomsCleaned);
	});
	const occupiedRooms = rooms.filter((room) => activeReservationForRoom(data, room.id)).length;
	const dirtyRooms = rooms.filter((room) => room.cleaningStatus === 'sujo').length;
	const cleaningRooms = rooms.filter((room) => room.cleaningStatus === 'em_limpeza').length;
	const maintenanceRooms = rooms.filter((room) => room.maintenanceStatus !== 'normal').length;

	async function changeData(
		update: (current: HousekeepingData) => HousekeepingData,
		successMessage = '',
	) {
		setSaving(true);
		setError('');
		setNotice('');
		try {
			await updateHousekeeping(update);
			if (successMessage) setNotice(successMessage);
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : 'Não foi possível salvar a operação.');
		} finally {
			setSaving(false);
		}
	}

	function saveRoom(room: HousekeepingRoom) {
		void changeData((current) => {
			const duplicate = Object.values(current.rooms).some((existing) =>
				existing.id !== room.id && existing.number.trim().toLocaleLowerCase('pt-BR') === room.number.trim().toLocaleLowerCase('pt-BR'),
			);
			if (duplicate) throw new Error(`O quarto ${room.number} já está cadastrado.`);
			if (room.maintenanceStatus === 'em_manutencao' && activeReservationForRoom(current, room.id)) {
				throw new Error('Faça o checkout do hóspede antes de bloquear o quarto para manutenção.');
			}
			return { ...current, rooms: { ...current.rooms, [room.id]: room } };
		}, 'Quarto salvo.');
		setModal(null);
	}

	function setCleaningStatus(room: HousekeepingRoom, status: HousekeepingRoom['cleaningStatus']) {
		void changeData((current) => ({
			...current,
			rooms: { ...current.rooms, [room.id]: { ...current.rooms[room.id], cleaningStatus: status } },
		}), status === 'em_limpeza' ? `Limpeza do quarto ${room.number} iniciada.` : 'Status do quarto atualizado.');
	}

	function updateDailyPlan(roomId: string, plan: Partial<RoomDayPlan>) {
		void changeData((current) => {
			const dayPlans = current.dailyPlans[today] ?? {};
			const previous = dayPlans[roomId] ?? { cleaningRequest: 'pendente' as DailyCleaningRequest };
			return {
				...current,
				dailyPlans: {
					...current.dailyPlans,
					[today]: { ...dayPlans, [roomId]: { ...previous, ...plan } },
				},
			};
		}, 'Informação diária atualizada.');
	}

	function completeCleaning(room: HousekeepingRoom, form: { attendant: string; doorsAndWindows: boolean; note: string }) {
		const log: RoomCleaningLog = {
			id: newId(),
			roomId: room.id,
			roomNumber: room.number,
			attendant: form.attendant.trim(),
			date: today,
			completedAt: new Date().toISOString(),
			doorsAndWindows: form.doorsAndWindows,
			note: form.note.trim(),
		};
		void changeData((current) => ({
			...current,
			rooms: { ...current.rooms, [room.id]: { ...current.rooms[room.id], cleaningStatus: 'limpo' } },
			cleaningLogs: { ...current.cleaningLogs, [log.id]: log },
		}), `Limpeza do quarto ${room.number} registrada.`);
		setModal(null);
	}

	function saveInterval(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const interval = Number(intervalDraft);
		if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
			setError('Defina um intervalo entre 1 e 365 dias.');
			return;
		}
		void changeData((current) => ({
			...current,
			settings: { ...current.settings, doorsAndWindowsIntervalDays: interval },
		}), 'Prazo de portas e janelas atualizado.');
	}

	function lastDoorsAndWindowsClean(roomId: string) {
		return Object.values(data.cleaningLogs)
			.filter((log) => log.roomId === roomId && log.doorsAndWindows)
			.sort((a, b) => b.date.localeCompare(a.date))[0];
	}

	function dueDays(roomId: string) {
		const lastLog = lastDoorsAndWindowsClean(roomId);
		if (!lastLog) return null;
		return Math.max(0, data.settings.doorsAndWindowsIntervalDays - dateDifference(lastLog.date, today));
	}

	return (
		<div className={`stock-app housekeeping-app ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
			<aside className="stock-sidebar">
				<div className="housekeeping-sidebar-header">
					<Link to="/" className="stock-brand" aria-label="Hotel Lindoia, painel principal" title="Painel principal">
						<span className="brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>OPERAÇÃO</small></span>
					</Link>
					<button className="housekeeping-sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}>
						<span aria-hidden="true">{sidebarCollapsed ? '›' : '‹'}</span>
					</button>
				</div>
				<div className="sidebar-label">HOTEL LINDOIA</div>
				<nav className="stock-nav housekeeping-nav" aria-label="Navegação do hotel">
					<HousekeepingNavLink route="/" label="Painel principal" shortLabel="P" />
					<HousekeepingNavLink route="/vendas" label="Vendas" shortLabel="V" />
					<HousekeepingNavLink route="/estoque" label="Estoque" shortLabel="E" />
					<HousekeepingNavLink route="/quartos" label="Serviço de quarto" shortLabel="Q" active />
					<HousekeepingNavLink route="/reservas" label="Reservas" shortLabel="R" />
					<HousekeepingNavLink route="/escala" label="Escala" shortLabel="ES" />
					{isAdmin && <HousekeepingNavLink route="/financeiro/caixa" label="Financeiro" shortLabel="F" />}
				</nav>
				<div className="sidebar-footer" title={`Salvo ${housekeepingStorageMode}`}><span className="connection-dot" /><span>Salvo {housekeepingStorageMode}</span></div>
			</aside>

			<main className="stock-main">
				<header className="stock-topbar">
					<div className="breadcrumb"><Link to="/">Painel</Link><span>/</span><strong>Serviço de quarto</strong></div>
					<div className="topbar-actions"><span className="user-chip">{isAdmin ? 'Gerência' : 'Equipe'}</span><Link className="back-link" to="/">Voltar ao painel</Link></div>
				</header>

				<div className="stock-content housekeeping-content">
					<section className="page-heading">
						<div><p className="eyebrow">OPERAÇÃO DE CAMAREIRAS</p><h1>Serviço de quarto</h1><p className="page-description">Ocupação, limpeza e manutenção de cada quarto.</p></div>
						<div className="heading-actions"><button className="button button-primary" onClick={() => setModal({ type: 'room' })}>+ Adicionar quarto</button></div>
					</section>

					{error && <div className="notice notice-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
					{notice && <div className="notice notice-success" role="status">{notice}</div>}

					<section className="housekeeping-summary" aria-label="Resumo dos quartos">
						<Metric label="Quartos cadastrados" value={rooms.length} tone="neutral" />
						<Metric label="Ocupados" value={occupiedRooms} tone="blue" />
						<Metric label="Sujo" value={dirtyRooms} tone="gold" />
						<Metric label="Em limpeza" value={cleaningRooms} tone="red" />
						<Metric label="Com manutenção" value={maintenanceRooms} tone="neutral" />
					</section>

					<section className="housekeeping-controls">
						<label className="schedule-field housekeeping-search"><span>Buscar quarto ou hóspede</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Ex.: 12 ou nome" /></label>
						<label className="schedule-field"><span>Filtrar quartos</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
							<option value="todos">Todos os quartos</option><option value="sujo">Sujo</option><option value="limpo">Limpo</option><option value="em_limpeza">Em limpeza</option><option value="livre">Livre</option><option value="ocupado">Ocupado</option><option value="manutencao_necessaria">Manutenção necessária</option><option value="em_manutencao">Em manutenção</option>
						</select></label>
						<form className="doors-interval-control" onSubmit={saveInterval}>
							<label className="schedule-field"><span>Portas e janelas, a cada</span><span className="interval-input-wrap"><input type="number" min="1" max="365" value={intervalDraft} onChange={(event) => setIntervalDraft(event.target.value)} /><span>dias</span></span></label>
							<button className="button button-soft" type="submit" disabled={saving}>Salvar prazo</button>
						</form>
					</section>

					<section className="housekeeping-workspace" aria-label="Quartos e produtividade diária">
						<div className="room-list-heading"><div><p className="eyebrow">{new Date(`${today}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p><h2>Quartos</h2></div><span>{filteredRooms.length} de {rooms.length}</span></div>
						{loading ? <div className="loading-state">Carregando quartos...</div> : rooms.length === 0 ? <div className="housekeeping-empty"><strong>Nenhum quarto cadastrado</strong><p>Cadastre os quartos do hotel para iniciar o acompanhamento diário.</p><button className="button button-primary" onClick={() => setModal({ type: 'room' })}>+ Adicionar primeiro quarto</button></div> : filteredRooms.length === 0 ? <div className="housekeeping-empty"><strong>Nenhum quarto encontrado</strong><p>Ajuste a busca ou o filtro.</p></div> : <div className="room-card-grid">{filteredRooms.map((room) => {
							const plan = data.dailyPlans[today]?.[room.id] ?? { cleaningRequest: 'pendente' as DailyCleaningRequest };
							const due = dueDays(room.id);
							const lastDoorsLog = lastDoorsAndWindowsClean(room.id);
							const unavailable = room.maintenanceStatus === 'em_manutencao';
							const reservation = activeReservationForRoom(data, room.id);
							return <article className={`room-card room-cleaning-${room.cleaningStatus}`} key={room.id}>
								<header className="room-card-header"><div><span className="room-number-label">QUARTO</span><h3>{room.number}</h3></div><button className="room-edit-button" onClick={() => setModal({ type: 'room', room })}>Editar</button></header>
								<div className="room-status-badges"><span className={`room-badge badge-cleaning-${room.cleaningStatus}`}>{cleaningLabels[room.cleaningStatus]}</span><span className={`room-badge badge-occupancy-${reservation ? 'ocupado' : 'livre'}`}>{reservation ? 'Ocupado' : 'Livre'}</span><span className={`room-badge badge-maintenance-${room.maintenanceStatus}`}>{maintenanceLabels[room.maintenanceStatus]}</span></div>
								{reservation && <div className="room-stayover">
									<div className="room-guest-name">Hóspede <strong>{reservation.guestName}</strong></div>
									<small className="room-plan-status">Checkout previsto: {shortDate(reservation.checkOutDate)}</small>
									<div className="cleaning-request-row"><span>Limpeza de hoje</span><div className="choice-buttons"><button className={plan.cleaningRequest === 'solicitada' ? 'is-selected' : ''} onClick={() => updateDailyPlan(room.id, { cleaningRequest: 'solicitada' })}>Sim</button><button className={plan.cleaningRequest === 'dispensada' ? 'is-selected' : ''} onClick={() => updateDailyPlan(room.id, { cleaningRequest: 'dispensada' })}>Não</button></div></div>
									<small className="room-plan-status">{cleaningRequestLabels[plan.cleaningRequest]}</small>
								</div>}
								<div className={`doors-due ${due === null || due === 0 ? 'is-due' : ''}`}><span className="doors-due-mark" />
									<div><strong>{due === null ? 'Primeira limpeza de portas e janelas' : due === 0 ? 'Portas e janelas vencidas' : `Portas e janelas em ${due} ${due === 1 ? 'dia' : 'dias'}`}</strong><small>{lastDoorsLog ? `Última: ${shortDate(lastDoorsLog.date)}` : `Intervalo: ${data.settings.doorsAndWindowsIntervalDays} dias`}</small></div>
								</div>
								{room.note && <p className="room-note">{room.note}</p>}
								<div className="room-card-actions">
									{room.cleaningStatus === 'em_limpeza' ? <button className="button button-primary" onClick={() => setModal({ type: 'cleaning', room })} disabled={unavailable}>Concluir limpeza</button> : <button className="button button-primary" onClick={() => setCleaningStatus(room, 'em_limpeza')} disabled={unavailable}>{room.cleaningStatus === 'limpo' ? 'Iniciar nova limpeza' : 'Iniciar limpeza'}</button>}
								</div>
							</article>;
						})}</div>}

						<aside className="attendant-panel">
							<div className="room-list-heading"><div><p className="eyebrow">{shortDate(today)}</p><h2>Limpezas por camareira</h2></div><span>{todayLogs.length} registros</span></div>
							{attendantTotals.size === 0 ? <p className="attendant-empty">As limpezas concluídas hoje aparecerão aqui.</p> : <div className="attendant-table-wrap"><table className="attendant-table"><thead><tr><th>Camareira</th><th>Quartos limpos</th></tr></thead><tbody>{[...attendantTotals.entries()].sort(([a], [b]) => a.localeCompare(b, 'pt-BR')).map(([attendant, cleanedRooms]) => <tr key={attendant}><th scope="row">{attendant}</th><td>{cleanedRooms.size}</td></tr>)}</tbody></table></div>}
							{todayLogs.length > 0 && <div className="attendant-log"><strong>Últimas limpezas</strong>{todayLogs.slice().sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map((log) => <div key={log.id}><span>Quarto {log.roomNumber}</span><span>{log.attendant}{log.doorsAndWindows ? ' · portas/janelas' : ''}</span></div>)}</div>}
						</aside>
					</section>
					<div className="schedule-cloud-status" role="status"><span className="connection-dot" />{saving ? 'Salvando...' : `Salvo ${housekeepingStorageMode}`}</div>
				</div>
			</main>

			{modal?.type === 'room' && <RoomEditor key={modal.room?.id ?? 'new'} room={modal.room} onCancel={() => setModal(null)} onSave={saveRoom} />}
			{modal?.type === 'cleaning' && <CleaningEditor room={modal.room} due={dueDays(modal.room.id) === null || dueDays(modal.room.id) === 0} onCancel={() => setModal(null)} onSave={(form) => completeCleaning(modal.room, form)} />}
		</div>
	);
}

function HousekeepingNavLink({ route, label, shortLabel, active = false }: { route: string; label: string; shortLabel: string; active?: boolean }) {
	return <Link className={`nav-item ${active ? 'selected' : ''}`} to={route} title={label} aria-label={label}>
		<span className="nav-indicator" /><span className="housekeeping-nav-icon" aria-hidden="true">{shortLabel}</span><span className="housekeeping-nav-label">{label}</span>
	</Link>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
	return <article className={`housekeeping-metric metric-${tone}`}><span className="metric-rule" /><p>{label}</p><strong>{value}</strong></article>;
}

function RoomEditor({ room, onCancel, onSave }: { room?: HousekeepingRoom; onCancel: () => void; onSave: (room: HousekeepingRoom) => void }) {
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const values = new FormData(event.currentTarget);
		onSave({
			id: room?.id ?? newId(),
			number: String(values.get('number') ?? '').trim(),
			cleaningStatus: String(values.get('cleaningStatus')) as HousekeepingRoom['cleaningStatus'],
			maintenanceStatus: String(values.get('maintenanceStatus')) as RoomMaintenanceStatus,
			note: String(values.get('note') ?? '').trim(),
		});
	}

	return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
		<section className="stock-modal housekeeping-modal" role="dialog" aria-modal="true" aria-labelledby="room-editor-title">
			<form onSubmit={submit}>
				<ModalHeading eyebrow={room ? 'ATUALIZAR QUARTO' : 'CADASTRO DE QUARTO'} title={room ? `Quarto ${room.number}` : 'Adicionar quarto'} onClose={onCancel} id="room-editor-title" />
				<label className="schedule-field"><span>Número do quarto</span><input name="number" required maxLength={12} defaultValue={room?.number} placeholder="Ex.: 12" /></label>
			<label className="schedule-field"><span>Limpeza</span><select name="cleaningStatus" defaultValue={room?.cleaningStatus ?? 'sujo'}><option value="sujo">Sujo</option><option value="limpo">Limpo</option><option value="em_limpeza">Em limpeza</option></select></label>
				<label className="schedule-field"><span>Manutenção</span><select name="maintenanceStatus" defaultValue={room?.maintenanceStatus ?? 'normal'}><option value="normal">Sem manutenção</option><option value="manutencao_necessaria">Precisa manutenção, mas pode usar</option><option value="em_manutencao">Em manutenção, indisponível</option></select></label>
				<label className="schedule-field"><span>Observação</span><textarea name="note" rows={3} maxLength={300} defaultValue={room?.note} placeholder="Manutenção pendente, preferência, observação da equipe" /></label>
				<div className="schedule-modal-actions"><button className="button button-plain" type="button" onClick={onCancel}>Cancelar</button><button className="button button-primary" type="submit">Salvar quarto</button></div>
			</form>
		</section>
	</div>;
}

function CleaningEditor({ room, due, onCancel, onSave }: { room: HousekeepingRoom; due: boolean; onCancel: () => void; onSave: (form: { attendant: string; doorsAndWindows: boolean; note: string }) => void }) {
	const [attendant, setAttendant] = useState('');
	const [doorsAndWindows, setDoorsAndWindows] = useState(due);
	const [note, setNote] = useState('');

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!attendant.trim()) return;
		onSave({ attendant, doorsAndWindows, note });
	}

	return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
		<section className="stock-modal housekeeping-modal" role="dialog" aria-modal="true" aria-labelledby="cleaning-editor-title">
			<form onSubmit={submit}>
				<ModalHeading eyebrow="CONCLUSÃO DE TAREFA" title={`Limpeza do quarto ${room.number}`} onClose={onCancel} id="cleaning-editor-title" />
				<label className="schedule-field"><span>Camareira responsável</span><input list="housekeeping-attendants" required maxLength={80} value={attendant} onChange={(event) => setAttendant(event.target.value)} placeholder="Nome da camareira" /><datalist id="housekeeping-attendants">{DEFAULT_EMPLOYEES.map((name) => <option value={name} key={name} />)}</datalist></label>
				<label className={`doors-cleaning-option ${due ? 'is-due' : ''}`}><input type="checkbox" checked={doorsAndWindows} onChange={(event) => setDoorsAndWindows(event.target.checked)} /><span><strong>Limpar portas e janelas</strong><small>{due ? 'Esta limpeza está vencida ou é a primeira registrada.' : 'Tarefa periódica; o prazo é configurado no painel.'}</small></span></label>
				<label className="schedule-field"><span>Observação</span><textarea rows={3} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Opcional" /></label>
				<div className="schedule-modal-actions"><button className="button button-plain" type="button" onClick={onCancel}>Cancelar</button><button className="button button-primary" type="submit">Concluir limpeza</button></div>
			</form>
		</section>
	</div>;
}

function ModalHeading({ eyebrow, title, id, onClose }: { eyebrow: string; title: string; id: string; onClose: () => void }) {
	return <div className="schedule-modal-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div><button type="button" className="schedule-modal-close" onClick={onClose} aria-label="Fechar">×</button></div>;
}