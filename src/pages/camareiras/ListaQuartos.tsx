import { deleteHotelRoom } from '../../services/hospitalityDeletion';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { UserRole } from '../../types';
import { roomCategoriesOf, roomCategoryDescription, type DailyCleaningRequest, type HousekeepingAttendant, type RoomCategoryRecord } from '../../types/housekeeping';
import type {
	HousekeepingData,
	HousekeepingRoom,
	RoomCleaningLog,
	RoomDayPlan,
	RoomMaintenanceStatus,
} from '../../types/housekeeping';
import { useStaff } from '../../services/staffStore';
import { findStaff, staffMembers } from '../../types/staff';
import {
	emptyHousekeeping,
	housekeepingStorageMode,
  completeRoomCleaning,
  deleteRoomCleaningLog,
  saveHousekeepingRoom,
  saveRoomCategory as persistRoomCategory,
  deleteRoomCategory as persistDeleteRoomCategory,
  saveRoomDayPlan,
	subscribeHousekeeping,
  updateHousekeepingSettings,
} from '../../services/housekeepingStore';
import { guestStayOccupiesToday, reservationOccupiesToday, stayCheckOutDate } from '../../services/reservationAnalytics';
import { subscribeActiveCleaningTasks } from '../../services/cleaningStore';
import { subscribeReceptionStayDirectory, type ReceptionStayDirectoryData } from '../../services/receptionStore';
import type { CleaningTask } from '../../types/cleaning';
import './quartos.css';

type ModalState =
	| { type: 'room'; room?: HousekeepingRoom }
	| { type: 'cleaning'; room: HousekeepingRoom }
	| { type: 'categories' }
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

