import React, { Suspense } from 'react';
import { RefreshCcw } from 'lucide-react';

const CloudSyncPanel = React.lazy(() =>
  import('../../settings/CloudSyncPanel').then((m) => ({ default: m.CloudSyncPanel }))
);

export const CloudSyncSettingsTab: React.FC = () => {
  return (
    <div className="max-w-4xl mx-auto py-1">
      <Suspense
        fallback={
          <div className="flex items-center justify-center p-12 text-pos-muted gap-3">
            <RefreshCcw className="w-5 h-5 animate-spin text-cyan-400" />
            <span className="text-xs font-semibold">Chargement du panneau de synchronisation cloud...</span>
          </div>
        }
      >
        <CloudSyncPanel />
      </Suspense>
    </div>
  );
};
