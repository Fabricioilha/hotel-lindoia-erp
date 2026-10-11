import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyDtOODuVs7QzZVmxohSgWcpMpUpG-JVj3w",
  authDomain: "hotel-lindoia-erp.firebaseapp.com",
  projectId: "hotel-lindoia-erp",
  storageBucket: "hotel-lindoia-erp.firebasestorage.app",
  databaseURL: 'https://hotel-lindoia-erp-default-rtdb.firebaseio.com',
  messagingSenderId: "101095801473",
  appId: "1:101095801473:web:339d6ad1184b2393ac4380"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
