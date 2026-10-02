import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { UserRole } from '../../types';
import type { HousekeepingData, HousekeepingRoom, Reservation, ReservationStatus } from '../../types/housekeeping';
import { emptyHousekeeping, housekeepingStorageMode, subscribeHousekeeping, updateHousekeeping } from '../../services/housekeepingStore';
import { dateKeyAfterDays, hotelOccupancySummary, reservationOverlaps } from '../../services/reservationAnalytics';
import '../camareiras/quartos.css';
import './reservas.css';

type ReservationFilter = 'proximas' | 'chegadas' | 'hospedados' | 'todas';

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const formatDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR');
const guestCount = (reservation: Reservation) => reservation.adults + reservation.children;
const statusLabels: Record<ReservationStatus, string> = {
	confirmada: 'Confirmada', hospedado: 'Hospedado', encerrada: 'Encerrada', cancelada: 'Cancelada',
};

function createId() {
	return crypto.randomUUID();
}

export function MapaReservas({ userRole }: { userRole: UserRole }) {
	const today = dateKey(new Date());
	const tomorrow = dateKeyAfterDays(1);
	const isAdmin = userRole === 'admin';
	const [data, setData] = useState<HousekeepingData>(emptyHousekeeping());
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [filter, setFilter] = useState<ReservationFilter>('proximas');
	const [search, setSearch] = useState('');
	const [editingId, setEditingId] = useState('');
	const [modalOpen, setModalOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

	useEffect(() => subscribeHousekeeping((next) => {
		setData(next);
		setLoading(false);
		setError('');
	}, (cause) => {
		setLoading(false);
		setError(`Não foi possível carregar as reservas: ${cause.message}`);
	}), []);

	const rooms = useMemo(() => Object.values(data.rooms).sort((a, b) => a.number.localeCompare(b.number, 'pt-BR', { numeric: true })), [data.rooms]);
	const reservations = useMemo(() => Object.values(data.reservations).sort((a, b) => a.checkInDate.localeCompare(b.checkInDate) || a.guestName.localeCompare(b.guestName, 'pt-BR')), [data.reservations]);
	const occupancy = hotelOccupancySummary(data);
	const visibleReservations = reservations.filter((reservation) => {
		const term = search.trim().toLocaleLowerCase('pt-BR');
		const matchesSearch = !term || reservation.guestName.toLocaleLowerCase('pt-BR').includes(term)
			|| reservation.roomNumber.toLocaleLowerCase('pt-BR').includes(term)
			|| reservation.phone.toLocaleLowerCase('pt-BR').includes(term);
		const matchesFilter = filter === 'todas'
			|| (filter === 'hospedados' && reservation.status === 'hospedado')
			|| (filter === 'chegadas' && reservation.status === 'confirmada' && (reservation.checkInDate === today || reservation.checkInDate === tomorrow))
			|| (filter === 'proximas' && ['confirmada', 'hospedado'].includes(reservation.status));
		return matchesSearch && matchesFilter;
	});
	const selected = data.reservations[editingId];

	async function persist(update: (current: HousekeepingData) => HousekeepingData, message: string): Promise<boolean> {
		setSaving(true);
		setError('');
		setNotice('');
		try {
			await updateHousekeeping(update);
			setNotice(message);
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a reserva.');
			return false;
		} finally {
			setSaving(false);
		}
	}

	async function saveReservation(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const roomId = String(form.get('roomId') ?? '');
		const room = data.rooms[roomId];
		const checkInDate = String(form.get('checkInDate') ?? '');
		const checkOutDate = String(form.get('checkOutDate') ?? '');
		const adults = Number(form.get('adults'));
		const children = Number(form.get('children'));
		const guestName = String(form.get('guestName') ?? '').trim();
		if (!room || !guestName || !checkInDate || !checkOutDate || checkOutDate <= checkInDate || !Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0) {
			setError('Confira o hóspede, quarto, período e quantidade de pessoas. O checkout deve ser após o check-in.');
			return;
		}
		const reservation: Reservation = {
			id: selected?.id ?? createId(),
			guestName,
			phone: String(form.get('phone') ?? '').trim(),
			roomId,
			roomNumber: room.number,
			checkInDate,
			checkOutDate,
			adults,
			children,
			status: selected?.status ?? 'confirmada',
			note: String(form.get('note') ?? '').trim(),
			createdAt: selected?.createdAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		const success = await persist((current) => {
			const currentRoom = current.rooms[roomId];
			if (!currentRoom) throw new Error('O quarto selecionado não existe mais.');
			if (currentRoom.maintenanceStatus === 'em_manutencao') throw new Error('Este quarto está indisponível para manutenção.');
			if (reservationOverlaps(current, reservation)) throw new Error(`O quarto ${currentRoom.number} já tem uma reserva ativa nesse período.`);
			if (selected?.status === 'hospedado') throw new Error('A hospedagem já iniciou. Edite a reserva antes do check-in ou faça o checkout.');
			return { ...current, reservations: { ...current.reservations, [reservation.id]: reservation } };
		}, selected ? 'Reserva atualizada.' : 'Reserva criada.');
		if (success) setModalOpen(false);
	}

	async function checkIn(reservation: Reservation) {
		if (reservation.checkInDate > today) {
			setError(`O check-in está previsto para ${formatDate(reservation.checkInDate)}.`);
			return;
		}
		const success = await persist((current) => {
			const room = current.rooms[reservation.roomId];
			const currentReservation = current.reservations[reservation.id];
			if (!room || !currentReservation || currentReservation.status !== 'confirmada') throw new Error('A reserva não está mais disponível para check-in.');
			if (room.cleaningStatus !== 'limpo') throw new Error(`O quarto ${room.number} ainda não está limpo.`);
			if (room.maintenanceStatus === 'em_manutencao') throw new Error(`O quarto ${room.number} está em manutenção e não pode receber hóspedes.`);
			if (reservationOverlaps(current, currentReservation)) throw new Error('Há conflito com outra reserva para este quarto.');
			return { ...current, reservations: { ...current.reservations, [reservation.id]: { ...currentReservation, status: 'hospedado', updatedAt: new Date().toISOString() } } };
		}, `Check-in de ${reservation.guestName} realizado.`);
		if (!success) return;
	}

	async function checkOut(reservation: Reservation) {
		const success = await persist((current) => {
			const room = current.rooms[reservation.roomId];
			const currentReservation = current.reservations[reservation.id];
			if (!room || !currentReservation || currentReservation.status !== 'hospedado') throw new Error('A reserva não está hospedada.');
			return {
				...current,
				reservations: { ...current.reservations, [reservation.id]: { ...currentReservation, status: 'encerrada', updatedAt: new Date().toISOString() } },
				rooms: { ...current.rooms, [room.id]: { ...room, cleaningStatus: 'sujo' } },
			};
		}, `Checkout de ${reservation.guestName} realizado; quarto liberado para limpeza.`);
		if (!success) return;
	}

	async function cancelReservation(reservation: Reservation) {
		if (!window.confirm(`Cancelar a reserva de ${reservation.guestName} no quarto ${reservation.roomNumber}?`)) return;
		await persist((current) => {
			const currentReservation = current.reservations[reservation.id];
			if (!currentReservation || currentReservation.status !== 'confirmada') throw new Error('Somente reservas confirmadas podem ser canceladas.');
			return { ...current, reservations: { ...current.reservations, [reservation.id]: { ...currentReservation, status: 'cancelada', updatedAt: new Date().toISOString() } } };
		}, 'Reserva cancelada.');
	}

	function openCreate() {
		setEditingId('');
		setError('');
		setModalOpen(true);
	}

	function openEdit(reservation: Reservation) {
		setEditingId(reservation.id);
		setError('');
		setModalOpen(true);
	}

	return (
		<div className={`stock-app housekeeping-app reservations-app ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
			<aside className="stock-sidebar">
				<div className="housekeeping-sidebar-header"><Link to="/" className="stock-brand" aria-label="Hotel Lindoia, painel principal" title="Painel principal"><span className="brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>OPERAÇÃO</small></span></Link><button className="housekeeping-sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}><span aria-hidden="true">{sidebarCollapsed ? '›' : '‹'}</span></button></div>
				<div className="sidebar-label">HOTEL LINDOIA</div>
				<nav className="stock-nav housekeeping-nav" aria-label="Navegação do hotel">
					<ReservationsNavLink route="/" label="Painel principal" shortLabel="P" />
					<ReservationsNavLink route="/vendas" label="Vendas" shortLabel="V" />
					<ReservationsNavLink route="/estoque" label="Estoque" shortLabel="E" />
					<ReservationsNavLink route="/quartos" label="Serviço de quarto" shortLabel="Q" />
					<ReservationsNavLink route="/escala" label="Escala" shortLabel="ES" />
					{isAdmin && <ReservationsNavLink route="/financeiro/caixa" label="Financeiro" shortLabel="F" />}
					<ReservationsNavLink route="/reservas" label="Reservas" shortLabel="R" active />
				</nav>
				<div className="sidebar-footer"><span className="connection-dot" /><span>Salvo {housekeepingStorageMode}</span></div>
			</aside>
			<main className="stock-main">
				<header className="stock-topbar"><div className="breadcrumb"><Link to="/">Painel</Link><span>/</span><strong>Reservas</strong></div><div className="topbar-actions"><span className="user-chip">{isAdmin ? 'Gerência' : 'Equipe'}</span><Link className="back-link" to="/">Voltar ao painel</Link></div></header>
				<div className="stock-content reservation-content">
					<section className="page-heading"><div><p className="eyebrow">RECEPÇÃO</p><h1>Reservas e hospedagens</h1><p className="page-description">Disponibilidade por quarto, chegadas, estadias e saídas.</p></div><div className="heading-actions"><button className="button button-primary" onClick={openCreate} disabled={!rooms.length}>+ Nova reserva</button></div></section>
					{error && <div className="notice notice-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
					{notice && <div className="notice notice-success" role="status">{notice}</div>}
					<section className="reservation-summary" aria-label="Resumo da hospedagem">
						<ReservationMetric label="Ocupação atual" value={occupancy.occupancyRate === null ? '—' : `${occupancy.occupancyRate}%`} detail={`${occupancy.occupiedRooms} de ${occupancy.usableRooms} quartos disponíveis`} tone="blue" />
						<ReservationMetric label="Chegadas hoje" value={String(occupancy.arrivalsToday.guests)} detail={`${occupancy.arrivalsToday.reservations} reservas`} tone="gold" />
						<ReservationMetric label="Saídas hoje" value={String(occupancy.departuresToday.guests)} detail={`${occupancy.departuresToday.reservations} reservas`} tone="red" />
						<ReservationMetric label="Chegadas amanhã" value={String(occupancy.arrivalsTomorrow.guests)} detail={`${occupancy.arrivalsTomorrow.reservations} reservas`} tone="green" />
						<ReservationMetric label="Saídas amanhã" value={String(occupancy.departuresTomorrow.guests)} detail={`${occupancy.departuresTomorrow.reservations} reservas`} tone="neutral" />
					</section>
					<section className="reservation-panel">
						<div className="reservation-toolbar"><div className="reservation-tabs" role="tablist" aria-label="Filtrar reservas">{([['proximas', 'Ativas'], ['chegadas', 'Chegadas'], ['hospedados', 'Hospedados'], ['todas', 'Todas']] as [ReservationFilter, string][]).map(([id, label]) => <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>{label}</button>)}</div><label className="schedule-field reservation-search"><span>Buscar hóspede ou quarto</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, telefone ou quarto" /></label></div>
						{loading ? <div className="loading-state">Carregando reservas...</div> : !rooms.length ? <div className="reservation-empty"><strong>Cadastre os quartos antes de criar reservas</strong><p>O mapa de reservas usa os mesmos quartos e status do serviço de quarto.</p><Link className="button button-primary" to="/quartos">Cadastrar quartos</Link></div> : !visibleReservations.length ? <div className="reservation-empty"><strong>Nenhuma reserva nesta visão</strong><p>Crie uma reserva para atualizar automaticamente ocupação e chegadas.</p><button className="button button-primary" onClick={openCreate}>+ Nova reserva</button></div> : <div className="finance-table-wrap"><table className="finance-table reservation-table"><thead><tr><th>Hóspede</th><th>Quarto</th><th>Check-in</th><th>Checkout</th><th>Pessoas</th><th>Status</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{visibleReservations.map((reservation) => {
							const room = data.rooms[reservation.roomId];
							const canCheckIn = reservation.status === 'confirmada' && reservation.checkInDate <= today && room?.cleaningStatus === 'limpo' && room.maintenanceStatus !== 'em_manutencao';
							return <tr key={reservation.id}><td><strong>{reservation.guestName}</strong>{reservation.phone && <small>{reservation.phone}</small>}{reservation.note && <small>{reservation.note}</small>}</td><td>{reservation.roomNumber}{room?.maintenanceStatus === 'manutencao_necessaria' && <small>Manutenção necessária</small>}</td><td>{formatDate(reservation.checkInDate)}</td><td>{formatDate(reservation.checkOutDate)}</td><td>{guestCount(reservation)} <small>({reservation.adults} adultos · {reservation.children} crianças)</small></td><td><span className={`reservation-status reservation-${reservation.status}`}>{statusLabels[reservation.status]}</span></td><td><div className="reservation-row-actions">{reservation.status === 'confirmada' && <><button onClick={() => openEdit(reservation)}>Editar</button><button className="reservation-action-primary" onClick={() => void checkIn(reservation)} disabled={!canCheckIn} title={!canCheckIn ? room?.cleaningStatus !== 'limpo' ? 'O quarto precisa estar limpo' : room?.maintenanceStatus === 'em_manutencao' ? 'Quarto em manutenção' : 'Check-in disponível a partir da data prevista' : undefined}>Check-in</button><button className="danger" onClick={() => void cancelReservation(reservation)}>Cancelar</button></>}{reservation.status === 'hospedado' && <button className="reservation-action-primary" onClick={() => void checkOut(reservation)}>Checkout</button>}</div></td></tr>;
						})}</tbody></table></div>}
					</section>
					<footer className="finance-page-footer"><span>Armazenamento: {housekeepingStorageMode}</span><span>Ocupação vinculada aos quartos e ao check-in</span></footer>
				</div>
			</main>
			{modalOpen && <ReservationEditor key={editingId || 'new-reservation'} rooms={rooms} reservation={selected} data={data} saving={saving} onClose={() => setModalOpen(false)} onSubmit={saveReservation} />}
		</div>
	);
}

function ReservationsNavLink({ route, label, shortLabel, active = false }: { route: string; label: string; shortLabel: string; active?: boolean }) {
	return <Link className={`nav-item ${active ? 'selected' : ''}`} to={route} title={label} aria-label={label}><span className="nav-indicator" /><span className="housekeeping-nav-icon" aria-hidden="true">{shortLabel}</span><span className="housekeeping-nav-label">{label}</span></Link>;
}

function ReservationMetric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
	return <article className={`housekeeping-metric metric-${tone}`}><span className="metric-rule" /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function ReservationEditor({ rooms, reservation, data, saving, onClose, onSubmit }: { rooms: HousekeepingRoom[]; reservation?: Reservation; data: HousekeepingData; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
	const [checkIn, setCheckIn] = useState(reservation?.checkInDate ?? dateKey(new Date()));
	const [checkOut, setCheckOut] = useState(reservation?.checkOutDate ?? dateKeyAfterDays(1));
	const [roomId, setRoomId] = useState(reservation?.roomId ?? '');
	const availableRooms = rooms.filter((room) => room.maintenanceStatus !== 'em_manutencao' || room.id === reservation?.roomId);

	return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="stock-modal housekeeping-modal reservation-modal" role="dialog" aria-modal="true" aria-labelledby="reservation-modal-title"><form onSubmit={onSubmit}>
		<div className="schedule-modal-heading"><div><p className="eyebrow">RECEPÇÃO</p><h2 id="reservation-modal-title">{reservation ? 'Editar reserva' : 'Nova reserva'}</h2></div><button type="button" className="schedule-modal-close" onClick={onClose} aria-label="Fechar">×</button></div>
		<label className="schedule-field"><span>Nome do hóspede</span><input name="guestName" required maxLength={100} defaultValue={reservation?.guestName} autoFocus /></label>
		<label className="schedule-field"><span>Telefone</span><input name="phone" type="tel" maxLength={30} defaultValue={reservation?.phone} /></label>
		<label className="schedule-field"><span>Quarto</span><select name="roomId" required value={roomId} onChange={(event) => setRoomId(event.target.value)}><option value="">Selecione...</option>{availableRooms.map((room) => {const conflict = reservationOverlaps(data, { id: reservation?.id ?? '__nova__', roomId: room.id, checkInDate: checkIn, checkOutDate: checkOut });return <option key={room.id} value={room.id} disabled={conflict}>{room.number}{room.maintenanceStatus === 'manutencao_necessaria' ? ' · manutenção necessária' : ''}{conflict ? ' · reservado neste período' : ''}</option>;})}</select></label>
		<div className="housekeeping-form-grid"><label className="schedule-field"><span>Check-in</span><input name="checkInDate" type="date" required value={checkIn} onChange={(event) => setCheckIn(event.target.value)} /></label><label className="schedule-field"><span>Checkout</span><input name="checkOutDate" type="date" required min={checkIn} value={checkOut} onChange={(event) => setCheckOut(event.target.value)} /></label></div>
		<div className="housekeeping-form-grid"><label className="schedule-field"><span>Adultos</span><input name="adults" type="number" min="1" max="20" required defaultValue={reservation?.adults ?? 1} /></label><label className="schedule-field"><span>Crianças</span><input name="children" type="number" min="0" max="20" required defaultValue={reservation?.children ?? 0} /></label></div>
		<label className="schedule-field"><span>Observação</span><textarea name="note" rows={2} maxLength={300} defaultValue={reservation?.note} /></label>
		<p className="reservation-hint">Datas de hospedagens são check-in inclusivo e checkout exclusivo. Reservas sobrepostas para o mesmo quarto não são permitidas.</p>
		<div className="schedule-modal-actions"><button className="button button-plain" type="button" onClick={onClose}>Cancelar</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : reservation ? 'Salvar alterações' : 'Confirmar reserva'}</button></div>
	</form></section></div>;
}
