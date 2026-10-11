import { createContext } from 'react';

// Permite que uma página injete um menu contextual dentro da barra lateral.
export const SidebarSlotContext = createContext<HTMLElement | null>(null);
