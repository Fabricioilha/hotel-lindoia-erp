import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { releaseOccupiedRoom, saveHousekeepingRoom, subscribeReservationCollections, subscribeReservationExtras, subscribeReservationRecord, updateRoomMaintenanceStatus } from '../services/housekeepingStore';
import { emptyFinance, subscribeReservationPaymentIncomes } from '../services/financeStore';
import { reservationBalanceDue, reservationFinancialTotal } from '../services/reservationFinance';
import { PAYMENT_METHOD_LABELS, type FinanceData } from '../types/finance';
import { roomCategoryDescription, type HousekeepingRoom, type Reservation, type ReservationCollection, type ReservationExtra } from '../types/housekeeping';
import { ROOM_TYPE_LABELS, roomChargePayments, stayPayments, stayTotals, type GuestStay, type ReceptionRoom, type RoomCharge } from '../types/reception';
import type { CleaningTask } from '../types/cleaning';

export interface ManagerRoomOccupant {
  sourceType: 'stay' | 'reservation';
  sourceId: string;
  name: string;
  startDate: string;
  checkOutDate: string;
  peopleCount: number;
}

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateLabel = (value: string) => value ? new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR') : 'Não informado';
const cleaningLabels = { sujo: 'Aguardando limpeza', limpo: 'Limpo', em_limpeza: 'Em limpeza' };
const channelLabels = { oyo: 'OYO', balcao: 'Balcão', rotativo: 'Rotativo' };

