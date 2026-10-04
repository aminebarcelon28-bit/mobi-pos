/**
 * ISOLATED UI HARNESS — test scaffolding only, never imported by src/.
 *
 * Why this exists: the SAV + IMEI modals are prop-less and read all state from
 * `usePosStore()`, self-gating on `activeModal`. The normal way to reach them
 * is through the App shell — but App.tsx mounts a fail-closed license gate
 * first, and in CI the E2E seed key is SUSPENDED, so the shell never renders a
 * till. Rather than weaken the licensing gate (explicitly out of scope), this
 * harness mounts ONLY the two modals against the real store and the real
 * Tailwind pipeline, so computed styles reflect production CSS.
 *
 * Nothing here alters product behaviour: it is a second Vite entry reachable
 * only at /tests/harness/index.html. It is excluded from `tsc -b` because
 * tsconfig.app.json includes only "src".
 */
import { Component, StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { usePosStore } from '../../src/store/usePosStore';
import { ToastProvider } from '../../src/components/ui/Toast';
import { ImeiWarrantyInspectorModal } from '../../src/components/modals/ImeiWarrantyInspectorModal';
import { RepairWorkOrderModal } from '../../src/components/modals/RepairWorkOrderModal';
import '../../src/index.css';

type WhichModal = 'inspector' | 'repair';
type ThemeMode = 'light' | 'dark';

const MODAL_BY_KEY: Record<WhichModal, 'imei_inspector' | 'repair_work_order'> = {
  inspector: 'imei_inspector',
  repair: 'repair_work_order',
};

declare global {
  interface Window {
    __harnessReady: boolean;
    __harnessError: string | null;
    __harnessSetTheme: (mode: ThemeMode) => void;
    __harnessOpen: (which: WhichModal) => void;
    /**
     * Merge a partial store state AFTER hydration. The inspector reads
     * `tradeIns` / `activeCashier` straight from the store and has no props, so
     * a spec that needs a device with a police-register seller (or a manager vs
     * a cashier) has no other way in. Test scaffolding only.
     */
    __harnessSeed: (state: Record<string, unknown>) => void;
  }
}

window.__harnessReady = false;
window.__harnessError = null;
window.__harnessSeed = (state) => {
  usePosStore.setState(state as never);
};
window.__harnessSetTheme = (mode) => {
  // Persist too. createUISlice.ts:74-85 applies `html.dark` at MODULE LOAD from
  // `localStorage.mobi_pos_theme` (default 'dark'), and zustand `persist`
  // rehydrates `themeMode` after mount. Setting only the class — or only the
  // store — leaves the two disagreeing, which renders a half-light/half-dark
  // modal and makes any colour audit meaningless.
  try {
    localStorage.setItem('mobi_pos_theme', mode);
  } catch {
    /* storage restricted — class + store still applied below */
  }
  usePosStore.setState({ themeMode: mode });
  document.documentElement.classList.toggle('dark', mode === 'dark');
};
window.__harnessOpen = (which) => {
  usePosStore.getState().openModal(MODAL_BY_KEY[which] ?? MODAL_BY_KEY.inspector);
};

/**
 * zustand `persist` rehydrates asynchronously. Any `setState` before it lands
 * is merged/overwritten, so the harness must wait for hydration before pinning
 * the theme — otherwise the render audited is not the render requested.
 */
async function whenStoreHydrated(): Promise<void> {
  const p = (
    usePosStore as unknown as {
      persist?: { hasHydrated?: () => boolean; onFinishHydration?: (fn: () => void) => void };
    }
  ).persist;
  if (!p?.hasHydrated || !p.onFinishHydration) return;
  if (p.hasHydrated()) return;
  await new Promise<void>((resolve) => p.onFinishHydration!(() => resolve()));
}

function Harness() {
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const which = (params.get('modal') ?? 'inspector') as WhichModal;
    const theme = (params.get('theme') ?? 'light') as ThemeMode;

    void (async () => {
      try {
        await whenStoreHydrated();
        // Open after hydration so the modals' mount effects (draft hydration,
        // key handlers, viewport listeners) settle before the test measures.
        window.__harnessOpen(which);
        window.__harnessSetTheme(theme);
        // Two frames: one for the class/token flip to paint, one for the modal's
        // own state-driven re-render. Ready means "measured this is stable".
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        window.__harnessReady = true;
      } catch (e) {
        window.__harnessError = String((e as Error)?.message ?? e);
        window.__harnessReady = true;
      }
    })();
  }, []);

  return (
    <ToastProvider>
      {/* Both mount; the inactive one self-gates to null on activeModal. */}
      <ImeiWarrantyInspectorModal />
      <RepairWorkOrderModal />
    </ToastProvider>
  );
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    window.__harnessError = String(error?.message ?? error);
  }
  render() {
    if (this.state.error) {
      return <pre data-harness-error="true">{this.state.error.message}</pre>;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('harness-root')!).render(
  <StrictMode>
    <Boundary>
      <Harness />
    </Boundary>
  </StrictMode>
);
