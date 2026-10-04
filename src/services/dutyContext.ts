import { createContext } from 'react';
import type { Duty } from './dutyRoster';

export interface DutyState {
  attendant: string;
  duty: Duty | null;
  minutesLeft: number | null;
}

export const DutyContext = createContext<DutyState>({ attendant: '', duty: null, minutesLeft: null });
