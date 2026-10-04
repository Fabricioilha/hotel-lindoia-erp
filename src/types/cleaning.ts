export interface Camareira {
  id: string;
  name: string;
}

export type CleaningStatus = 'em_limpeza' | 'concluido' | 'cancelado';

export interface CleaningTask {
  id: string;
  roomNumber: string;
  camareira: string;
  status: CleaningStatus;
  assignedBy: string;
  assignedAt: string;
  date: string;
  completedAt?: string;
  completedBy?: string;
}

export interface CleaningData {
  camareiras: Record<string, Camareira>;
  camareirasConfigured: boolean;
  tasks: Record<string, CleaningTask>;
}

export const DEFAULT_CAMAREIRAS = ['Juliana', 'Amanda', 'Thifani'];
