import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/base.css';

// Follow the OS when the user has chosen "system".
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  const stored = localStorage.getItem('mail.theme');
  if (stored && JSON.parse(stored).mode === 'system') {
    document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
