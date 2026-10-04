import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { UserRole } from '../../types';
import { roomCategoryLabels, type DailyCleaningRequest, type HousekeepingAttendant, type RoomCategory } from '../../types/housekeeping';
import type {
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
	| { type: 'attendants' }
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

const attendantsOf = (data: HousekeepingData): HousekeepingAttendant[] => (data.attendantsConfigured
	? Object.values(data.attendants ?? {})
	: DEFAULT_EMPLOYEES.map((name) => ({ id: `default-${name}`, name })))
	.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

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

	function changeAttendants(mutate: (list: HousekeepingAttendant[]) => HousekeepingAttendant[], message: string) {
		void changeData((current) => {
			const next = mutate(attendantsOf(current));
			const names = next.map((item) => item.name.trim().toLocaleLowerCase('pt-BR'));
			if (next.some((item) => !item.name.trim())) throw new Error('Informe o nome da camareira.');
			if (new Set(names).size !== names.length) throw new Error('Já existe uma camareira com este nome.');
			return { ...current, attendantsConfigured: true, attendants: Object.fromEntries(next.map((item) => [item.id, { id: item.id, name: item.name.trim() }])) };
		}, message);
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
		<div className={`stock-app housekeeping-app`}>

			<main className="stock-main">
				<header className="stock-topbar">
					<div className="breadcrumb"><Link to="/">Painel</Link><span>/</span><strong>Serviço de quarto</strong></div>
					<div className="topbar-actions"><span className="user-chip">{isAdmin ? 'Gerência' : 'Equipe'}</span><Link className="back-link" to="/">Voltar ao painel</Link></div>
				</header>

				<div className="stock-content housekeeping-content">
					<section className="page-heading">
						<div><p className="eyebrow">OPERAÇÃO DE CAMAREIRAS</p><h1>Serviço de quarto</h1><p className="page-description">Ocupação, limpeza e manutenção de cada quarto.</p></div>
						{isAdmin && <div className="heading-actions"><button className="button button-plain" onClick={() => setModal({ type: 'attendants' })}>Camareiras</button><button className="button button-primary" onClick={() => setModal({ type: 'room' })}>+ Adicionar quarto</button></div>}
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
						{isAdmin && <form className="doors-interval-control" onSubmit={saveInterval}>
							<label className="schedule-field"><span>Portas e janelas, a cada</span><span className="interval-input-wrap"><input type="number" min="1" max="365" value={intervalDraft} onChange={(event) => setIntervalDraft(event.target.value)} /><span>dias</span></span></label>
							<button className="button button-soft" type="submit" disabled={saving}>Salvar prazo</button>
						</form>}
					</section>

					<section className="housekeeping-workspace" aria-label="Quartos e produtividade diária">
						<div className="room-list-heading"><div><p className="eyebrow">{new Date(`${today}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p><h2>Quartos</h2></div><span>{filteredRooms.length} de {rooms.length}</span></div>
						{loading ? <div className="loading-state">Carregando quartos...</div> : rooms.length === 0 ? <div className="housekeeping-empty"><strong>Nenhum quarto cadastrado</strong><p>Cadastre os quartos do hotel para iniciar o acompanhamento diário.</p>{isAdmin && <button className="button button-primary" onClick={() => setModal({ type: 'room' })}>+ Adicionar primeiro quarto</button>}</div> : filteredRooms.length === 0 ? <div className="housekeeping-empty"><strong>Nenhum quarto encontrado</strong><p>Ajuste a busca ou o filtro.</p></div> : <div className="room-card-grid">{filteredRooms.map((room) => {
							const plan = data.dailyPlans[today]?.[room.id] ?? { cleaningRequest: 'pendente' as DailyCleaningRequest };
							const due = dueDays(room.id);
							const lastDoorsLog = lastDoorsAndWindowsClean(room.id);
							const unavailable = room.maintenanceStatus === 'em_manutencao';
							const reservation = activeReservationForRoom(data, room.id);
							return <article className={`room-card room-cleaning-${room.cleaningStatus}`} key={room.id}>
								<header className="room-card-header"><div><span className="room-number-label">QUARTO</span><h3>{room.number}</h3>{room.category && <small className="room-number-label">{roomCategoryLabels[room.category]}</small>}</div>{isAdmin && <button className="room-edit-button" onClick={() => setModal({ type: 'room', room })}>Editar</button>}</header>
								<div className="room-status-badges"><span className={`room-badge badge-cleaning-${room.cleaningStatus}`}>{cleaningLabels[room.cleaningStatus]}</span><span className={`room-badge badge-occupancy-${reservation ? 'ocupado' : 'livre'}`}>{reservation ? 'Ocupado' : 'Livre'}</span><span className={`room-badge badge-maintenance-${room.maintenanceStatus}`}>{maintenanceLabels[room.maintenanceStatus]}</span></div>
								{reservation && <div className="room-stayover">
									<div className="room-guest-name">Hóspede <strong>{reservation.guestName}</strong></div>
									<small className="room-plan-status">Checkout previsto: {shortDate(reservation.checkOutDate)}</small>
									<div className="cleaning-request-row"><span>Limpeza de hoje</span>{isAdmin && <div className="choice-buttons"><button className={plan.cleaningRequest === 'solicitada' ? 'is-selected' : ''} onClick={() => updateDailyPlan(room.id, { cleaningRequest: 'solicitada' })}>Sim</button><button className={plan.cleaningRequest === 'dispensada' ? 'is-selected' : ''} onClick={() => updateDailyPlan(room.id, { cleaningRequest: 'dispensada' })}>Não</button></div>}</div>
									<small className="room-plan-status">{cleaningRequestLabels[plan.cleaningRequest]}</small>
								</div>}
								<div className={`doors-due ${due === null || due === 0 ? 'is-due' : ''}`}><span className="doors-due-mark" />
									<div><strong>{due === null ? 'Primeira limpeza de portas e janelas' : due === 0 ? 'Portas e janelas vencidas' : `Portas e janelas em ${due} ${due === 1 ? 'dia' : 'dias'}`}</strong><small>{lastDoorsLog ? `Última: ${shortDate(lastDoorsLog.date)}` : `Intervalo: ${data.settings.doorsAndWindowsIntervalDays} dias`}</small></div>
								</div>
								{room.note && <p className="room-note">{room.note}</p>}
								{isAdmin && <div className="room-card-actions">
									{room.cleaningStatus === 'em_limpeza' ? <button className="button button-primary" onClick={() => setModal({ type: 'cleaning', room })} disabled={unavailable}>Concluir limpeza</button> : <button className="button button-primary" onClick={() => setCleaningStatus(room, 'em_limpeza')} disabled={unavailable}>{room.cleaningStatus === 'limpo' ? 'Iniciar nova limpeza' : 'Iniciar limpeza'}</button>}
								</div>}
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

			{isAdmin && modal?.type === 'room' && <RoomEditor key={modal.room?.id ?? 'new'} room={modal.room} onCancel={() => setModal(null)} onSave={saveRoom} />}
			{isAdmin && modal?.type === 'attendants' && <AttendantsManager attendants={attendantsOf(data)} saving={saving} error={error} onClose={() => setModal(null)} onAdd={(name) => changeAttendants((list) => [...list, { id: newId(), name }], 'Camareira adicionada.')} onRename={(id, name) => changeAttendants((list) => list.map((item) => item.id === id ? { ...item, name } : item), 'Camareira atualizada.')} onRemove={(id) => changeAttendants((list) => list.filter((item) => item.id !== id), 'Camareira removida.')} />}
			{isAdmin && modal?.type === 'cleaning' && <CleaningEditor room={modal.room} attendants={attendantsOf(data)} due={dueDays(modal.room.id) === null || dueDays(modal.room.id) === 0} onCancel={() => setModal(null)} onSave={(form) => completeCleaning(modal.room, form)} />}
		</div>
	);
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
			category: String(values.get('category')) as RoomCategory,
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
				<label className="schedule-field"><span>Categoria</span><select name="category" required defaultValue={room?.category ?? ''}><option value="" disabled>Selecione</option>{(Object.entries(roomCategoryLabels) as [RoomCategory, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
			<label className="schedule-field"><span>Limpeza</span><select name="cleaningStatus" defaultValue={room?.cleaningStatus ?? 'sujo'}><option value="sujo">Sujo</option><option value="limpo">Limpo</option><option value="em_limpeza">Em limpeza</option></select></label>
				<label className="schedule-field"><span>Manutenção</span><select name="maintenanceStatus" defaultValue={room?.maintenanceStatus ?? 'normal'}><option value="normal">Sem manutenção</option><option value="manutencao_necessaria">Precisa manutenção, mas pode usar</option><option value="em_manutencao">Em manutenção, indisponível</option></select></label>
				<label className="schedule-field"><span>Observação</span><textarea name="note" rows={3} maxLength={300} defaultValue={room?.note} placeholder="Manutenção pendente, preferência, observação da equipe" /></label>
				<div className="schedule-modal-actions"><button className="button button-plain" type="button" onClick={onCancel}>Cancelar</button><button className="button button-primary" type="submit">Salvar quarto</button></div>
			</form>
		</section>
	</div>;
}

function CleaningEditor({ room, attendants, due, onCancel, onSave }: { room: HousekeepingRoom; attendants: HousekeepingAttendant[]; due: boolean; onCancel: () => void; onSave: (form: { attendant: string; doorsAndWindows: boolean; note: string }) => void }) {
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
				<label className="schedule-field"><span>Camareira responsável</span><select required value={attendant} onChange={(event) => setAttendant(event.target.value)}><option value="" disabled>Selecione a camareira</option>{attendants.map((item) => <option value={item.name} key={item.id}>{item.name}</option>)}</select></label>
				<label className={`doors-cleaning-option ${due ? 'is-due' : ''}`}><input type="checkbox" checked={doorsAndWindows} onChange={(event) => setDoorsAndWindows(event.target.checked)} /><span><strong>Limpar portas e janelas</strong><small>{due ? 'Esta limpeza está vencida ou é a primeira registrada.' : 'Tarefa periódica; o prazo é configurado no painel.'}</small></span></label>
				<label className="schedule-field"><span>Observação</span><textarea rows={3} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Opcional" /></label>
				<div className="schedule-modal-actions"><button className="button button-plain" type="button" onClick={onCancel}>Cancelar</button><button className="button button-primary" type="submit">Concluir limpeza</button></div>
			</form>
		</section>
	</div>;
}

function AttendantsManager({ attendants, saving, error, onClose, onAdd, onRename, onRemove }: { attendants: HousekeepingAttendant[]; saving: boolean; error: string; onClose: () => void; onAdd: (name: string) => void; onRename: (id: string, name: string) => void; onRemove: (id: string) => void }) {
	const [newName, setNewName] = useState('');
	const [editingId, setEditingId] = useState('');
	const [draft, setDraft] = useState('');

	return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
		<section className="stock-modal housekeeping-modal" role="dialog" aria-modal="true" aria-labelledby="attendants-title">
			<ModalHeading eyebrow="EQUIPE DE LIMPEZA" title="Camareiras" onClose={onClose} id="attendants-title" />
			<form className="attendant-add-form" onSubmit={(event) => { event.preventDefault(); if (!newName.trim()) return; onAdd(newName); setNewName(''); }}>
				<label className="schedule-field"><span>Nova camareira</span><input value={newName} maxLength={80} onChange={(event) => setNewName(event.target.value)} placeholder="Nome" /></label>
				<button className="button button-primary" type="submit" disabled={saving || !newName.trim()}>Adicionar</button>
			</form>
			{error && <p className="reservation-modal-error" role="alert">{error}</p>}
			{attendants.length === 0 ? <p className="attendant-empty">Nenhuma camareira cadastrada.</p> : <ul className="attendant-manage-list">{attendants.map((item) => <li key={item.id}>
				{editingId === item.id
					? <><input value={draft} maxLength={80} autoFocus aria-label={`Nome de ${item.name}`} onChange={(event) => setDraft(event.target.value)} /><button className="button button-primary" type="button" disabled={saving || !draft.trim()} onClick={() => { onRename(item.id, draft); setEditingId(''); }}>Salvar</button><button className="button button-plain" type="button" onClick={() => setEditingId('')}>Cancelar</button></>
					: <><span>{item.name}</span><button className="button button-plain" type="button" disabled={saving} onClick={() => { setEditingId(item.id); setDraft(item.name); }}>Editar</button><button className="button button-plain" type="button" disabled={saving} onClick={() => { if (window.confirm(`Remover ${item.name}? O histórico de limpezas é mantido.`)) onRemove(item.id); }}>Remover</button></>}
			</li>)}</ul>}
			<div className="schedule-modal-actions"><button className="button button-plain" type="button" onClick={onClose}>Fechar</button></div>
		</section>
	</div>;
}

function ModalHeading({ eyebrow, title, id, onClose }: { eyebrow: string; title: string; id: string; onClose: () => void }) {
	return <div className="schedule-modal-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div><button type="button" className="schedule-modal-close" onClick={onClose} aria-label="Fechar">×</button></div>;
}