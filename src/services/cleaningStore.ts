import { endAt, equalTo, get, onValue, orderByChild, query, ref, runTransaction, startAt, update } from 'firebase/database';
import { db } from '../config/firebase';
import { type CleaningData, type CleaningTask } from '../types/cleaning';
import type { HousekeepingRoom, ReservationDirectoryEntry, RoomCleaningLog, RoomDayPlan } from '../types/housekeeping';
import type { GuestStay } from '../types/reception';
import { guestStayOccupiesToday, localDateKey, reservationOccupiesToday } from './reservationAnalytics';
import { withTransactionData } from './firebaseTransactions';

const PATH = 'erp_geral/limpeza';
const ROOMS_PATH = 'erp_geral/quartos/rooms';
const LOGS_PATH = 'erp_geral/quartos/cleaningLogs';

interface CleaningClaim { taskId: string; phase: 'assigning' | 'finishing'; expiresAt: number }
const CLAIM_DURATION_MS = 5 * 60_000;

export function emptyCleaning(): CleaningData {
  return { camareiras: {}, camareirasConfigured: false, tasks: {} };
}

function fiveYearsAgoTimestamp(): string {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  return cutoff.toISOString();
}

function taskDateBounds(date: string): [string, string] {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}

export function subscribeCleaning(onChange: (data: CleaningData) => void, onError: (error: Error) => void): () => void {
  let active: Record<string, CleaningTask> | undefined;
  let recent: Record<string, CleaningTask> | undefined;
  const publish = () => {
    if (!active || !recent) return;
    onChange({ ...emptyCleaning(), tasks: { ...recent, ...active } });
  };
  const activeQuery = query(ref(db, `${PATH}/tasks`), orderByChild('status'), equalTo('em_limpeza'));
  const historyQuery = query(ref(db, `${PATH}/tasks`), orderByChild('completedAt'), startAt(fiveYearsAgoTimestamp()));
  const stopActive = onValue(activeQuery, (snapshot) => { active = snapshot.val() ?? {}; publish(); }, onError);
  const stopHistory = onValue(historyQuery, (snapshot) => { recent = snapshot.val() ?? {}; publish(); }, onError);
  return () => { stopActive(); stopHistory(); };
}

export function subscribeDashboardCleaningTasks(
  date: string,
  onChange: (data: CleaningData) => void,
  onError: (error: Error) => void,
): () => void {
  let active: Record<string, CleaningTask> | undefined;
  let completedToday: Record<string, CleaningTask> | undefined;
  const publish = () => {
    if (!active || !completedToday) return;
    onChange({ ...emptyCleaning(), tasks: { ...completedToday, ...active } });
  };
  const [start, end] = taskDateBounds(date);
  const activeQuery = query(ref(db, `${PATH}/tasks`), orderByChild('status'), equalTo('em_limpeza'));
  const completedTodayQuery = query(ref(db, `${PATH}/tasks`), orderByChild('completedAt'), startAt(start), endAt(end));
  const stopActive = onValue(activeQuery, (snapshot) => { active = snapshot.val() ?? {}; publish(); }, onError);
  const stopCompleted = onValue(completedTodayQuery, (snapshot) => { completedToday = snapshot.val() ?? {}; publish(); }, onError);
  return () => { stopActive(); stopCompleted(); };
}

export function subscribeActiveCleaningTasks(
  onChange: (tasks: Record<string, CleaningTask>) => void,
  onError: (error: Error) => void,
): () => void {
  const activeTasks = query(ref(db, `${PATH}/tasks`), orderByChild('status'), equalTo('em_limpeza'));
  return onValue(activeTasks, (snapshot) => onChange(snapshot.val() ?? {}), onError);
}

export function subscribeRoomCleaningPlans(date: string, onChange: (plans: Record<string, RoomDayPlan>) => void, onError: (error: Error) => void): () => void {
  return onValue(ref(db, `erp_geral/quartos/dailyPlans/${date}`), (snapshot) => onChange(snapshot.val() ?? {}), onError);
}

