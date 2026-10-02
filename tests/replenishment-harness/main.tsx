/**
 * Isolated mount point for the Réapprovisionnement modal.
 *
 * Split from tests/harness/main.tsx so the SAV/inspector suite's licence-gate
 * reasoning stays untouched. The replenishment modal is prop-driven — no store,
 * no activeModal — so this entry keeps the harness unbloated.
 *
 * Reachable at /tests/replenishment-harness/index.html.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReplenishmentDemo } from '../../src/components/replenishment';
import '../../src/index.css';

declare global {
  interface Window {
    __replReady: boolean;
    __replError: string | null;
    __replOpen: (open: boolean) => void;
  }
}

window.__replReady = false;
window.__replError = null;

function Harness() {
  const [isOpen, setIsOpen] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    window.__replOpen = (open: boolean) => setIsOpen(open);
    window.__replReady = true;
    try {
      const urlTheme = new URLSearchParams(location.search).get('theme');
      if (urlTheme === 'dark') {
        setTheme('dark');
        localStorage.setItem('mobi_pos_theme', 'dark');
        document.documentElement.classList.add('dark');
      }
    } catch { /* storage unavailable */ }
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <button
        type="button"
        data-harness-trigger
        onClick={() => setIsOpen(true)}
      >
        Ouvrir le réapprovisionnement
      </button>
      <ReplenishmentDemo
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </div>
  );
}

createRoot(document.getElementById('harness-root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
