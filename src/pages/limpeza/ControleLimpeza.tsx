import { useEffect, useMemo, useState } from 'react';
import type { UserRole } from '../../types';
import { type CleaningData, type CleaningTask } from '../../types/cleaning';
import { assignRooms, cancelTask, completeTask, deleteCleaningTask, emptyCleaning, subscribeCleaning, subscribeRoomCleaningPlans } from '../../services/cleaningStore';
import { subscribeReservationDirectory, subscribeRoomDirectory } from '../../services/housekeepingStore';
import { localDateKey, subscribeReceptionStayDirectory, type ReceptionStayDirectoryData } from '../../services/receptionStore';
import { guestStayOccupiesToday, reservationOccupiesToday } from '../../services/reservationAnalytics';
import type { HousekeepingRoom, ReservationDirectoryEntry, RoomDayPlan } from '../../types/housekeeping';
import { BackToPanel } from '../../components/ui/BackToPanel';
import { useAttendant } from '../../services/useAttendant';
import './limpeza.css';
import { Link, useSearchParams } from 'react-router-dom';
import { useStaff } from '../../services/staffStore';
import { findStaff, staffMembers } from '../../types/staff';

const timeOf = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
const byRoom = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true });
const cleaningLabels = { sujo: 'Sujo', limpo: 'Limpo', em_limpeza: 'Em limpeza' };

