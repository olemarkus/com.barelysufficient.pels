import { ChargingAccessError } from './chargingAccessError';
import type { ChargingAccessStatus } from '../../../packages/contracts/src/chargingControl';
import type { Logger } from '../../utils/types';
import type { SettingsPort } from '../../ports/homeyRuntime';
import { HomeyRequestTimeoutError } from '../../utils/errorUtils';

/** An adapter-resolved Homey action, never supplied by the settings UI. */
export type ChargingCurrentAction = {
  ownerUri: string;
  cardId: string;
  args: Readonly<Record<string, unknown>>;
};

/** Configuration, not a cache. Only this backend owner reads or writes it. */
export const CHARGING_ACCESS_KEY = '_homey_flow_api_key';
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 15_000;
const LATE_RESPONSE_TIMEOUT_MS = 120_000;

export type ChargingAccessHomey = {
  settings: SettingsPort;
  api: { getLocalUrl(): Promise<string> };
  cloud: { getHomeyId(): Promise<string> };
};


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /\s/u.test(value)) {
    throw new ChargingAccessError('unavailable');
  }
  return value;
}

/**
 * Owns one Homey's optional user key. App credentials continue to own ordinary
 * reads and capability writes. Checking or saving access sends no device command.
 */
export class ChargingAccess {
  private key = '';
  private generation = 0;
  private accessState: ChargingAccessStatus['state'] = 'not_configured';
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly homey: ChargingAccessHomey, private readonly logger: Pick<Logger, 'structuredLog'>) {}

  status(): ChargingAccessStatus {
    this.sync();
    return { configured: this.key.length > 0, state: this.accessState };
  }

  async check(): Promise<ChargingAccessStatus> {
    this.sync();
    if (!this.key) return this.status();
    const generation = this.generation;
    try {
      await this.verify(this.key);
      if (generation === this.generation) this.accessState = 'ready';
    } catch (error) {
      if (generation === this.generation) this.noteFailure(error);
    }
    return this.status();
  }

  async save(body: unknown): Promise<ChargingAccessStatus> {
    if (!isRecord(body) || typeof body.key !== 'string') throw new ChargingAccessError('unavailable');
    const candidate = readKey(body.key.trim());
    this.sync();
    const generation = ++this.generation;
    await this.verify(candidate);
    // Removal or replacement while validation was outstanding wins.
    if (generation !== this.generation) throw new ChargingAccessError('unavailable');
    this.homey.settings.set(CHARGING_ACCESS_KEY, candidate);
    this.key = candidate;
    this.accessState = 'ready';
    return this.status();
  }

  remove(): ChargingAccessStatus {
    this.homey.settings.unset(CHARGING_ACCESS_KEY);
    this.generation++;
    this.key = '';
    this.accessState = 'not_configured';
    return this.status();
  }

  /** Called only by device transport under the actuator's current command. */
  async runCurrentAction(deviceId: string, action: ChargingCurrentAction, assertAuthorized: () => void): Promise<void> {
    this.sync();
    // A transient scope-check failure must not require a settings visit to
    // recover. Recheck on the next planned command; never retry its POST.
    if (this.key && (this.accessState === 'not_checked' || this.accessState === 'unavailable')) await this.check();
    if (!this.key || this.accessState !== 'ready' || this.inFlight.has(deviceId)) {
      throw new ChargingAccessError(this.accessState === 'permission_denied' ? 'permission_denied' : 'unavailable');
    }
    const generation = this.generation;
    const path = `manager/flow/flowcardaction/${encodeURIComponent(action.ownerUri)}`
      + `/${encodeURIComponent(action.cardId)}/run`;
    const operation = this.request(
      this.key, path, 'POST', { args: action.args }, generation, assertAuthorized,
    ).then((result) => {
      if (result === false || !isRecord(result) || result.error !== null) {
        throw new ChargingAccessError('unavailable');
      }
    });
    this.inFlight.set(deviceId, operation);
    // Keep the device busy after a caller timeout: the remote action may still
    // be executing. A new key must not make an outstanding write replayable.
    void operation.catch((error: unknown) => {
      // A vendor command failure says nothing about this Homey's verified key.
      // Keep other devices and normal executor retries usable; only an actual
      // authorization rejection invalidates shared access.
      if (generation === this.generation && error instanceof ChargingAccessError
        && error.reason === 'permission_denied') this.noteFailure(error);
      this.logger.structuredLog.warn({
        event: 'charging_current_action_failed', deviceId,
        reasonCode: error instanceof ChargingAccessError ? error.reason : 'unavailable',
      });
    }).finally(() => {
      if (this.inFlight.get(deviceId) === operation) this.inFlight.delete(deviceId);
    }).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HomeyRequestTimeoutError('POST', path)), WRITE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private sync(): void {
    try {
      const listed = this.homey.settings.getKeys().includes(CHARGING_ACCESS_KEY);
      const raw: unknown = this.homey.settings.get(CHARGING_ACCESS_KEY);
      if (!listed && (raw === null || raw === undefined)) {
        if (this.key) this.generation++;
        this.key = '';
        this.accessState = 'not_configured';
        return;
      }
      const key = readKey(raw);
      if (key === this.key) return;
      this.key = key;
      this.generation++;
      this.accessState = 'not_checked';
    } catch {
      // A failed settings read does not erase a previously accepted key.
      if (!this.key) this.accessState = 'unavailable';
    }
  }

  private noteFailure(error: unknown): void {
    this.accessState = error instanceof ChargingAccessError ? error.reason : 'unavailable';
  }

  private async verify(key: string): Promise<void> {
    const session = await this.request(key, 'manager/sessions/session/me', 'GET');
    if (!isRecord(session) || !Array.isArray(session.intersectedScopes)) {
      throw new ChargingAccessError('unavailable');
    }
    if (!session.intersectedScopes.some((scope) => scope === 'homey.flow' || scope === 'homey')) {
      throw new ChargingAccessError('permission_denied');
    }
  }

  private async resolveHomeyTarget(): Promise<[string, string]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([this.homey.api.getLocalUrl(), this.homey.cloud.getHomeyId()]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ChargingAccessError('unavailable')), READ_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async request(
    key: string, path: string, method: 'GET' | 'POST',
    body?: unknown, generation?: number, assertAuthorized?: () => void,
  ): Promise<unknown> {
    try {
      const [address, homeyId] = await this.resolveHomeyTarget();
      const url = new URL(address);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !homeyId) {
        throw new ChargingAccessError('unavailable');
      }
      if (method === 'POST') {
        this.sync();
        if (generation !== this.generation || key !== this.key || this.accessState !== 'ready') {
          throw new ChargingAccessError('unavailable');
        }
      }
      assertAuthorized?.();
      const response = await fetch(new URL(`/api/${path}`, url), {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'GET' ? READ_TIMEOUT_MS : LATE_RESPONSE_TIMEOUT_MS),
      });
      return await readResponse(response, homeyId);
    } catch (error) {
      if (error instanceof ChargingAccessError) throw error;
      throw new ChargingAccessError('unavailable');
    }
  }
}

async function readResponse(response: Awaited<ReturnType<typeof fetch>>, homeyId: string): Promise<unknown> {
  if (response.headers.get('X-Homey-ID') !== homeyId) throw new ChargingAccessError('unavailable');
  if (response.status === 401 || response.status === 403) throw new ChargingAccessError('permission_denied');
  if (!response.ok) throw new ChargingAccessError('unavailable');
  return response.json();
}
