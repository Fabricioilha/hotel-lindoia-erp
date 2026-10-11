import { createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

const PanelModalContext = createContext<(() => void) | null>(null);

export function PanelModalProvider({ close, children }: { close: () => void; children: ReactNode }) {
  return <PanelModalContext.Provider value={close}>{children}</PanelModalContext.Provider>;
}

export function PanelHomeLink({ className, children, title }: { className: string; children: ReactNode; title?: string }) {
  const close = useContext(PanelModalContext);
  if (close) return <button type="button" className={`${className} panel-modal-home`} onClick={close} title={title}>{children}</button>;
  return <Link to="/" className={className} title={title}>{children}</Link>;
}