export function ControleLimpeza({ userRole }: { userRole: UserRole }) {
  const [searchParams] = useSearchParams();
  const focusedRoom = searchParams.get('room')?.trim() ?? '';
  const [clock, setClock] = useState(() => Date.now());
  const today = localDateKey(new Date(clock));
  const { data: staff, error: staffError } = useStaff();
  const isAdmin = userRole === 'admin';
  const sessionAttendant = useAttendant();
  const actor = isAdmin ? 'Gerência' : sessionAttendant || 'Equipe';
  const [data, setData] = useState<CleaningData>(emptyCleaning());
  const [loading, setLoading] = useState(true);
  const [roomDirectory, setRoomDirectory] = useState<Record<string, HousekeepingRoom>>({});
  const [reservations, setReservations] = useState<Record<string, ReservationDirectoryEntry>>({});
  const [reception, setReception] = useState<ReceptionStayDirectoryData>({ stays: {}, rooms: {} });
  const [cleaningPlans, setCleaningPlans] = useState<Record<string, RoomDayPlan>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [chosen, setChosen] = useState('');
  const [selected, setSelected] = useState<string[]>(() => focusedRoom ? [focusedRoom] : []);
  const [viewDate, setViewDate] = useState(() => localDateKey());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => subscribeCleaning((next) => {
    setData(next);
    setLoading(false);
  }, (cause) => {
    setError(cause.message);
    setLoading(false);
  }), []);
  useEffect(() => subscribeRoomCleaningPlans(today, setCleaningPlans, (cause) => setError(`Não foi possível carregar as solicitações de limpeza: ${cause.message}`)), [today]);

  useEffect(() => {
    const onError = (cause: Error) => setError(`Não foi possível carregar a situação dos quartos: ${cause.message}`);
    const stopHousekeeping = subscribeRoomDirectory(setRoomDirectory, onError);
    const stopReservations = subscribeReservationDirectory(setReservations, onError);
    const stopReception = subscribeReceptionStayDirectory(setReception, onError);
    return () => {
      stopHousekeeping();
      stopReservations();
      stopReception();
    };
  }, []);

  const camareiras = staffMembers(staff, 'housekeeping');
  const tasks = Object.values(data.tasks).map((task) => ({ ...task, camareira: findStaff(staff, task.camareira, task.employeeId)?.name ?? task.camareira }));
  const inProgress = tasks.filter((task) => task.status === 'em_limpeza').sort((a, b) => a.assignedAt.localeCompare(b.assignedAt));
  const doneOnDate = tasks.filter((task) => (task.status === 'concluido' || (isAdmin && task.status === 'cancelado')) && localDateKey(new Date(task.completedAt ?? task.assignedAt)) === viewDate)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const busyRooms = new Map(inProgress.map((task) => [task.roomNumber, task.camareira]));
  const rooms = useMemo(() => [...new Set([...Object.values(roomDirectory), ...Object.values(reception.rooms)].map((room) => room.number))].sort(byRoom), [roomDirectory, reception.rooms]);
  const canonicalRooms = new Map(Object.values(roomDirectory).map((room) => [room.number, room]));
  const cleaningDeclined = (number: string) => Boolean(guestOf(number)) && cleaningPlans[canonicalRooms.get(number)?.id ?? '']?.cleaningRequest === 'dispensada';
  const eligible = (number: string) => canonicalRooms.has(number) && !busyRooms.has(number) && canonicalRooms.get(number)?.maintenanceStatus !== 'em_manutencao' && !cleaningDeclined(number);
  const selectedRooms = selected.filter(eligible);
  const visibleInProgress = focusedRoom ? inProgress.filter((task) => task.roomNumber === focusedRoom) : inProgress;
  const visibleDone = focusedRoom ? doneOnDate.filter((task) => task.roomNumber === focusedRoom) : doneOnDate;

  function guestOf(number: string): string {
    return Object.values(reservations).find((reservation) => reservation.roomNumber === number && reservationOccupiesToday(reservation, today, clock))?.guestName
      ?? Object.values(reception.stays).find((stay) => stay.roomNumber === number && guestStayOccupiesToday(stay, today, clock))?.guestName ?? '';
  }

  function toggleRoom(room: string) {
    if (!eligible(room)) return;
    setSelected((current) => current.includes(room) ? current.filter((item) => item !== room) : [...current, room]);
  }

  async function run(action: () => Promise<void>, success: string) {
    setError('');
    setNotice('');
    setSaving(true);
    try {
      await action();
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a operação.');
    } finally {
      setSaving(false);
    }
  }

  async function designate() {
    if (!chosen || selectedRooms.length === 0) return;
    const list = [...selectedRooms].sort(byRoom);
    await run(async () => {
      const member = findStaff(staff, chosen);
      if (!member?.active || !camareiras.some((item) => item.id === member.id)) throw new Error('Selecione uma camareira ativa do cadastro.');
      await assignRooms(list, member.name, actor, member.id);
      setSelected([]);
    }, `${list.length === 1 ? `Quarto ${list[0]} designado` : `Quartos ${list.join(', ')} designados`} para ${chosen}.`);
  }

  function finish(task: CleaningTask) {
    void run(() => completeTask(task, actor), `Quarto ${task.roomNumber} concluído por ${task.camareira}.`);
  }

  function cancel(task: CleaningTask) {
    if (!window.confirm(`Cancelar a limpeza do quarto ${task.roomNumber} (${task.camareira})?`)) return;
    void run(() => cancelTask(task, actor), `Limpeza do quarto ${task.roomNumber} cancelada.`);
  }

  return (
    <div className="clean-page">
      <BackToPanel />
      <header className="clean-title">
        <div>
          <p className="clean-eyebrow">OPERAÇÃO <span>/</span> HOSPEDAGEM</p>
          <h1>Controle de Limpeza de Quartos</h1>
          <p>Escolha a camareira, toque nos quartos que ela vai limpar e confirme. Quando ela terminar, toque em <strong>Quarto limpo</strong>.</p>
        </div>
        <span className="clean-counter"><strong>{inProgress.length}</strong><small>em limpeza agora</small></span>
      </header>

      {(error || staffError) && <div className="clean-alert" role="alert">{error || staffError}</div>}
      {notice && <div className="clean-success" role="status">{notice}</div>}
      {focusedRoom && <section className="clean-context" aria-label={`Limpeza do quarto ${focusedRoom}`}><div><strong>Quarto {focusedRoom}</strong><span>{guestOf(focusedRoom) ? `Ocupado · ${guestOf(focusedRoom)}` : 'Acompanhe a limpeza e a camareira responsável.'}</span>{cleaningDeclined(focusedRoom) && <span>O hóspede dispensou a limpeza de hoje. Atualize a solicitação em Gerenciar quartos para designar.</span>}</div><nav>{isAdmin && <><Link to={`/quartos?room=${encodeURIComponent(focusedRoom)}`}>Gerenciar quarto</Link><Link to={`/reservas?room=${encodeURIComponent(focusedRoom)}`}>Reservas e hospedagens</Link></>}<Link to="/limpeza">Todos os quartos</Link></nav></section>}
      {isAdmin && !focusedRoom && <nav className="clean-module-links"><Link to="/quartos">Gerenciar quartos</Link><Link to="/reservas">Reservas e hospedagens</Link></nav>}

      <section className="clean-panel">
        <h2><span className="clean-step">1</span> Quem vai limpar?</h2>
        {loading ? <p className="clean-muted">Carregando...</p> : <div className="clean-people">
          {camareiras.map((item) => {
            const count = inProgress.filter((task) => task.camareira === item.name).length;
            return <button key={item.id} type="button" className={`clean-person ${chosen === item.name ? 'is-chosen' : ''}`} onClick={() => setChosen(item.name)} aria-pressed={chosen === item.name}>
              <span className="clean-avatar">{item.name.slice(0, 1).toUpperCase()}</span>
              <strong>{item.name}</strong>
              <small>{count === 0 ? 'Livre' : `${count} quarto(s) em limpeza`}</small>
            </button>;
          })}
        </div>}
      </section>

      <section className="clean-panel">
        <h2><span className="clean-step">2</span> Quais quartos?</h2>
        <div className="clean-legend"><span className="legend-free">Disponível para limpeza</span><span className="legend-selected">Selecionado</span><span className="legend-busy">Em limpeza</span><span className="legend-blocked">Bloqueado</span></div>
        <div className="clean-rooms">
          {rooms.map((room) => {
            const busy = busyRooms.get(room);
            const registered = canonicalRooms.get(room);
            const blocked = registered?.maintenanceStatus === 'em_manutencao';
            const declined = cleaningDeclined(room);
            const guest = guestOf(room);
            const state = blocked || declined || !registered ? 'is-blocked' : busy ? 'is-busy' : selectedRooms.includes(room) ? 'is-selected' : '';
            return <button key={room} type="button" className={`clean-room ${state} ${focusedRoom === room ? 'is-focused' : ''}`} disabled={!eligible(room) || saving} onClick={() => toggleRoom(room)} aria-pressed={selectedRooms.includes(room)}>
              <strong>{room}</strong><small>{blocked ? 'Bloqueado' : declined ? 'Limpeza dispensada' : busy ?? (registered ? cleaningLabels[registered.cleaningStatus] : 'Vincule o cadastro')}</small><small>{guest ? `Ocupado · ${guest}` : 'Sem hóspede'}</small>
            </button>;
          })}
          {rooms.length === 0 && <p className="clean-muted">Nenhum quarto cadastrado. Cadastre os quartos em Gerenciar quartos para designar a limpeza.</p>}
        </div>
        {rooms.some((room) => !canonicalRooms.has(room)) && <p className="clean-muted">Quartos cadastrados somente na recepção precisam ser vinculados em {isAdmin ? <Link to="/quartos">Gerenciar quartos</Link> : 'Gerenciar quartos pela gerência'}.</p>}
      </section>

      <section className="clean-panel clean-confirm">
        <h2><span className="clean-step">3</span> Confirmar</h2>
        <button type="button" className="clean-primary" disabled={!chosen || selectedRooms.length === 0 || saving} onClick={() => void designate()}>
          {!chosen ? 'Escolha uma camareira' : selectedRooms.length === 0 ? 'Escolha os quartos' : `Designar ${selectedRooms.length} quarto(s) para ${chosen}`}
        </button>
        {selected.length > 0 && <button type="button" className="clean-secondary" onClick={() => setSelected([])}>Limpar seleção</button>}
      </section>

      <section className="clean-panel">
        <h2>{focusedRoom ? `Limpeza do quarto ${focusedRoom}` : 'Em limpeza agora'}</h2>
        {visibleInProgress.length === 0 ? <p className="clean-muted">Nenhuma tarefa de limpeza em andamento{focusedRoom ? ` para o quarto ${focusedRoom}` : ''}.</p> : <div className="clean-tasks">
          {visibleInProgress.map((task) => <article key={task.id} className="clean-task">
            <div><span className="clean-task-room">Quarto {task.roomNumber}</span><small>{task.camareira} · desde {timeOf(task.assignedAt)} · por {task.assignedBy}</small></div>
            <div className="clean-task-actions">
              {isAdmin && <Link className="clean-link" to={`/quartos?room=${encodeURIComponent(task.roomNumber)}`}>Ver quarto</Link>}
              <button type="button" className="clean-done" disabled={saving} onClick={() => finish(task)}>✓ Quarto limpo</button>
              <button type="button" className="clean-link" disabled={saving} onClick={() => cancel(task)}>Cancelar</button>
              {isAdmin && <button disabled={saving} onClick={() => { if (window.confirm(`Excluir a limpeza do quarto ${task.roomNumber}?`)) void run(() => deleteCleaningTask(task.id), 'Registro excluído.'); }}>Excluir</button>}
            </div>
          </article>)}
        </div>}
      </section>

      <section className="clean-panel">
        <div className="clean-panel-head">
          <h2>{isAdmin ? 'Limpezas concluídas e canceladas' : 'Limpezas concluídas'}</h2>
          <label className="clean-date">Dia<input type="date" value={viewDate} onChange={(event) => event.target.value && setViewDate(event.target.value)} /></label>
        </div>
        {visibleDone.length === 0 ? <p className="clean-muted">Nenhuma limpeza concluída neste dia{focusedRoom ? ` para o quarto ${focusedRoom}` : ''}.</p> : <table className="clean-table">
          <thead><tr><th>Quarto</th><th>Camareira</th><th>Início</th><th>Fim</th><th>Designado por</th>{isAdmin && <th>Ações</th>}</tr></thead>
          <tbody>{visibleDone.map((task) => <tr key={task.id}><td>{isAdmin ? <Link to={`/quartos?room=${encodeURIComponent(task.roomNumber)}`}>Quarto {task.roomNumber}</Link> : <strong>{task.roomNumber}</strong>}</td><td>{task.camareira}{task.status === 'cancelado' ? ' · cancelada' : ''}</td><td>{timeOf(task.assignedAt)}</td><td>{timeOf(task.completedAt)}</td><td>{task.assignedBy}</td>{isAdmin && <td><button onClick={() => { if (window.confirm(`Excluir a limpeza do quarto ${task.roomNumber}?`)) void run(() => deleteCleaningTask(task.id), 'Registro excluído.'); }}>Excluir</button></td>}</tr>)}</tbody>
        </table>}
      </section>

      {isAdmin && <section className="clean-panel"><Link to="/funcionarios">Gerenciar funcionários e categorias</Link></section>}
    </div>
  );
}
