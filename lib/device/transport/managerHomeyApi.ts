import type Homey from 'homey';
import http from 'http';
import https from 'https';
import type { Logger, RawHomeyDeviceLike } from '../../utils/types';
import { HomeyRequestTimeoutError, normalizeError } from '../../utils/errorUtils';
import { HomeyHttpStatusError } from '../../utils/homeyHttpStatusError';
import { getLogger } from '../../logging/logger';
import { bindCurrentContext } from '../../logging/alsContext';
import { countHomeyApiCall } from './homeyApiCallCount';
import {
  bufferedDeviceInventoryRequired, readDeviceInventoryEntries, type DeviceInventoryShape,
} from './deviceInventoryStream';

export const DEVICES_API_PATH = 'manager/devices/device';
export const HOMEY_LOCATION_API_PATH = 'manager/geolocation/option/location';

/**
 * Set by the SLOWEST request that has ever SUCCEEDED, not by how long a failing
 * hub might take to answer. Across 2123 successful writes in production the
 * distribution is p50 0.28 s / p90 2.04 s / p99 7.76 s / max 9.16 s, and NOTHING
 * has ever succeeded after 10 s — the binding device is the EV charger, which is
 * routinely slow (p50 6.70 s). 15 s keeps ~1.6x headroom over anything observed.
 *
 * It is deliberately not longer. A write is awaited inside the plan rebuild and
 * rebuilds are serialized through one queue (`lib/plan/planService.ts`), so a
 * hung write is time the capacity controller is not deciding at all: one stalled
 * the planner for a full 32 s in prod. It must also stay well inside the
 * pending/settle window that resolves an unacknowledged command: 90 s
 * (`CONTROL_COMMAND_CONFIRMATION_MS`), or a learned on/off window, which is
 * never under 30 s (`writeAnswerTimes.ts`). The device that motivated this is
 * a cloud one.
 *
 * Two things this value is NOT, both of which it would be easy to read into it:
 *
 * - It is not a deadline. `options.timeout` is Node's socket-IDLE timer (see
 *   `HomeyRequestTimeoutError`), so a response that trickles never trips it.
 *   This shortens the common stall; it does not bound the worst one. Bounding
 *   that means not awaiting the write inside the rebuild.
 * - It is not the point at which we stop LISTENING. The owning app behind a
 *   cloud device can take 22-60 s to answer with a real error (myUplink returns
 *   HTTP 500 "Failed to change the settings."), and aborting the socket at our
 *   own deadline is exactly what kept that error out of every log. The request
 *   is therefore abandoned by the CALLER at this deadline but left open until
 *   `LATE_RESPONSE_ABANDON_MS`, so the answer still gets recorded when it
 *   arrives. Control does not wait for it; only the log does.
 *
 * The distribution above is writes; it governs reads too. A read that aborts is
 * a no-op by design — the last good sample carries forward and the 10-minute
 * shed-timeout escalation is the backstop — so the write-derived bound is the
 * conservative one to share.
 */
const HTTP_TIMEOUT_MS = 15_000;


/**
 * How long an abandoned request stays open purely to record its outcome.
 *
 * Bounded because these are sockets: the value has to outlast the slowest real
 * answer we have seen (60 s from myUplink) with room to spare, while still
 * guaranteeing the request cannot linger indefinitely if the far end never
 * replies at all. Nothing in the control path is waiting on it — by the time
 * this window opens, the caller has already been told the outcome is unknown.
 */
const LATE_RESPONSE_ABANDON_MS = 120_000;

const lateResponseLogger = getLogger('device/transport');

/**
 * The answer to a request the caller already gave up on.
 *
 * This is the only place a cloud-backed device's real failure is observable, so
 * it is logged at warn even when the status is a success. An HTTP response
 * distinguishes a rejection from a slow acknowledgement. It does not report
 * the device's actual setpoint.
 */
function logLateResponse(params: {
  method: string;
  urlPath: string;
  statusCode?: number;
  raw: string;
  startedAtMs: number;
}): void {
  const { method, urlPath, statusCode, raw, startedAtMs } = params;
  const accepted = statusCode !== undefined && statusCode < 400;
  lateResponseLogger.warn({
    event: 'homey_request_late_response',
    reasonCode: accepted ? 'landed_after_abandon' : 'failed_after_abandon',
    method,
    urlPath,
    statusCode: statusCode ?? null,
    elapsedMs: Date.now() - startedAtMs,
    // The owning app's own words. Truncated: some Homey error bodies carry a
    // full remote stack.
    responseBody: raw.slice(0, 200),
  });
}

/** The abandoned request never produced a response at all. */
function logLateFailure(params: {
  method: string;
  urlPath: string;
  error: Error;
  startedAtMs: number;
}): void {
  const { method, urlPath, error, startedAtMs } = params;
  lateResponseLogger.warn({
    event: 'homey_request_late_failure',
    reasonCode: 'no_response_after_abandon',
    method,
    urlPath,
    elapsedMs: Date.now() - startedAtMs,
    err: normalizeError(error),
  });
}

