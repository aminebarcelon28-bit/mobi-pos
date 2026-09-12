// Canonical ApiError mapping machine-readable codes into typed errors (rules.md R6.3)

export type ApiErrorCode =
  | 'DATABASE_BUSY'
  | 'SYNC_CONFLICT'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'PATH_TRAVERSAL'
  | 'HARDWARE_ERROR'
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
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
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
