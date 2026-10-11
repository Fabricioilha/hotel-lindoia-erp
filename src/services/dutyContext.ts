import { createContext } from 'react';
import type { Duty } from './dutyRoster';
import type { ShiftHandoff } from '../types/reception';

export interface DutyState {
  attendant: string;
  duty: Duty | null;
  minutesLeft: number | null;
  previous: string;
  nextAttendant: string;
  handoff?: ShiftHandoff;
}

export const DutyContext = createContext<DutyState>({ attendant: '', duty: null, minutesLeft: null, previous: '', nextAttendant: '' });