export async function assignRooms(roomNumbers: string[], camareira: string, actor: string, employeeId?: string): Promise<void> {
  const numbers = [...new Set(roomNumbers.map((number) => number.trim()).filter(Boolean))];
  if (!numbers.length || !camareira.trim()) throw new Error('Selecione uma camareira e pelo menos um quarto cadastrado.');
  const now = new Date();
  const today = localDateKey(now);
  const [roomsSnapshot, activeSnapshot, plansSnapshot, reservationsSnapshot, staysSnapshot] = await Promise.all([
    get(ref(db, ROOMS_PATH)),
    get(query(ref(db, `${PATH}/tasks`), orderByChild('status'), equalTo('em_limpeza'))),
    get(ref(db, `erp_geral/quartos/dailyPlans/${today}`)),
    get(ref(db, 'erp_geral/quartos/reservationIndex')),
    get(query(ref(db, 'erp_geral/recepcao/stays'), orderByChild('status'), equalTo('hospedado'))),
  ]);
  const rooms = Object.values((roomsSnapshot.val() ?? {}) as Record<string, HousekeepingRoom>);
  const activeTasks = Object.values((activeSnapshot.val() ?? {}) as Record<string, CleaningTask>);
  const plans = (plansSnapshot.val() ?? {}) as Record<string, RoomDayPlan>;
  const occupiedNumbers = new Set([
    ...Object.values((reservationsSnapshot.val() ?? {}) as Record<string, ReservationDirectoryEntry>).filter((reservation) => reservationOccupiesToday(reservation, today, now.getTime())).map((reservation) => reservation.roomNumber),
    ...Object.values((staysSnapshot.val() ?? {}) as Record<string, GuestStay>).filter((stay) => guestStayOccupiesToday(stay, today, now.getTime())).map((stay) => stay.roomNumber),
  ]);
  const selectedRooms = numbers.map((number) => {
    const room = rooms.find((item) => item.number.trim() === number);
    if (!room) throw new Error(`Cadastre o quarto ${number} em Gerenciar quartos antes de designar a limpeza.`);
    if (room.maintenanceStatus === 'em_manutencao') throw new Error(`O quarto ${number} está bloqueado para manutenção.`);
    if (occupiedNumbers.has(number) && plans[room.id]?.cleaningRequest === 'dispensada') throw new Error(`O hóspede do quarto ${number} dispensou a limpeza de hoje. Atualize a solicitação em Gerenciar quartos antes de designar.`);
    if (activeTasks.some((task) => task.roomId === room.id || task.roomNumber.trim() === number)) {
      throw new Error(`O quarto ${number} já tem uma limpeza em andamento. Atualize a seleção.`);
    }
    return room;
  });
  const claimed: { roomId: string; taskId: string }[] = [];
  try {
    const updates: Record<string, unknown> = {};
    for (const room of selectedRooms) {
      const id = crypto.randomUUID();
      const claimedAt = Date.now();
      const lock = await runTransaction(ref(db, `${PATH}/activeRooms/${room.id}`), (current: CleaningClaim | null) => current === null
        || (current.expiresAt < claimedAt && !activeTasks.some((task) => task.id === current.taskId))
        ? { taskId: id, phase: 'assigning', expiresAt: claimedAt + CLAIM_DURATION_MS } satisfies CleaningClaim : undefined, { applyLocally: false });
      if (!lock.committed) throw new Error(`O quarto ${room.number} já foi designado para limpeza. Atualize a seleção.`);
      claimed.push({ roomId: room.id, taskId: id });
      updates[`${PATH}/tasks/${id}`] = { id, roomId: room.id, roomNumber: room.number, camareira: camareira.trim(), ...(employeeId ? { employeeId } : {}), status: 'em_limpeza', assignedBy: actor, assignedAt: now.toISOString(), date: localDateKey(now) };
      updates[`${ROOMS_PATH}/${room.id}/cleaningStatus`] = 'em_limpeza';
    }
    // A room blocked while the task was being assigned must remain unavailable.
    for (const room of selectedRooms) {
      const snapshot = await get(ref(db, `${ROOMS_PATH}/${room.id}`));
      if (!snapshot.exists() || snapshot.child('maintenanceStatus').val() === 'em_manutencao') {
        throw new Error(`O quarto ${room.number} está indisponível. Atualize a seleção.`);
      }
    }
    await update(ref(db), updates);
  } catch (cause) {
    await Promise.allSettled(claimed.map(({ roomId, taskId }) => releaseClaim(roomId, taskId)));
    throw cause;
  }
}

function taskMatchesRoom(task: CleaningTask, room: HousekeepingRoom): boolean {
  return task.roomId === room.id || task.roomNumber.trim() === room.number.trim();
}

function cleaningLog(task: CleaningTask, room: HousekeepingRoom, completedAt: string): RoomCleaningLog {
  return {
    id: `task-${task.id}`, roomId: room.id, roomNumber: room.number, attendant: task.camareira,
    ...(task.employeeId ? { employeeId: task.employeeId } : {}),
    date: localDateKey(new Date(completedAt)), completedAt, doorsAndWindows: false, note: '',
  };
}

