import { onValue, ref, runTransaction } from 'firebase/database';
import { db } from '../config/firebase';
import type { HousekeepingData } from '../types/housekeeping';

const STORAGE_KEY = 'hotel-lindoia:housekeeping:v1';
const LOCAL_UPDATE_EVENT = 'hotel-lindoia:housekeeping-updated';

export function emptyHousekeeping(): HousekeepingData {
  return {
    rooms: {},
    dailyPlans: {},
    cleaningLogs: {},
    reservations: {},
    settings: { doorsAndWindowsIntervalDays: 5 },
  };
}

function normalizeHousekeeping(value: unknown): HousekeepingData {
  const data = value && typeof value === 'object' ? value as Partial<HousekeepingData> : {};
  return {
    rooms: data.rooms ?? {},
    dailyPlans: data.dailyPlans ?? {},
    cleaningLogs: data.cleaningLogs ?? {},
    reservations: data.reservations ?? {},
    settings: {
      doorsAndWindowsIntervalDays: Math.max(1, Number(data.settings?.doorsAndWindowsIntervalDays) || 5),
    },
  };
}

function readLocalHousekeeping(): HousekeepingData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeHousekeeping(JSON.parse(saved)) : emptyHousekeeping();
  } catch {
    return emptyHousekeeping();
  }
}

export const housekeepingStorageMode = import.meta.env.DEV ? 'neste navegador' : 'Firebase';

export function subscribeHousekeeping(
  onChange: (data: HousekeepingData) => void,
  onError: (error: Error) => void,
): () => void {
  if (import.meta.env.DEV) {
    const refresh = () => onChange(readLocalHousekeeping());
    refresh();
    window.addEventListener('storage', refresh);
    window.addEventListener(LOCAL_UPDATE_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(LOCAL_UPDATE_EVENT, refresh);
    };
  }

  return onValue(
    ref(db, 'erp_geral/quartos'),
    (snapshot) => onChange(normalizeHousekeeping(snapshot.val())),
    onError,
  );
}

export async function updateHousekeeping(
  update: (current: HousekeepingData) => HousekeepingData,
): Promise<void> {
  if (import.meta.env.DEV) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(update(readLocalHousekeeping())));
    window.dispatchEvent(new Event(LOCAL_UPDATE_EVENT));
    return;
  }

  const result = await runTransaction(ref(db, 'erp_geral/quartos'), (current) =>
    update(normalizeHousekeeping(current)),
  );
  if (!result.committed) throw new Error('A gravação do serviço de quarto não foi confirmada.');
}