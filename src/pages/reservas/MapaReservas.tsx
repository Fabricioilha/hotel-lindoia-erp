import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { UserRole } from '../../types';
import type { AuditEvent } from '../../types/audit';
import { incomeItems, type FinanceData, type FinanceIncome, type FinancePaymentMethod } from '../../types/finance';
import { roomCategoryLabels } from '../../types/housekeeping';
import { DateInput } from '../../components/ui/DateInput';
import type { HousekeepingData, HousekeepingRoom, Reservation, ReservationChannel, ReservationCollection, ReservationExtra, ReservationExtraType, ReservationGuest, ReservationStatus } from '../../types/housekeeping';
import { createReservation, emptyHousekeeping, housekeepingStorageMode, recordReservationCollection, recordReservationExtra, releaseReservationSlots, subscribeHousekeeping, subscribeReservationCollections, subscribeReservationExtras, syncReservationCollections, syncReservationSlots, transitionReservation, updateHousekeeping } from '../../services/housekeepingStore';
import { emptyFinance, subscribeFinance } from '../../services/financeStore';
import { dateKeyAfterDays, hotelOccupancySummary, reservationOverlaps } from '../../services/reservationAnalytics';
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
const pendingCollectionsTotal = (reservationId: string, collections: Record<string, ReservationCollection>) => Object.values(collections).filter((item) => item.reservationId === reservationId).reduce((total, item) => total + item.amount, 0);
const reservationExtrasTotal = (reservationId: string, extras: Record<string, ReservationExtra>) => Object.values(extras).filter((item) => item.reservationId === reservationId).reduce((total, item) => total + item.amount, 0);
const storedExtrasTotal = (reservation: Reservation) => (reservation.extras ?? []).reduce((total, extra) => total + extra.amount, 0);
const reservationExtrasCount = (reservation: Reservation, extras: Record<string, ReservationExtra>) => (reservation.extras?.length ?? 0) + Object.values(extras).filter((item) => item.reservationId === reservation.id).length;
const money = (amount: number) => amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const paymentLabels: Record<FinancePaymentMethod, string> = { credit: 'Cartão de crédito', debit: 'Cartão de débito', cash: 'Dinheiro', pix: 'Pix', bank_transfer: 'Transferência bancária', prepaid: 'OYO a receber' };
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
	const [financeData, setFinanceData] = useState<FinanceData>(emptyFinance());
	const [collections, setCollections] = useState<Record<string, ReservationCollection>>({});
	const [extras, setExtras] = useState<Record<string, ReservationExtra>>({});
	const [checkoutReservation, setCheckoutReservation] = useState<Reservation | null>(null);
	const [extraReservation, setExtraReservation] = useState<Reservation | null>(null);

	useEffect(() => subscribeHousekeeping((next) => {
		setData(next);
		setLoading(false);
		setError('');
	}, (cause) => {
		setLoading(false);
		setError(`Não foi possível carregar as reservas: ${cause.message}`);
	}), []);

	useEffect(() => {
		if (!isAdmin) return;
		return subscribeFinance(setFinanceData, (cause) => setError(`Não foi possível carregar os recebimentos: ${cause.message}`));
	}, [isAdmin]);

	useEffect(() => subscribeReservationCollections(setCollections, (cause) => setError(`Não foi possível carregar as cobranças: ${cause.message}`)), []);
	useEffect(() => subscribeReservationExtras(setExtras, (cause) => setError(`Não foi possível carregar os adicionais: ${cause.message}`)), []);

	useEffect(() => {
		if (isAdmin) void syncReservationCollections().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Não foi possível conciliar as cobranças de checkout.'));
	}, [isAdmin, collections]);

	const rooms = useMemo(() => Object.values(data.rooms).sort((a, b) => a.number.localeCompare(b.number, 'pt-BR', { numeric: true })), [data.rooms]);
	const reservations = useMemo(() => Object.values(data.reservations).sort((a, b) => a.checkInDate.localeCompare(b.checkInDate) || a.guestName.localeCompare(b.guestName, 'pt-BR')), [data.reservations]);
	const occupancy = hotelOccupancySummary(data);
	const visibleReservations = reservations.filter((reservation) => {
		const term = search.trim().toLocaleLowerCase('pt-BR');
		const matchesSearch = !term || reservation.guestName.toLocaleLowerCase('pt-BR').includes(term)
			|| (reservation.guests ?? []).some((guest) => guest.name.toLocaleLowerCase('pt-BR').includes(term))
			|| (reservation.oyoReservationNumber ?? '').toLocaleLowerCase('pt-BR').includes(term)
			|| reservation.roomNumber.toLocaleLowerCase('pt-BR').includes(term)
			|| reservation.phone.toLocaleLowerCase('pt-BR').includes(term);
		const matchesFilter = filter === 'todas'
			|| (filter === 'hospedados' && reservation.status === 'hospedado')
			|| (filter === 'chegadas' && reservation.status === 'confirmada' && (reservation.checkInDate === today || reservation.checkInDate === tomorrow))
			|| (filter === 'proximas' && ['confirmada', 'hospedado'].includes(reservation.status));
		return matchesSearch && matchesFilter;
	});
	const selected = data.reservations[editingId];
	const amountDue = (reservation: Reservation) => Math.round(Math.max(0, (reservation.balanceDue ?? reservationTotal(reservation) + storedExtrasTotal(reservation) - reservationPaymentsTotal(reservation.id, financeData)) + reservationExtrasTotal(reservation.id, extras) - pendingCollectionsTotal(reservation.id, collections)) * 100) / 100;

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
		const breakfastIncluded = (form.getAll('extraType').includes('cafe_manha')) || Boolean(selected?.extras?.some((extra) => extra.type === 'cafe_manha'));
		const payTargets = field('payTarget');
		const payMethods = field('payMethod');
		const paymentLines = field('payAmount').map((amount, index) => ({ id: createId(), target: payTargets[index] ?? 'Hospedagem', method: payMethods[index] as FinancePaymentMethod, amount: Number(amount || 0) }));
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
		const total = reservationAmount + tax + (selected ? storedExtrasTotal(selected) : 0) + bookingExtras.reduce((sum, extra) => sum + extra.amount, 0);
		const alreadyReceived = selected ? reservationPaymentsTotal(selected.id, financeData) : 0;
		if (alreadyReceived + paymentAmount > total + 0.001) {
			setError('O valor recebido não pode ultrapassar o total das diárias.');
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
						await updateHousekeeping((current) => {
							const saved = current.reservations[reservation.id];
							if (!saved) return current;
							return { ...current, reservations: { ...current.reservations, [reservation.id]: { ...saved, balanceDue: Math.max(0, total - paymentAmount) } } };
						});
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
		const success = await persist((current) => {
			const currentRoom = current.rooms[roomId];
			if (!currentRoom) throw new Error('O quarto selecionado não existe mais.');
			if (currentRoom.maintenanceStatus === 'em_manutencao') throw new Error('Este quarto está indisponível para manutenção.');
			if (reservationOverlaps(current, reservation)) throw new Error(`O quarto ${currentRoom.number} já tem uma reserva ativa nesse período.`);
			if (selected?.status === 'hospedado') throw new Error('A hospedagem já iniciou. Edite a reserva antes do check-in ou faça o checkout.');
			return { ...current, reservations: { ...current.reservations, [reservation.id]: reservation } };
		}, selected ? 'Reserva atualizada.' : 'Reserva criada.');
		if (success) {
			setModalOpen(false);
			try {
				await syncReservationSlots(selected, reservation);
			} catch (cause) {
				setError(cause instanceof Error ? `Reserva atualizada, mas os bloqueios de datas não foram sincronizados: ${cause.message}` : 'Reserva atualizada, mas os bloqueios de datas não foram sincronizados.');
			}
			if (paymentAmount > 0) {
				try {
					await recordPayments();
					await updateHousekeeping((current) => {
						const saved = current.reservations[reservation.id];
						if (!saved) return current;
						return { ...current, reservations: { ...current.reservations, [reservation.id]: { ...saved, balanceDue: Math.max(0, total - alreadyReceived - paymentAmount) } } };
					});
				} catch (cause) {
					setError(cause instanceof Error ? `Reserva salva, mas o recebimento não foi lançado no Financeiro: ${cause.message}` : 'Reserva salva, mas o recebimento não foi lançado no Financeiro.');
				}
			}
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
			setCheckoutReservation(null);
			setNotice(`Checkout de ${reservation.guestName} realizado; quarto liberado para limpeza.`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível concluir o checkout.');
		} finally {
			setSaving(false);
		}
	}

	async function cancelReservation(reservation: Reservation) {
		if (!window.confirm(`Cancelar a reserva de ${reservation.guestName} no quarto ${reservation.roomNumber}?`)) return;
		const success = await persist((current) => {
			const currentReservation = current.reservations[reservation.id];
			if (!currentReservation || currentReservation.status !== 'confirmada') throw new Error('Somente reservas confirmadas podem ser canceladas.');
			return { ...current, reservations: { ...current.reservations, [reservation.id]: { ...currentReservation, status: 'cancelada', updatedAt: new Date().toISOString() } } };
		}, 'Reserva cancelada.');
		if (success) {
			try {
				await releaseReservationSlots(reservation);
			} catch (cause) {
				setError(cause instanceof Error ? `Reserva cancelada, mas as datas não foram liberadas: ${cause.message}` : 'Reserva cancelada, mas as datas não foram liberadas.');
			}
		}
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
		<div className={`stock-app housekeeping-app reservations-app`}>
			<main className="stock-main">
				<header className="stock-topbar"><div className="breadcrumb"><Link to="/">Painel</Link><span>/</span><strong>Reservas</strong></div><div className="topbar-actions"><span className="user-chip">{isAdmin ? 'Gerência' : 'Equipe'}</span><Link className="back-link" to="/">Voltar ao painel</Link></div></header>
				<div className="stock-content reservation-content">
					<section className="page-heading"><div><p className="eyebrow">RECEPÇÃO</p><h1>Reservas e hospedagens</h1><p className="page-description">Disponibilidade por quarto, chegadas, estadias e saídas.</p></div><div className="heading-actions"><button className="button button-primary" onClick={openCreate} disabled={!rooms.length}>+ Nova reserva</button></div></section>
					{error && <div className="notice notice-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Fechar aviso">×</button></div>}
					{notice && <div className="notice notice-success" role="status">{notice}</div>}
					<section className="reservation-summary" aria-label="Resumo da hospedagem">
						<ReservationMetric label="Ocupação atual" value={occupancy.occupancyRate === null ? '—' : `${occupancy.occupancyRate}%`} detail={`${occupancy.occupiedRooms} de ${occupancy.usableRooms} quartos disponíveis`} tone="blue" />
						<ReservationMetric label="Chegadas hoje" value={String(occupancy.arrivalsToday.rooms)} detail="quartos" tone="gold" />
						<ReservationMetric label="Saídas hoje" value={String(occupancy.departuresToday.rooms)} detail="quartos" tone="red" />
						<ReservationMetric label="Chegadas amanhã" value={String(occupancy.arrivalsTomorrow.rooms)} detail="quartos" tone="green" />
						<ReservationMetric label="Saídas amanhã" value={String(occupancy.departuresTomorrow.rooms)} detail="quartos" tone="neutral" />
					</section>
					<section className="reservation-panel">
						<div className="reservation-toolbar"><div className="reservation-tabs" role="tablist" aria-label="Filtrar reservas">{([['proximas', 'Ativas'], ['chegadas', 'Chegadas'], ['hospedados', 'Hospedados'], ['todas', 'Todas']] as [ReservationFilter, string][]).map(([id, label]) => <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>{label}</button>)}</div><label className="schedule-field reservation-search"><span>Buscar hóspede ou quarto</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, telefone ou quarto" /></label></div>
						{loading ? <div className="loading-state">Carregando reservas...</div> : !rooms.length ? <div className="reservation-empty"><strong>Cadastre os quartos antes de criar reservas</strong><p>O mapa de reservas usa os mesmos quartos e status do serviço de quarto.</p>{isAdmin && <Link className="button button-primary" to="/quartos">Cadastrar quartos</Link>}</div> : !visibleReservations.length ? <div className="reservation-empty"><strong>Nenhuma reserva nesta visão</strong><p>Crie uma reserva para atualizar automaticamente ocupação e chegadas.</p><button className="button button-primary" onClick={openCreate}>+ Nova reserva</button></div> : <div className="reservation-list">{visibleReservations.map((reservation) => {
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
								<div className="reservation-row-actions">{reservation.status === 'confirmada' && <>{isAdmin && <button onClick={() => openEdit(reservation)}>Editar</button>}<button className="reservation-action-primary" onClick={() => void checkIn(reservation)} disabled={!canCheckIn || saving} title={!canCheckIn ? room?.cleaningStatus !== 'limpo' ? 'O quarto precisa estar limpo' : room?.maintenanceStatus === 'em_manutencao' ? 'Quarto em manutenção' : 'Check-in disponível a partir do horário previsto' : undefined}>Check-in</button>{isAdmin && <button className="danger" onClick={() => void cancelReservation(reservation)}>Cancelar</button>}</>}{reservation.status === 'hospedado' && <><button onClick={() => setExtraReservation(reservation)}>Lançar extra</button><button className="reservation-action-primary" onClick={() => checkOut(reservation)}>Checkout</button></>}</div>
							</article>;
						})}</div>}
					</section>
					<footer className="finance-page-footer"><span>Armazenamento: {housekeepingStorageMode}</span><span>Ocupação vinculada aos quartos e ao check-in</span></footer>
					{isAdmin && <ReservationAudit events={Object.values(data.auditLog ?? {}).filter((event) => event.entity === 'reservation').sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 20)} />}
				</div>
			</main>
			{modalOpen && <ReservationEditor key={editingId || 'new-reservation'} rooms={rooms} reservation={selected} data={data} payments={selected ? reservationPayments(selected.id, financeData) : []} isAdmin={isAdmin} saving={saving} error={error} onClose={() => setModalOpen(false)} onSubmit={saveReservation} />}
			{checkoutReservation && <CheckoutEditor key={`${checkoutReservation.id}-${amountDue(checkoutReservation)}`} reservation={checkoutReservation} due={amountDue(checkoutReservation)} saving={saving} error={error} onClose={() => setCheckoutReservation(null)} onSubmit={(event) => void submitCheckOut(event, checkoutReservation)} />}
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

function ReservationEditor({ rooms, reservation, data, payments, isAdmin, saving, error, onClose, onSubmit }: { rooms: HousekeepingRoom[]; reservation?: Reservation; data: HousekeepingData; payments: FinanceIncome[]; isAdmin: boolean; saving: boolean; error: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
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
	const [invoice, setInvoice] = useState(reservation?.invoiceRequested ?? false);
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
	const total = reservationAmount + tax + (reservation ? storedExtrasTotal(reservation) : 0);
	const updateGuest = (index: number, key: keyof GuestDraft, value: string) => setGuests((current) => current.map((guest, position) => position === index ? { ...guest, [key]: value } : guest));
	const updatePayment = (key: string, patch: Partial<PaymentDraft>) => setPaymentLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
	const draftPaymentsTotal = paymentLines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
	const draftExtrasTotal = Object.values(extraAmounts).reduce((sum, amount) => sum + Number(amount || 0), 0);
	const received = payments.reduce((total, income) => total + income.amount, 0);

	return <div className="modal-backdrop reservation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="stock-modal housekeeping-modal reservation-modal reservation-modal-wide" role="dialog" aria-modal="true" aria-labelledby="reservation-modal-title"><form className="reservation-form" onSubmit={onSubmit}>
		<input type="hidden" name="reservationId" value={reservationId} />
		<header className="reservation-modal-heading"><div><p className="eyebrow">RECEPÇÃO <span>/</span> HOSPEDAGEM</p><h2 id="reservation-modal-title">{reservation ? 'Editar reserva' : 'Nova reserva'}</h2><p>Informe os dados da estadia e confirme o valor combinado.</p></div><button type="button" className="schedule-modal-close" onClick={onClose} aria-label="Fechar">×</button></header>
		<div className="reservation-live-summary" aria-live="polite"><div><span>{channel === 'rotativo' ? 'Locação' : 'Diárias'}</span><strong>{channel === 'rotativo' ? '4 horas' : reservationNights(checkIn, standardCheckOut)}</strong></div><div><span>Valor da diária</span><strong>{money(Number(dailyRate || 0))}</strong></div><div><span>Hospedagem</span><strong>{money(reservationAmount)}</strong></div>{tax > 0 && <div><span>Taxa OYO</span><strong>{money(tax)}</strong></div>}{(draftExtrasTotal > 0 || (reservation ? storedExtrasTotal(reservation) : 0) > 0) && <div><span>Extras</span><strong>{money(draftExtrasTotal + (reservation ? storedExtrasTotal(reservation) : 0))}</strong></div>}<div className="reservation-live-total"><span>Total</span><strong>{money(total + draftExtrasTotal)}</strong></div>{isAdmin && <div><span>Saldo após recebimento</span><strong>{money(Math.max(0, total + draftExtrasTotal - received - draftPaymentsTotal))}</strong></div>}</div>
		<div className="reservation-modal-content">
			<section className="reservation-form-section"><div className="reservation-section-heading"><span>01</span><div><h3>Hóspede e origem</h3><p>Identificação e canal da reserva</p></div></div><div className="reservation-form-grid"><fieldset className="reservation-channel-field reservation-field-wide"><legend>Origem da hospedagem</legend><div className="reservation-channel-options"><label className={channel === 'oyo' ? 'selected' : ''}><input type="radio" name="channel" value="oyo" required checked={channel === 'oyo'} onChange={() => { setChannel('oyo'); setPaymentMethod('prepaid'); }} /><span>OYO<small>Booking e outros canais</small></span></label><label className={channel === 'balcao' ? 'selected' : ''}><input type="radio" name="channel" value="balcao" required checked={channel === 'balcao'} onChange={() => { setChannel('balcao'); setPaymentMethod('cash'); }} /><span>Balcão<small>Sem reserva de canal</small></span></label><label className={channel === 'rotativo' ? 'selected' : ''}><input type="radio" name="channel" value="rotativo" required checked={channel === 'rotativo'} onChange={() => { const checkout = fourHourCheckout(checkIn, checkInTime); setChannel('rotativo'); setCheckOut(checkout.date); setCheckOutTime(checkout.time); setPaymentMethod('cash'); }} /><span>Rotativo<small>Locação por 4 horas</small></span></label></div></fieldset>{channel === 'oyo' && <label className="schedule-field reservation-field-wide"><span>Número da reserva OYO *</span><input name="oyoReservationNumber" required maxLength={40} defaultValue={reservation?.oyoReservationNumber} /></label>}</div></section>
			<section className="reservation-form-section"><div className="reservation-section-heading"><span>02</span><div><h3>Hóspedes</h3><p>Dados do titular e acompanhantes</p></div></div>{guests.map((guest, index) => <div className="reservation-form-grid" key={index}><strong className="reservation-field-wide">Hóspede {index + 1}{index === 0 ? ' (titular)' : ''}</strong><label className="schedule-field reservation-field-wide"><span>Nome *</span><input name="guestName" required maxLength={100} value={guest.name} onChange={(event) => updateGuest(index, 'name', event.target.value)} autoFocus={index === 0} /></label><label className="schedule-field"><span>CPF *</span><input name="guestCpf" required inputMode="numeric" maxLength={14} placeholder="000.000.000-00" value={maskCpf(guest.cpf)} onChange={(event) => updateGuest(index, 'cpf', maskCpf(event.target.value))} /></label><label className="schedule-field"><span>Data de nascimento *</span><DateInput name="guestBirth" required max={dateKey(new Date())} value={guest.birthDate} onValueChange={(next) => updateGuest(index, 'birthDate', next)} /></label><label className="schedule-field"><span>Celular{index === 0 ? ' *' : ''}</span><input name="guestPhone" type="tel" required={index === 0} maxLength={30} value={guest.phone} onChange={(event) => updateGuest(index, 'phone', event.target.value)} /></label><label className="schedule-field"><span>CNPJ (opcional)</span><input name="guestCnpj" inputMode="numeric" maxLength={18} value={guest.cnpj} onChange={(event) => updateGuest(index, 'cnpj', event.target.value)} /></label><label className="schedule-field reservation-field-wide"><span>E-mail (opcional)</span><input name="guestEmail" type="email" maxLength={100} value={guest.email} onChange={(event) => updateGuest(index, 'email', event.target.value)} /></label>{index > 0 && <button type="button" className="button button-plain reservation-field-wide" onClick={() => setGuests((current) => current.filter((_, position) => position !== index))}>Remover hóspede {index + 1}</button>}</div>)}<button type="button" className="button button-plain" onClick={() => setGuests((current) => [...current, emptyGuest()])}>+ Adicionar hóspede {guests.length + 1}</button><div className="reservation-form-grid"><strong className="reservation-field-wide">Endereço (opcional)</strong><label className="schedule-field reservation-field-wide"><span>Rua</span><input name="address_street" maxLength={120} defaultValue={reservation?.address?.street} /></label><label className="schedule-field"><span>Número</span><input name="address_number" maxLength={20} defaultValue={reservation?.address?.number} /></label><label className="schedule-field"><span>Bairro</span><input name="address_district" maxLength={80} defaultValue={reservation?.address?.district} /></label><label className="schedule-field"><span>Cidade</span><input name="address_city" maxLength={80} defaultValue={reservation?.address?.city} /></label><label className="schedule-field"><span>CEP</span><input name="address_zip" inputMode="numeric" maxLength={9} placeholder="00000-000" defaultValue={maskCep(reservation?.address?.zip ?? '')} onChange={(event) => { event.target.value = maskCep(event.target.value); }} /></label></div></section>
			<section className="reservation-form-section"><div className="reservation-section-heading"><span>03</span><div><h3>Estadia</h3><p>Quarto, período e hóspedes</p></div></div><div className="reservation-form-grid"><label className="schedule-field reservation-field-wide"><span>Quarto</span><select name="roomId" required value={roomId} onChange={(event) => setRoomId(event.target.value)}><option value="">Selecione um quarto</option>{availableRooms.map((room) => {const conflict = reservationOverlaps(data, { id: reservation?.id ?? '__nova__', roomId: room.id, checkInDate: checkIn, checkOutDate: channel === 'rotativo' ? fourHourCheckout(checkIn, checkInTime).date : standardCheckOut, channel: channel || undefined, checkInTime, checkOutTime: channel === 'rotativo' ? fourHourCheckout(checkIn, checkInTime).time : undefined });return <option key={room.id} value={room.id} disabled={conflict}>{room.number}{room.category ? ` · ${roomCategoryLabels[room.category]}` : ''}{room.maintenanceStatus === 'manutencao_necessaria' ? ' · manutenção necessária' : ''}{conflict ? ' · reservado neste período' : ''}</option>;})}</select></label>{channel === 'rotativo' ? <><label className="schedule-field"><span>Data de entrada</span><DateInput name="checkInDate" required value={checkIn} onValueChange={(next) => { if (!next) return; const checkout = fourHourCheckout(next, checkInTime); setCheckIn(next); setCheckOut(checkout.date); setCheckOutTime(checkout.time); }} /></label><label className="schedule-field"><span>Horário de entrada</span><input name="checkInTime" type="time" step="900" required value={checkInTime} onChange={(event) => { const checkout = fourHourCheckout(checkIn, event.target.value); setCheckInTime(event.target.value); setCheckOut(checkout.date); setCheckOutTime(checkout.time); }} /></label><input name="checkOutDate" type="hidden" value={checkOut} /><input name="checkOutTime" type="hidden" value={checkOutTime} /><div className="reservation-rotativo-checkout"><span>Checkout previsto</span><strong>{formatDate(checkOut)} às {checkOutTime}</strong><small>Quatro horas após a entrada</small></div></> : <><label className="schedule-field"><span>Check-in</span><DateInput name="checkInDate" required value={checkIn} onValueChange={(next) => { if (next) setCheckIn(next); }} /></label><label className="schedule-field"><span>Checkout</span><DateInput name="checkOutDate" required min={checkIn} value={standardCheckOut} onValueChange={(next) => { if (next) setCheckOut(next); }} /></label></>}<label className="schedule-field"><span>Crianças</span><input name="children" type="number" min="0" max="20" required defaultValue={reservation?.children ?? 0} /></label></div></section>
			<section className="reservation-form-section"><div className="reservation-section-heading"><span>04</span><div><h3>Valores e serviços</h3><p>Preço acordado e itens incluídos</p></div></div><div className="reservation-form-grid"><label className="schedule-field"><span>Valor da diária (R$)</span><input name="dailyRate" type="number" min="0" step="0.01" required value={dailyRate} onChange={(event) => setDailyRate(event.target.value)} /></label>{channel === 'oyo' && <><label className="schedule-field"><span>Taxa OYO (R$)</span><input name="oyoFee" type="number" min="0" step="0.01" value={oyoFee} onChange={(event) => setOyoFee(event.target.value)} /></label><label className="schedule-field reservation-field-wide"><span>Pagamento da taxa</span><select name="oyoFeePayer" value={oyoFeePayer} onChange={(event) => setOyoFeePayer(event.target.value as 'hospede' | 'oyo')}><option value="hospede">Hóspede paga na reserva/estadia</option><option value="oyo">Já paga diretamente à OYO</option></select></label></>}<fieldset className="reservation-channel-field reservation-field-wide"><legend>Nota fiscal</legend><div className="reservation-channel-options"><label className={!invoice ? 'selected' : ''}><input type="radio" name="invoiceRequested" value="no" checked={!invoice} onChange={() => setInvoice(false)} /><span>Sem nota fiscal</span></label><label className={invoice ? 'selected' : ''}><input type="radio" name="invoiceRequested" value="yes" checked={invoice} onChange={() => setInvoice(true)} /><span>Com nota fiscal</span></label></div></fieldset>{invoice && <label className="schedule-field reservation-field-wide"><span>Número da nota fiscal</span><input name="invoiceNumber" maxLength={40} defaultValue={reservation?.invoiceNumber} placeholder="Informe quando a nota for emitida" /></label>}</div><div className="reservation-total-row"><span>Total da reserva com extras</span><strong>{money(total + draftExtrasTotal)}</strong></div>{isAdmin && <div className="reservation-admin-balance"><span>Recebido <strong>{money(received)}</strong></span><span>Saldo <strong>{money(Math.max(0, total + draftExtrasTotal - received))}</strong></span></div>}</section>
			<section className="reservation-form-section"><div className="reservation-section-heading"><span>05</span><div><h3>Extras da hospedagem</h3><p>Itens cobrados junto ao saldo do quarto</p></div></div>{reservation?.extras?.length ? <div className="reservation-payment-history"><strong>Extras já lançados</strong>{reservation.extras.map((extra) => <small key={extra.id}>{extra.description} · {money(extra.amount)}</small>)}</div> : null}<div className="reservation-extra-list">{(Object.entries(extraLabels) as [ReservationExtraType, string][]).map(([type, label]) => <div className="reservation-extra-option" key={type}><label><input type="checkbox" name="extraType" value={type} checked={extraAmounts[type] !== undefined} onChange={(event) => setExtraAmounts((current) => { const next = { ...current }; if (event.target.checked) next[type] = ''; else delete next[type]; return next; })} /><span>{label}</span></label>{extraAmounts[type] !== undefined && <><input type="hidden" name={`extraId_${type}`} value={extraIds[type]} /><label className="schedule-field"><span>Valor (R$)</span><input name={`extraAmount_${type}`} type="number" min="0.01" step="0.01" required value={extraAmounts[type]} onChange={(event) => setExtraAmounts((current) => ({ ...current, [type]: event.target.value }))} /></label></>}</div>)}</div></section>
			{isAdmin && <section className="reservation-form-section"><div className="reservation-section-heading"><span>06</span><div><h3>Recebimento</h3><p>Opcional; somente para a gerência</p></div></div>{payments.length > 0 && <div className="reservation-payment-history"><strong>Histórico</strong>{payments.map((income) => <small key={income.id}>{formatDate(income.date)} · {incomeItems(income).map((item) => paymentLabels[item.paymentMethod]).join(', ')} · {money(income.amount)}</small>)}</div>}<div className="reservation-form-grid"><label className="schedule-field reservation-field-wide"><span>Valor total recebido agora</span><input value={money(draftPaymentsTotal)} readOnly tabIndex={-1} /></label>{paymentLines.map((line) => <div className="reservation-extra-option reservation-field-wide" key={line.key}><label className="schedule-field"><span>Referênte a</span><select name="payTarget" value={line.target} onChange={(event) => updatePayment(line.key, { target: event.target.value })}>{paymentTargets.map((target) => <option key={target} value={target}>{target}</option>)}</select></label><label className="schedule-field"><span>Forma</span><select name="payMethod" value={line.method} onChange={(event) => updatePayment(line.key, { method: event.target.value as FinancePaymentMethod })}><option value="cash">Dinheiro</option><option value="pix">Pix</option><option value="debit">Cartão de débito</option><option value="credit">Cartão de crédito</option><option value="bank_transfer">Transferência bancária</option>{channel === 'oyo' && <option value="prepaid">OYO a receber</option>}</select></label><label className="schedule-field"><span>Valor (R$)</span><input name="payAmount" type="number" min="0.01" step="0.01" required value={line.amount} onChange={(event) => updatePayment(line.key, { amount: event.target.value })} /></label><button type="button" className="button button-plain" onClick={() => setPaymentLines((current) => current.filter((item) => item.key !== line.key))}>Remover</button></div>)}<button type="button" className="button button-plain reservation-field-wide" onClick={() => setPaymentLines((current) => [...current, { key: createId(), target: 'Hospedagem', method: paymentMethod, amount: '' }])}>+ Adicionar forma de pagamento</button><label className="schedule-field reservation-field-wide"><span>Data do recebimento</span><DateInput name="paymentDate" value={paymentDate} onValueChange={setPaymentDate} required={paymentLines.length > 0} /></label></div></section>}
			<section className="reservation-form-section reservation-form-notes"><label className="schedule-field"><span>Observação</span><textarea name="note" rows={2} maxLength={300} defaultValue={reservation?.note} /></label><p className="reservation-hint">Check-in é inclusivo e checkout exclusivo. O sistema impede sobreposição de reservas no mesmo quarto.</p></section>
		</div>
		{error && <p className="reservation-modal-error" role="alert">{error}</p>}
		<footer className="reservation-modal-footer"><button className="button button-plain" type="button" onClick={onClose}>Cancelar</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : reservation ? 'Salvar alterações' : 'Confirmar reserva'}</button></footer>
	</form></section></div>;
}