function taskCompletionUpdates(task: CleaningTask, status: 'concluido' | 'cancelado', actor: string, completedAt: string, logId?: string): Record<string, unknown> {
  const path = `${PATH}/tasks/${task.id}`;
  return {
    [`${path}/status`]: status,
    [`${path}/completedAt`]: completedAt,
    [`${path}/completedBy`]: actor,
    ...(logId ? { [`${path}/cleaningLogId`]: logId } : {}),
  };
}

/** Reconcile manager room edits with the same tasks used by the cleaning board. */
export async function roomCleaningTaskUpdates(room: HousekeepingRoom, status: HousekeepingRoom['cleaningStatus'], actor: string, log?: RoomCleaningLog): Promise<Record<string, unknown>> {
  if (status === 'em_limpeza' && room.maintenanceStatus !== 'em_manutencao') return {};
  const snapshot = await get(query(ref(db, `${PATH}/tasks`), orderByChild('status'), equalTo('em_limpeza')));
  const tasks = Object.values((snapshot.val() ?? {}) as Record<string, CleaningTask>).filter((task) => taskMatchesRoom(task, room))
    .sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
  const completedAt = log?.completedAt ?? new Date().toISOString();
  const canComplete = status === 'limpo' && room.maintenanceStatus !== 'em_manutencao';
  const finalLog = canComplete && tasks.length ? log ?? cleaningLog(tasks[0], room, completedAt) : undefined;
  const updates: Record<string, unknown> = { [`${PATH}/activeRooms/${room.id}`]: null };
  tasks.forEach((task, index) => Object.assign(updates,
    taskCompletionUpdates(task, canComplete && index === 0 ? 'concluido' : 'cancelado', actor, completedAt, index === 0 ? finalLog?.id : undefined)));
  if (finalLog && tasks[0]) {
    updates[`${PATH}/tasks/${tasks[0].id}/camareira`] = finalLog.attendant;
    updates[`${PATH}/tasks/${tasks[0].id}/employeeId`] = finalLog.employeeId ?? null;
  }
  if (finalLog && !log) updates[`${LOGS_PATH}/${finalLog.id}`] = finalLog;
  return updates;
}

export async function renameRoomCleaningTasks(previous: HousekeepingRoom, next: HousekeepingRoom): Promise<Record<string, unknown>> {
  if (previous.number === next.number) return {};
  const [byNumber, byId, logsSnapshot] = await Promise.all([
    get(query(ref(db, `${PATH}/tasks`), orderByChild('roomNumber'), equalTo(previous.number))),
    get(query(ref(db, `${PATH}/tasks`), orderByChild('roomId'), equalTo(previous.id))),
    get(query(ref(db, LOGS_PATH), orderByChild('roomId'), equalTo(previous.id))),
  ]);
  const tasks = { ...(byNumber.val() ?? {}), ...(byId.val() ?? {}) } as Record<string, CleaningTask>;
  const updates: Record<string, unknown> = {};
  Object.values(tasks).forEach((task) => {
    updates[`${PATH}/tasks/${task.id}/roomNumber`] = next.number;
    updates[`${PATH}/tasks/${task.id}/roomId`] = next.id;
  });
  Object.values((logsSnapshot.val() ?? {}) as Record<string, RoomCleaningLog>).forEach((log) => {
    updates[`${LOGS_PATH}/${log.id}/roomNumber`] = next.number;
  });
  return updates;
}

export async function deleteCleaningLogTaskUpdates(log: RoomCleaningLog): Promise<Record<string, unknown>> {
  const snapshot = await get(query(ref(db, `${PATH}/tasks`), orderByChild('cleaningLogId'), equalTo(log.id)));
  return Object.fromEntries(Object.values((snapshot.val() ?? {}) as Record<string, CleaningTask>).map((task) => [`${PATH}/tasks/${task.id}`, null]));
}

async function releaseClaim(roomId: string, claim: string): Promise<void> {
  await withTransactionData(`${PATH}/activeRooms/${roomId}`, (reference) => runTransaction(reference, (current: CleaningClaim | null) => current?.taskId === claim && current.phase === 'assigning' ? null : undefined, { applyLocally: false }));
}