function todayKey(today = new Date()) {
	return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function newId() {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultBedCount(room?: HousekeepingRoom): number | '' {
	const bedCount = room?.bedCount;
	if (typeof bedCount === 'number' && Number.isInteger(bedCount) && bedCount > 0) return bedCount;
	if (room?.category === 'triplo') return 3;
	if (room?.category === 'solteiro' || room?.category === 'casal') return 1;
	return '';
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
	const [searchParams] = useSearchParams();
	const focusedRoom = searchParams.get('room')?.trim() ?? '';
	const { data: staff } = useStaff();
	const attendants = staffMembers(staff, 'housekeeping');
	const [clock, setClock] = useState(() => Date.now());
	const today = todayKey(new Date(clock));
	const isAdmin = userRole === 'admin';
	const [data, setData] = useState<HousekeepingData>(emptyHousekeeping());
	const [cleaningTasks, setCleaningTasks] = useState<Record<string, CleaningTask>>({});
	const [reception, setReception] = useState<ReceptionStayDirectoryData>({ stays: {}, rooms: {} });
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [search, setSearch] = useState('');
	const [statusFilter, setStatusFilter] = useState('todos');
	const [modal, setModal] = useState<ModalState>(null);
	const [intervalDraft, setIntervalDraft] = useState('5');
  const [logDate, setLogDate] = useState(today);

	useEffect(() => subscribeHousekeeping((next) => {
		setData(next);
		setIntervalDraft(String(next.settings.doorsAndWindowsIntervalDays));
		setLoading(false);
		setError('');
	}, (storageError) => {
		setLoading(false);
		setError(`Não foi possível carregar os quartos: ${storageError.message}`);
	}), []);
	useEffect(() => {
		const timer = window.setInterval(() => setClock(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);
	useEffect(() => {
		const onError = (cause: Error) => setError(`Não foi possível carregar a operação dos quartos: ${cause.message}`);
		const stopTasks = subscribeActiveCleaningTasks(setCleaningTasks, onError);
		const stopReception = subscribeReceptionStayDirectory(setReception, onError);
		return () => { stopTasks(); stopReception(); };
	}, []);

	const rooms = useMemo(() => Object.values(data.rooms).sort((a, b) =>
		a.number.localeCompare(b.number, 'pt-BR', { numeric: true }),
	), [data.rooms]);
	const categories = useMemo(() => roomCategoriesOf({ categories: data.categories, categoriesConfigured: data.categoriesConfigured }), [data.categories, data.categoriesConfigured]);
	function occupancyOf(room: HousekeepingRoom) {
		const reservation = Object.values(data.reservations).find((item) => item.roomId === room.id && reservationOccupiesToday(item, today, clock));
		const stay = Object.values(reception.stays).find((item) => item.roomNumber === room.number && guestStayOccupiesToday(item, today, clock));
		return { reservation, stay, guestName: reservation?.guestName ?? stay?.guestName ?? '', checkOutDate: reservation?.checkOutDate ?? (stay ? stayCheckOutDate(stay) : '') };
	}
	function taskOf(room: HousekeepingRoom) {
		return Object.values(cleaningTasks).find((task) => task.roomId === room.id || task.roomNumber === room.number);
	}
	const filteredRooms = rooms.filter((room) => {
		const currentGuest = occupancyOf(room).guestName;
		const matchesSearch = room.number.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))
			|| currentGuest.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'));
		const matchesStatus = statusFilter === 'todos'
			|| room.cleaningStatus === statusFilter
			|| (currentGuest ? 'ocupado' : 'livre') === statusFilter
			|| room.maintenanceStatus === statusFilter;
		return matchesSearch && matchesStatus && (!focusedRoom || focusedRoom === room.number);
	});
	const todayLogs = Object.values(data.cleaningLogs).map((log) => ({ ...log, attendant: findStaff(staff, log.attendant, log.employeeId)?.name ?? log.attendant })).filter((log) => log.date === logDate);
	const attendantTotals = new Map<string, Set<string>>();
	todayLogs.forEach((log) => {
		const roomsCleaned = attendantTotals.get(log.attendant) ?? new Set<string>();
		roomsCleaned.add(log.roomId);
		attendantTotals.set(log.attendant, roomsCleaned);
	});
	const occupiedRooms = rooms.filter((room) => occupancyOf(room).guestName).length;
	const dirtyRooms = rooms.filter((room) => room.cleaningStatus === 'sujo').length;
	const cleaningRooms = rooms.filter((room) => room.cleaningStatus === 'em_limpeza').length;
	const maintenanceRooms = rooms.filter((room) => room.maintenanceStatus !== 'normal').length;

	async function changeData(
		action: () => Promise<void>,
		successMessage = '',
	): Promise<boolean> {
		setSaving(true);
		setError('');
		setNotice('');
		try {
			await action();
			if (successMessage) setNotice(successMessage);
			return true;
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : 'Não foi possível salvar a operação.');
			return false;
		} finally {
			setSaving(false);
		}
	}

	async function saveCategory(category: RoomCategoryRecord) {
		if (await changeData(() => persistRoomCategory(category, categories), 'Categoria de quarto salva.')) setModal(null);
	}

	async function removeCategory(categoryId: string) {
		if (await changeData(() => persistDeleteRoomCategory(categoryId, categories), 'Categoria removida.')) setModal(null);
	}


	async function removeRoom(room: HousekeepingRoom) {
    if (!window.confirm(`Excluir o quarto ${room.number}? Reservas, hospedagens, adicionais, escala de limpeza e pagamentos associados também serão removidos.`)) return;
    setSaving(true); setError('');
    try { await deleteHotelRoom(room); setNotice('Quarto e registros associados excluídos.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível excluir.'); }
    finally { setSaving(false); }
  }

  function removeCleaningLog(log: RoomCleaningLog) {
    if (!window.confirm(`Excluir o registro de limpeza do quarto ${log.roomNumber}?`)) return;
    void changeData(() => deleteRoomCleaningLog(log), 'Registro excluído; indicadores de limpeza atualizados.');
  }

	async function saveRoom(room: HousekeepingRoom) {
		if (await changeData(() => saveHousekeepingRoom(room), 'Quarto salvo.')) setModal(null);
	}

	function updateDailyPlan(roomId: string, plan: Partial<RoomDayPlan>) {
		void changeData(() => saveRoomDayPlan(roomId, today, plan), 'Informação diária atualizada.');
	}

	async function completeCleaning(room: HousekeepingRoom, form: { attendant: string; doorsAndWindows: boolean; note: string }) {
		const log: RoomCleaningLog = {
			id: newId(),
			roomId: room.id,
			roomNumber: room.number,
			attendant: form.attendant.trim(),
			...(findStaff(staff, form.attendant) ? { employeeId: findStaff(staff, form.attendant)!.id } : {}),
			date: today,
			completedAt: new Date().toISOString(),
			doorsAndWindows: form.doorsAndWindows,
			note: form.note.trim(),
		};
		if (await changeData(() => completeRoomCleaning(room.id, log), `Limpeza do quarto ${room.number} registrada.`)) setModal(null);
	}

	function saveInterval(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const interval = Number(intervalDraft);
		if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
			setError('Defina um intervalo entre 1 e 365 dias.');
			return;
		}
		void changeData(() => updateHousekeepingSettings({ doorsAndWindowsIntervalDays: interval }), 'Prazo de portas e janelas atualizado.');
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
					<div className="breadcrumb"><Link to="/">Painel</Link><span>/</span><strong>{isAdmin ? 'Gerenciar quartos' : 'Serviço de quarto'}</strong></div>
					<div className="topbar-actions"><span className="user-chip">{isAdmin ? 'Gerência' : 'Equipe'}</span><Link className="back-link" to="/">Voltar ao painel</Link></div>
				</header>

				<div className="stock-content housekeeping-content">
					<section className="page-heading">
					<div><p className="eyebrow">{isAdmin ? 'CADASTRO E OPERAÇÃO' : 'OPERAÇÃO DE CAMAREIRAS'}</p><h1>{isAdmin ? 'Gerenciar quartos' : 'Serviço de quarto'}</h1><p className="page-description">{isAdmin ? 'Configure categorias e camas e acompanhe ocupação, limpeza e manutenção.' : 'Ocupação, limpeza e manutenção de cada quarto.'}</p></div>
						{isAdmin && <div className="heading-actions"><Link className="button button-plain" to="/funcionarios">Funcionários</Link><button className="button button-plain" onClick={() => setModal({ type: 'categories' })}>Categorias de quartos</button><button className="button button-primary" onClick={() => setModal({ type: 'room' })}>+ Adicionar quarto</button></div>}
					</section>

					{error && <div className="notice notice-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
					{notice && <div className="notice notice-success" role="status">{notice}</div>}
					{focusedRoom && <section className="housekeeping-context"><strong>Quarto {focusedRoom}</strong><nav><Link to={`/limpeza?room=${encodeURIComponent(focusedRoom)}`}>Limpeza por camareiras</Link><Link to={`/reservas?room=${encodeURIComponent(focusedRoom)}`}>Reservas e hospedagens</Link><Link to="/quartos">Todos os quartos</Link></nav></section>}
					{isAdmin && !focusedRoom && <nav className="housekeeping-module-links"><Link to="/limpeza">Limpeza por camareiras</Link><Link to="/reservas">Reservas e hospedagens</Link></nav>}

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
						<div className="room-list-heading"><div><p className="eyebrow">{new Date(`${today}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p><h2>{isAdmin ? 'Quartos cadastrados' : 'Quartos'}</h2></div><span>{filteredRooms.length} de {rooms.length}</span></div>
						{loading ? <div className="loading-state">Carregando quartos...</div> : rooms.length === 0 ? <div className="housekeeping-empty"><strong>Nenhum quarto cadastrado</strong><p>Cadastre os quartos do hotel para iniciar o acompanhamento diário.</p>{isAdmin && <button className="button button-primary" onClick={() => setModal({ type: 'room' })}>+ Adicionar primeiro quarto</button>}</div> : filteredRooms.length === 0 ? <div className="housekeeping-empty"><strong>Nenhum quarto encontrado</strong><p>Ajuste a busca ou o filtro.</p></div> : <div className="room-card-grid">{filteredRooms.map((room) => {
							const plan = data.dailyPlans[today]?.[room.id] ?? { cleaningRequest: 'pendente' as DailyCleaningRequest };
							const due = dueDays(room.id);
							const lastDoorsLog = lastDoorsAndWindowsClean(room.id);
							const unavailable = room.maintenanceStatus === 'em_manutencao';
							const occupancy = occupancyOf(room);
							const task = taskOf(room);
							return <article className={`room-card room-cleaning-${room.cleaningStatus}`} key={room.id}>
								<header className="room-card-header"><div><span className="room-number-label">QUARTO</span><h3>{room.number}</h3>{room.category && <small className="room-number-label">{roomCategoryDescription(room)}</small>}<small className={`room-bed-count${defaultBedCount(room) === '' ? ' is-missing' : ''}`}>{defaultBedCount(room) === '' ? 'Camas não informadas' : `${defaultBedCount(room)} ${defaultBedCount(room) === 1 ? 'cama' : 'camas'}`}</small></div>{isAdmin && <div><button className="room-edit-button" onClick={() => setModal({ type: 'room', room })}>Editar quarto</button><button className="room-edit-button" disabled={saving} onClick={() => void removeRoom(room)}>Excluir</button></div>}</header>
								<div className="room-status-badges"><span className={`room-badge badge-cleaning-${room.cleaningStatus}`}>{cleaningLabels[room.cleaningStatus]}</span><span className={`room-badge badge-occupancy-${occupancy.guestName ? 'ocupado' : 'livre'}`}>{occupancy.guestName ? 'Ocupado' : 'Livre'}</span><span className={`room-badge badge-maintenance-${room.maintenanceStatus}`}>{maintenanceLabels[room.maintenanceStatus]}</span></div>
								{task && <p className="room-assignment">Camareira responsável: <strong>{findStaff(staff, task.camareira, task.employeeId)?.name ?? task.camareira}</strong><Link to={`/limpeza?room=${encodeURIComponent(room.number)}`}>Acompanhar limpeza</Link></p>}
								{occupancy.guestName && <div className="room-stayover">
									<div className="room-guest-name">Hóspede <strong>{occupancy.guestName}</strong></div>
									<small className="room-plan-status">Checkout previsto: {shortDate(occupancy.checkOutDate)}</small>
									{isAdmin && <Link className="room-reservation-link" to={`/reservas?room=${encodeURIComponent(room.number)}${occupancy.reservation ? `&reservation=${encodeURIComponent(occupancy.reservation.id)}` : ''}`}>Ver reserva e hospedagem</Link>}
									<div className="cleaning-request-row"><span>Limpeza de hoje</span>{isAdmin && <div className="choice-buttons"><button className={plan.cleaningRequest === 'solicitada' ? 'is-selected' : ''} onClick={() => updateDailyPlan(room.id, { cleaningRequest: 'solicitada' })}>Sim</button><button className={plan.cleaningRequest === 'dispensada' ? 'is-selected' : ''} onClick={() => updateDailyPlan(room.id, { cleaningRequest: 'dispensada' })}>Não</button></div>}</div>
									<small className="room-plan-status">{cleaningRequestLabels[plan.cleaningRequest]}</small>
								</div>}
								<div className={`doors-due ${due === null || due === 0 ? 'is-due' : ''}`}><span className="doors-due-mark" />
									<div><strong>{due === null ? 'Primeira limpeza de portas e janelas' : due === 0 ? 'Portas e janelas vencidas' : `Portas e janelas em ${due} ${due === 1 ? 'dia' : 'dias'}`}</strong><small>{lastDoorsLog ? `Última: ${shortDate(lastDoorsLog.date)}` : `Intervalo: ${data.settings.doorsAndWindowsIntervalDays} dias`}</small></div>
								</div>
								{room.note && <p className="room-note">{room.note}</p>}
								{isAdmin && <div className="room-card-actions">
									{room.cleaningStatus === 'em_limpeza' ? <><button className="button button-primary" onClick={() => setModal({ type: 'cleaning', room })} disabled={unavailable || saving}>Concluir limpeza</button><Link className="button button-plain" to={`/limpeza?room=${encodeURIComponent(room.number)}`}>{task ? 'Ver tarefa da camareira' : 'Designar camareira'}</Link></> : unavailable ? <span className="room-plan-status">Libere o quarto antes de designar a limpeza.</span> : <Link className="button button-primary" to={`/limpeza?room=${encodeURIComponent(room.number)}`}>{room.cleaningStatus === 'limpo' ? 'Designar nova limpeza' : 'Designar limpeza'}</Link>}
								</div>}
							</article>;
						})}</div>}

						<aside className="attendant-panel">
							<div className="room-list-heading"><div><label className="eyebrow">Dia<input type="date" value={logDate} onChange={(event) => setLogDate(event.target.value || today)} /></label><h2>Limpezas por camareira</h2><Link to={focusedRoom ? `/limpeza?room=${encodeURIComponent(focusedRoom)}` : '/limpeza'}>Acompanhar designações</Link></div><span>{todayLogs.length} registros</span></div>
							{attendantTotals.size === 0 ? <p className="attendant-empty">Nenhuma limpeza registrada neste dia.</p> : <div className="attendant-table-wrap"><table className="attendant-table"><thead><tr><th>Camareira</th><th>Quartos limpos</th></tr></thead><tbody>{[...attendantTotals.entries()].sort(([a], [b]) => a.localeCompare(b, 'pt-BR')).map(([attendant, cleanedRooms]) => <tr key={attendant}><th scope="row">{attendant}</th><td>{cleanedRooms.size}</td></tr>)}</tbody></table></div>}
							{todayLogs.length > 0 && <div className="attendant-log"><strong>Últimas limpezas</strong>{todayLogs.slice().sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map((log) => <div key={log.id}><span>Quarto {log.roomNumber}</span><span>{log.attendant}{log.doorsAndWindows ? ' · portas/janelas' : ''}</span>{isAdmin && <button disabled={saving} onClick={() => removeCleaningLog(log)}>Excluir</button>}</div>)}</div>}
						</aside>
					</section>
					<div className="schedule-cloud-status" role="status"><span className="connection-dot" />{saving ? 'Salvando...' : `Salvo ${housekeepingStorageMode}`}</div>
				</div>
			</main>

			{isAdmin && modal?.type === 'room' && <RoomEditor key={modal.room?.id ?? 'new'} room={modal.room} categories={categories} onCancel={() => setModal(null)} onSave={saveRoom} />}

			{isAdmin && modal?.type === 'categories' && <RoomCategoriesEditor categories={categories} rooms={rooms} saving={saving} error={error} onCancel={() => setModal(null)} onSave={saveCategory} onDelete={removeCategory} />}

			{isAdmin && modal?.type === 'cleaning' && <CleaningEditor key={modal.room.id} room={modal.room} attendants={attendants} assignedTask={taskOf(modal.room)} due={dueDays(modal.room.id) === null || dueDays(modal.room.id) === 0} onCancel={() => setModal(null)} onSave={(form) => completeCleaning(modal.room, form)} />}
		</div>
	);
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
	return <article className={`housekeeping-metric metric-${tone}`}><span className="metric-rule" /><p>{label}</p><strong>{value}</strong></article>;
}


function RoomEditor({ room, categories, onCancel, onSave }: { room?: HousekeepingRoom; categories: RoomCategoryRecord[]; onCancel: () => void; onSave: (room: HousekeepingRoom) => void }) {
	const [categoryId, setCategoryId] = useState(room?.category ?? '');
	const selectedCategory = categories.find((category) => category.id === categoryId);

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const values = new FormData(event.currentTarget);
		if (!selectedCategory) return;
		onSave({
			id: room?.id ?? newId(),
			number: String(values.get('number') ?? '').trim(),
			category: selectedCategory.id,
			categoryName: selectedCategory.name,
			bedComposition: selectedCategory.bedComposition,
			bedCount: selectedCategory.bedCount,
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
				<label className="schedule-field"><span>Categoria e configuração das camas</span><select name="category" required value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="" disabled>Selecione uma categoria</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name} · {category.bedComposition}</option>)}</select></label>
				{selectedCategory && <div className="room-category-preview"><strong>{selectedCategory.name}</strong><span>{selectedCategory.bedComposition}</span><small>{selectedCategory.bedCount} {selectedCategory.bedCount === 1 ? 'cama' : 'camas'} cadastradas nesta configuração</small></div>}
			<label className="schedule-field"><span>Limpeza</span><select name="cleaningStatus" defaultValue={room?.cleaningStatus ?? 'sujo'}><option value="sujo">Sujo</option><option value="limpo">Limpo</option><option value="em_limpeza">Em limpeza</option></select></label>
				<label className="schedule-field"><span>Manutenção</span><select name="maintenanceStatus" defaultValue={room?.maintenanceStatus ?? 'normal'}><option value="normal">Sem manutenção</option><option value="manutencao_necessaria">Precisa manutenção, mas pode usar</option><option value="em_manutencao">Em manutenção, indisponível</option></select></label>
				<label className="schedule-field"><span>Observação</span><textarea name="note" rows={3} maxLength={300} defaultValue={room?.note} placeholder="Manutenção pendente, preferência, observação da equipe" /></label>
				<div className="schedule-modal-actions"><button className="button button-plain" type="button" onClick={onCancel}>Cancelar</button><button className="button button-primary" type="submit">Salvar quarto</button></div>
			</form>
		</section>
	</div>;
}

function RoomCategoriesEditor({ categories, rooms, saving, error, onCancel, onSave, onDelete }: { categories: RoomCategoryRecord[]; rooms: HousekeepingRoom[]; saving: boolean; error: string; onCancel: () => void; onSave: (category: RoomCategoryRecord) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [bedComposition, setBedComposition] = useState('');
	const [bedCount, setBedCount] = useState('1');
	const editing = categories.find((category) => category.id === editingId);

	function startEdit(category: RoomCategoryRecord) {
		setEditingId(category.id);
		setName(category.name);
		setBedComposition(category.bedComposition);
		setBedCount(String(category.bedCount));
	}

	function resetForm() {
		setEditingId(null);
		setName('');
		setBedComposition('');
		setBedCount('1');
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const nextCategory: RoomCategoryRecord = {
			id: editing?.id ?? `categoria-${newId()}`,
			name: name.trim(),
			bedComposition: bedComposition.trim(),
			bedCount: Number(bedCount),
		};
		await onSave(nextCategory);
	}

	return <div className="modal-backdrop room-categories-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
		<section className="stock-modal housekeeping-modal room-categories-modal" role="dialog" aria-modal="true" aria-labelledby="room-categories-title">
			<header className="schedule-modal-header"><div><p className="schedule-eyebrow">CONFIGURAÇÃO DO HOTEL</p><h2 id="room-categories-title">Categorias de quartos</h2><p>Defina as combinações de camas e associe cada quarto a uma configuração.</p></div><button type="button" onClick={onCancel} aria-label="Fechar">×</button></header>
			{error && <div className="room-category-error" role="alert">{error}</div>}
			<form className="room-category-form" onSubmit={submit}>
				<label className="schedule-field"><span>Nome da categoria</span><input required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Triplo" /></label>
				<label className="schedule-field"><span>Composição das camas</span><input required maxLength={120} value={bedComposition} onChange={(event) => setBedComposition(event.target.value)} placeholder="Ex.: 1 cama de casal e 1 de solteiro" /></label>
				<label className="schedule-field"><span>Quantidade de camas</span><input required type="number" min="1" max="10" value={bedCount} onChange={(event) => setBedCount(event.target.value)} /></label>
				<div className="room-category-form-actions"><button className="button button-plain" type="button" onClick={resetForm}>{editing ? 'Cancelar edição' : 'Limpar'}</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : editing ? 'Salvar categoria' : 'Adicionar categoria'}</button></div>
			</form>
			<div className="room-category-list"><h3>Configurações cadastradas <span>{categories.length}</span></h3>
				{categories.map((category) => {
					const usedBy = rooms.filter((room) => room.category === category.id).length;
					return <article className="room-category-item" key={category.id}><div><strong>{category.name}</strong><span>{category.bedComposition}</span><small>{category.bedCount} {category.bedCount === 1 ? 'cama' : 'camas'} · {usedBy} {usedBy === 1 ? 'quarto vinculado' : 'quartos vinculados'}</small></div><div><button className="room-edit-button" type="button" onClick={() => startEdit(category)}>Editar</button><button className="room-edit-button room-category-delete" type="button" disabled={saving || usedBy > 0} title={usedBy > 0 ? 'Desvincule esta categoria dos quartos antes de removê-la.' : undefined} onClick={() => void onDelete(category.id)}>Excluir</button></div></article>;
				})}
			</div>
		</section>
	</div>;
}

function CleaningEditor({ room, attendants, assignedTask, due, onCancel, onSave }: { room: HousekeepingRoom; attendants: HousekeepingAttendant[]; assignedTask?: CleaningTask; due: boolean; onCancel: () => void; onSave: (form: { attendant: string; doorsAndWindows: boolean; note: string }) => void }) {
	const [attendant, setAttendant] = useState(() => attendants.find((item) => item.id === assignedTask?.employeeId || item.name === assignedTask?.camareira)?.name ?? '');
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

function ModalHeading({ eyebrow, title, onClose, id }: { eyebrow: string; title: string; onClose: () => void; id: string }) {
  return <header className="schedule-modal-header"><div><p className="schedule-eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div><button type="button" onClick={onClose} aria-label="Fechar">×</button></header>;
}
