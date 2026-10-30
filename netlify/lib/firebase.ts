import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';

export function adminServices() {
  if (!getApps().length) {
    const credentials = process.env.FIREBASE_SERVICE_ACCOUNT;
    const databaseURL = process.env.FIREBASE_DATABASE_URL;
    if (!credentials || !databaseURL) throw new Error('Configure FIREBASE_SERVICE_ACCOUNT e FIREBASE_DATABASE_URL no servidor.');
    initializeApp({ credential: cert(JSON.parse(credentials)), databaseURL });
  }
  return { auth: getAuth(), db: getDatabase() };
}
