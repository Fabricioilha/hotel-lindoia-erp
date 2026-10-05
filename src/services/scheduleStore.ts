import { onValue, ref, runTransaction } from 'firebase/database';
import { db } from '../config/firebase';
import type { ScheduleData, Shift } from '../types';

const STORAGE_KEY = 'hotel-lindoia:schedule:v1';
const LOCAL_UPDATE_EVENT = 'hotel-lindoia:schedule-updated';

export interface ScheduleStoreData {
  days: ScheduleData;
  employees: string[];
}

export const DEFAULT_EMPLOYEES = [
  'Amanda', 'Bianca', 'Cevani', 'Felipe', 'Juliana', 'Julya', 'Luana', 'Paulo', 'Tatiana', 'Márcia',
];

export function emptySchedule(): ScheduleStoreData {
  return { days: {}, employees: [...DEFAULT_EMPLOYEES] };
}

function normalizeSchedule(value: unknown): ScheduleStoreData {
  const data = value && typeof value === 'object' ? value as Partial<ScheduleStoreData> : {};
  const days = data.days && typeof data.days === 'object' ? data.days : {};
  const employees = Array.isArray(data.employees)
    ? data.employees.filter((employee): employee is string => typeof employee === 'string' && employee.trim().length > 0)
    : DEFAULT_EMPLOYEES;

  return { days, employees: [...new Set(employees.map((employee) => employee.trim()))] };
}

function readLocalSchedule(): ScheduleStoreData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeSchedule(JSON.parse(saved)) : emptySchedule();
  } catch {
    return emptySchedule();
  }
}

export const scheduleStorageMode = db ? 'Firebase' : 'neste navegador';

export function subscribeSchedule(
  onChange: (data: ScheduleStoreData) => void,
  onError: (error: Error) => void,
): () => void {
  if (db) {
    return onValue(
      ref(db, 'erp_geral/escala'),
      (snapshot) => onChange(normalizeSchedule(snapshot.val())),
      onError,
    );
  }

  const refresh = () => onChange(readLocalSchedule());
  refresh();
  window.addEventListener('storage', refresh);
  window.addEventListener(LOCAL_UPDATE_EVENT, refresh);
  return () => {
    window.removeEventListener('storage', refresh);
    window.removeEventListener(LOCAL_UPDATE_EVENT, refresh);
  };
}

export async function updateSchedule(update: (current: ScheduleStoreData) => ScheduleStoreData): Promise<void> {
  if (db) {
    const result = await runTransaction(ref(db, 'erp_geral/escala'), (current) => update(normalizeSchedule(current)));
    if (!result.committed) throw new Error('A gravação da escala não foi confirmada.');
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(update(readLocalSchedule())));
  window.dispatchEvent(new Event(LOCAL_UPDATE_EVENT));
}

export function withShift(days: ScheduleData, dateKey: string, shift: Shift): ScheduleData {
  return { ...days, [dateKey]: [...(days[dateKey] ?? []), shift] };
}