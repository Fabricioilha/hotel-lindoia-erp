import { useContext, useEffect, useState } from 'react';
import { DutyContext, type DutyState } from './dutyContext';
import { currentDuty } from './dutyRoster';
import { emptySchedule, subscribeSchedule, type ScheduleStoreData } from './scheduleStore';
import { subscribeReception } from './receptionStore';
import { DEFAULT_ATTENDANTS } from '../types/reception';

export function useAttendant(): string {
  return useContext(DutyContext).attendant;
}

export function useDuty(): DutyState {
  return useContext(DutyContext);
}

// Calcula o plantonista a partir da escala do dia; a cada 20 s reavalia a troca de turno.
export function useDutyRoster(enabled: boolean): DutyState {
  const [schedule, setSchedule] = useState<ScheduleStoreData>(emptySchedule());
  const [names, setNames] = useState<string[]>(DEFAULT_ATTENDANTS);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!enabled) return;
    const stopSchedule = subscribeSchedule(setSchedule, () => undefined);
    const stopReception = subscribeReception((data) => {
      const custom = Object.values(data.attendants).map((item) => item.name);
      setNames(custom.length > 0 ? custom : DEFAULT_ATTENDANTS);
    }, () => undefined);
    const timer = window.setInterval(() => setNow(new Date()), 20000);
    return () => {
      stopSchedule();
      stopReception();
      window.clearInterval(timer);
    };
  }, [enabled]);

  const duty = enabled ? currentDuty(schedule.days, names, now) : null;
  return { attendant: duty?.name ?? '', duty, minutesLeft: duty ? Math.ceil((duty.end.getTime() - now.getTime()) / 60000) : null };
}