export type RestClient = {
  get: (path: string) => Promise<unknown>;
  readDeviceInventory?: <T>(collect: DeviceInventoryCollector<T>, shape: DeviceInventoryShape) => Promise<T>;
  post?: (path: string, body: unknown) => Promise<unknown>;
  put: (path: string, body: unknown) => Promise<unknown>;
};

type DeviceInventoryCollector<T> = (entries: AsyncIterable<unknown>) => Promise<T>;

// The active REST client, set during init.
let restClient: RestClient | null = null;

export function resolveHomeyInstance(homey: Homey.App): Homey.App['homey'] {
  if (isHomeyAppWrapper(homey)) {
    return homey.homey;
  }
  return homey;
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
    readDeviceInventory: (collect, shape) => homeyReadDeviceInventory(baseUrl, token, collect, shape),
    post: (path, body) => homeyHttpPost(baseUrl, token, `/api/${path}`, body),
    put: (path, body) => homeyHttpPut(baseUrl, token, `/api/${path}`, body),
  };
}

/** Set the REST client directly (used by test mocks). */
export function setRestClient(client: RestClient): void {
  restClient = client;
}

async function collectDeviceInventory<T>(
  entries: AsyncIterable<unknown>, collect: DeviceInventoryCollector<T>,
): Promise<T> {
  let ended = false;
  async function* read(): AsyncGenerator<unknown> {
    yield* entries;
    ended = true;
  }
  const result = await collect(read());
  if (!ended) throw new Error('Device inventory collector ended before the response');
  return result;
}

async function* readBufferedDeviceInventory(shape: DeviceInventoryShape): AsyncGenerator<unknown> {
  const entries = await getRawFromHomeyApi(DEVICES_API_PATH);
  yield* bufferedDeviceEntries(entries, shape);
}

/**
 * Collect a complete registry. Keep results local to each collector invocation: an unusual map
 * may restart the read to preserve Homey's key enumeration order and last duplicate value.
 */
export function readRawDeviceInventory<T>(
  collect: DeviceInventoryCollector<T>, shape: DeviceInventoryShape = 'collection',
): Promise<T> {
  return restClient?.readDeviceInventory
    ? restClient.readDeviceInventory(collect, shape)
    : collectDeviceInventory(readBufferedDeviceInventory(shape), collect);
}

export async function getRawDevice(
  deviceId: string,
): Promise<RawHomeyDeviceLike> {
  if (!restClient) throw new Error('REST client not initialized — call initHomeyHttpClient first');
  const data = await restClient.get(`${DEVICES_API_PATH}/${deviceId}`);
  if (!data || typeof data !== 'object') {
    throw new Error(`Invalid response for device ${deviceId}`);
  }
  return data as RawHomeyDeviceLike;
}

/**
 * `transactionId` comes back on Homey's capability event for this write, which
 * is how the transport tells PELS's echo from any other report
 * (`ownCapabilityWrites.ts`).
 */
