import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Blocking screen after a failed native schema migration (SEC-01 / ADR-005).
 *
 * The native heal runs in one transaction and only commits when the schema
 * matches the golden manifest. When it fails, the database is left at its
 * previous state and the renderer must NOT silently fall back to its own heal:
 * after the read-only flip it cannot, and before the flip a silent fallback
 * would hide a broken migration. The only action is a restart (the native pass
 * re-runs) plus the path of the pre-migration backup for support.
 */
export function SchemaRecoveryScreen({ error }: { error: string | null }) {
  return (
    <StrictMode>
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#0b1220',
          color: '#e6edf7',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ maxWidth: 640, width: '100%' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
            Migration de la base interrompue
          </h1>
          <p style={{ color: '#9fb0c9', lineHeight: 1.5 }}>
            La base locale n&apos;a pas été modifiée : la migration est transactionnelle et a
            été annulée. Une sauvegarde a été prise avant l&apos;opération (dossier
            <code style={{ margin: '0 4px' }}>backups</code> des données de l&apos;application).
          </p>
          <pre
            style={{
              marginTop: 16,
              padding: 12,
              borderRadius: 8,
              background: '#111c2e',
              color: '#ffb4b4',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error ?? 'Erreur inconnue'}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 20,
              padding: '10px 18px',
              borderRadius: 8,
              border: '1px solid #2f4a72',
              background: '#173a63',
              color: '#e6edf7',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Redémarrer et réessayer
          </button>
          <p style={{ marginTop: 16, color: '#6f819c', fontSize: 12 }}>
            Si l&apos;erreur persiste, transmettez ce message et la sauvegarde au support avant
            toute réinstallation.
          </p>
        </div>
      </div>
    </StrictMode>
  );
}

/** Mount the recovery screen in place of the POS UI. */
export function renderSchemaRecovery(error: string | null): void {
  const el = document.getElementById('root');
  if (!el) return;
  createRoot(el).render(<SchemaRecoveryScreen error={error} />);
}
