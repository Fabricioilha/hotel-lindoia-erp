// src/config/firebase.ts
import { initializeApp } from 'firebase/app';
import { connectDatabaseEmulator, getDatabase, ref, type Database } from 'firebase/database';
import { connectAuthEmulator, getAuth } from 'firebase/auth';

const useFirebaseEmulators = import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS !== 'false';
const emulatorProjectId = import.meta.env.VITE_FIREBASE_EMULATOR_PROJECT_ID ?? 'demo-hotel-lindoia-erp';

if (useFirebaseEmulators && !emulatorProjectId.startsWith('demo-')) {
  throw new Error('O projeto local do Firebase precisa usar o prefixo demo- para impedir acesso a serviços de produção.');
}

const productionFirebaseConfig = {
  apiKey: "AIzaSyDtOODuVs7QzZVmxohSgWcpMpUpG-JVj3w",
  authDomain: "hotel-lindoia-erp.firebaseapp.com",
  projectId: "hotel-lindoia-erp",
  storageBucket: "hotel-lindoia-erp.firebasestorage.app",
  databaseURL: 'https://hotel-lindoia-erp-default-rtdb.firebaseio.com',
  messagingSenderId: "101095801473",
  appId: "1:101095801473:web:339d6ad1184b2393ac4380"
};

const firebaseConfig = useFirebaseEmulators
  ? {
      ...productionFirebaseConfig,
      authDomain: `${emulatorProjectId}.firebaseapp.com`,
      projectId: emulatorProjectId,
      storageBucket: `${emulatorProjectId}.firebasestorage.app`,
      databaseURL: `https://${emulatorProjectId}-default-rtdb.firebaseio.com`,
    }
  : productionFirebaseConfig;

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export const db: Database = getDatabase(app);

if (useFirebaseEmulators) {
  const emulatorHost = import.meta.env.VITE_FIREBASE_EMULATOR_HOST ?? '127.0.0.1';
  const authPort = Number(import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_PORT ?? 9099);
  const databasePort = Number(import.meta.env.VITE_FIREBASE_DATABASE_EMULATOR_PORT ?? 9000);

  connectAuthEmulator(auth, `http://${emulatorHost}:${authPort}`, { disableWarnings: true });
  connectDatabaseEmulator(db, emulatorHost, databasePort);
}

export const dbRef = ref(db, 'erp_geral');