export async function setRawCapabilityValue(
  deviceId: string,
  capabilityId: string,
  value: unknown,
  transactionId: string,
): Promise<void> {
  if (!restClient) throw new Error('REST client not initialized — call initHomeyHttpClient first');
  const path = `${DEVICES_API_PATH}/${deviceId}/capability/${capabilityId}`;
  try {
    await restClient.put(path, { value, transactionId });
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

/**
 * Generic read-only GET against the Homey local Web API, for endpoints that
 * have no dedicated helper (e.g. the user-flow lists). Throws when the REST
 * client is not initialised so callers can fail closed rather than treat an
 * uninitialised client as an empty result.
 */
export async function getRawFromHomeyApi(path: string): Promise<unknown> {
  if (!restClient) throw new Error('REST client not initialized — call initHomeyHttpClient first');
  return restClient.get(path);
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

export function logDeviceTransportRuntimeError(
  logger: Pick<Logger, 'error'>,
  payload: { event: string } & Record<string, unknown>,
  error: unknown,
): void {
  const normalizedError = normalizeError(error);
  logger.error({ ...payload, err: normalizedError });
  // Mirror to stderr as a last-resort sink in case the structured logger
  // destination is unavailable; use the event name as the human-readable tag.
  writeErrorToStderr(payload.event, normalizedError);
}

function isHomeyAppWrapper(value: unknown): value is { homey: Homey.App['homey'] } {
  return typeof value === 'object' && value !== null && 'homey' in value;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function readResponseBody(response: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    /* eslint-disable-next-line functional/immutable-data -- The fallback and HTTP errors need their complete body. */
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function* readBufferedInventoryResponse(
  response: http.IncomingMessage, shape: DeviceInventoryShape,
): AsyncGenerator<unknown> {
  yield* bufferedDeviceEntries(JSON.parse(await readResponseBody(response)), shape);
}

function bufferedDeviceEntries(entries: unknown, shape: DeviceInventoryShape): unknown[] {
  if (shape === 'keyed' && (entries === null || typeof entries !== 'object' || Array.isArray(entries))) return [];
  if (Array.isArray(entries)) return entries;
  if (typeof entries !== 'object' || entries === null) throw new Error('Invalid response for device inventory');
  return Object.values(entries);
}

async function homeyReadDeviceInventory<T>(
  baseUrl: string, token: string, collect: DeviceInventoryCollector<T>, shape: DeviceInventoryShape,
): Promise<T> {
  const path = `/api/${DEVICES_API_PATH}`;
  try {
    return await homeyHttpRequest('GET', baseUrl, token, path, undefined, (response) => (
      collectDeviceInventory(readDeviceInventoryEntries(response, shape), collect)
    ));
  } catch (error) {
    if (error !== bufferedDeviceInventoryRequired) throw error;
  }
  return homeyHttpRequest('GET', baseUrl, token, path, undefined, (response) => (
    collectDeviceInventory(readBufferedInventoryResponse(response, shape), collect)
  ));
}

function homeyHttpGet(baseUrl: string, token: string, urlPath: string): Promise<unknown> {
  return homeyHttpRequest('GET', baseUrl, token, urlPath);
}

function homeyHttpPost(baseUrl: string, token: string, urlPath: string, body: unknown): Promise<unknown> {
  return homeyHttpRequest('POST', baseUrl, token, urlPath, body);
}

function homeyHttpPut(baseUrl: string, token: string, urlPath: string, body: unknown): Promise<unknown> {
  return homeyHttpRequest('PUT', baseUrl, token, urlPath, body);
}

function homeyHttpRequest(
  method: string, baseUrl: string, token: string, urlPath: string, body?: unknown,
): Promise<unknown>;
function homeyHttpRequest<T>(
  method: string, baseUrl: string, token: string, urlPath: string, body: undefined,
  readResponse: (response: http.IncomingMessage) => Promise<T>,
): Promise<T>;
function homeyHttpRequest(
  method: string,
  baseUrl: string,
  token: string,
  urlPath: string,
  body?: unknown,
  readResponse?: (response: http.IncomingMessage) => Promise<unknown>,
): Promise<unknown> {
  countHomeyApiCall(method, urlPath);
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

    const startedAtMs = Date.now();
    // A reused socket can invoke a callback under a different operation's context.
    const logInRequestContext = bindCurrentContext();
    let abandoned = false;
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    const stopListening = (): void => {
      if (abandonTimer) clearTimeout(abandonTimer);
      abandonTimer = undefined;
    };

    const req = requestModule.request(options, (res) => {
      if (readResponse) {
        const result = res.statusCode && res.statusCode < 400
          ? readResponse(res)
          : readResponseBody(res).then((bodyText) => { throw new HomeyHttpStatusError(res.statusCode, bodyText); });
        void result.then(resolve, (error: unknown) => {
          res.destroy();
          reject(error);
        });
        return;
      }
      const chunks: Buffer[] = [];
      /* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      /* eslint-enable functional/immutable-data */
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        // The control path gave up on this request long ago and has already
        // decided. This is the answer arriving anyway — the ONLY place the
        // owning app's real error is ever visible — so log it and stop.
        if (abandoned) {
          stopListening();
          logInRequestContext(() => logLateResponse({
            method, urlPath, statusCode: res.statusCode, raw, startedAtMs,
          }));
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new HomeyHttpStatusError(res.statusCode, raw));
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

    req.on('error', (error: Error) => {
      if (abandoned) {
        stopListening();
        logInRequestContext(() => logLateFailure({ method, urlPath, error, startedAtMs }));
        return;
      }
      reject(error);
    });
    req.on('timeout', () => {
      // The socket-idle timer keeps firing while we linger; only the first one
      // decides anything.
      if (abandoned) return;
      abandoned = true;
      reject(new HomeyRequestTimeoutError(method, urlPath));
      if (readResponse) {
        req.destroy();
        return;
      }
      // Deliberately NOT destroyed here. Abandoning the socket is what made the
      // owning app's real answer unobservable: a cloud-backed device can take
      // 22-60 s to reply `HTTP 500 "Failed to change the settings."`, and
      // killing the request at our own deadline meant that error never reached
      // a log. Nothing downstream waits on this — the promise is already
      // rejected and the caller has moved on — it stays open purely so the
      // answer can be recorded. A late 2xx tells us Homey acknowledged the
      // request after we stopped waiting.
      abandonTimer = setTimeout(() => {
        req.destroy();
      }, LATE_RESPONSE_ABANDON_MS);
      abandonTimer.unref?.();
    });

    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}
