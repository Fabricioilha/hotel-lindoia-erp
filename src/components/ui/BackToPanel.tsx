import { Link } from 'react-router-dom';
import './actionCard.css';

export function BackToPanel() {
  return <Link to="/" className="back-to-panel">← Voltar ao painel principal</Link>;
}
