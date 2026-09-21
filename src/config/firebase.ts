// src/config/firebase.ts
import { initializeApp } from "firebase/app";
import { getDatabase, ref } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDtOODuVs7QzZVmxohSgWcpMpUpG-JVj3w",
  authDomain: "hotel-lindoia-erp.firebaseapp.com",
  projectId: "hotel-lindoia-erp",
  storageBucket: "hotel-lindoia-erp.firebasestorage.app",
  messagingSenderId: "101095801473",
  appId: "1:101095801473:web:339d6ad1184b2393ac4380"
};

// Inicializa o Firebase
const app = initializeApp(firebaseConfig);

// Exporta o banco de dados para ser usado nos outros componentes do React
export const db = getDatabase(app);

// Cria a referência principal (uma "gaveta" vazia pronta para receber os dados do ERP)
export const dbRef = ref(db, 'erp_geral');