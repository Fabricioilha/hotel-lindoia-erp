import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ACTION_ICONS } from './actionIcons';
import './actionCard.css';

type ActionTone = 'blue' | 'gold' | 'red' | 'green' | 'purple' | 'teal' | 'slate';

interface ActionCardProps {
  icon: keyof typeof ACTION_ICONS;
  title: string;
  hint: string;
  tone: ActionTone;
  onClick?: () => void;
  to?: string;
}

export function ActionCard({ icon, title, hint, tone, onClick, to }: ActionCardProps): ReactNode {
  const content = <>
    <span className="action-card-icon"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ACTION_ICONS[icon]} /></svg></span>
    <span className="action-card-text"><strong>{title}</strong><small>{hint}</small></span>
    <span className="action-card-arrow" aria-hidden="true">→</span>
  </>;
  if (to) return <Link className={`action-card tone-${tone}`} to={to}>{content}</Link>;
  return <button type="button" className={`action-card tone-${tone}`} onClick={onClick}>{content}</button>;
}
