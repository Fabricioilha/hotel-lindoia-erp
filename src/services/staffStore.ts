import { useEffect, useState } from 'react';
import { get, onValue, ref, runTransaction } from 'firebase/database';
import { db } from '../config/firebase';
import { defaultStaff, findStaff, staffMembers, staffNameKey, type StaffData, type StaffMember } from '../types/staff';
import { updateSchedule } from './scheduleStore';

const PATH = 'erp_geral/escala/staff';
let staffSnapshot = defaultStaff();
let stopStaff: (() => void) | undefined;
const listeners = new Set<{ change: (data: StaffData) => void; error: (cause: Error) => void }>();

export function staffReference(name: string): { employeeId?: string } {
  const member = findStaff(staffSnapshot, name);
  return member ? { employeeId: member.id } : {};
}

export function subscribeStaff(change: (data: StaffData) => void, error: (cause: Error) => void): () => void {
  const listener = { change, error };
  listeners.add(listener);
  change(staffSnapshot);
  if (!stopStaff) stopStaff = onValue(ref(db, PATH), (snapshot) => {
    const value = snapshot.val() as StaffData | null;
    staffSnapshot = value?.configured ? { configured: true, categories: value.categories ?? {}, members: value.members ?? {} } : defaultStaff();
    listeners.forEach((item) => item.change(staffSnapshot));
  }, (cause) => listeners.forEach((item) => item.error(cause)));
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stopStaff?.(); stopStaff = undefined; staffSnapshot = defaultStaff(); }
  };
}

// Only personnel data is shared with the operational team. Login accounts remain in Firebase Auth.
export async function initializeStaff(): Promise<void> {
  const existing = await get(ref(db, PATH));
  if (existing.val()?.configured) return;
  const paths = ['erp_geral/escala', 'erp_geral/recepcao/attendants', 'erp_geral/limpeza/camareiras', 'erp_geral/quartos/attendants'];
  const snapshots = await Promise.all(paths.map((path) => get(ref(db, path))));
  const staff = defaultStaff();
  const schedule = snapshots[0].val() ?? {};
  const historical = new Set<string>(Array.isArray(schedule.employees) ? schedule.employees : []);
  Object.values(schedule.days ?? {}).forEach((value) => {
    if (Array.isArray(value)) value.forEach((shift) => { if (typeof shift?.name === 'string') historical.add(shift.name); });
  });
  snapshots.slice(1).forEach((snapshot) => Object.values(snapshot.val() ?? {}).forEach((value) => {
    const name = (value as { name?: string }).name;
    if (name) historical.add(name);
  }));
  historical.forEach((name) => {
    if (!name.trim() || findStaff(staff, name)) return;
    staff.categories.legacy = { id: 'legacy', name: 'Histórico · sem classificação', duty: 'other' };
    const id = crypto.randomUUID();
    staff.members[id] = { id, name: name.trim(), categoryId: 'legacy', active: false };
  });
  staff.configured = true;
  await runTransaction(ref(db, PATH), (current) => current?.configured ? undefined : staff);
}

export function useStaff() {
  const [data, setData] = useState<StaffData>(defaultStaff);
  const [error, setError] = useState('');
  useEffect(() => subscribeStaff((staff) => { setData(staff); setError(''); }, (cause) => setError(cause.message)), []);
  return { data, error };
}

export async function updateStaff(mutate: (current: StaffData) => StaffData): Promise<void> {
  await initializeStaff();
  await updateSchedule((schedule) => {
    const staff = mutate(schedule.staff ?? defaultStaff());
    if (Object.values(staff.members).some((member) => !staff.categories[member.categoryId])) throw new Error('Classifique os funcionários antes de excluir a categoria.');
    const names = Object.values(staff.members).map((member) => staffNameKey(member.name));
    if (new Set(names).size !== names.length) throw new Error('Já existe um funcionário com esse nome.');
    return { ...schedule, staff, employees: staffMembers(staff).map((member) => member.name) };
  });
}

export async function saveStaffMember(member: StaffMember): Promise<void> {
  await updateStaff((data) => {
    const previous = data.members[member.id];
    const previousNames = [...new Set([...(previous?.previousNames ?? []), ...(previous && previous.name !== member.name ? [previous.name] : [])])];
    const saved = { ...member, ...(previousNames.length ? { previousNames } : {}) };
    return { ...data, members: { ...data.members, [member.id]: saved } };
  });
}
