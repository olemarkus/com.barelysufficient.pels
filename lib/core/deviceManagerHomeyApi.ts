import type Homey from 'homey';
import http from 'http';
import https from 'https';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import { normalizeError } from '../utils/errorUtils';

export const DEVICES_API_PATH = 'manager/devices/device';

const HTTP_TIMEOUT_MS = 30_000;


export type RestClient = {
  get: (path: string) => Promise<unknown>;
  put: (path: string, body: unknown) => Promise<unknown>;
};

// The active REST client, set during init.
let restClient: RestClient | null = null;

export function resolveHomeyInstance(homey: Homey.App): Homey.App['homey'] {
  if (isHomeyAppWrapper(homey)) {
    return homey.homey;
  }
  return homey as unknown as Homey.App['homey'];
}

/**
 * Initialize the REST client using the Homey local HTTP API (bearer token auth).
 * No-op if a REST client is already set (e.g. by test mock via setRestClient).
 */
export async function initHomeyHttpClient(homey: Homey.App): Promise<void> {
  if (restClient) return;
  const homeyInstance = resolveHomeyInstance(homey);
  type SdkInitApi = {
    getOwnerApiToken?: () => Promise<string>;
    getLocalUrl?: () => Promise<string>;
  };
  const api = (homeyInstance as { api?: SdkInitApi }).api;
  if (!api?.getOwnerApiToken || !api?.getLocalUrl) {
    throw new Error('Homey SDK API missing getOwnerApiToken or getLocalUrl');
  }

  const token = await api.getOwnerApiToken();
  const baseUrl = await api.getLocalUrl();
  if (!token || !baseUrl) {
    throw new Error('getOwnerApiToken or getLocalUrl returned empty');
  }

  restClient = {
    get: (path) => homeyHttpGet(baseUrl, token, `/api/${path}`),
    put: (path, body) => homeyHttpPut(baseUrl, token, `/api/${path}`, body),
  };
}

/** Set the REST client directly (used by test mocks). */
export function setRestClient(client: RestClient): void {
  restClient = client;
}

/** Reset the REST client (for test cleanup). */
export function resetRestClient(): void {
  restClient = null;
}

export async function getRawDevices(
  path: string,
): Promise<Record<string, HomeyDeviceLike> | HomeyDeviceLike[]> {
  if (!restClient) throw new Error('REST client not initialized — call initHomeyHttpClient first');
  const data = await restClient.get(path);
  if (Array.isArray(data)) return data as HomeyDeviceLike[];
  if (typeof data === 'object' && data !== null) return data as Record<string, HomeyDeviceLike>;
  return [];
}

export async function getRawDevice(
  deviceId: string,
): Promise<HomeyDeviceLike> {
  if (!restClient) throw new Error('REST client not initialized — call initHomeyHttpClient first');
  const data = await restClient.get(`${DEVICES_API_PATH}/${deviceId}`);
  if (!data || typeof data !== 'object') {
    throw new Error(`Invalid response for device ${deviceId}`);
  }
  return data as HomeyDeviceLike;
}

export async function setRawCapabilityValue(
  deviceId: string,
  capabilityId: string,
  value: unknown,
): Promise<void> {
  if (!restClient) throw new Error('REST client not initialized — call initHomeyHttpClient first');
  const path = `${DEVICES_API_PATH}/${deviceId}/capability/${capabilityId}`;
  try {
    await restClient.put(path, { value });
  } catch (error) {
    writeErrorToStderr(`setRawCapabilityValue PUT '${path}' failed`, error);
    throw error;
  }
}

export function hasRestClient(): boolean {
  return restClient !== null;
}

export const ENERGY_LIVE_API_PATH = 'manager/energy/live';

export async function getEnergyLiveReport(): Promise<unknown> {
  if (!restClient) return null;
  return restClient.get(ENERGY_LIVE_API_PATH);
}

export function writeErrorToStderr(message: string, error: unknown): void {
  const stderr = typeof process !== 'undefined' ? process.stderr : undefined;
  if (!stderr || typeof stderr.write !== 'function') return;
  const normalizedError = normalizeError(error);
  const errorText = normalizedError.stack || normalizedError.message;
  try {
    stderr.write(`[PelsApp] ${message} ${errorText}\n`);
  } catch (_) {
    // ignore stderr failures
  }
}

export function logDeviceManagerRuntimeError(
  logger: Pick<Logger, 'error'>,
  message: string,
  error: unknown,
): void {
  const normalizedError = normalizeError(error);
  logger.error(message, normalizedError);
  writeErrorToStderr(message, normalizedError);
}

function isHomeyAppWrapper(value: unknown): value is { homey: Homey.App['homey'] } {
  return typeof value === 'object' && value !== null && 'homey' in value;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function homeyHttpGet(baseUrl: string, token: string, urlPath: string): Promise<unknown> {
  return homeyHttpRequest('GET', baseUrl, token, urlPath);
}

function homeyHttpPut(baseUrl: string, token: string, urlPath: string, body: unknown): Promise<unknown> {
  return homeyHttpRequest('PUT', baseUrl, token, urlPath, body);
}

function homeyHttpRequest(
  method: string,
  baseUrl: string,
  token: string,
  urlPath: string,
  body?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const requestModule = url.protocol === 'https:' ? https : http;
    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: HTTP_TIMEOUT_MS,
    };

    const req = requestModule.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        if (!raw.trim()) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Non-JSON response from ${method} ${urlPath}: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP ${method} ${urlPath} timed out`));
    });

    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}
