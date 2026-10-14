import { deleteReservation } from '../../services/hospitalityDeletion';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { UserRole } from '../../types';
import type { AuditEvent } from '../../types/audit';
import { incomeItems, incomePaymentWallet, PAYMENT_METHOD_LABELS, type FinanceData, type FinanceIncome, type FinancePaymentMethod } from '../../types/finance';
import { roomCategoryDescription } from '../../types/housekeeping';
import { DateInput } from '../../components/ui/DateInput';
import { CaixaRecepcao, type ReceptionEntryContext } from '../caixa/CaixaRecepcao';
import type { HousekeepingData, HousekeepingRoom, Reservation, ReservationChannel, ReservationCollection, ReservationDirectoryEntry, ReservationExtra, ReservationExtraType, ReservationGuest, ReservationStatus } from '../../types/housekeeping';
import { cancelConfirmedReservation, createReservation, emptyHousekeeping, housekeepingStorageMode, recordReservationCollection, recordReservationExtra, releaseObsoleteReservationSlots, releaseReservationSlots, reserveReservationSlots, rollbackReservationSlots, saveReservationBalanceDue, saveReservationRecord, subscribeCurrentReservationDirectory, subscribeReservationCollections, subscribeReservationExtras, subscribeReservationRecord, subscribeReservationWorkspace, syncReservationCollections, syncReservationDirectory, transitionReservation } from '../../services/housekeepingStore';
import { emptyFinance, subscribeReservationPaymentIncomes } from '../../services/financeStore';
import { deleteStay, subscribeReceptionStayDirectory } from '../../services/receptionStore';
import { dateKeyAfterDays, guestStayOccupiesToday, hotelOccupancySummary, occupiedRoomNumbers, reservationOccupiesToday, reservationOverlaps, stayCheckOutDate } from '../../services/reservationAnalytics';
import type { GuestStay, ReceptionRoom } from '../../types/reception';
import { recordOperationalIncome } from '../../services/operationalIncome';
import '../camareiras/quartos.css';
import './reservas.css';

type ReservationFilter = 'proximas' | 'chegadas' | 'hospedados' | 'todas';

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const formatDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR');
const guestCount = (reservation: Reservation) => reservation.adults + reservation.children;
const reservationNights = (checkIn: string, checkOut: string) => Math.max(0, Math.round((Date.parse(`${checkOut}T00:00:00`) - Date.parse(`${checkIn}T00:00:00`)) / 86_400_000));
const reservationTotal = (reservation: Reservation) => (reservation.reservationAmount ?? reservationNights(reservation.checkInDate, reservation.checkOutDate) * (reservation.nightlyRate ?? 0)) + (reservation.tax ?? 0);
const reservationPayments = (reservationId: string, finance: FinanceData) => Object.values(finance.incomes).filter((income) => income.id.startsWith(`reservation-${reservationId}-`));
const reservationPaymentsTotal = (reservationId: string, finance: FinanceData) => reservationPayments(reservationId, finance).reduce((total, income) => total + income.amount, 0);
const pendingCollectionsTotal = (reservationId: string, collections: Record<string, ReservationCollection>, finance: FinanceData) => Object.values(collections).filter((item) => item.reservationId === reservationId && !finance.incomes[`reservation-${reservationId}-checkout-${item.id}`]).reduce((total, item) => total + item.amount, 0);
const reservationExtrasTotal = (reservationId: string, extras: Record<string, ReservationExtra>) => Object.values(extras).filter((item) => item.reservationId === reservationId).reduce((total, item) => total + item.amount, 0);
const storedExtrasTotal = (reservation: Reservation) => (reservation.extras ?? []).reduce((total, extra) => total + extra.amount, 0);
const reservationExtrasCount = (reservation: Reservation, extras: Record<string, ReservationExtra>) => (reservation.extras?.length ?? 0) + Object.values(extras).filter((item) => item.reservationId === reservation.id).length;
const money = (amount: number) => amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const paymentLabels = PAYMENT_METHOD_LABELS;
const fourHourCheckout = (date: string, time: string) => {
	const checkout = new Date(`${date}T${time}:00`);
	checkout.setHours(checkout.getHours() + 4);
	return { date: dateKey(checkout), time: `${String(checkout.getHours()).padStart(2, '0')}:${String(checkout.getMinutes()).padStart(2, '0')}` };
};
const statusLabels: Record<ReservationStatus, string> = {
	confirmada: 'Confirmada', hospedado: 'Hospedado', encerrada: 'Encerrada', cancelada: 'Cancelada',
};
const channelLabels: Record<ReservationChannel, string> = {
	oyo: 'OYO · Booking e parceiros',
	balcao: 'Balcão',
	rotativo: 'Rotativo · 4 horas',
};
const extraLabels: Record<ReservationExtraType, string> = {
	cafe_manha: 'Café da manhã',
	colchao_extra: 'Colchão extra',
	pessoa_adicional: 'Pessoa adicional',
	checkin_antecipado: 'Check-in antecipado',
	checkout_tardio: 'Check-out tardio',
	consumo: 'Consumo',
};
const paymentTargets = ['Hospedagem', 'Taxa', 'Extras', 'Consumo'];
type GuestDraft = { name: string; cpf: string; birthDate: string; phone: string; cnpj: string; email: string };
type PaymentDraft = { key: string; target: string; method: FinancePaymentMethod; amount: string };
type ExistingPaymentDraft = { incomeId: string; itemId: string; version: string; date: string; description: string; method: FinancePaymentMethod; amount: string };
const emptyGuest = (): GuestDraft => ({ name: '', cpf: '', birthDate: '', phone: '', cnpj: '', email: '' });
const onlyDigits = (value: string) => value.replace(/\D/g, '');
const maskCpf = (value: string) => {
	const d = onlyDigits(value).slice(0, 11);
	return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
};
const maskCep = (value: string) => onlyDigits(value).slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2');
const validCpf = (value: string) => {
	const digits = onlyDigits(value);
	if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
	const check = (length: number) => {
		let sum = 0;
		for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (length + 1 - index);
		const rest = (sum * 10) % 11;
		return rest === 10 ? 0 : rest;
	};
	return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
};

function createId() {
	return crypto.randomUUID();
}

