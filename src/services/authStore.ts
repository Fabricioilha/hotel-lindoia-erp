import { pb } from '../config/pocketbase';
import type { UserRole } from '../types';

export interface AuthUser {
  uid: string;
  email: string;
  getIdToken(): Promise<string>;
}

function currentUser(): AuthUser | null {
  const record = pb.authStore.record;
  if (!record) return null;
  return {
    uid: record.id,
    email: record.email,
    getIdToken: async () => pb.authStore.token,
  };
}

async function loadRole(): Promise<UserRole> {
  if (!pb.authStore.isValid) return null;
  const result = await pb.send<{ role: UserRole }>('/api/hotel/me', {});
  return result.role === 'admin' || result.role === 'viewer' ? result.role : null;
}

export async function observeAuth(onUser: (user: AuthUser | null) => void) {
  const unsubscribe = pb.authStore.onChange(() => onUser(currentUser()), false);
  try {
    if (pb.authStore.isValid) {
      await pb.collection('users').authRefresh();
      await loadRole();
    }
  } catch {
    pb.authStore.clear();
  }
  onUser(currentUser());
  return unsubscribe;
}

export async function readUserRole(uid: string): Promise<UserRole> {
  if (currentUser()?.uid !== uid) return null;
  return loadRole();
}

export async function signInUser(email: string, password: string): Promise<UserRole> {
  await pb.collection('users').authWithPassword(email.trim().toLowerCase(), password);
  try {
    const role = await loadRole();
    if (role) return role;
    throw new Error('Conta autenticada sem perfil de acesso.');
  } catch (error) {
    pb.authStore.clear();
    throw error;
  }
}

export async function signOutUser(): Promise<void> {
  pb.authStore.clear();
}