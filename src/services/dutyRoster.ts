import type { ScheduleData } from '../types';

export interface Duty {
  name: string;
  start: Date;
  end: Date;
  originalTime: string;
  dateKey: string;
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
    const key = keyOf(day);
    (days[key] ?? []).forEach((shift) => {
      if (shift.type !== 'normal' || !allowed.has(shift.name.trim().toLocaleLowerCase('pt-BR'))) return;
      const [from = '', to = ''] = shift.time.split(' às ');
      const start = atTime(day, from);
      let end = atTime(day, to);
      if (!start || !end) return;
      if (end <= start) end = atTime(day, to, 1) as Date;
      if (start <= now && now < end && (!best || start > best.start)) {
        best = { name: shift.name.trim(), start, end, originalTime: shift.time, dateKey: key };
      }
    });
  });
  return best;
}