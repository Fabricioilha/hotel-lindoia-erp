import type { ScheduleData } from '../types';
import type { ShiftHandoff } from '../types/reception';

export interface Duty {
  name: string;
  start: Date;
  end: Date;
  scheduledStart?: Date;
  scheduledEnd?: Date;
}

const keyOf = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

function atTime(base: Date, time: string, addDays = 0): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, Number(match[1]), Number(match[2]));
}

// Plantonista em serviço agora, conforme a escala; turnos noturnos (ex.: 19:00 às 07:00) atravessam a meia-noite.
export function currentDuty(days: ScheduleData, attendantNames: string[], now: Date): Duty | null {
  const allowed = new Set(attendantNames.map((name) => name.trim().toLocaleLowerCase('pt-BR')));
  let best: Duty | null = null;
  [-1, 0].forEach((offset) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    (days[keyOf(day)] ?? []).forEach((shift) => {
      if (shift.type !== 'normal' || !allowed.has(shift.name.trim().toLocaleLowerCase('pt-BR'))) return;
      const [from = '', to = ''] = shift.time.split(' às ');
      const start = atTime(day, from);
      let end = atTime(day, to);
      if (!start || !end) return;
      if (end <= start) end = atTime(day, to, 1) as Date;
      if (start <= now && now < end && (!best || start > best.start)) best = { name: shift.name.trim(), start, end, scheduledStart: start, scheduledEnd: end };
    });
  });
  return best;
}

export function nextScheduledDuty(days: ScheduleData, attendantNames: string[], after: Date, skipName = ''): Duty | null {
  const allowed = new Set(attendantNames.map((name) => name.trim().toLocaleLowerCase('pt-BR')));
  const skipped = skipName.trim().toLocaleLowerCase('pt-BR');
  const candidates: Duty[] = [];
  for (let offset = 0; offset <= 60; offset += 1) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset);
    (days[keyOf(day)] ?? []).forEach((shift) => {
      const name = shift.name.trim();
      if (shift.type !== 'normal' || !name || !allowed.has(name.toLocaleLowerCase('pt-BR'))
        || name.toLocaleLowerCase('pt-BR') === skipped) return;
      const [from = '', to = ''] = shift.time.split(' às ');
      const start = atTime(day, from);
      let end = atTime(day, to);
      if (!start || !end) return;
      if (end <= start) end = atTime(day, to, 1) as Date;
      if (start <= after || end <= after) return;
      candidates.push({ name, start, end, scheduledStart: start, scheduledEnd: end });
    });
  }
  return candidates.sort((left, right) => left.start.getTime() - right.start.getTime())[0] ?? null;
}

export function activeShiftHandoff(handoffs: Record<string, ShiftHandoff>, now: Date): ShiftHandoff | null {
  return Object.values(handoffs)
    .filter((handoff) => Date.parse(handoff.createdAt) <= now.getTime() && now.getTime() < Date.parse(handoff.endsAt))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export function effectiveDuty(
  days: ScheduleData,
  attendantNames: string[],
  now: Date,
  handoffs: Record<string, ShiftHandoff>,
): Duty | null {
  const handoff = activeShiftHandoff(handoffs, now);
  if (handoff) {
    const start = new Date(handoff.createdAt);
    const end = new Date(handoff.endsAt);
    return { name: handoff.toAttendant, start, end, scheduledStart: start, scheduledEnd: end };
  }
  return currentDuty(days, attendantNames, now);
}
