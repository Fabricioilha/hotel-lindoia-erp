import { onValue, ref, remove, set } from 'firebase/database';
import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { db } from '../config/firebase';
import { updateFinance } from './financeStore';
import { recordOperationalIncomes, type OperationalIncomeInput } from './operationalIncome';
import { DEFAULT_ATTENDANTS, extraTotal, type Attendant, type CashOut, type FloatCheck, type GuestStay, type ReceptionData, type ReceptionRoom } from '../types/reception';

const PATH = 'erp_geral/recepcao';

export function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function emptyReception(): ReceptionData {
  return { attendants: {}, stays: {}, rooms: {}, cashOuts: {}, floatChecks: {} };
}

export function subscribeReception(onChange: (data: ReceptionData) => void, onError: (error: Error) => void): () => void {
  return onValue(ref(db, PATH), (snapshot) => {
    const value = snapshot.val() ?? {};
    onChange({ attendants: value.attendants ?? {}, stays: value.stays ?? {}, rooms: value.rooms ?? {}, cashOuts: value.cashOuts ?? {}, floatChecks: value.floatChecks ?? {} });
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

export function saveFloatCheck(check: FloatCheck): Promise<void> {
  return set(ref(db, `${PATH}/floatChecks/${check.id}`), check);
}

export function saveCashOut(cashOut: CashOut): Promise<void> {
  return set(ref(db, `${PATH}/cashOuts/${cashOut.id}`), cashOut);
}

const ensuredCashOuts = new Set<string>();

// Roda na sessão da gerência: lança as saídas de caixa como despesas pagas em dinheiro.
export function useCashOutFinanceSync(cashOuts: Record<string, CashOut>, isAdmin: boolean, setError: Dispatch<SetStateAction<string>>) {
  useEffect(() => {
    const pending = Object.values(cashOuts).filter((cashOut) => !ensuredCashOuts.has(cashOut.id));
    if (pending.length === 0) return;
    void updateFinance((current) => {
      const timestamp = new Date().toISOString();
      let expenses = current.expenses;
      pending.forEach((cashOut) => {
        const id = `caixa-${cashOut.id}`;
        if (current.suppressed[id] || expenses[id]) return;
        const note = ['Saída de caixa', cashOut.reason, cashOut.note, `Plantão ${cashOut.attendant}`].filter(Boolean).join(' · ');
        expenses = { ...expenses, [id]: { id, dueDate: cashOut.date, category: 'Saída de caixa', plannedAmount: cashOut.amount, paidCash: cashOut.amount, paidBank: 0, note, createdAt: timestamp, updatedAt: timestamp } };
      });
      return expenses === current.expenses ? current : { ...current, expenses };
    }).then(() => pending.forEach((cashOut) => ensuredCashOuts.add(cashOut.id)))
      .catch((cause: unknown) => setError(cause instanceof Error ? `Saída de caixa não conciliada no Financeiro: ${cause.message}` : 'Saída de caixa não conciliada no Financeiro.'));
  }, [cashOuts, isAdmin, setError]);
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

export async function deleteCashOut(id: string): Promise<void> {
  await remove(ref(db, `${PATH}/cashOuts/${id}`));
  await updateFinance((current) => {
    if (!current.expenses[`caixa-${id}`]) return current;
    const expenses = { ...current.expenses };
    delete expenses[`caixa-${id}`];
    return { ...current, expenses };
  });
}

export function useReceptionFinanceSync(stays: Record<string, GuestStay>, isAdmin: boolean, setError: Dispatch<SetStateAction<string>>) {
  useEffect(() => {
    const report = (cause: unknown) => setError(cause instanceof Error ? `Caixa - Recepção não conciliado no Financeiro: ${cause.message}` : 'Caixa - Recepção não conciliado no Financeiro.');
    const inputs: OperationalIncomeInput[] = [];
    Object.values(stays).forEach((stay) => {
      const prefix = incomePrefix(stay.id);
      const note = [stay.kind === 'periodo' ? `Rotativo ${stay.hours ?? 4}h` : '', `Quarto ${stay.roomNumber}`, stay.guestName, `Plantão ${stay.attendant}`, stay.note].filter(Boolean).join(' · ');
      const base = { date: stay.checkInDate, note };
      const split = stay.dailySplit && stay.dailySplit.amount > 0 && stay.dailySplit.amount < stay.dailyRate * stay.nights ? stay.dailySplit : undefined;
      if (stay.dailyRate > 0) inputs.push({ ...base, id: `${prefix}diaria`, category: 'Diária', description: stay.kind === 'periodo' ? `Rotativo (${stay.hours ?? 4}h)` : `Diária × ${stay.nights}`, amount: stay.dailyRate * stay.nights - (split?.amount ?? 0), paymentMethod: stay.dailyMethod });
      if (split) inputs.push({ ...base, id: `${prefix}diaria-2`, category: 'Diária', description: `Diária × ${stay.nights} (2ª forma)`, amount: split.amount, paymentMethod: split.method });
      if (stay.hasBreakfast && stay.breakfastRate > 0) inputs.push({ ...base, id: `${prefix}cafe`, category: 'Café', description: `Café × ${stay.nights}`, amount: stay.breakfastRate * stay.nights, paymentMethod: stay.dailyMethod });
      if (stay.taxAmount > 0) inputs.push({ ...base, id: `${prefix}taxa`, category: 'Diária', description: 'Taxa', amount: stay.taxAmount, paymentMethod: stay.taxMethod });
      (stay.extras ?? []).forEach((extra) => {
        const amount = extraTotal(extra, stay.nights);
        if (amount > 0) inputs.push({ ...base, id: `${prefix}extra-${extra.id}`, category: 'Diária', description: extra.label, amount, paymentMethod: extra.method ?? stay.dailyMethod });
      });
    });
    void recordOperationalIncomes(inputs).catch(report);
  }, [stays, isAdmin, setError]);
}
