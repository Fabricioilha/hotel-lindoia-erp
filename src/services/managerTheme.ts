import type { UserRole } from '../types';

// O tema escuro "Dark Glassmorphism" é exclusivo da gerência: só vale para o perfil admin e nunca é aplicado
// ao login de funcionários nem à tela de entrada.
export const MANAGER_THEME_STORAGE_KEY = 'lindoia_manager_dark_glass';
export const MANAGER_THEME_ATTRIBUTE = 'data-manager-theme';
export const MANAGER_THEME_VALUE = 'dark-glass';

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface ThemeElement { setAttribute(name: string, value: string): void; removeAttribute(name: string): void }
interface ThemeDocument { documentElement: ThemeElement; body?: ThemeElement | null }

function browserStorage(): ThemeStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function readManagerThemePreference(storage: ThemeStorage | null = browserStorage()): boolean {
  try { return storage?.getItem(MANAGER_THEME_STORAGE_KEY) === 'true'; } catch { return false; }
}

export function writeManagerThemePreference(enabled: boolean, storage: ThemeStorage | null = browserStorage()): void {
  try { storage?.setItem(MANAGER_THEME_STORAGE_KEY, String(enabled)); } catch { /* armazenamento indisponível: a preferência vale só nesta sessão */ }
}

export function managerThemeApplies(role: UserRole, preferred: boolean): boolean {
  return role === 'admin' && preferred;
}

export function clearManagerTheme(doc: ThemeDocument | undefined = typeof document === 'undefined' ? undefined : document): void {
  doc?.documentElement.removeAttribute(MANAGER_THEME_ATTRIBUTE);
  doc?.body?.removeAttribute(MANAGER_THEME_ATTRIBUTE);
}

// Liga o tema só para o gerente; qualquer outro perfil, ou a ausência de sessão, remove o atributo imediatamente.
export function applyManagerTheme(role: UserRole, preferred: boolean, doc: ThemeDocument | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  clearManagerTheme(doc);
  if (!doc || !managerThemeApplies(role, preferred)) return false;
  doc.documentElement.setAttribute(MANAGER_THEME_ATTRIBUTE, MANAGER_THEME_VALUE);
  return true;
}