export function MapaReservas({ userRole }: { userRole: UserRole }) {
	const now = new Date();
	const today = dateKey(now);
	const isAdmin = userRole === 'admin';
	const [searchParams, setSearchParams] = useSearchParams();
	const contextualReservationId = searchParams.get('reservation') ?? '';
	const contextualStayId = searchParams.get('stay') ?? '';
	const contextualAction = searchParams.get('action') ?? '';
	const contextSelectionKey = JSON.stringify([contextualReservationId, contextualStayId, contextualAction]);
	const [dismissedContext, setDismissedContext] = useState('');
	const roomFilter = (searchParams.get('room') ?? '').trim();
	const [workspaceData, setData] = useState<HousekeepingData>(emptyHousekeeping());
	const [contextualRecord, setContextualRecord] = useState<{ id: string; reservation: Reservation | null; loaded: boolean }>({ id: '', reservation: null, loaded: false });
	const data = useMemo<HousekeepingData>(() => contextualRecord.id === contextualReservationId && contextualRecord.reservation
		? { ...workspaceData, reservations: { ...workspaceData.reservations, [contextualRecord.reservation.id]: contextualRecord.reservation } }
		: workspaceData, [workspaceData, contextualRecord, contextualReservationId]);
	const [loadedWorkspaceScope, setLoadedWorkspaceScope] = useState('');
	const [receptionDirectory, setReceptionDirectory] = useState<{ stays: Record<string, GuestStay>; rooms: Record<string, ReceptionRoom> }>({ stays: {}, rooms: {} });
	const [receptionLoading, setReceptionLoading] = useState(true);
	const [currentReservationIndex, setCurrentReservationIndex] = useState<Record<string, ReservationDirectoryEntry>>({});
	const [currentReservationIndexLoaded, setCurrentReservationIndexLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [filter, setFilter] = useState<ReservationFilter>('todas');
	const [search, setSearch] = useState('');
	const [dateFrom, setDateFrom] = useState(today);
	const [dateTo, setDateTo] = useState(today);
	const validDateRange = /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(dateTo) && dateFrom <= dateTo;
	const workspaceScope = JSON.stringify([dateFrom, dateTo, isAdmin]);
	const loading = validDateRange && loadedWorkspaceScope !== workspaceScope;
	const [editingId, setEditingId] = useState('');
	const [editingReservation, setEditingReservation] = useState<Reservation | null>(null);
	const [modalOpen, setModalOpen] = useState(false);
	const [loadedFinanceData, setFinanceData] = useState<FinanceData>(emptyFinance());
	const financeData = isAdmin ? loadedFinanceData : emptyFinance();
	const [financeScope, setFinanceScope] = useState('');
	const [collections, setCollections] = useState<Record<string, ReservationCollection>>({});
	const [collectionsScope, setCollectionsScope] = useState('');
	const [extras, setExtras] = useState<Record<string, ReservationExtra>>({});
	const [extrasScope, setExtrasScope] = useState('');
	const [checkoutReservation, setCheckoutReservation] = useState<Reservation | null>(null);
	const [extraReservation, setExtraReservation] = useState<Reservation | null>(null);
	const [editingReceptionStay, setEditingReceptionStay] = useState<GuestStay | null>(null);
	const reservationScope = JSON.stringify(Object.keys(data.reservations).sort());
	const reservationIds = useMemo(() => JSON.parse(reservationScope) as string[], [reservationScope]);
	const financialLoading = (isAdmin && financeScope !== reservationScope) || collectionsScope !== reservationScope || extrasScope !== reservationScope;

	useEffect(() => {
		if (!isAdmin || !contextualReservationId) return;
		return subscribeReservationRecord(contextualReservationId, (reservation) => {
			setContextualRecord({ id: contextualReservationId, reservation, loaded: true });
		}, (cause) => {
			setContextualRecord({ id: contextualReservationId, reservation: null, loaded: true });
			setError(`Não foi possível carregar a reserva selecionada: ${cause.message}`);
		});
	}, [contextualReservationId, isAdmin]);

	useEffect(() => {
		if (!validDateRange) return;
		return subscribeReservationWorkspace({ from: dateFrom, to: dateTo }, (next) => {
			setData(next);
			setLoadedWorkspaceScope(workspaceScope);
			setError('');
		}, (cause) => {
			setLoadedWorkspaceScope(workspaceScope);
			setError(`Não foi possível carregar as reservas: ${cause.message}`);
		}, isAdmin);
	}, [dateFrom, dateTo, isAdmin, validDateRange, workspaceScope]);

	useEffect(() => {
		return subscribeReceptionStayDirectory((next) => {
			setReceptionDirectory(next);
			setReceptionLoading(false);
			setError((current) => current.startsWith('Não foi possível carregar as hospedagens da recepção:') ? '' : current);
		}, (cause) => {
			setReceptionLoading(false);
			setError(`Não foi possível carregar as hospedagens da recepção: ${cause.message}`);
		});
	}, []);

	useEffect(() => subscribeCurrentReservationDirectory((next) => {
		setCurrentReservationIndex(next);
		setCurrentReservationIndexLoaded(true);
	}, (cause) => {
		setCurrentReservationIndexLoaded(true);
		setError(`Não foi possível atualizar o resumo da ocupação: ${cause.message}`);
	}), []);

	useEffect(() => {
		if (!isAdmin) return;
		let subscribed = false;
		const stop = subscribeReservationPaymentIncomes(reservationIds, (next) => {
			if (!subscribed && reservationIds.length > 0) return;
			setFinanceData(next); setFinanceScope(reservationScope);
		}, (cause) => setError(`Não foi possível carregar os recebimentos: ${cause.message}`));
		subscribed = true;
		return stop;
	}, [isAdmin, reservationIds, reservationScope]);

	useEffect(() => {
		let subscribed = false;
		const stop = subscribeReservationCollections((next) => {
			if (!subscribed && reservationIds.length > 0) return;
			setCollections(next); setCollectionsScope(reservationScope);
		}, (cause) => setError(`Não foi possível carregar as cobranças: ${cause.message}`), reservationIds);
		subscribed = true;
		return stop;
	}, [reservationIds, reservationScope]);
	useEffect(() => {
		let subscribed = false;
		const stop = subscribeReservationExtras((next) => {
			if (!subscribed && reservationIds.length > 0) return;
			setExtras(next); setExtrasScope(reservationScope);
		}, (cause) => setError(`Não foi possível carregar os adicionais: ${cause.message}`), reservationIds);
		subscribed = true;
		return stop;
	}, [reservationIds, reservationScope]);

	useEffect(() => {
		if (!isAdmin || reservationIds.length === 0 || Object.keys(collections).length === 0) return;
		void syncReservationCollections(reservationIds).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Não foi possível conciliar as cobranças de checkout.'));
	}, [isAdmin, collections, reservationIds]);

	useEffect(() => {
		if (!isAdmin || loading || !validDateRange) return;
		void syncReservationDirectory(data.reservations).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar a lista operacional de hospedagens.'));
	}, [isAdmin, loading, validDateRange, data.reservations]);

	const rooms = useMemo(() => Object.values(data.rooms).sort((a, b) => a.number.localeCompare(b.number, 'pt-BR', { numeric: true })), [data.rooms]);
	const reservations = useMemo(() => Object.values(data.reservations).sort((a, b) => a.checkInDate.localeCompare(b.checkInDate) || a.guestName.localeCompare(b.guestName, 'pt-BR')), [data.reservations]);
	const occupancy = hotelOccupancySummary({ rooms: data.rooms, reservations: currentReservationIndex }, now, receptionDirectory);
	const occupancyRooms = (() => {
		const roomByNumber = new Map<string, { number: string; maintenanceStatus?: string }>();
		Object.values(data.rooms).forEach((room) => roomByNumber.set(room.number.trim(), room));
		Object.values(receptionDirectory.rooms).forEach((room) => {
			if (!roomByNumber.has(room.number.trim())) roomByNumber.set(room.number.trim(), room);
		});

		const occupiedNumbers = occupiedRoomNumbers({ rooms: data.rooms, reservations: currentReservationIndex }, receptionDirectory.stays, now);
		const occupantByRoom = new Map<string, string>();
		Object.values(receptionDirectory.stays).forEach((stay) => {
			const roomNumber = stay.roomNumber.trim();
			if (roomNumber && guestStayOccupiesToday(stay, today, now.getTime())) occupantByRoom.set(roomNumber, stay.guestName?.trim() || 'Hóspede hospedado');
		});
		Object.values(currentReservationIndex).forEach((reservation) => {
			const roomNumber = reservation.roomNumber.trim();
			if (roomNumber && reservationOccupiesToday(reservation, today, now.getTime())) occupantByRoom.set(roomNumber, reservation.guestName?.trim() || 'Hóspede hospedado');
		});

		return [...roomByNumber.values()]
			.filter((room) => room.number)
			.sort((a, b) => a.number.localeCompare(b.number, 'pt-BR', { numeric: true }))
			.map((room) => ({
				...room,
				occupied: occupiedNumbers.has(room.number.trim()),
				guestName: occupantByRoom.get(room.number.trim()) ?? '',
			}));
	})();
	const visibleReservations = reservations.filter((reservation) => {
		const term = search.trim().toLocaleLowerCase('pt-BR');
		const matchesSearch = !term || reservation.guestName.toLocaleLowerCase('pt-BR').includes(term)
			|| (reservation.guests ?? []).some((guest) => guest.name.toLocaleLowerCase('pt-BR').includes(term))
			|| (reservation.oyoReservationNumber ?? '').toLocaleLowerCase('pt-BR').includes(term)
			|| reservation.roomNumber.toLocaleLowerCase('pt-BR').includes(term)
			|| reservation.phone.toLocaleLowerCase('pt-BR').includes(term);
		const matchesPeriod = validDateRange && reservation.checkInDate >= dateFrom && reservation.checkInDate <= dateTo;
		const matchesFilter = filter === 'todas'
			|| (filter === 'hospedados' && reservation.status === 'hospedado')
			|| (filter === 'chegadas' && reservation.status === 'confirmada' && reservation.checkInDate >= dateFrom && reservation.checkInDate <= dateTo)
			|| (filter === 'proximas' && ['confirmada', 'hospedado'].includes(reservation.status));
		const matchesRoom = !roomFilter || reservation.roomNumber.trim() === roomFilter;
		return reservation.id === contextualReservationId || (matchesRoom && matchesPeriod && matchesSearch && matchesFilter);
	});
	const receptionStays = Object.values(receptionDirectory.stays).sort((a, b) => (b.checkInDate ?? '').localeCompare(a.checkInDate ?? '') || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
	const visibleReceptionStays = receptionStays.filter((stay) => {
		const term = search.trim().toLocaleLowerCase('pt-BR');
		const matchesSearch = !term || (stay.guestName ?? '').toLocaleLowerCase('pt-BR').includes(term)
			|| (stay.roomNumber ?? '').toLocaleLowerCase('pt-BR').includes(term)
			|| (stay.attendant ?? '').toLocaleLowerCase('pt-BR').includes(term)
			|| (stay.note ?? '').toLocaleLowerCase('pt-BR').includes(term);
		const checkoutDate = stayCheckOutDate(stay);
		const matchesPeriod = validDateRange && stay.checkInDate >= dateFrom && stay.checkInDate <= dateTo;
		const matchesFilter = filter === 'todas'
			|| (filter === 'hospedados' && guestStayOccupiesToday(stay, today, now.getTime()))
			|| (filter === 'chegadas' && stay.status === 'hospedado' && stay.checkInDate >= dateFrom && stay.checkInDate <= dateTo)
			|| (filter === 'proximas' && stay.status === 'hospedado' && (stay.kind === 'periodo' ? guestStayOccupiesToday(stay, today, now.getTime()) : checkoutDate >= today));
		const matchesRoom = !roomFilter || (stay.roomNumber ?? '').trim() === roomFilter;
		return stay.id === contextualStayId || (matchesRoom && matchesPeriod && matchesSearch && matchesFilter);
	});
	const receptionEntryContext = useMemo<ReceptionEntryContext>(() => ({
		stays: receptionDirectory.stays,
		rooms: receptionDirectory.rooms,
		roomDirectory: data.rooms,
		reservations: data.reservations,
		attendant: 'Gerência',
	}), [receptionDirectory, data.rooms, data.reservations]);
	const contextScopesLoaded = !contextualReservationId || [financeScope, collectionsScope, extrasScope].every((scope) => scope && (JSON.parse(scope) as string[]).includes(contextualReservationId));
	const contextualRecordMissing = contextualRecord.id === contextualReservationId && contextualRecord.loaded && !contextualRecord.reservation;
	const contextualReady = isAdmin && !loading && !receptionLoading && (contextScopesLoaded || contextualRecordMissing);
	const linkedReservation = contextualReady && contextualRecord.id === contextualReservationId && contextualRecord.loaded ? contextualRecord.reservation : null;
	const linkedStay = contextualReady && contextualStayId ? receptionDirectory.stays[contextualStayId] : null;
	const contextModalActive = dismissedContext !== contextSelectionKey;
	const activeCheckoutReservation = checkoutReservation ?? (contextModalActive && contextualAction === 'checkout' && linkedReservation?.status === 'hospedado' ? linkedReservation : null);
	const selected = editingReservation ?? data.reservations[editingId] ?? linkedReservation ?? undefined;
	const reservationEditorOpen = modalOpen || Boolean(contextModalActive && linkedReservation && !activeCheckoutReservation);
	const activeReceptionStay = editingReceptionStay ?? (contextModalActive ? linkedStay : null);
	const contextError = contextualReady && contextualReservationId && contextualRecord.id === contextualReservationId && contextualRecord.loaded && !linkedReservation
		? 'A reserva selecionada não foi encontrada ou foi excluída.'
		: contextualReady && contextualStayId && !linkedStay ? 'A hospedagem selecionada não foi encontrada ou foi excluída.'
			: contextualReady && contextualAction === 'checkout' && linkedReservation && linkedReservation.status !== 'hospedado' ? 'Esta reserva já não está hospedada. Confira os dados atualizados.' : '';
	const amountDue = (reservation: Reservation) => {
		const total = reservationTotal(reservation) + storedExtrasTotal(reservation) + reservationExtrasTotal(reservation.id, extras);
		const balance = isAdmin ? total - reservationPaymentsTotal(reservation.id, financeData) : reservation.balanceDue ?? total;
		return Math.round(Math.max(0, balance - pendingCollectionsTotal(reservation.id, collections, financeData)) * 100) / 100;
	};
	function clearContextSelection() {
		setDismissedContext('');
		const next = new URLSearchParams(searchParams);
		next.delete('reservation'); next.delete('stay'); next.delete('action');
		setSearchParams(next, { replace: true });
	}
	function closeReservationEditor() { setModalOpen(false); setEditingId(''); setEditingReservation(null); clearContextSelection(); }
	function closeCheckoutEditor() { setCheckoutReservation(null); clearContextSelection(); }
	function showSavedReservation(reservation: Reservation) {
		setModalOpen(false); setEditingId(''); setEditingReservation(null);
		const next = new URLSearchParams(searchParams);
		next.delete('stay'); next.delete('action');
		next.set('reservation', reservation.id); next.set('room', reservation.roomNumber);
		setDismissedContext(JSON.stringify([reservation.id, '', '']));
		setSearchParams(next, { replace: true });
	}
	function showSavedReceptionStay(stayId: string) {
		setEditingReceptionStay(null);
		const next = new URLSearchParams(searchParams);
		next.delete('reservation'); next.delete('action'); next.delete('room'); next.set('stay', stayId);
		setDismissedContext(JSON.stringify(['', stayId, '']));
		setSearchParams(next, { replace: true });
	}

	async function submitExtra(event: FormEvent<HTMLFormElement>, reservation: Reservation) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const type = String(form.get('type')) as ReservationExtraType;
		const amount = Number(form.get('amount'));
		if (!extraLabels[type] || !Number.isFinite(amount) || amount <= 0) { setError('Informe um adicional e um valor maior que zero.'); return; }
		setSaving(true);
		setError('');
		try {
			await recordReservationExtra({
				id: String(form.get('extraId')),
				reservationId: reservation.id,
				type,
				description: extraLabels[type],
				amount,
				date: today,
				actor: isAdmin ? 'Gerência' : 'Equipe',
				createdAt: new Date().toISOString(),
			});
			setExtraReservation(null);
			setNotice(`${extraLabels[type]} lançado para o quarto ${reservation.roomNumber}.`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível lançar o adicional.');
		} finally {
			setSaving(false);
		}
	}

	async function persistReservation(reservation: Reservation, previous: Reservation, message: string, paymentUpdates: FinanceIncome[] = []): Promise<boolean> {
		setSaving(true);
		setError('');
		setNotice('');
		try {
			await reserveReservationSlots(reservation);
			try {
				await saveReservationRecord(reservation, previous, paymentUpdates);
			} catch (cause) {
				await rollbackReservationSlots(previous, reservation).catch(() => undefined);
				throw cause;
			}
			await releaseObsoleteReservationSlots(previous, reservation).catch((cause: unknown) => {
				setError(cause instanceof Error ? `Reserva salva, mas as datas antigas não foram liberadas: ${cause.message}` : 'Reserva salva, mas as datas antigas não foram liberadas.');
			});
			setNotice(message);
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a reserva.');
			return false;
		} finally {
			setSaving(false);
		}
	}

	async function saveReservation(event: FormEvent<HTMLFormElement>, originalReservation?: Reservation) {
		const selected = originalReservation;
		event.preventDefault();
		if (financialLoading) { setError('Aguarde o carregamento dos recebimentos e adicionais antes de salvar.'); return; }
		const form = new FormData(event.currentTarget);
		const roomId = String(form.get('roomId') ?? '');
		const room = data.rooms[roomId];
		const checkInDate = String(form.get('checkInDate') ?? '');
		const checkOutDate = String(form.get('checkOutDate') ?? '');
		const checkInTime = String(form.get('checkInTime') ?? '');
		const checkOutTime = String(form.get('checkOutTime') ?? '');
		const field = (name: string) => form.getAll(name).map((value) => String(value).trim());
		const [guestNames, guestCpfs, guestBirths, guestPhones, guestCnpjs, guestEmails] = ['guestName', 'guestCpf', 'guestBirth', 'guestPhone', 'guestCnpj', 'guestEmail'].map(field);
		const guests: ReservationGuest[] = guestNames.map((name, index) => ({
			name,
			cpf: onlyDigits(guestCpfs[index] ?? ''),
			birthDate: guestBirths[index] ?? '',
			phone: guestPhones[index] ?? '',
			...(guestCnpjs[index] ? { cnpj: onlyDigits(guestCnpjs[index]) } : {}),
			...(guestEmails[index] ? { email: guestEmails[index] } : {}),
		}));
		const adults = guests.length;
		const children = Number(form.get('children'));
		const dailyRate = Number(form.get('dailyRate'));
		const oyoFee = Number(form.get('oyoFee') || 0);
		const oyoFeePaidToOyo = form.get('oyoFeePayer') === 'oyo';
		const oyoReservationNumber = String(form.get('oyoReservationNumber') ?? '').trim();
		const invoiceRequested = form.get('invoiceRequested') === 'yes';
		const invoiceNumber = String(form.get('invoiceNumber') ?? '').trim();
		const address = Object.fromEntries(['street', 'number', 'district', 'city', 'zip'].map((key) => [key, String(form.get(`address_${key}`) ?? '').trim()])) as Record<'street' | 'number' | 'district' | 'city' | 'zip', string>;
		const hasAddress = Object.values(address).some(Boolean);
		const breakfastIncluded = form.get('breakfastIncluded') === 'yes' || form.getAll('extraType').includes('cafe_manha') || Boolean(selected?.extras?.some((extra) => extra.type === 'cafe_manha'));
		const payTargets = field('payTarget');
		const payMethods = field('payMethod');
		const payIds = field('payId');
		const paymentLines = field('payAmount').map((amount, index) => ({ id: payIds[index] || createId(), target: payTargets[index] ?? 'Hospedagem', method: payMethods[index] as FinancePaymentMethod, amount: Number(amount || 0) }));
		const [existingIncomeIds, existingItemIds, existingVersions, existingDates, existingMethods, existingAmounts] = ['existingIncomeId', 'existingItemId', 'existingPaymentVersion', 'existingPaymentDate', 'existingPaymentMethod', 'existingPaymentAmount'].map(field);
		const editedPayments: FinanceIncome[] = [];
		if (selected) {
			for (const income of reservationPayments(selected.id, financeData)) {
				const rows = existingIncomeIds.map((id, index) => id === income.id ? index : -1).filter((index) => index >= 0);
				if (!rows.length) continue;
				const items = incomeItems(income).map((item) => {
					const index = rows.find((row) => existingItemIds[row] === item.id);
					return index === undefined ? item : { ...item, amount: Number(existingAmounts[index]), paymentMethod: existingMethods[index] as FinancePaymentMethod };
				});
				const date = existingDates[rows[0]];
				if (!date || date > today || rows.some((row) => existingDates[row] !== date) || items.some((item) => !Number.isFinite(item.amount) || item.amount <= 0 || !paymentLabels[item.paymentMethod])) {
					setError('Confira a data, o valor e a forma de pagamento dos recebimentos já registrados.'); return;
				}
				if (date !== income.date || JSON.stringify(items) !== JSON.stringify(incomeItems(income))) editedPayments.push({ ...income, date, amount: Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100, wallet: incomePaymentWallet(items[0].paymentMethod)!, items, updatedAt: existingVersions[rows[0]], operationalOverride: true });
			}
		}
		const paymentAmount = paymentLines.reduce((sum, line) => sum + (Number.isFinite(line.amount) ? line.amount : 0), 0);
		const paymentDate = String(form.get('paymentDate') ?? '');
		const guestName = guests[0]?.name ?? '';
		const channel = String(form.get('channel') ?? '') as ReservationChannel;
		const tax = channel === 'oyo' && !oyoFeePaidToOyo ? oyoFee : 0;
		const reservationId = String(form.get('reservationId') ?? selected?.id ?? createId());
		const extraTypes = form.getAll('extraType').map(String) as ReservationExtraType[];
		const bookingExtras = extraTypes.map((type) => ({
			id: String(form.get(`extraId_${type}`) ?? createId()),
			reservationId,
			type,
			description: extraLabels[type],
			amount: Number(form.get(`extraAmount_${type}`)),
			date: today,
			actor: isAdmin ? 'Gerência' : 'Equipe',
			createdAt: new Date().toISOString(),
		}));
		const reservationAmount = Math.round(dailyRate * (channel === 'rotativo' ? 1 : reservationNights(checkInDate, checkOutDate)) * 100) / 100;
		const validPeriod = channel === 'rotativo'
			? Boolean(checkInDate && checkOutDate && checkInTime && checkOutTime && Date.parse(`${checkOutDate}T${checkOutTime}:00`) - Date.parse(`${checkInDate}T${checkInTime}:00`) === 4 * 60 * 60 * 1000)
			: Boolean(checkInDate && checkOutDate && checkOutDate > checkInDate);
		if (!room || !guestName || !['oyo', 'balcao', 'rotativo'].includes(channel) || !validPeriod || !Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0 || !Number.isFinite(reservationAmount) || reservationAmount < 0 || !Number.isFinite(oyoFee) || oyoFee < 0 || bookingExtras.some((extra) => !extraLabels[extra.type] || !Number.isFinite(extra.amount) || extra.amount <= 0) || paymentLines.some((line) => !Number.isFinite(line.amount) || line.amount < 0 || (line.amount > 0 && (!paymentLabels[line.method] || !paymentTargets.includes(line.target) || (line.method === 'prepaid' && channel !== 'oyo')))) || (paymentAmount > 0 && (!paymentDate || paymentDate > today))) {
			setError('Confira o hóspede, origem, período, valores e quantidade de pessoas. O checkout deve ser após o check-in.');
			return;
		}
		if (channel === 'oyo' && !oyoReservationNumber) { setError('Informe o número da reserva fornecido pela OYO.'); return; }
		const invalidGuest = guests.findIndex((guest, index) => !validCpf(guest.cpf) || !guest.birthDate || guest.birthDate > today || (index === 0 && onlyDigits(guest.phone).length < 10) || (guest.cnpj !== undefined && guest.cnpj.length !== 14));
		if (invalidGuest >= 0) { setError(`Confira CPF, data de nascimento, ${invalidGuest === 0 ? 'celular e ' : ''}CNPJ (se informado) do hóspede ${invalidGuest + 1}.`); return; }
		if (address.zip && onlyDigits(address.zip).length !== 8) { setError('O CEP deve ter 8 dígitos.'); return; }
		const total = reservationAmount + tax + (selected ? storedExtrasTotal(selected) + reservationExtrasTotal(selected.id, extras) : 0) + bookingExtras.reduce((sum, extra) => sum + extra.amount, 0);
		const alreadyReceived = selected ? reservationPaymentsTotal(selected.id, financeData) + pendingCollectionsTotal(selected.id, collections, financeData) + editedPayments.reduce((sum, income) => sum + income.amount - (financeData.incomes[income.id]?.amount ?? 0), 0) : 0;
		if (alreadyReceived + paymentAmount > total + 0.001) {
			setError('O valor recebido não pode ultrapassar o total da hospedagem com taxas e extras.');
			return;
		}
		const recordPayments = async () => {
			for (const line of paymentLines.filter((item) => item.amount > 0)) {
				await recordOperationalIncome({ id: `reservation-${reservationId}-${line.id}`, date: paymentDate, category: line.target === 'Consumo' ? 'Consumo' : channel === 'rotativo' && line.target === 'Hospedagem' ? 'Rotativo' : 'Diária', description: `${line.target} · quarto ${room.number}`, amount: line.amount, paymentMethod: line.method, note: `Recebimento da reserva de ${guestName}` });
			}
		};
		const reservation: Reservation = {
			id: reservationId,
			guestName,
			channel,
			phone: guests[0]?.phone ?? '',
			guests,
			invoiceRequested,
			...(invoiceRequested && invoiceNumber ? { invoiceNumber } : {}),
			...(channel === 'oyo' ? { oyoReservationNumber, oyoFee, oyoFeePaidToOyo } : {}),
			...(hasAddress ? { address: Object.fromEntries(Object.entries(address).filter(([, value]) => value).map(([key, value]) => [key, key === 'zip' ? onlyDigits(value) : value])) } : {}),
			roomId,
			roomNumber: room.number,
			checkInDate,
			checkOutDate,
			...(channel === 'rotativo' ? { checkInTime, checkOutTime } : {}),
			adults,
			children,
			reservationAmount,
			tax,
			extras: [...(selected?.extras ?? []), ...bookingExtras],
			balanceDue: Math.max(0, total - alreadyReceived),
			breakfastIncluded,
			...(channel !== 'rotativo' ? { nightlyRate: dailyRate } : {}),
			status: selected?.status ?? 'confirmada',
			note: String(form.get('note') ?? '').trim(),
			createdAt: selected?.createdAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		if (!selected) {
			setSaving(true);
			setError('');
			try {
				await createReservation(reservation, data);
				setModalOpen(false);
				setNotice('Reserva criada.');
				if (paymentAmount > 0) {
					try {
						await recordPayments();
						await saveReservationBalanceDue(reservation.id, Math.max(0, total - paymentAmount));
					} catch (cause) {
						setError(cause instanceof Error ? `Reserva criada, mas o recebimento não foi lançado no Financeiro: ${cause.message}` : 'Reserva criada, mas o recebimento não foi lançado no Financeiro.');
					}
				}
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : 'Não foi possível criar a reserva.');
			} finally {
				setSaving(false);
			}
			return;
		}
		const currentRoom = data.rooms[roomId];
		if (!currentRoom) { setError('O quarto selecionado não existe mais.'); return; }
		if (currentRoom.maintenanceStatus === 'em_manutencao' && currentRoom.id !== selected.roomId) { setError('Este quarto está indisponível para manutenção.'); return; }
		if (['confirmada', 'hospedado'].includes(reservation.status) && reservationOverlaps(data, reservation)) { setError(`O quarto ${currentRoom.number} já tem uma reserva ativa nesse período.`); return; }
		const timestamp = new Date().toISOString();
		const newPayments: FinanceIncome[] = paymentLines.filter((line) => line.amount > 0).map((line) => {
			const id = `reservation-${reservationId}-${line.id}`;
			return { id, date: paymentDate, category: line.target === 'Consumo' ? 'Consumo' : channel === 'rotativo' && line.target === 'Hospedagem' ? 'Rotativo' : 'Diária', amount: line.amount, wallet: incomePaymentWallet(line.method)!, items: [{ id, description: `${line.target} · quarto ${room.number}`, amount: line.amount, paymentMethod: line.method }], note: `Recebimento da reserva de ${guestName}`, createdAt: timestamp, updatedAt: timestamp };
		});
		const success = await persistReservation(reservation, selected, 'Reserva e recebimentos vinculados atualizados.', [...editedPayments, ...newPayments]);
		if (success) {
			showSavedReservation(reservation);
		}
	}

	async function checkIn(reservation: Reservation) {
		const now = new Date();
		const checkInAt = new Date(`${reservation.checkInDate}T${reservation.channel === 'rotativo' ? reservation.checkInTime : '00:00'}:00`);
		if (checkInAt > now) {
			setError(`O check-in está previsto para ${formatDate(reservation.checkInDate)}.`);
			return;
		}
		const room = data.rooms[reservation.roomId];
		if (!room || reservation.status !== 'confirmada') { setError('A reserva não está mais disponível para check-in.'); return; }
		if (reservationOverlaps(data, reservation)) { setError('Há conflito com outra reserva ativa para este quarto.'); return; }
		if (room.cleaningStatus !== 'limpo') { setError(`O quarto ${room.number} ainda não está limpo.`); return; }
		if (room.maintenanceStatus === 'em_manutencao') { setError(`O quarto ${room.number} está em manutenção e não pode receber hóspedes.`); return; }
		setSaving(true);
		try {
			await transitionReservation(reservation, 'hospedado');
			setNotice(`Check-in de ${reservation.guestName} realizado.`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível realizar o check-in.');
		} finally {
			setSaving(false);
		}
	}

	function checkOut(reservation: Reservation) {
		setCheckoutReservation(reservation);
		setError('');
	}

	async function submitCheckOut(event: FormEvent<HTMLFormElement>, reservation: Reservation) {
		event.preventDefault();
		if (financialLoading) { setError('Aguarde o carregamento do saldo antes de finalizar o checkout.'); return; }
		const form = new FormData(event.currentTarget);
		const collectionAmount = Number(form.get('collectionAmount') || 0);
		const paymentMethod = String(form.get('paymentMethod') ?? '') as FinancePaymentMethod;
		const due = amountDue(reservation);
		if (!Number.isFinite(collectionAmount) || collectionAmount < 0 || collectionAmount > due + 0.001 || (due > 0 && collectionAmount <= 0)) {
			setError(due > 0 ? 'Informe quanto será recebido no checkout, sem ultrapassar o saldo devido.' : 'O valor informado é inválido.');
			return;
		}
		if (collectionAmount > 0 && !paymentLabels[paymentMethod]) { setError('Selecione a forma de pagamento.'); return; }
		setSaving(true);
		setError('');
		try {
			if (collectionAmount > 0) {
				await recordReservationCollection({
					id: String(form.get('collectionId')),
					reservationId: reservation.id,
					date: today,
					amount: collectionAmount,
					paymentMethod,
					actor: isAdmin ? 'Gerência' : 'Equipe',
					createdAt: new Date().toISOString(),
				});
			}
			await transitionReservation(reservation, 'encerrada');
			closeCheckoutEditor();
			setNotice(`Checkout de ${reservation.guestName} realizado; quarto liberado para limpeza.`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível concluir o checkout.');
		} finally {
			setSaving(false);
		}
	}

	async function cancelReservation(reservation: Reservation) {
		if (!window.confirm(`Cancelar a reserva de ${reservation.guestName} no quarto ${reservation.roomNumber}?`)) return;
		let success = false;
		setSaving(true);
		setError('');
		try {
			await cancelConfirmedReservation(reservation.id);
			setNotice('Reserva cancelada.');
			success = true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível cancelar a reserva.');
		} finally {
			setSaving(false);
		}
		if (success) {
			try {
				await releaseReservationSlots(reservation);
			} catch (cause) {
				setError(cause instanceof Error ? `Reserva cancelada, mas as datas não foram liberadas: ${cause.message}` : 'Reserva cancelada, mas as datas não foram liberadas.');
			}
		}
	}

	async function removeReservation(reservation: Reservation) {
    if (!window.confirm(`Excluir a reserva de ${reservation.guestName}? Os pagamentos e adicionais ligados à reserva serão removidos, os valores serão recalculados e as datas ficarão livres.`)) return;
    setSaving(true); setError('');
    try { await deleteReservation(reservation); setNotice('Reserva e lançamentos relacionados excluídos.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível excluir.'); }
    finally { setSaving(false); }
  }

	function openCreate() {
		setEditingId('');
		setEditingReservation(null);
		clearContextSelection();
		setError('');
		setModalOpen(true);
	}

	async function removeReceptionStay(stay: GuestStay) {
		if (!isAdmin || !window.confirm(`Excluir a hospedagem de ${stay.guestName || `quarto ${stay.roomNumber}`}? Eventuais hospedagens convertidas, cobranças, valores recebidos e lançamentos da OYO vinculados também serão removidos e recalculados.`)) return;
		setSaving(true);
		setError('');
		setNotice('');
		try {
			await deleteStay(stay);
			setNotice('Hospedagem excluída. Cobranças e valores financeiros vinculados foram atualizados.');
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível excluir a hospedagem.');
		} finally {
			setSaving(false);
		}
	}

	function openEdit(reservation: Reservation) {
		setEditingId(reservation.id);
		setEditingReservation(reservation);
		setError('');
		setModalOpen(true);
	}

	return (
		<div className={`stock-app housekeeping-app reservations-app`}>
			<main className="stock-main">
				<header className="stock-topbar"><div className="breadcrumb"><Link to="/">Painel</Link><span>/</span><strong>Reservas</strong></div><div className="topbar-actions"><span className="user-chip">{isAdmin ? 'Gerência' : 'Equipe'}</span><Link className="back-link" to="/">Voltar ao painel</Link></div></header>
				<div className="stock-content reservation-content">
					<section className="page-heading"><div><p className="eyebrow">RECEPÇÃO</p><h1>Reservas e hospedagens</h1><p className="page-description">Disponibilidade por quarto, chegadas, estadias e saídas.</p></div><div className="heading-actions"><button className="button button-primary" onClick={openCreate} disabled={!rooms.length || loading || financialLoading}>+ Nova reserva</button></div></section>
					{(error || contextError) && <div className="notice notice-error" role="alert">{error || contextError}<button onClick={() => { setError(''); if (contextError) clearContextSelection(); }} aria-label="Fechar aviso">×</button></div>}
					{notice && <div className="notice notice-success" role="status">{notice}</div>}
					{roomFilter && <div className="reservation-room-context"><strong>Reservas do quarto {roomFilter}</strong><div><Link to={`/quartos?room=${encodeURIComponent(roomFilter)}`}>Gerência de quartos</Link><button type="button" onClick={() => { const next = new URLSearchParams(searchParams); next.delete('room'); setSearchParams(next, { replace: true }); }}>Ver todos os quartos</button></div></div>}
					{isAdmin && contextualReservationId && (contextualRecord.id !== contextualReservationId || !contextualRecord.loaded || financialLoading) && <div className="loading-state" role="status">Carregando a reserva selecionada e seus recebimentos...</div>}
					<section className="reservation-summary" aria-label="Resumo da hospedagem">
						<ReservationMetric label="Ocupação atual" value={occupancy.occupancyRate === null ? '—' : `${occupancy.occupancyRate}%`} detail={`${occupancy.occupiedRooms} de ${occupancy.usableRooms} quartos disponíveis`} tone="blue" />
						<ReservationMetric label="Chegadas hoje" value={String(occupancy.arrivalsToday.rooms)} detail="quartos" tone="gold" />
						<ReservationMetric label="Saídas hoje" value={String(occupancy.departuresToday.rooms)} detail="quartos" tone="red" />
						<ReservationMetric label="Chegadas amanhã" value={String(occupancy.arrivalsTomorrow.rooms)} detail="quartos" tone="green" />
						<ReservationMetric label="Saídas amanhã" value={String(occupancy.departuresTomorrow.rooms)} detail="quartos" tone="neutral" />
					</section>
					{isAdmin && <section className="reservation-room-occupancy" aria-labelledby="reservation-room-occupancy-title">
						<div className="reservation-room-occupancy-heading"><div><p className="eyebrow">ACOMPANHAMENTO DE HOJE</p><h2 id="reservation-room-occupancy-title">Grade de ocupação dos quartos</h2></div><span>{loading || receptionLoading || !currentReservationIndexLoaded ? 'Carregando...' : `${occupancyRooms.filter((room) => room.occupied).length} ocupados · ${occupancyRooms.length} quartos`}</span></div>
						{loading || receptionLoading || !currentReservationIndexLoaded ? <div className="loading-state">Carregando ocupação dos quartos...</div> : !occupancyRooms.length ? <div className="reservation-empty"><strong>Nenhum quarto cadastrado</strong><p>Cadastre os quartos para acompanhar a ocupação.</p></div> : <div className="reservation-room-grid" role="list">
							{occupancyRooms.map((room) => {
								const status = room.occupied ? 'occupied' : room.maintenanceStatus === 'em_manutencao' ? 'maintenance' : 'free';
								const label = status === 'occupied' ? 'Ocupado' : status === 'maintenance' ? 'Em manutenção' : 'Livre';
								const reservation = Object.values(currentReservationIndex).find((item) => item.roomNumber.trim() === room.number.trim() && reservationOccupiesToday(item, today, now.getTime()));
								const stay = Object.values(receptionDirectory.stays).find((item) => item.roomNumber.trim() === room.number.trim() && guestStayOccupiesToday(item, today, now.getTime()));
								const target = reservation ? `/reservas?reservation=${encodeURIComponent(reservation.id)}&room=${encodeURIComponent(room.number)}` : stay ? `/reservas?stay=${encodeURIComponent(stay.id)}&room=${encodeURIComponent(room.number)}` : `/quartos?room=${encodeURIComponent(room.number)}`;
								return <article key={room.number} role="listitem"><Link to={target} onClick={() => setDismissedContext('')} className={`reservation-room-tile is-${status}`} aria-label={`Quarto ${room.number}, ${label}${room.guestName ? ` por ${room.guestName}` : ''}. ${room.occupied ? 'Ver hospedagem' : 'Gerenciar quarto'}`}>
									<div className="reservation-room-tile-top"><strong>Quarto {room.number}</strong><span>{label}</span></div>
									<p>{room.occupied ? room.guestName || 'Hóspede hospedado' : status === 'maintenance' ? 'Indisponível para hospedagem' : 'Sem hospedagem ativa'}</p>
								</Link></article>;
							})}
						</div>}
					</section>}
					<section className="reservation-panel">
						<div className="reservation-toolbar"><div className="reservation-period"><label className="schedule-field"><span>Check-in de</span><input name="reservationFrom" type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} /></label><label className="schedule-field"><span>Até</span><input name="reservationTo" type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} /></label></div><div className="reservation-toolbar-controls"><div className="reservation-tabs" role="tablist" aria-label="Filtrar reservas">{([['proximas', 'Ativas'], ['chegadas', 'Chegadas'], ['hospedados', 'Hospedados'], ['todas', 'Todas']] as [ReservationFilter, string][]).map(([id, label]) => <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>{label}</button>)}</div><label className="schedule-field reservation-search"><span>Buscar hóspede ou quarto</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, telefone ou quarto" /></label></div></div>
						{loading || receptionLoading ? <div className="loading-state">Carregando reservas e hospedagens...</div> : !validDateRange ? <div className="reservation-empty"><strong>Informe um período válido</strong><p>A data final deve ser igual ou posterior à data inicial.</p></div> : !rooms.length ? <div className="reservation-empty"><strong>Cadastre os quartos antes de criar reservas</strong><p>O mapa de reservas usa os mesmos quartos e status do serviço de quarto.</p>{isAdmin && <Link className="button button-primary" to="/quartos">Cadastrar quartos</Link>}</div> : !visibleReservations.length ? <div className="reservation-empty"><strong>Nenhuma reserva nesta visão</strong><p>Hospedagens registradas pela recepção aparecem na seção abaixo.</p><button className="button button-primary" onClick={openCreate}>+ Nova reserva</button></div> : <div className="reservation-list">{visibleReservations.map((reservation) => {
							const room = data.rooms[reservation.roomId];
							const checkInAt = new Date(`${reservation.checkInDate}T${reservation.channel === 'rotativo' ? reservation.checkInTime : '00:00'}:00`);
							const canCheckIn = reservation.status === 'confirmada' && checkInAt <= new Date() && room?.cleaningStatus === 'limpo' && room.maintenanceStatus !== 'em_manutencao';
							return <article className="reservation-card" key={reservation.id}>
								<div className="rc-main"><div className="rc-title"><strong>{reservation.guestName}</strong><span className={`reservation-status reservation-${reservation.status}`}>{statusLabels[reservation.status]}</span></div><small className={`reservation-channel channel-${reservation.channel ?? 'unknown'}`}>{reservation.channel ? channelLabels[reservation.channel] : 'Origem não informada'}</small>{reservation.phone && <small>{reservation.phone}</small>}{reservation.oyoReservationNumber && <small>Reserva OYO {reservation.oyoReservationNumber}</small>}{(reservation.guests?.length ?? 0) > 1 && <small>+ {reservation.guests?.slice(1).map((guest) => guest.name).join(', ')}</small>}{reservation.invoiceRequested && <small>Com nota fiscal{reservation.invoiceNumber ? ` nº ${reservation.invoiceNumber}` : ''}</small>}{reservation.note && <small>{reservation.note}</small>}</div>
								<div className="rc-field"><span className="rc-label">Quarto</span><strong>{reservation.roomNumber}</strong>{room?.maintenanceStatus === 'manutencao_necessaria' && <small>Manutenção necessária</small>}</div>
								<div className="rc-field"><span className="rc-label">Check-in</span><strong>{formatDate(reservation.checkInDate)}</strong>{reservation.checkInTime && <small>às {reservation.checkInTime}</small>}</div>
								<div className="rc-field"><span className="rc-label">Checkout</span><strong>{formatDate(reservation.checkOutDate)}</strong>{reservation.checkOutTime && <small>às {reservation.checkOutTime}</small>}</div>
								<div className="rc-field"><span className="rc-label">Pessoas</span><strong>{guestCount(reservation)}</strong><small>{reservation.adults} adultos · {reservation.children} crianças</small></div>
								<div className="rc-field rc-money"><span className="rc-label">Hospedagem</span><strong>{reservation.reservationAmount === undefined && reservation.nightlyRate === undefined ? 'Valor não informado' : money(reservationTotal(reservation))}</strong><small>{reservation.tax ? `Taxa ${money(reservation.tax)}` : ''}{reservation.tax ? ' · ' : ''}{reservation.breakfastIncluded ? 'Com café da manhã' : 'Sem café da manhã'}</small><small>Devido {money(amountDue(reservation))}{reservationExtrasCount(reservation, extras) > 0 ? ` · ${reservationExtrasCount(reservation, extras)} extra(s)` : ''}</small></div>
								<div className="reservation-row-actions">{isAdmin && <button disabled={saving || financialLoading} onClick={() => openEdit(reservation)}>Editar</button>}{reservation.status === 'confirmada' && <><button className="reservation-action-primary" onClick={() => void checkIn(reservation)} disabled={!canCheckIn || saving} title={!canCheckIn ? room?.cleaningStatus !== 'limpo' ? 'O quarto precisa estar limpo' : room?.maintenanceStatus === 'em_manutencao' ? 'Quarto em manutenção' : 'Check-in disponível a partir do horário previsto' : undefined}>Check-in</button>{isAdmin && <button className="danger" onClick={() => void cancelReservation(reservation)}>Cancelar</button>}</>}{reservation.status === 'hospedado' && <><button onClick={() => setExtraReservation(reservation)}>Lançar extra</button><button className="reservation-action-primary" disabled={saving || financialLoading} onClick={() => checkOut(reservation)}>Checkout</button></>}{isAdmin && <button className="danger" disabled={saving} onClick={() => void removeReservation(reservation)}>Excluir</button>}</div>
							</article>;
						})}</div>}
						{!loading && !receptionLoading && <section className="reception-stays-section" aria-labelledby="reception-stays-title">
							<div className="reception-stays-heading"><div><h2 id="reception-stays-title">Hospedagens cadastradas pela recepção</h2><p>Registros feitos em “Adicionar hóspede”.</p></div><span>{visibleReceptionStays.length} {visibleReceptionStays.length === 1 ? 'registro' : 'registros'}</span></div>
							{visibleReceptionStays.length ? <div className="reservation-list">{visibleReceptionStays.map((stay) => {
								const checkoutDate = stayCheckOutDate(stay);
								const currentlyHosted = guestStayOccupiesToday(stay, today, now.getTime());
								const statusLabel = stay.status === 'encerrado' ? 'Encerrado'
									: stay.checkInDate > today ? 'Programado'
										: currentlyHosted ? 'Hospedado' : 'Período encerrado';
								const statusClass = statusLabel === 'Hospedado' ? 'reservation-hospedado'
									: statusLabel === 'Programado' ? 'reservation-confirmada' : 'reservation-encerrada';
								return <article className="reservation-card reception-stay-card" key={stay.id}>
									<div className="rc-main"><div className="rc-title"><strong>{stay.guestName || 'Hóspede sem nome'}</strong><span className={`reservation-status ${statusClass}`}>{statusLabel}</span></div><small className="reservation-channel channel-balcao">{stay.kind === 'periodo' ? 'Rotativo · 4 horas' : 'Balcão · diária'}</small>{stay.attendant && <small>Atendente: {stay.attendant}</small>}{stay.note && <small>{stay.note}</small>}</div>
									<div className="rc-field"><span className="rc-label">Quarto</span><strong>{stay.roomNumber || '—'}</strong></div>
									<div className="rc-field"><span className="rc-label">Check-in</span><strong>{formatDate(stay.checkInDate)}</strong></div>
									<div className="rc-field"><span className="rc-label">Checkout</span><strong>{checkoutDate ? formatDate(checkoutDate) : '—'}</strong></div>
									<div className="rc-field"><span className="rc-label">Pessoas</span><strong>{Math.max(1, stay.guestCount ?? (stay.hasAdditionalGuests ? 2 : 1))}</strong></div>
									{isAdmin && <div className="reservation-row-actions reception-stay-actions"><button disabled={saving} onClick={() => { setError(''); setNotice(''); setEditingReceptionStay(stay); }}>Editar</button><button className="danger" disabled={saving} onClick={() => void removeReceptionStay(stay)}>Excluir</button></div>}
								</article>;
							})}</div> : <div className="reservation-empty"><strong>Nenhuma hospedagem da recepção nesta visão</strong><p>Altere o filtro ou a busca para localizar outros registros.</p></div>}
						</section>}
					</section>
					<footer className="finance-page-footer"><span>Armazenamento: {housekeepingStorageMode}</span><span>Ocupação vinculada aos quartos e ao check-in</span></footer>
					{isAdmin && <ReservationAudit events={Object.values(data.auditLog ?? {}).filter((event) => event.entity === 'reservation').sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 20)} />}
				</div>
			</main>
			{reservationEditorOpen && <ReservationEditor key={selected?.id || 'new-reservation'} rooms={rooms} reservation={selected} data={data} payments={selected ? reservationPayments(selected.id, financeData) : []} externalExtras={selected ? Object.values(extras).filter((extra) => extra.reservationId === selected.id) : []} pendingReceived={selected ? pendingCollectionsTotal(selected.id, collections, financeData) : 0} isAdmin={isAdmin} saving={saving || financialLoading} error={error || contextError} onClose={closeReservationEditor} onSubmit={saveReservation} />}
			{isAdmin && activeReceptionStay && <CaixaRecepcao userRole={userRole} modalOnly editingStay={activeReceptionStay} entryContext={receptionEntryContext} onModalClose={(message) => { if (message) { showSavedReceptionStay(activeReceptionStay.id); setError(''); setNotice(message); } else { setEditingReceptionStay(null); clearContextSelection(); } }} />}
			{activeCheckoutReservation && <CheckoutEditor key={`${activeCheckoutReservation.id}-${amountDue(activeCheckoutReservation)}`} reservation={activeCheckoutReservation} due={amountDue(activeCheckoutReservation)} saving={saving || financialLoading} error={error} onClose={closeCheckoutEditor} onSubmit={(event) => void submitCheckOut(event, activeCheckoutReservation)} />}
			{extraReservation && <ExtraEditor key={extraReservation.id} reservation={extraReservation} saving={saving} error={error} onClose={() => setExtraReservation(null)} onSubmit={(event) => void submitExtra(event, extraReservation)} />}
		</div>
	);
}

function ReservationMetric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
	return <article className={`housekeeping-metric metric-${tone}`}><span className="metric-rule" /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function ReservationAudit({ events }: { events: AuditEvent[] }) {
	return <details className="reservation-audit"><summary>Histórico de reservas</summary>{events.length ? <ol>{events.map((event) => <li key={event.id}><strong>{event.action}</strong><span>{new Date(event.occurredAt).toLocaleString('pt-BR')} · registro {event.recordId} · usuário {event.actorUid}</span></li>)}</ol> : <p>Nenhuma alteração registrada ainda.</p>}</details>;
}

function ExtraEditor({ reservation, saving, error, onClose, onSubmit }: { reservation: Reservation; saving: boolean; error: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
	const [extraId] = useState(createId);
	return <div className="modal-backdrop reservation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="stock-modal housekeeping-modal reservation-modal checkout-modal" role="dialog" aria-modal="true" aria-labelledby="extra-modal-title"><form className="reservation-form" onSubmit={onSubmit}>
		<header className="reservation-modal-heading"><div><p className="eyebrow">RECEPÇÃO <span>/</span> CONSUMO</p><h2 id="extra-modal-title">Lançar extra · quarto {reservation.roomNumber}</h2><p>{reservation.guestName} · o valor será adicionado ao saldo do checkout.</p></div><button type="button" className="schedule-modal-close" onClick={onClose} aria-label="Fechar">×</button></header>
		<div className="reservation-modal-content"><section className="reservation-form-section"><input type="hidden" name="extraId" value={extraId} /><label className="schedule-field"><span>Item *</span><select name="type" required defaultValue="cafe_manha"><option value="cafe_manha">Café da manhã</option><option value="colchao_extra">Colchão extra</option><option value="pessoa_adicional">Pessoa adicional</option><option value="checkin_antecipado">Check-in antecipado</option><option value="checkout_tardio">Check-out tardio</option><option value="consumo">Consumo</option></select></label><label className="schedule-field"><span>Valor a cobrar (R$) *</span><input name="amount" type="number" min="0.01" step="0.01" required autoFocus /></label><div className="reservation-hint">O lançamento ficará vinculado à hospedagem ativa e será somado ao saldo devido.</div></section></div>
		{error && <p className="reservation-modal-error" role="alert">{error}</p>}
		<footer className="reservation-modal-footer"><button className="button button-plain" type="button" onClick={onClose}>Cancelar</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Lançando...' : 'Lançar no quarto'}</button></footer>
	</form></section></div>;
}

function CheckoutEditor({ reservation, due, saving, error, onClose, onSubmit }: { reservation: Reservation; due: number; saving: boolean; error: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
	const [amount, setAmount] = useState(due > 0 ? due.toFixed(2) : '0.00');
	const [paymentMethod, setPaymentMethod] = useState<FinancePaymentMethod>('cash');
	const [collectionId] = useState(createId);
	return <div className="modal-backdrop reservation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="stock-modal housekeeping-modal reservation-modal checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-modal-title"><form className="reservation-form" onSubmit={onSubmit}>
		<header className="reservation-modal-heading"><div><p className="eyebrow">RECEPÇÃO <span>/</span> ENCERRAMENTO</p><h2 id="checkout-modal-title">Checkout · quarto {reservation.roomNumber}</h2><p>{reservation.guestName}</p></div><button type="button" className="schedule-modal-close" onClick={onClose} aria-label="Fechar">×</button></header>
		<div className="reservation-modal-content"><section className="reservation-form-section"><div className="reservation-total-row"><span>Saldo devido</span><strong>{money(due)}</strong></div>{due > 0 ? <><p className="reservation-hint">Registre o valor recebido neste checkout. Se houver saldo restante, ele continuará visível para a gerência.</p><input type="hidden" name="collectionId" value={collectionId} /><div className="reservation-form-grid"><label className="schedule-field reservation-field-wide"><span>Valor recebido (R$)</span><input name="collectionAmount" type="number" min="0.01" max={due} step="0.01" required value={amount} onChange={(event) => setAmount(event.target.value)} /></label><label className="schedule-field reservation-field-wide"><span>Forma de pagamento</span><select name="paymentMethod" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as FinancePaymentMethod)}><option value="cash">Dinheiro</option><option value="pix">Pix</option><option value="debit">Cartão de débito</option><option value="credit">Cartão de crédito</option><option value="bank_transfer">Transferência bancária</option></select></label></div><div className="reservation-total-row checkout-remaining-row"><span>Restará após este recebimento</span><strong>{money(Math.max(0, due - Number(amount || 0)))}</strong></div></> : <p className="reservation-hint">Não há saldo pendente para esta hospedagem.</p>}</section></div>
		{error && <p className="reservation-modal-error" role="alert">{error}</p>}
		<footer className="reservation-modal-footer"><button className="button button-plain" type="button" onClick={onClose}>Cancelar</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Finalizando...' : due > 0 ? 'Receber e finalizar checkout' : 'Finalizar checkout'}</button></footer>
	</form></section></div>;
}

function ReservationEditor({ rooms, reservation, data, payments, externalExtras, pendingReceived, isAdmin, saving, error, onClose, onSubmit }: { rooms: HousekeepingRoom[]; reservation?: Reservation; data: HousekeepingData; payments: FinanceIncome[]; externalExtras: ReservationExtra[]; pendingReceived: number; isAdmin: boolean; saving: boolean; error: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>, originalReservation?: Reservation) => void }) {
	const [originalReservation] = useState(reservation);
	const [checkIn, setCheckIn] = useState(reservation?.checkInDate ?? dateKey(new Date()));
	const [checkOut, setCheckOut] = useState(reservation?.checkOutDate ?? dateKeyAfterDays(1));
	const [channel, setChannel] = useState<ReservationChannel | ''>(reservation?.channel ?? '');
	const [checkInTime, setCheckInTime] = useState(reservation?.checkInTime ?? '14:00');
	const [checkOutTime, setCheckOutTime] = useState(reservation?.checkOutTime ?? fourHourCheckout(reservation?.checkInDate ?? checkIn, reservation?.checkInTime ?? '14:00').time);
	const [dailyRate, setDailyRate] = useState(String(reservation?.nightlyRate ?? (reservation?.reservationAmount !== undefined ? reservation.reservationAmount / Math.max(1, reservation.channel === 'rotativo' ? 1 : reservationNights(reservation.checkInDate, reservation.checkOutDate)) : 0)));
	const [oyoFee, setOyoFee] = useState(String(reservation?.oyoFee ?? reservation?.tax ?? 0));
	const [oyoFeePayer, setOyoFeePayer] = useState<'hospede' | 'oyo'>(reservation?.oyoFeePaidToOyo ? 'oyo' : 'hospede');
	const [guests, setGuests] = useState<GuestDraft[]>(() => reservation?.guests?.length ? reservation.guests.map((guest) => ({ ...emptyGuest(), ...guest })) : [{ ...emptyGuest(), name: reservation?.guestName ?? '', phone: reservation?.phone ?? '' }]);
	const [paymentLines, setPaymentLines] = useState<PaymentDraft[]>([]);
	const [existingPayments, setExistingPayments] = useState<ExistingPaymentDraft[]>(() => payments.flatMap((income) => incomeItems(income).map((item) => ({ incomeId: income.id, itemId: item.id, version: income.updatedAt, date: income.date, description: item.description, method: item.paymentMethod, amount: item.amount.toFixed(2) }))));
	const [invoice, setInvoice] = useState(reservation?.invoiceRequested ?? false);
	const [breakfastIncluded, setBreakfastIncluded] = useState(reservation?.breakfastIncluded ?? false);
	const [paymentDate, setPaymentDate] = useState(dateKey(new Date()));
	const [paymentMethod, setPaymentMethod] = useState<FinancePaymentMethod>(reservation?.channel === 'oyo' ? 'prepaid' : 'cash');
	const [roomId, setRoomId] = useState(reservation?.roomId ?? '');
	const [reservationId] = useState(reservation?.id ?? createId());
	const [extraAmounts, setExtraAmounts] = useState<Partial<Record<ReservationExtraType, string>>>({});
	const [extraIds] = useState<Record<ReservationExtraType, string>>(() => Object.fromEntries(Object.keys(extraLabels).map((type) => [type, createId()])) as Record<ReservationExtraType, string>);
	const availableRooms = rooms.filter((room) => room.maintenanceStatus !== 'em_manutencao' || room.id === reservation?.roomId);
	const standardCheckOut = channel !== 'rotativo' && checkOut <= checkIn
		? dateKeyAfterDays(1, new Date(`${checkIn}T12:00:00`))
		: checkOut;
	const tax = channel === 'oyo' && oyoFeePayer === 'hospede' ? Number(oyoFee || 0) : 0;
	const reservationAmount = Number(dailyRate || 0) * (channel === 'rotativo' ? 1 : reservationNights(checkIn, standardCheckOut));
	const existingExtrasTotal = (reservation ? storedExtrasTotal(reservation) : 0) + externalExtras.reduce((sum, extra) => sum + extra.amount, 0);
	const total = reservationAmount + tax + existingExtrasTotal;
	const updateGuest = (index: number, key: keyof GuestDraft, value: string) => setGuests((current) => current.map((guest, position) => position === index ? { ...guest, [key]: value } : guest));
	const updatePayment = (key: string, patch: Partial<PaymentDraft>) => setPaymentLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
	const draftPaymentsTotal = paymentLines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
	const draftExtrasTotal = Object.values(extraAmounts).reduce((sum, amount) => sum + Number(amount || 0), 0);
	const received = existingPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) + pendingReceived;
	const updateExistingPayment = (incomeId: string, itemId: string, patch: Partial<ExistingPaymentDraft>) => setExistingPayments((current) => current.map((payment) => payment.incomeId === incomeId && (payment.itemId === itemId || patch.date !== undefined) ? { ...payment, ...patch } : payment));

	return <div className="modal-backdrop reservation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="stock-modal housekeeping-modal reservation-modal reservation-modal-wide" role="dialog" aria-modal="true" aria-labelledby="reservation-modal-title"><form className="reservation-form" onSubmit={(event) => onSubmit(event, originalReservation)}>
		<input type="hidden" name="reservationId" value={reservationId} />
		<header className="reservation-modal-heading"><div><p className="eyebrow">RECEPÇÃO <span>/</span> HOSPEDAGEM</p><h2 id="reservation-modal-title">{reservation ? 'Editar reserva' : 'Nova reserva'}</h2><p>{reservation ? `Quarto ${reservation.roomNumber} · ${statusLabels[reservation.status]}. As alterações atualizam os módulos conectados.` : 'Informe os dados da estadia e confirme o valor combinado.'}</p></div><button type="button" className="schedule-modal-close" onClick={onClose} aria-label="Fechar">×</button></header>
		<div className="reservation-live-summary" aria-live="polite"><div><span>{channel === 'rotativo' ? 'Locação' : 'Diárias'}</span><strong>{channel === 'rotativo' ? '4 horas' : reservationNights(checkIn, standardCheckOut)}</strong></div><div><span>Valor da diária</span><strong>{money(Number(dailyRate || 0))}</strong></div><div><span>Hospedagem</span><strong>{money(reservationAmount)}</strong></div>{tax > 0 && <div><span>Taxa OYO</span><strong>{money(tax)}</strong></div>}{(draftExtrasTotal > 0 || existingExtrasTotal > 0) && <div><span>Extras</span><strong>{money(draftExtrasTotal + existingExtrasTotal)}</strong></div>}<div className="reservation-live-total"><span>Total</span><strong>{money(total + draftExtrasTotal)}</strong></div>{isAdmin && <div><span>Saldo após recebimento</span><strong>{money(Math.max(0, total + draftExtrasTotal - received - draftPaymentsTotal))}</strong></div>}</div>
		<div className="reservation-modal-content">
			<section className="reservation-form-section"><div className="reservation-section-heading"><span>01</span><div><h3>Hóspede e origem</h3><p>Identificação e canal da reserva</p></div></div><div className="reservation-form-grid"><fieldset className="reservation-channel-field reservation-field-wide"><legend>Origem da hospedagem</legend><div className="reservation-channel-options"><label className={channel === 'oyo' ? 'selected' : ''}><input type="radio" name="channel" value="oyo" required checked={channel === 'oyo'} onChange={() => { setChannel('oyo'); setPaymentMethod('prepaid'); }} /><span>OYO<small>Booking e outros canais</small></span></label><label className={channel === 'balcao' ? 'selected' : ''}><input type="radio" name="channel" value="balcao" required checked={channel === 'balcao'} onChange={() => { setChannel('balcao'); setPaymentMethod('cash'); }} /><span>Balcão<small>Sem reserva de canal</small></span></label><label className={channel === 'rotativo' ? 'selected' : ''}><input type="radio" name="channel" value="rotativo" required checked={channel === 'rotativo'} onChange={() => { const checkout = fourHourCheckout(checkIn, checkInTime); setChannel('rotativo'); setCheckOut(checkout.date); setCheckOutTime(checkout.time); setPaymentMethod('cash'); }} /><span>Rotativo<small>Locação por 4 horas</small></span></label></div></fieldset>{channel === 'oyo' && <label className="schedule-field reservation-field-wide"><span>Número da reserva OYO *</span><input name="oyoReservationNumber" required maxLength={40} defaultValue={reservation?.oyoReservationNumber} /></label>}</div></section>
			<section className="reservation-form-section"><div className="reservation-section-heading"><span>02</span><div><h3>Hóspedes</h3><p>Dados do titular e acompanhantes</p></div></div>{guests.map((guest, index) => <div className="reservation-form-grid" key={index}><strong className="reservation-field-wide">Hóspede {index + 1}{index === 0 ? ' (titular)' : ''}</strong><label className="schedule-field reservation-field-wide"><span>Nome *</span><input name="guestName" required maxLength={100} value={guest.name} onChange={(event) => updateGuest(index, 'name', event.target.value)} autoFocus={index === 0} /></label><label className="schedule-field"><span>CPF *</span><input name="guestCpf" required inputMode="numeric" maxLength={14} placeholder="000.000.000-00" value={maskCpf(guest.cpf)} onChange={(event) => updateGuest(index, 'cpf', maskCpf(event.target.value))} /></label><label className="schedule-field"><span>Data de nascimento *</span><DateInput name="guestBirth" required max={dateKey(new Date())} value={guest.birthDate} onValueChange={(next) => updateGuest(index, 'birthDate', next)} /></label><label className="schedule-field"><span>Celular{index === 0 ? ' *' : ''}</span><input name="guestPhone" type="tel" required={index === 0} maxLength={30} value={guest.phone} onChange={(event) => updateGuest(index, 'phone', event.target.value)} /></label><label className="schedule-field"><span>CNPJ (opcional)</span><input name="guestCnpj" inputMode="numeric" maxLength={18} value={guest.cnpj} onChange={(event) => updateGuest(index, 'cnpj', event.target.value)} /></label><label className="schedule-field reservation-field-wide"><span>E-mail (opcional)</span><input name="guestEmail" type="email" maxLength={100} value={guest.email} onChange={(event) => updateGuest(index, 'email', event.target.value)} /></label>{index > 0 && <button type="button" className="button button-plain reservation-field-wide" onClick={() => setGuests((current) => current.filter((_, position) => position !== index))}>Remover hóspede {index + 1}</button>}</div>)}<button type="button" className="button button-plain" onClick={() => setGuests((current) => [...current, emptyGuest()])}>+ Adicionar hóspede {guests.length + 1}</button><div className="reservation-form-grid"><strong className="reservation-field-wide">Endereço (opcional)</strong><label className="schedule-field reservation-field-wide"><span>Rua</span><input name="address_street" maxLength={120} defaultValue={reservation?.address?.street} /></label><label className="schedule-field"><span>Número</span><input name="address_number" maxLength={20} defaultValue={reservation?.address?.number} /></label><label className="schedule-field"><span>Bairro</span><input name="address_district" maxLength={80} defaultValue={reservation?.address?.district} /></label><label className="schedule-field"><span>Cidade</span><input name="address_city" maxLength={80} defaultValue={reservation?.address?.city} /></label><label className="schedule-field"><span>CEP</span><input name="address_zip" inputMode="numeric" maxLength={9} placeholder="00000-000" defaultValue={maskCep(reservation?.address?.zip ?? '')} onChange={(event) => { event.target.value = maskCep(event.target.value); }} /></label></div></section>
							<section className="reservation-form-section"><div className="reservation-section-heading"><span>03</span><div><h3>Estadia</h3><p>Quarto, período e hóspedes</p></div></div><div className="reservation-form-grid"><label className="schedule-field reservation-field-wide"><span>Quarto</span><select name="roomId" required value={roomId} onChange={(event) => setRoomId(event.target.value)}><option value="">Selecione um quarto</option>{availableRooms.map((room) => {const conflict = reservationOverlaps(data, { id: reservation?.id ?? '__nova__', roomId: room.id, checkInDate: checkIn, checkOutDate: channel === 'rotativo' ? fourHourCheckout(checkIn, checkInTime).date : standardCheckOut, channel: channel || undefined, checkInTime, checkOutTime: channel === 'rotativo' ? fourHourCheckout(checkIn, checkInTime).time : undefined });const roomType = room.categoryName || room.bedComposition || room.category || room.bedCount ? roomCategoryDescription(room) : '';return <option key={room.id} value={room.id} disabled={conflict}>{room.number}{roomType ? ` · ${roomType}` : ''}{room.maintenanceStatus === 'manutencao_necessaria' ? ' · manutenção necessária' : ''}{conflict ? ' · reservado neste período' : ''}</option>;})}</select></label>{channel === 'rotativo' ? <><label className="schedule-field"><span>Data de entrada</span><DateInput name="checkInDate" required value={checkIn} onValueChange={(next) => { if (!next) return; const checkout = fourHourCheckout(next, checkInTime); setCheckIn(next); setCheckOut(checkout.date); setCheckOutTime(checkout.time); }} /></label><label className="schedule-field"><span>Horário de entrada</span><input name="checkInTime" type="time" step="900" required value={checkInTime} onChange={(event) => { const checkout = fourHourCheckout(checkIn, event.target.value); setCheckInTime(event.target.value); setCheckOut(checkout.date); setCheckOutTime(checkout.time); }} /></label><input name="checkOutDate" type="hidden" value={checkOut} /><input name="checkOutTime" type="hidden" value={checkOutTime} /><div className="reservation-rotativo-checkout"><span>Checkout previsto</span><strong>{formatDate(checkOut)} às {checkOutTime}</strong><small>Quatro horas após a entrada</small></div></> : <><label className="schedule-field"><span>Check-in</span><DateInput name="checkInDate" required value={checkIn} onValueChange={(next) => { if (next) setCheckIn(next); }} /></label><label className="schedule-field"><span>Checkout</span><DateInput name="checkOutDate" required min={checkIn} value={standardCheckOut} onValueChange={(next) => { if (next) setCheckOut(next); }} /></label></>}<label className="schedule-field"><span>Crianças</span><input name="children" type="number" min="0" max="20" required defaultValue={reservation?.children ?? 0} /></label></div></section>
			<section className="reservation-form-section"><div className="reservation-section-heading"><span>04</span><div><h3>Valores e serviços</h3><p>Preço acordado e itens incluídos</p></div></div><div className="reservation-form-grid"><label className="schedule-field"><span>Valor da diária (R$)</span><input name="dailyRate" type="number" min="0" step="0.01" required value={dailyRate} onChange={(event) => setDailyRate(event.target.value)} /></label>{channel === 'oyo' && <><label className="schedule-field"><span>Taxa informada na reserva (R$)</span><input name="oyoFee" type="number" min="0" step="0.01" value={oyoFee} onChange={(event) => setOyoFee(event.target.value)} /></label><label className="schedule-field reservation-field-wide"><span>Pagamento da taxa</span><select name="oyoFeePayer" value={oyoFeePayer} onChange={(event) => setOyoFeePayer(event.target.value as 'hospede' | 'oyo')}><option value="hospede">Hóspede paga na reserva/estadia</option><option value="oyo">Já paga diretamente à OYO</option></select></label></>}<label className="reservation-check-option reservation-field-wide"><input type="checkbox" name="breakfastIncluded" value="yes" checked={breakfastIncluded} onChange={(event) => setBreakfastIncluded(event.target.checked)} /><span>Café da manhã incluído</span></label><fieldset className="reservation-channel-field reservation-field-wide"><legend>Nota fiscal</legend><div className="reservation-channel-options"><label className={!invoice ? 'selected' : ''}><input type="radio" name="invoiceRequested" value="no" checked={!invoice} onChange={() => setInvoice(false)} /><span>Sem nota fiscal</span></label><label className={invoice ? 'selected' : ''}><input type="radio" name="invoiceRequested" value="yes" checked={invoice} onChange={() => setInvoice(true)} /><span>Com nota fiscal</span></label></div></fieldset>{invoice && <label className="schedule-field reservation-field-wide"><span>Número da nota fiscal</span><input name="invoiceNumber" maxLength={40} defaultValue={reservation?.invoiceNumber} placeholder="Informe quando a nota for emitida" /></label>}</div><div className="reservation-total-row"><span>Total da reserva com extras</span><strong>{money(total + draftExtrasTotal)}</strong></div>{isAdmin && <div className="reservation-admin-balance"><span>Quitado pelo hóspede <strong>{money(received)}</strong></span><span>Saldo <strong>{money(Math.max(0, total + draftExtrasTotal - received))}</strong></span></div>}</section>
			<section className="reservation-form-section"><div className="reservation-section-heading"><span>05</span><div><h3>Extras da hospedagem</h3><p>Itens cobrados junto ao saldo do quarto</p></div></div>{((reservation?.extras?.length ?? 0) > 0 || externalExtras.length > 0) && <div className="reservation-payment-history"><strong>Extras já lançados</strong>{[...(reservation?.extras ?? []), ...externalExtras].map((extra) => <small key={extra.id}>{extra.description} · {money(extra.amount)}</small>)}</div>}<div className="reservation-extra-list">{(Object.entries(extraLabels) as [ReservationExtraType, string][]).map(([type, label]) => <div className="reservation-extra-option" key={type}><label><input type="checkbox" name="extraType" value={type} checked={extraAmounts[type] !== undefined} onChange={(event) => setExtraAmounts((current) => { const next = { ...current }; if (event.target.checked) next[type] = ''; else delete next[type]; return next; })} /><span>{label}</span></label>{extraAmounts[type] !== undefined && <><input type="hidden" name={`extraId_${type}`} value={extraIds[type]} /><label className="schedule-field"><span>Valor (R$)</span><input name={`extraAmount_${type}`} type="number" min="0.01" step="0.01" required value={extraAmounts[type]} onChange={(event) => setExtraAmounts((current) => ({ ...current, [type]: event.target.value }))} /></label></>}</div>)}</div></section>
			{isAdmin && <section className="reservation-form-section"><div className="reservation-section-heading"><span>06</span><div><h3>Recebimento</h3><p>Opcional; somente para a gerência</p></div></div>{existingPayments.length > 0 && <div className="reservation-payment-history reservation-payment-edit-history"><strong>Recebimentos registrados</strong><p className="reservation-hint">As correções de valor, data e forma de pagamento também atualizam o fluxo de caixa.</p>{existingPayments.map((payment) => <div className="reservation-existing-payment" key={`${payment.incomeId}-${payment.itemId}`}><input type="hidden" name="existingIncomeId" value={payment.incomeId} /><input type="hidden" name="existingItemId" value={payment.itemId} /><input type="hidden" name="existingPaymentVersion" value={payment.version} /><strong>{payment.description}</strong><label className="schedule-field"><span>Data</span><DateInput name="existingPaymentDate" required max={dateKey(new Date())} value={payment.date} onValueChange={(date) => updateExistingPayment(payment.incomeId, payment.itemId, { date })} /></label><label className="schedule-field"><span>Forma de pagamento</span><select name="existingPaymentMethod" value={payment.method} onChange={(event) => updateExistingPayment(payment.incomeId, payment.itemId, { method: event.target.value as FinancePaymentMethod })}>{Object.entries(paymentLabels).map(([method, label]) => <option key={method} value={method}>{label}</option>)}</select></label><label className="schedule-field"><span>Valor recebido (R$)</span><input name="existingPaymentAmount" type="number" min="0.01" step="0.01" required value={payment.amount} onChange={(event) => updateExistingPayment(payment.incomeId, payment.itemId, { amount: event.target.value })} /></label></div>)}</div>}{pendingReceived > 0 && <p className="reservation-hint">Recebimento de checkout em conciliação: {money(pendingReceived)}.</p>}<div className="reservation-form-grid"><label className="schedule-field reservation-field-wide"><span>Valor total recebido agora</span><input value={money(draftPaymentsTotal)} readOnly tabIndex={-1} /></label>{paymentLines.map((line) => <div className="reservation-extra-option reservation-field-wide" key={line.key}><input type="hidden" name="payId" value={line.key} /><label className="schedule-field"><span>Referente a</span><select name="payTarget" value={line.target} onChange={(event) => updatePayment(line.key, { target: event.target.value })}>{paymentTargets.map((target) => <option key={target} value={target}>{target}</option>)}</select></label><label className="schedule-field"><span>Forma</span><select name="payMethod" value={line.method} onChange={(event) => updatePayment(line.key, { method: event.target.value as FinancePaymentMethod })}><option value="cash">Dinheiro</option><option value="pix">Pix</option><option value="debit">Cartão de débito</option><option value="credit">Cartão de crédito</option><option value="bank_transfer">Transferência bancária</option>{channel === 'oyo' && <option value="prepaid">{PAYMENT_METHOD_LABELS.prepaid}</option>}</select></label><label className="schedule-field"><span>Valor (R$)</span><input name="payAmount" type="number" min="0.01" step="0.01" required value={line.amount} onChange={(event) => updatePayment(line.key, { amount: event.target.value })} /></label><button type="button" className="button button-plain" onClick={() => setPaymentLines((current) => current.filter((item) => item.key !== line.key))}>Remover</button></div>)}<button type="button" className="button button-plain reservation-field-wide" onClick={() => setPaymentLines((current) => [...current, { key: createId(), target: 'Hospedagem', method: paymentMethod, amount: '' }])}>+ Adicionar forma de pagamento</button><label className="schedule-field reservation-field-wide"><span>Data do recebimento</span><DateInput name="paymentDate" value={paymentDate} onValueChange={setPaymentDate} required={paymentLines.length > 0} /></label></div></section>}
			<section className="reservation-form-section reservation-form-notes"><label className="schedule-field"><span>Observação</span><textarea name="note" rows={2} maxLength={300} defaultValue={reservation?.note} /></label><p className="reservation-hint">Check-in é inclusivo e checkout exclusivo. O sistema impede sobreposição de reservas no mesmo quarto.</p></section>
		</div>
		{error && <p className="reservation-modal-error" role="alert">{error}</p>}
		<footer className="reservation-modal-footer"><button className="button button-plain" type="button" onClick={onClose}>Cancelar</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : reservation ? 'Salvar alterações' : 'Confirmar reserva'}</button></footer>
	</form></section></div>;
}
