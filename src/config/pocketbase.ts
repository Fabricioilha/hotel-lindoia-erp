import type {} from '../vite-env';
import PocketBase from 'pocketbase';

export const ERP_SCHEMA_VERSION = 2;

export interface SystemBannerState {
  maintenanceReadonly: boolean;
  maintenanceMessage: string;
  upgradeRequired: boolean;
  upgradeMessage: string;
}

const initialBannerState: SystemBannerState = {
  maintenanceReadonly: false,
  maintenanceMessage: '',
  upgradeRequired: false,
  upgradeMessage: '',
};

let bannerState: SystemBannerState = { ...initialBannerState };
const bannerListeners = new Set<(state: SystemBannerState) => void>();

export function getSystemBannerState(): SystemBannerState {
  return bannerState;
}

export function subscribeSystemBanner(listener: (state: SystemBannerState) => void): () => void {
  bannerListeners.add(listener);
  listener(bannerState);
  return () => {
    bannerListeners.delete(listener);
  };
}

export function reportSystemBanner(patch: Partial<SystemBannerState>): void {
  const next: SystemBannerState = { ...bannerState, ...patch };
  if (JSON.stringify(next) === JSON.stringify(bannerState)) return;
  bannerState = next;
  bannerListeners.forEach((listener) => listener(bannerState));
}

export function inspectApiErrorStatus(error: unknown): void {
  if (!error || typeof error !== 'object' || !('status' in error)) return;
  const status = Number((error as { status?: unknown }).status);
  const message = error instanceof Error ? error.message : '';
  if (status === 426) {
    reportSystemBanner({
      upgradeRequired: true,
      upgradeMessage: message || 'Uma nova versão do ERP foi publicada. Recarregue a página para continuar.',
    });
  } else if (status === 503) {
    reportSystemBanner({
      maintenanceReadonly: true,
      maintenanceMessage: message || 'Sistema em manutenção rápida (somente leitura). Nenhuma alteração foi descartada.',
    });
  }
}

const pocketbaseUrl = import.meta.env.VITE_POCKETBASE_URL || 'http://127.0.0.1:8090';

export const pb = new PocketBase(pocketbaseUrl);
pb.autoCancellation(false);
pb.beforeSend = (url, options) => {
  const headers = new Headers(options.headers as HeadersInit | undefined);
  headers.set('X-ERP-Schema-Version', String(ERP_SCHEMA_VERSION));
  options.headers = Object.fromEntries(headers.entries());
  return { url, options };
};
