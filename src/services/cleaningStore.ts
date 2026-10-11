import { equalTo, onValue, orderByChild, query, ref, remove, update } from 'firebase/database';
import { db } from '../config/firebase';
import { type CleaningData, type CleaningTask } from '../types/cleaning';
import { localDateKey } from './receptionStore';

const PATH = 'erp_geral/limpeza';

export function emptyCleaning(): CleaningData {
  return { camareiras: {}, camareirasConfigured: false, tasks: {} };
}

export function subscribeCleaning(onChange: (data: CleaningData) => void, onError: (error: Error) => void): () => void {
  return onValue(ref(db, `${PATH}/tasks`), (snapshot) => onChange({ ...emptyCleaning(), tasks: snapshot.val() ?? {} }), onError);
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
