import { onValue, ref, remove, set, update } from 'firebase/database';
import { db } from '../config/firebase';
import { DEFAULT_CAMAREIRAS, type Camareira, type CleaningData, type CleaningTask } from '../types/cleaning';
import { localDateKey } from './receptionStore';

const PATH = 'erp_geral/limpeza';

export function emptyCleaning(): CleaningData {
  return { camareiras: {}, camareirasConfigured: false, tasks: {} };
}

export function subscribeCleaning(onChange: (data: CleaningData) => void, onError: (error: Error) => void): () => void {
  return onValue(ref(db, PATH), (snapshot) => {
    const value = snapshot.val() ?? {};
    onChange({ camareiras: value.camareiras ?? {}, camareirasConfigured: Boolean(value.camareirasConfigured), tasks: value.tasks ?? {} });
  }, onError);
}

export async function seedDefaultCamareiras(): Promise<void> {
  const camareiras = Object.fromEntries(DEFAULT_CAMAREIRAS.map((name) => {
    const id = crypto.randomUUID();
    return [id, { id, name }];
  }));
  await update(ref(db, PATH), { camareiras, camareirasConfigured: true });
}

export async function saveCamareira(camareira: Camareira): Promise<void> {
  await update(ref(db, PATH), { [`camareiras/${camareira.id}`]: camareira, camareirasConfigured: true });
}

export async function deleteCamareira(id: string): Promise<void> {
  await remove(ref(db, `${PATH}/camareiras/${id}`));
}

export async function assignRooms(roomNumbers: string[], camareira: string, actor: string): Promise<void> {
  const now = new Date();
  const updates: Record<string, CleaningTask> = {};
  roomNumbers.forEach((roomNumber) => {
    const id = crypto.randomUUID();
    updates[`tasks/${id}`] = { id, roomNumber, camareira, status: 'em_limpeza', assignedBy: actor, assignedAt: now.toISOString(), date: localDateKey(now) };
  });
  await update(ref(db, PATH), updates);
}

export async function completeTask(task: CleaningTask, actor: string): Promise<void> {
  await set(ref(db, `${PATH}/tasks/${task.id}`), { ...task, status: 'concluido', completedAt: new Date().toISOString(), completedBy: actor });
}

export async function cancelTask(task: CleaningTask, actor: string): Promise<void> {
  await set(ref(db, `${PATH}/tasks/${task.id}`), { ...task, status: 'cancelado', completedAt: new Date().toISOString(), completedBy: actor });
}
