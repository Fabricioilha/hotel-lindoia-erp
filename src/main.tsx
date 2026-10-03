import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

document.documentElement.dataset.theme = localStorage.getItem('hotel-lindoia:theme') === 'dark' ? 'dark' : 'light';
document.documentElement.style.setProperty('--font-scale', localStorage.getItem('hotel-lindoia:font-scale') ?? '1');

// O timeout evita que o clique do mouse desfaça a seleção logo após o foco.
document.addEventListener('focusin', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type === 'number' && !target.readOnly) setTimeout(() => target.select(), 0);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
