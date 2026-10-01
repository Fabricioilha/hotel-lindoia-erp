// src/config/firebase.ts
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, type Database } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyDtOODuVs7QzZVmxohSgWcpMpUpG-JVj3w",
  authDomain: "hotel-lindoia-erp.firebaseapp.com",
  projectId: "hotel-lindoia-erp",
  storageBucket: "hotel-lindoia-erp.firebasestorage.app",
  messagingSenderId: "101095801473",
  appId: "1:101095801473:web:339d6ad1184b2393ac4380"
};

const app = initializeApp(firebaseConfig);

const databaseUrl = import.meta.env.VITE_FIREBASE_DATABASE_URL;
export const db: Database = getDatabase(app, databaseUrl);

export const dbRef = ref(db, 'erp_geral');