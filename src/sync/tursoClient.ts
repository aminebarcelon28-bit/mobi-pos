// Direct Turso Client via @libsql/client.
// Connects directly to the customer's dedicated Turso database.
// Credentials (URL + token) are retrieved strictly from the OS Keychain.
// No proxy servers, no shared accounts, no hardcoded secrets.

import { createClient, type Client } from '@libsql/client';
import { getCloudCredentials } from './keychain';
import { checkRemoteSchemaStatus } from './remoteSchema';

let cachedClient: Client | null = null;
let cachedCredentialsKey: string | null = null;

export function closeTursoClient(): void {
  if (cachedClient) {
    try {
      cachedClient.close();
    } catch {
      // Safe to ignore per R5.1: Socket might already be closed or disconnected.
    }
    cachedClient = null;
    cachedCredentialsKey = null;
  }
}

export function withNetworkTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 10000,
  operationName = 'Opération Cloud Turso'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[Délai d'attente R5.5] ${operationName} a expiré après ${timeoutMs}ms. Vérifiez la connexion.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

function wrapClientWithTimeout(client: Client, timeoutMs = 10000): Client {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop === 'execute' && typeof original === 'function') {
        return function (...args: unknown[]) {
          return withNetworkTimeout(
            original.apply(target, args),
            timeoutMs,
            'Requête SQL Turso'
          );
        };
      }
      if (prop === 'batch' && typeof original === 'function') {
        return function (...args: unknown[]) {
          return withNetworkTimeout(
            original.apply(target, args),
            timeoutMs,
            'Lot de requêtes Turso (batch)'
          );
        };
      }
      return original;
    },
  });
}

export async function getTursoClient(): Promise<Client> {
  const creds = await getCloudCredentials();
  if (!creds || !creds.url || !creds.token) {
    throw new Error('Identifiants Cloud manquants. Veuillez configurer votre base Turso dans Paramètres > Synchronisation Cloud.');
  }

  const credsKey = `${creds.url}::${creds.token}`;
  if (cachedClient && cachedCredentialsKey === credsKey) {
    return cachedClient;
  }

  closeTursoClient();

  const rawClient = createClient({
    url: creds.url,
    authToken: creds.token,
  });
  cachedClient = wrapClientWithTimeout(rawClient, 10000);
  cachedCredentialsKey = credsKey;

  return cachedClient;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  isSchemaReady: boolean;
  appliedVersion: number;
  missingTables: string[];
  error?: string;
  errorCode?: 'INVALID_TOKEN' | 'UNREACHABLE' | 'SCHEMA_MISMATCH' | 'NETWORK_ERROR' | 'UNKNOWN';
}

/**
 * Tests connection to a Turso database using given credentials before saving them.
 * Never throws silently; returns clear, human-readable diagnostics.
 */
export async function testTursoConnection(url: string, token: string): Promise<ConnectionTestResult> {
  const trimmedUrl = url.trim();
  const trimmedToken = token.trim();

  if (!trimmedUrl) {
    return { ok: false, latencyMs: 0, isSchemaReady: false, appliedVersion: 0, missingTables: [], error: 'URL de la base de données manquante.', errorCode: 'NETWORK_ERROR' };
  }
  if (!trimmedToken) {
    return { ok: false, latencyMs: 0, isSchemaReady: false, appliedVersion: 0, missingTables: [], error: 'Jeton d\'authentification (Auth Token) manquant.', errorCode: 'INVALID_TOKEN' };
  }

  let tempClient: Client | null = null;
  const start = performance.now();
  try {
    tempClient = createClient({ url: trimmedUrl, authToken: trimmedToken });

    // Probe 1: Ping query
    await Promise.race([
      tempClient.execute('SELECT 1 as ping'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Délai d\'attente dépassé (timeout 8s). Vérifiez votre connexion Internet.')), 8000)),
    ]);
    const latencyMs = Math.round(performance.now() - start);

    // Probe 2: Check schema
    const schemaStatus = await checkRemoteSchemaStatus(tempClient);

    return {
      ok: true,
      latencyMs,
      isSchemaReady: schemaStatus.isInitialized,
      appliedVersion: schemaStatus.appliedVersion,
      missingTables: schemaStatus.missingTables,
    };
  } catch (e: unknown) {
    const rawMsg = e instanceof Error ? e.message : String(e);
    let error = rawMsg;
    let errorCode: ConnectionTestResult['errorCode'] = 'UNKNOWN';

    if (rawMsg.includes('401') || rawMsg.includes('UNAUTHORIZED') || rawMsg.includes('JWT') || rawMsg.includes('auth') || rawMsg.includes('token expired')) {
      error = 'Jeton d\'authentification invalide ou expiré (Erreur 401). Vérifiez le jeton envoyé pour ce client.';
      errorCode = 'INVALID_TOKEN';
    } else if (rawMsg.includes('ENOTFOUND') || rawMsg.includes('getaddrinfo') || rawMsg.includes('Failed to fetch') || rawMsg.includes('ECONNREFUSED')) {
      error = `Serveur distant inaccessible (${trimmedUrl}). Vérifiez l'URL de la base de données et votre accès réseau.`;
      errorCode = 'UNREACHABLE';
    } else if (rawMsg.includes('timeout')) {
      error = 'Délai d\'attente dépassé. La base de données Turso ne répond pas dans le temps imparti.';
      errorCode = 'NETWORK_ERROR';
    }

    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      isSchemaReady: false,
      appliedVersion: 0,
      missingTables: [],
      error,
      errorCode,
    };
  } finally {
    if (tempClient) {
      try {
        tempClient.close();
      } catch {
        // Safe to ignore per R5.1: Temporary probe socket may already be terminated.
      }
    }
  }
}

/**
 * Lightweight ping to verify network and remote database availability.
 */
export async function probeOnline(timeoutMs = 5000): Promise<boolean> {
  try {
    const client = await getTursoClient();
    await Promise.race([
      client.execute('SELECT 1'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}
