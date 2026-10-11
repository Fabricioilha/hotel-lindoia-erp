import { endAt, equalTo, onValue, orderByChild, query, ref, remove, startAt, update } from 'firebase/database';
import { db } from '../config/firebase';
import { type CleaningData, type CleaningTask } from '../types/cleaning';
import { localDateKey } from './receptionStore';

const PATH = 'erp_geral/limpeza';

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

export async function assignRooms(roomNumbers: string[], camareira: string, actor: string, employeeId?: string): Promise<void> {
  const now = new Date();
  const updates: Record<string, CleaningTask> = {};
  roomNumbers.forEach((roomNumber) => {
    const id = crypto.randomUUID();
    updates[`tasks/${id}`] = { id, roomNumber, camareira, ...(employeeId ? { employeeId } : {}), status: 'em_limpeza', assignedBy: actor, assignedAt: now.toISOString(), date: localDateKey(now) };
  });
  await update(ref(db, PATH), updates);
}

export async function completeTask(task: CleaningTask, actor: string): Promise<void> {
  await update(ref(db, `${PATH}/tasks/${task.id}`), { status: 'concluido', completedAt: new Date().toISOString(), completedBy: actor });
}

export async function cancelTask(task: CleaningTask, actor: string): Promise<void> {
  await update(ref(db, `${PATH}/tasks/${task.id}`), { status: 'cancelado', completedAt: new Date().toISOString(), completedBy: actor });
}

export async function deleteCleaningTask(id: string): Promise<void> {
  await remove(ref(db, `${PATH}/tasks/${id}`));
}
