import { useContext, useEffect, useState } from 'react';
import { DutyContext, type DutyState } from './dutyContext';
import { activeShiftHandoff, currentDuty, nextScheduledDuty } from './dutyRoster';
import { emptySchedule, subscribeSchedule, type ScheduleStoreData } from './scheduleStore';
import { defaultStaff, findStaff, staffMembers } from '../types/staff';
import { subscribeShiftHandoffs } from './shiftHandoffStore';
import type { ShiftHandoff } from '../types/reception';

export function useAttendant(): string {
  return useContext(DutyContext).attendant;
}

export function useDuty(): DutyState {
  return useContext(DutyContext);
}

// Calcula o plantonista a partir da escala do dia; a cada 20 s reavalia a troca de turno.
export function useDutyRoster(enabled: boolean): DutyState {
  const [schedule, setSchedule] = useState<ScheduleStoreData>(emptySchedule());
  const [names, setNames] = useState<string[]>(staffMembers(defaultStaff(), 'reception').map((member) => member.name));
  const [handoffs, setHandoffs] = useState<Record<string, ShiftHandoff>>({});
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!enabled) return;
    const stopSchedule = subscribeSchedule((data) => {
      setSchedule(data);
      setNames(staffMembers(data.staff ?? defaultStaff(), 'reception').map((member) => member.name));
    }, () => undefined);
    const stopHandoffs = subscribeShiftHandoffs(setHandoffs, () => undefined);
    const timer = window.setInterval(() => setNow(new Date()), 20000);
    return () => {
      stopSchedule();
      stopHandoffs();
      window.clearInterval(timer);
    };
  }, [enabled]);

  const activeHandoff = enabled ? activeShiftHandoff(handoffs, now) : null;
  const toName = activeHandoff ? findStaff(schedule.staff ?? defaultStaff(), activeHandoff.toAttendant)?.name ?? activeHandoff.toAttendant : '';
  const handoff = activeHandoff && names.includes(toName) ? { ...activeHandoff, toAttendant: toName, fromAttendant: findStaff(schedule.staff ?? defaultStaff(), activeHandoff.fromAttendant)?.name ?? activeHandoff.fromAttendant } : undefined;
  const scheduledDuty = enabled ? currentDuty(schedule.days, names, now) : null;
  const duty = handoff
    ? { name: handoff.toAttendant, start: new Date(handoff.createdAt), end: new Date(handoff.endsAt) }
    : scheduledDuty;
  const previous = handoff?.fromAttendant
    ?? (duty ? currentDuty(schedule.days, names, new Date(duty.start.getTime() - 60000))?.name ?? '' : '');
  const nextAttendant = enabled ? nextScheduledDuty(schedule.days, names, now, duty?.name ?? '')?.name ?? '' : '';
  return { attendant: duty?.name ?? '', duty, previous, nextAttendant, handoff, minutesLeft: duty ? Math.ceil((duty.end.getTime() - now.getTime()) / 60000) : null };
}
