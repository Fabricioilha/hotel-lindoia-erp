import { onValue, ref, remove, set } from 'firebase/database';
import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { db } from '../config/firebase';
import { updateFinance } from './financeStore';
import { recordOperationalIncome } from './operationalIncome';
import { DEFAULT_ATTENDANTS, extraTotal, type Attendant, type GuestStay, type ReceptionData, type ReceptionRoom } from '../types/reception';

const PATH = 'erp_geral/recepcao';

export function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function emptyReception(): ReceptionData {
  return { attendants: {}, stays: {}, rooms: {} };
}

export function subscribeReception(onChange: (data: ReceptionData) => void, onError: (error: Error) => void): () => void {
  return onValue(ref(db, PATH), (snapshot) => {
    const value = snapshot.val() ?? {};
    onChange({ attendants: value.attendants ?? {}, stays: value.stays ?? {}, rooms: value.rooms ?? {} });
  }, onError);
}

export async function seedDefaultAttendants(): Promise<void> {
  const attendants = Object.fromEntries(DEFAULT_ATTENDANTS.map((name) => {
    const id = crypto.randomUUID();
    return [id, { id, name }];
  }));
  await set(ref(db, `${PATH}/attendants`), attendants);
}

export function saveAttendant(attendant: Attendant): Promise<void> {
  return set(ref(db, `${PATH}/attendants/${attendant.id}`), attendant);
}

export function deleteAttendant(id: string): Promise<void> {
  return remove(ref(db, `${PATH}/attendants/${id}`));
}

export function saveRoom(room: ReceptionRoom): Promise<void> {
  return set(ref(db, `${PATH}/rooms/${room.id}`), room);
}

export function deleteRoom(id: string): Promise<void> {
  return remove(ref(db, `${PATH}/rooms/${id}`));
}

export function saveStay(stay: GuestStay): Promise<void> {
  return set(ref(db, `${PATH}/stays/${stay.id}`), stay);
}

function incomePrefix(stayId: string) {
  return `recepcao-${stayId}-`;
}

export async function deleteStay(stay: GuestStay): Promise<void> {
  await remove(ref(db, `${PATH}/stays/${stay.id}`));
  const prefix = incomePrefix(stay.id);
  await updateFinance((current) => {
    const ids = Object.keys(current.incomes).filter((id) => id.startsWith(prefix));
    if (ids.length === 0) return current;
    const incomes = { ...current.incomes };
    ids.forEach((id) => delete incomes[id]);
    return { ...current, incomes };
  });
}

export function useReceptionFinanceSync(stays: Record<string, GuestStay>, isAdmin: boolean, setError: Dispatch<SetStateAction<string>>) {
  useEffect(() => {
    if (!isAdmin) return;
    const report = (cause: unknown) => setError(cause instanceof Error ? `Caixa - Recepção não conciliado no Financeiro: ${cause.message}` : 'Caixa - Recepção não conciliado no Financeiro.');
    Object.values(stays).forEach((stay) => {
      const prefix = incomePrefix(stay.id);
      const note = [stay.kind === 'periodo' ? 'Período' : '', `Quarto ${stay.roomNumber}`, stay.guestName, `Plantão ${stay.attendant}`, stay.note].filter(Boolean).join(' · ');
      const base = { date: stay.checkInDate, note };
      if (stay.dailyRate > 0) void recordOperationalIncome({ ...base, id: `${prefix}diaria`, category: 'Diária', description: `Diária × ${stay.nights}`, amount: stay.dailyRate * stay.nights, paymentMethod: stay.dailyMethod }).catch(report);
      if (stay.hasBreakfast && stay.breakfastRate > 0) void recordOperationalIncome({ ...base, id: `${prefix}cafe`, category: 'Café', description: `Café × ${stay.nights}`, amount: stay.breakfastRate * stay.nights, paymentMethod: stay.dailyMethod }).catch(report);
      if (stay.taxAmount > 0) void recordOperationalIncome({ ...base, id: `${prefix}taxa`, category: 'Diária', description: 'Taxa', amount: stay.taxAmount, paymentMethod: stay.taxMethod }).catch(report);
      (stay.extras ?? []).forEach((extra) => {
        const amount = extraTotal(extra, stay.nights);
        if (amount > 0) void recordOperationalIncome({ ...base, id: `${prefix}extra-${extra.id}`, category: 'Diária', description: extra.label, amount, paymentMethod: stay.dailyMethod }).catch(report);
      });
    });
  }, [stays, isAdmin, setError]);
}
