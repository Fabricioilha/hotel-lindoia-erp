import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { UserRole } from '../../types';
import { type CleaningData, type CleaningTask } from '../../types/cleaning';
import { assignRooms, cancelTask, completeTask, deleteCleaningTask, emptyCleaning, subscribeCleaning } from '../../services/cleaningStore';
import { subscribeRoomDirectory } from '../../services/housekeepingStore';
import { localDateKey, subscribeReception } from '../../services/receptionStore';
import { BackToPanel } from '../../components/ui/BackToPanel';
import { useAttendant } from '../../services/useAttendant';
import './limpeza.css';
import { Link } from 'react-router-dom';
import { useStaff } from '../../services/staffStore';
import { findStaff, staffMembers } from '../../types/staff';

const timeOf = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
const byRoom = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true });

export function ControleLimpeza({ userRole }: { userRole: UserRole }) {
  const { data: staff, error: staffError } = useStaff();
  const isAdmin = userRole === 'admin';
  const sessionAttendant = useAttendant();
  const actor = isAdmin ? 'Gerência' : sessionAttendant || 'Equipe';
  const [data, setData] = useState<CleaningData>(emptyCleaning());
  const [loading, setLoading] = useState(true);
  const [roomNumbers, setRoomNumbers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [chosen, setChosen] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [extraRoom, setExtraRoom] = useState('');
  const [viewDate, setViewDate] = useState(() => localDateKey());
  const [saving, setSaving] = useState(false);

  useEffect(() => subscribeCleaning((next) => {
    setData(next);
    setLoading(false);
  }, (cause) => {
    setError(cause.message);
    setLoading(false);
  }), []);

  useEffect(() => {
    let housekeeping: string[] = [];
    let reception: string[] = [];
    const publish = () => setRoomNumbers([...new Set([...housekeeping, ...reception])]);
    const stopHousekeeping = subscribeRoomDirectory((next) => {
      housekeeping = Object.values(next).map((room) => room.number);
      publish();
    }, () => undefined);
    const stopReception = subscribeReception((next) => {
      reception = Object.values(next.rooms).map((room) => room.number);
      publish();
    }, () => undefined);
    return () => {
      stopHousekeeping();
      stopReception();
    };
  }, []);

  const camareiras = staffMembers(staff, 'housekeeping');
  const tasks = Object.values(data.tasks).map((task) => ({ ...task, camareira: findStaff(staff, task.camareira, task.employeeId)?.name ?? task.camareira }));
  const inProgress = tasks.filter((task) => task.status === 'em_limpeza').sort((a, b) => a.assignedAt.localeCompare(b.assignedAt));
  const doneOnDate = tasks.filter((task) => (task.status === 'concluido' || (isAdmin && task.status === 'cancelado')) && localDateKey(new Date(task.completedAt ?? task.assignedAt)) === viewDate)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const busyRooms = new Map(inProgress.map((task) => [task.roomNumber, task.camareira]));
  const rooms = useMemo(() => [...new Set([...roomNumbers, ...selected])].sort(byRoom), [roomNumbers, selected]);

  function toggleRoom(room: string) {
    if (busyRooms.has(room)) return;
    setSelected((current) => current.includes(room) ? current.filter((item) => item !== room) : [...current, room]);
  }

  function addExtraRoom(event: FormEvent) {
    event.preventDefault();
    const number = extraRoom.trim();
    if (!number || busyRooms.has(number)) return;
    setSelected((current) => current.includes(number) ? current : [...current, number]);
    setExtraRoom('');
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
    if (!chosen || selected.length === 0) return;
    const list = [...selected].sort(byRoom);
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
        <div className="clean-legend"><span className="legend-free">Livre</span><span className="legend-selected">Selecionado</span><span className="legend-busy">Em limpeza</span></div>
        <div className="clean-rooms">
          {rooms.map((room) => {
            const busy = busyRooms.get(room);
            const state = busy ? 'is-busy' : selected.includes(room) ? 'is-selected' : '';
            return <button key={room} type="button" className={`clean-room ${state}`} disabled={Boolean(busy)} onClick={() => toggleRoom(room)} aria-pressed={selected.includes(room)}>
              <strong>{room}</strong><small>{busy ?? ''}</small>
            </button>;
          })}
          {rooms.length === 0 && <p className="clean-muted">Nenhum quarto cadastrado. Digite o número abaixo para adicionar.</p>}
        </div>
        <form className="clean-add-room" onSubmit={addExtraRoom}>
          <label>Outro quarto<input value={extraRoom} onChange={(event) => setExtraRoom(event.target.value)} maxLength={10} placeholder="Número" /></label>
          <button type="submit" className="clean-secondary">Adicionar</button>
        </form>
      </section>

      <section className="clean-panel clean-confirm">
        <h2><span className="clean-step">3</span> Confirmar</h2>
        <button type="button" className="clean-primary" disabled={!chosen || selected.length === 0 || saving} onClick={() => void designate()}>
          {!chosen ? 'Escolha uma camareira' : selected.length === 0 ? 'Escolha os quartos' : `Designar ${selected.length} quarto(s) para ${chosen}`}
        </button>
        {selected.length > 0 && <button type="button" className="clean-secondary" onClick={() => setSelected([])}>Limpar seleção</button>}
      </section>

      <section className="clean-panel">
        <h2>Em limpeza agora</h2>
        {inProgress.length === 0 ? <p className="clean-muted">Nenhum quarto em limpeza no momento.</p> : <div className="clean-tasks">
          {inProgress.map((task) => <article key={task.id} className="clean-task">
            <div><span className="clean-task-room">Quarto {task.roomNumber}</span><small>{task.camareira} · desde {timeOf(task.assignedAt)} · por {task.assignedBy}</small></div>
            <div className="clean-task-actions">
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
        {doneOnDate.length === 0 ? <p className="clean-muted">Nenhuma limpeza concluída neste dia.</p> : <table className="clean-table">
          <thead><tr><th>Quarto</th><th>Camareira</th><th>Início</th><th>Fim</th><th>Designado por</th>{isAdmin && <th>Ações</th>}</tr></thead>
          <tbody>{doneOnDate.map((task) => <tr key={task.id}><td><strong>{task.roomNumber}</strong></td><td>{task.camareira}{task.status === 'cancelado' ? ' · cancelada' : ''}</td><td>{timeOf(task.assignedAt)}</td><td>{timeOf(task.completedAt)}</td><td>{task.assignedBy}</td>{isAdmin && <td><button onClick={() => { if (window.confirm(`Excluir a limpeza do quarto ${task.roomNumber}?`)) void run(() => deleteCleaningTask(task.id), 'Registro excluído.'); }}>Excluir</button></td>}</tr>)}</tbody>
        </table>}
      </section>

      {isAdmin && <section className="clean-panel"><Link to="/funcionarios">Gerenciar funcionários e categorias</Link></section>}
    </div>
  );
}