async function finishTask(task: CleaningTask, actor: string, status: 'concluido' | 'cancelado'): Promise<void> {
  const [taskSnapshot, roomsSnapshot] = await Promise.all([
    get(ref(db, `${PATH}/tasks/${task.id}`)), get(ref(db, ROOMS_PATH)),
  ]);
  const currentTask = taskSnapshot.val() as CleaningTask | null;
  if (!currentTask || currentTask.status !== 'em_limpeza') throw new Error('Esta limpeza já foi concluída ou cancelada. Atualize a tela.');
  const room = Object.values((roomsSnapshot.val() ?? {}) as Record<string, HousekeepingRoom>).find((item) => taskMatchesRoom(currentTask, item));
  if (!room) throw new Error('O quarto desta tarefa foi excluído. Atualize a tela.');
  if (status === 'concluido' && room.maintenanceStatus === 'em_manutencao') throw new Error('O quarto está bloqueado para manutenção. Cancele a tarefa ou libere o quarto primeiro.');
  const claimedAt = Date.now();
  const lock = await runTransaction(ref(db, `${PATH}/activeRooms/${room.id}`), (current: CleaningClaim | null) => current === null
    || (current.taskId === currentTask.id && (current.phase === 'assigning' || current.expiresAt < claimedAt))
    ? { taskId: currentTask.id, phase: 'finishing', expiresAt: claimedAt + CLAIM_DURATION_MS } satisfies CleaningClaim : undefined, { applyLocally: false });
  if (!lock.committed) throw new Error('A limpeza está sendo atualizada por outra pessoa. Aguarde e atualize a tela.');
  try {
    const latest = await get(ref(db, `${PATH}/tasks/${task.id}`));
    if (latest.child('status').val() !== 'em_limpeza') throw new Error('Esta limpeza já foi concluída ou cancelada. Atualize a tela.');
    const completedAt = new Date().toISOString();
    const log = status === 'concluido' ? cleaningLog(currentTask, room, completedAt) : undefined;
    const updates: Record<string, unknown> = {
      ...taskCompletionUpdates(currentTask, status, actor, completedAt, log?.id),
      [`${PATH}/tasks/${currentTask.id}/roomId`]: room.id,
      [`${ROOMS_PATH}/${room.id}/cleaningStatus`]: status === 'concluido' ? 'limpo' : 'sujo',
      [`${PATH}/activeRooms/${room.id}`]: null,
    };
    const activeSnapshot = await get(query(ref(db, `${PATH}/tasks`), orderByChild('status'), equalTo('em_limpeza')));
    Object.values((activeSnapshot.val() ?? {}) as Record<string, CleaningTask>)
      .filter((item) => item.id !== currentTask.id && taskMatchesRoom(item, room))
      .forEach((duplicate) => Object.assign(updates, taskCompletionUpdates(duplicate, 'cancelado', actor, completedAt)));
    if (log) updates[`${LOGS_PATH}/${log.id}`] = log;
    await update(ref(db), updates);
  } catch (cause) {
    await withTransactionData(`${PATH}/activeRooms/${room.id}`, (reference) => runTransaction(reference, (current: CleaningClaim | null) => current?.taskId === currentTask.id && current.phase === 'finishing'
      ? { taskId: currentTask.id, phase: 'assigning', expiresAt: Date.now() + CLAIM_DURATION_MS } satisfies CleaningClaim : undefined, { applyLocally: false }));
    throw cause;
  }
}

export async function completeTask(task: CleaningTask, actor: string): Promise<void> {
  await finishTask(task, actor, 'concluido');
}

export async function cancelTask(task: CleaningTask, actor: string): Promise<void> {
  await finishTask(task, actor, 'cancelado');
}

export async function deleteCleaningTask(id: string): Promise<void> {
  const snapshot = await get(ref(db, `${PATH}/tasks/${id}`));
  const task = snapshot.val() as CleaningTask | null;
  if (!task) return;
  if (task.status === 'em_limpeza') await cancelTask(task, 'Gerência');
  const updates: Record<string, unknown> = { [`${PATH}/tasks/${id}`]: null };
  if (task.cleaningLogId) {
    const logSnapshot = await get(ref(db, `${LOGS_PATH}/${task.cleaningLogId}`));
    const log = logSnapshot.val() as RoomCleaningLog | null;
    updates[`${LOGS_PATH}/${task.cleaningLogId}`] = null;
    if (log) {
      const [remainingSnapshot, roomSnapshot] = await Promise.all([
        get(query(ref(db, LOGS_PATH), orderByChild('roomId'), equalTo(log.roomId))),
        get(ref(db, `${ROOMS_PATH}/${log.roomId}`)),
      ]);
      const remaining = Object.values((remainingSnapshot.val() ?? {}) as Record<string, RoomCleaningLog>).filter((item) => item.id !== log.id);
      if (!remaining.length && roomSnapshot.child('cleaningStatus').val() === 'limpo') updates[`${ROOMS_PATH}/${log.roomId}/cleaningStatus`] = 'sujo';
    }
  }
  await update(ref(db), updates);
}