export function ManagerRoomDialog({ number, room, receptionRoom, occupant, stay, charges, cleaningTasks, onClose, onSaved }: {
  number: string;
  room?: HousekeepingRoom;
  receptionRoom?: ReceptionRoom;
  occupant?: ManagerRoomOccupant;
  stay?: GuestStay;
  charges: RoomCharge[];
  cleaningTasks: CleaningTask[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [reservation, setReservation] = useState<Reservation | null | undefined>(undefined);
  const [finance, setFinance] = useState<FinanceData>(emptyFinance());
  const [collections, setCollections] = useState<Record<string, ReservationCollection>>({});
  const [extras, setExtras] = useState<Record<string, ReservationExtra>>({});
  const [financialLoaded, setFinancialLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmRelease, setConfirmRelease] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const reservationId = occupant?.sourceType === 'reservation' ? occupant.sourceId : '';
  const blocked = room?.maintenanceStatus === 'em_manutencao';
  const activeTasks = cleaningTasks.filter((task) => task.status === 'em_limpeza');
  const cleaningStatus = activeTasks.length > 0 ? 'em_limpeza' : room?.cleaningStatus ?? 'sujo';
  const context = `room=${encodeURIComponent(number)}`;
  const bookingLink = occupant ? `/reservas?${occupant.sourceType === 'stay' ? 'stay' : 'reservation'}=${encodeURIComponent(occupant.sourceId)}` : `/reservas?${context}`;

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (!reservationId) return;
    const reportError = (cause: Error) => setError(`Não foi possível consultar a reserva: ${cause.message}`);
    let subscribed = false;
    const loaded = new Set<string>();
    const markLoaded = (key: string) => { loaded.add(key); if (loaded.size === 3) setFinancialLoaded(true); };
    const stops = [
      subscribeReservationRecord(reservationId, setReservation, reportError),
      subscribeReservationPaymentIncomes([reservationId], (next) => { if (!subscribed) return; setFinance(next); markLoaded('finance'); }, reportError),
      subscribeReservationCollections((next) => { if (!subscribed) return; setCollections(next); markLoaded('collections'); }, reportError, [reservationId]),
      subscribeReservationExtras((next) => { if (!subscribed) return; setExtras(next); markLoaded('extras'); }, reportError, [reservationId]),
    ];
    subscribed = true;
    return () => stops.forEach((stop) => stop());
  }, [reservationId]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !saving) onClose();
    if (event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  async function changeAvailability() {
    setSaving(true);
    setError('');
    try {
      if (!room && receptionRoom) {
        await saveHousekeepingRoom({ id: receptionRoom.id, number, category: receptionRoom.type, categoryName: ROOM_TYPE_LABELS[receptionRoom.type].split(' · ')[0], bedComposition: ROOM_TYPE_LABELS[receptionRoom.type].split(' · ').slice(1).join(' · '), cleaningStatus: 'sujo', maintenanceStatus: 'normal', note: '' });
      }
      const roomId = room?.id ?? receptionRoom?.id;
      if (!roomId) throw new Error('Cadastre este quarto na Gerência de quartos.');
      await updateRoomMaintenanceStatus(roomId, blocked ? 'normal' : 'em_manutencao');
      onSaved(blocked ? `Quarto ${number} desbloqueado. ${cleaningLabels[cleaningStatus]}.` : `Quarto ${number} bloqueado para manutenção.`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar o quarto.');
    } finally { setSaving(false); }
  }

  async function releaseStay() {
    if (occupant?.sourceType !== 'stay') return;
    setSaving(true);
    setError('');
    try {
      await releaseOccupiedRoom({ stayId: occupant.sourceId, roomId: room?.id });
      onSaved(`Hospedagem encerrada. Quarto ${number} liberado para limpeza.`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível liberar o quarto.');
    } finally { setSaving(false); }
  }

  const reservationTotal = reservation ? reservationFinancialTotal(reservation, extras) : 0;
  const balance = reservation ? reservationBalanceDue(reservation, finance.incomes, extras, collections, finance.suppressed) : 0;
  const chargeTotal = charges.reduce((total, charge) => total + charge.amount, 0);
  const chargesPaid = charges.reduce((total, charge) => total + roomChargePayments(charge).reduce((paid, payment) => paid + payment.amount, 0), 0);

  return <div className="dashboard-room-charge-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="dashboard-room-charge-modal manager-room-dialog" role="dialog" aria-modal="true" aria-labelledby="manager-room-title" onKeyDown={handleKeyDown}>
      <header className="dashboard-room-charge-header">
        <div><p className="dashboard-eyebrow">GERÊNCIA DE QUARTOS</p><h2 id="manager-room-title">Quarto {number}</h2><small>{room ? roomCategoryDescription(room) : receptionRoom ? ROOM_TYPE_LABELS[receptionRoom.type] : 'Quarto'}</small></div>
        <button ref={closeButton} type="button" className="dashboard-room-charge-close" aria-label="Fechar opções do quarto" disabled={saving} onClick={onClose}>×</button>
      </header>
      <div className="manager-room-badges"><span>{occupant ? 'Ocupado' : 'Livre'}</span><span>{blocked ? 'Bloqueado para manutenção' : 'Sem bloqueio'}</span><span>{cleaningLabels[cleaningStatus]}</span></div>
      {activeTasks.length > 0 && <p className="manager-room-cleaner">Limpeza designada: <strong>{activeTasks.map((task) => task.camareira).join(', ')}</strong></p>}
      {room?.note && <p className="manager-room-note">{room.note}</p>}
      {occupant && <div className="manager-room-booking">
        <h3>Informações da {occupant.sourceType === 'stay' ? 'hospedagem' : 'reserva'}</h3>
        <dl className="manager-room-details">
          <div><dt>Hóspede titular</dt><dd>{reservation?.guestName ?? stay?.guestName ?? occupant.name}</dd></div>
          <div><dt>Pessoas</dt><dd>{reservation ? reservation.adults + reservation.children : stay?.guestCount ?? occupant.peopleCount}</dd></div>
          <div><dt>Check-in</dt><dd>{dateLabel(reservation?.checkInDate ?? stay?.checkInDate ?? occupant.startDate)}{reservation?.checkInTime ? ` às ${reservation.checkInTime}` : ''}</dd></div>
          <div><dt>Check-out previsto</dt><dd>{dateLabel(reservation?.checkOutDate ?? occupant.checkOutDate)}{reservation?.checkOutTime ? ` às ${reservation.checkOutTime}` : ''}</dd></div>
          {reservation && <>
            <div><dt>Origem</dt><dd>{channelLabels[reservation.channel ?? 'balcao']}</dd></div>
            <div><dt>Telefone</dt><dd>{reservation.phone || 'Não informado'}</dd></div>
            {reservation.oyoReservationNumber && <div><dt>Reserva OYO</dt><dd>{reservation.oyoReservationNumber}</dd></div>}
            <div><dt>Total da reserva e adicionais</dt><dd>{financialLoaded ? money(reservationTotal + chargeTotal) : 'Consultando…'}</dd></div>
            <div><dt>Saldo a receber</dt><dd>{financialLoaded ? money(balance + Math.max(0, chargeTotal - chargesPaid)) : 'Consultando…'}</dd></div>
          </>}
          {stay && <>
            <div><dt>Hospedagem</dt><dd>{stay.kind === 'periodo' ? `Rotativo · ${stay.hours ?? 4} horas` : `${stay.nights} diária(s)`}</dd></div>
            <div><dt>Total registrado</dt><dd>{money(stayTotals(stay).total + chargeTotal)}</dd></div>
            <div><dt>Pagamentos da hospedagem</dt><dd>{stayPayments(stay).map((payment) => `${payment.label}: ${money(payment.amount)} (${PAYMENT_METHOD_LABELS[payment.method]})`).join(' · ') || 'Nenhum pagamento ativo'}</dd></div>
          </>}
        </dl>
        {reservationId && reservation === undefined && <p role="status">Consultando informações da reserva…</p>}
        {reservationId && reservation === null && <p role="alert">A reserva não está mais disponível.</p>}
        {(reservation?.note || stay?.note) && <p className="manager-room-note">{reservation?.note || stay?.note}</p>}
        {charges.length > 0 && <p className="manager-room-note">Adicionais do quarto: {charges.map((charge) => `${charge.productName ?? charge.guestName} · ${money(charge.amount)}`).join('; ')}</p>}
      </div>}
      {error && <p className="dashboard-room-charge-error" role="alert">{error}</p>}
      {confirmRelease ? <div className="manager-room-release-confirm">
        <p>Encerrar a hospedagem de <strong>{occupant?.name}</strong> e liberar o quarto para limpeza? Os pagamentos registrados serão preservados.</p>
        <div className="dashboard-room-charge-actions"><button type="button" className="dashboard-room-charge-cancel" disabled={saving} onClick={() => setConfirmRelease(false)}>Voltar</button><button type="button" className="dashboard-room-charge-submit" disabled={saving} onClick={() => void releaseStay()}>{saving ? 'Liberando…' : 'Confirmar liberação'}</button></div>
      </div> : <div className="manager-room-actions">
        {occupant && <Link className="dashboard-room-charge-submit" to={bookingLink}>Editar {occupant.sourceType === 'stay' ? 'hospedagem' : 'reserva'}</Link>}
        {occupant?.sourceType === 'reservation' && <Link className="dashboard-room-charge-cancel" to={`${bookingLink}&action=checkout`}>Liberar quarto / checkout</Link>}
        {occupant?.sourceType === 'stay' && <button type="button" className="dashboard-room-charge-cancel" disabled={saving} onClick={() => setConfirmRelease(true)}>Liberar quarto</button>}
        <button type="button" className="dashboard-room-charge-cancel" disabled={saving || Boolean(occupant)} onClick={() => void changeAvailability()}>{saving ? 'Salvando…' : blocked ? 'Liberar bloqueio do quarto' : 'Bloquear quarto'}</button>
        <Link className="dashboard-room-charge-cancel" to={`/quartos?${context}`}>Gerência de quartos</Link>
        <Link className="dashboard-room-charge-cancel" to={`/limpeza?${context}`}>Limpeza por camareiras</Link>
        {!occupant && <Link className="dashboard-room-charge-cancel" to={bookingLink}>Reservas e hospedagens</Link>}
      </div>}
      {occupant && !confirmRelease && <p className="manager-room-help">Finalize o checkout para liberar a ocupação antes de bloquear o quarto.</p>}
      {!occupant && <p className="manager-room-help">A limpeza e o bloqueio são acompanhados também na Gerência de quartos e na Limpeza por camareiras.</p>}
    </section>
  </div>;
}
