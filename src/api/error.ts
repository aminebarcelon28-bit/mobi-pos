// Canonical ApiError mapping machine-readable codes into typed errors (rules.md R6.3)

export type ApiErrorCode =
  | 'DATABASE_BUSY'
  | 'SYNC_CONFLICT'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'PATH_TRAVERSAL'
  | 'HARDWARE_ERROR'
  | 'IPC_TIMEOUT'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly originalError?: unknown;

  constructor(code: ApiErrorCode, message: string, originalError?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.originalError = originalError;
  }
}

export function toApiError(error: unknown, fallbackCode: ApiErrorCode = 'INTERNAL_ERROR'): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  // Phase 1 native trust kernel: Rust denials arrive as
  // { gate_code, message_key, kind, detail? }. Map the coarse gate code to
  // the closest ApiErrorCode; the detail carries only display-safe context.
  if (typeof error === 'object' && error !== null && 'gate_code' in error) {
    const wire = error as { gate_code?: unknown; message_key?: unknown; detail?: unknown };
    const gate = typeof wire.gate_code === 'string' ? wire.gate_code : 'LOCKED';
    const detail = typeof wire.detail === 'string' ? wire.detail : '';
    const lower = detail.toLowerCase();
    if (lower.includes('traversée') || lower.includes('traversal')) {
      return new ApiError('PATH_TRAVERSAL', detail || 'Accès au chemin de fichier refusé.', error);
    }
    if (lower.includes('busy') || lower.includes('occupée')) {
      return new ApiError('DATABASE_BUSY', detail || 'La base de données est occupée, veuillez réessayer.', error);
    }
    if (gate === 'NONE') {
      return new ApiError(fallbackCode, detail || 'Une erreur système inattendue est survenue.', error);
    }
    const gateMessage: Record<string, string> = {
      ACTIVATION: 'Aucune licence active sur ce terminal.',
      EXPIRED: 'Licence expirée — renouvelez pour continuer.',
      SUSPENDED: 'Licence suspendue — contactez votre administrateur.',
      REVOKED: 'Licence révoquée — contactez votre administrateur.',
      CLOCK: 'Horloge appareil incohérente — vérification requise.',
      LOCKED: 'Terminal verrouillé — opération refusée.',
    };
    return new ApiError(
      'PERMISSION_DENIED',
      detail || gateMessage[gate] || gateMessage.LOCKED,
      error
    );
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('timed out after')) {
      return new ApiError('IPC_TIMEOUT', 'Délai de communication dépassé, veuillez réessayer.', error);
    }
    if (msg.includes('busy') || msg.includes('locked')) {
      return new ApiError('DATABASE_BUSY', 'La base de données est occupée, veuillez réessayer.', error);
    }
    if (msg.includes('conflict')) {
      return new ApiError('SYNC_CONFLICT', 'Conflit de synchronisation détecté.', error);
    }
    if (msg.includes('refusé') || msg.includes('traversée') || msg.includes('traversal')) {
      return new ApiError('PATH_TRAVERSAL', 'Accès au chemin de fichier refusé.', error);
    }
    return new ApiError(fallbackCode, error.message, error);
  }
  if (typeof error === 'string') {
    return new ApiError(fallbackCode, error);
  }
  return new ApiError(fallbackCode, 'Une erreur système inattendue est survenue.', error);
}
