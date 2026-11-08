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

// `available` é verdadeiro só para a gerência; funcionários nunca veem o botão nem recebem o tema.
export function useManagerTheme(userRole: UserRole) {
  const preferred = useSyncExternalStore(subscribe, () => readManagerThemePreference(), () => false);
  const toggle = useCallback(() => {
    writeManagerThemePreference(!readManagerThemePreference());
    listeners.forEach((listener) => listener());
  }, []);
  return { available: userRole === 'admin', enabled: managerThemeApplies(userRole, preferred), preferred, toggle };
}
