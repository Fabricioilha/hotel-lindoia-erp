import { db, onValue, ref, runTransaction } from './pocketbaseRealtime';
import type { ScheduleData, Shift } from '../types';
import { defaultStaff, findStaff, staffMembers, type StaffData, type StaffMember } from '../types/staff';

export interface ScheduleStoreData {
  days: ScheduleData;
  employees: string[];
  staff?: StaffData;
}

export const DEFAULT_EMPLOYEES = staffMembers(defaultStaff()).map((member) => member.name);

export function emptySchedule(): ScheduleStoreData {
  return { days: {}, employees: [...DEFAULT_EMPLOYEES], staff: defaultStaff() };
}

function normalizeSchedule(value: unknown): ScheduleStoreData {
  const data = value && typeof value === 'object' ? value as Partial<ScheduleStoreData> : {};
  const staff: StaffData = data.staff?.configured
    ? { configured: true, categories: data.staff.categories ?? {}, members: data.staff.members ?? {} }
    : defaultStaff();
  const days = Object.fromEntries(Object.entries(data.days ?? {}).map(([key, shifts]) => [key, shifts.map((shift) => {
    const member = findStaff(staff, shift.name, shift.employeeId);
    return member ? { ...shift, name: member.name, employeeId: member.id } : shift;
  })]));
  return { days, employees: staffMembers(staff).map((member) => member.name), staff };
}

export const scheduleStorageMode = 'PocketBase';

export function subscribeSchedule(
  onChange: (data: ScheduleStoreData) => void,
  onError: (error: Error) => void,
): () => void {
  return onValue(
    ref(db, 'erp_geral/escala'),
    (snapshot) => onChange(normalizeSchedule(snapshot.val())),
    onError,
  );
}

export async function updateSchedule(update: (current: ScheduleStoreData) => ScheduleStoreData): Promise<void> {
  const result = await runTransaction(ref(db, 'erp_geral/escala'), (current) => update(normalizeSchedule(current)));
  if (!result.committed) throw new Error('A gravação da escala não foi confirmada.');
}

export function withShift(days: ScheduleData, dateKey: string, shift: Shift): ScheduleData {
  return { ...days, [dateKey]: [...(days[dateKey] ?? []), shift] };
}

function scheduleDateKey(year: number, month: number, day: number) {
  return `${year}-${month}-${day}`;
}

const receptionPairs: Record<string, { partner: string; worksOnOddDay: boolean }> = {
  paulo: { partner: 'cevani', worksOnOddDay: true },
  cevani: { partner: 'paulo', worksOnOddDay: false },
  luana: { partner: 'tatiana', worksOnOddDay: true },
  tatiana: { partner: 'luana', worksOnOddDay: false },
};
const managedScheduleNames = new Set(['paulo', 'cevani', 'luana', 'tatiana', 'juliana', 'thifani', 'amanda']);

function housekeepingDayOff(member: StaffMember): number | undefined {
  if (member.weeklyDayOff !== undefined) return member.weeklyDayOff;
  const defaults: Record<string, number> = { juliana: 1, thifani: 2, amanda: 3 };
  return defaults[member.name.trim().toLocaleLowerCase('pt-BR')];
}

function automaticShift(member: StaffMember, duty: string | undefined, year: number, month: number, day: number, id: number): Shift | null {
  const date = new Date(year, month, day);
  if (member.startDate) {
    const startDate = new Date(`${member.startDate}T00:00:00`);
    if (Number.isFinite(startDate.getTime()) && date < startDate) return null;
  }
  const startDate = member.startDate ? new Date(`${member.startDate}T00:00:00`) : new Date(1970, 0, 1);
  const daysSinceStart = Math.floor((date.getTime() - startDate.getTime()) / 86_400_000);
  const isPlantonista = duty === 'reception';
  const pair = receptionPairs[member.name.trim().toLocaleLowerCase('pt-BR')];
  const type = isPlantonista
    ? pair ? (day % 2 === 1) === pair.worksOnOddDay ? 'normal' : 'folga'
      : daysSinceStart % 2 === 0 ? 'normal' : 'folga'
    : housekeepingDayOff(member) === date.getDay() ? 'folga' : 'normal';
  if (isPlantonista && type === 'folga') return null;
  const isCamareira = duty === 'housekeeping';
  const normalizedName = member.name.trim().toLocaleLowerCase('pt-BR');
  const housekeepingHours = normalizedName === 'thifani'
    ? { start: '06:30', end: date.getDay() === 0 || date.getDay() === 6 ? '15:30' : '14:30' }
    : normalizedName === 'juliana'
      ? { start: '08:00', end: '16:20' }
      : normalizedName === 'amanda'
        ? { start: '09:00', end: '17:20' }
        : { start: member.workStart || '08:00', end: member.workEnd || '16:00' };
  const start = isCamareira ? housekeepingHours.start : member.workStart || '08:00';
  const end = isCamareira ? housekeepingHours.end : member.workEnd || '16:00';
  return {
    id,
    employeeId: member.id,
    name: member.name,
    type,
    time: type === 'normal' ? `${start} às ${end}` : 'Folga',
    generated: true,
  };
}

export function propagateShiftToNextMonth(days: ScheduleData, date: string, previous: Shift | undefined, next: Shift | undefined): ScheduleData {
  const [year, month, day] = date.split('-').map(Number);
  const nextMonth = new Date(year, month + 1, 1);
  const targetDay = Math.min(day, new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate());
  const targetKey = scheduleDateKey(nextMonth.getFullYear(), nextMonth.getMonth(), targetDay);
  const target = [...(days[targetKey] ?? [])];
  const employeeId = next?.employeeId ?? previous?.employeeId;
  const name = next?.name ?? previous?.name;
  const matches = (shift: Shift) => employeeId ? shift.employeeId === employeeId : shift.name === name;
  const remaining = target.filter((shift) => !matches(shift));
  if (next) remaining.push({ ...next, id: Date.now() + Math.floor(Math.random() * 100000), generated: false });
  const updated = { ...days };
  if (remaining.length) updated[targetKey] = remaining;
  else delete updated[targetKey];
  return updated;
}

export function refreshNextMonthSchedule(schedule: ScheduleStoreData, reference = new Date()): ScheduleStoreData {
  const next = new Date(reference.getFullYear(), reference.getMonth() + 1, 1);
  return refreshScheduleMonths(schedule, [{ year: next.getFullYear(), month: next.getMonth() }]);
}

export function refreshScheduleMonths(schedule: ScheduleStoreData, months: { year: number; month: number }[], replaceManaged = false): ScheduleStoreData {
  const staff = schedule.staff ?? defaultStaff();
  const days = { ...schedule.days };
  let id = Date.now();
  months.forEach(({ year, month }) => {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = scheduleDateKey(year, month, day);
      const existing = days[key] ?? [];
      const manual = existing.filter((shift) => !shift.generated && (!replaceManaged || !managedScheduleNames.has(shift.name.trim().toLocaleLowerCase('pt-BR'))));
      const generated = staffMembers(staff).flatMap((member) => {
        if (manual.some((shift) => shift.employeeId === member.id || shift.name === member.name)) return [];
        const shift = automaticShift(member, staff.categories[member.categoryId]?.duty, year, month, day, id++);
        return shift ? [shift] : [];
      });
      const shifts = [...manual, ...generated];
      if (shifts.length) days[key] = shifts;
      else delete days[key];
    }
  });
  return { ...schedule, days };
}
