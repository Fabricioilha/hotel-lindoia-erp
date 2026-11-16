import { useCallback, useSyncExternalStore } from 'react';
import type { UserRole } from '../types';
import { MANAGER_THEME_STORAGE_KEY, managerThemeApplies, readManagerThemePreference, writeManagerThemePreference } from './managerTheme';

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Mantém abas abertas em sincronia quando a preferência muda em outra aba.
  const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === MANAGER_THEME_STORAGE_KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

// A preferência fica disponível para qualquer perfil autenticado e continua sincronizada entre abas.
export function useManagerTheme(userRole: UserRole) {
  const preferred = useSyncExternalStore(subscribe, () => readManagerThemePreference(), () => false);
  const toggle = useCallback(() => {
    writeManagerThemePreference(!readManagerThemePreference());
    listeners.forEach((listener) => listener());
  }, []);
  return { available: userRole === 'admin' || userRole === 'viewer', enabled: managerThemeApplies(userRole, preferred), preferred, toggle };
}
