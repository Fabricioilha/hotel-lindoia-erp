import { get, ref } from 'firebase/database';
import type { User } from 'firebase/auth';
import { app, db } from '../config/firebase';
import type { UserRole } from '../types';

export async function observeAuth(onUser: (user: User | null) => void) {
  const { getAuth, onAuthStateChanged } = await import('firebase/auth');
  return onAuthStateChanged(getAuth(app), onUser);
}

export async function readUserRole(uid: string): Promise<UserRole> {
  const snapshot = await get(ref(db, `roles/${uid}/role`));
  const role = snapshot.val();
  return role === 'admin' || role === 'viewer' ? role : null;
}

export async function signInUser(email: string, password: string): Promise<UserRole> {
  const { getAuth, signInWithEmailAndPassword, signOut } = await import('firebase/auth');
  const auth = getAuth(app);
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  try {
    const role = await readUserRole(credential.user.uid);
    if (role) return role;
    throw new Error('Conta autenticada sem perfil de acesso.');
  } catch (error) {
    await signOut(auth);
    throw error;
  }
}

export function signOutUser(): Promise<void> {
  return import('firebase/auth').then(({ getAuth, signOut }) => signOut(getAuth(app)));
}