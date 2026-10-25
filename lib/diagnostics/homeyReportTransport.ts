import type { SupportReportAvailability } from '../../packages/contracts/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { getLogger } from '../logging/logger';

export type SupportReportDelivery =
  | { state: 'accepted'; reference: string }
  | { state: 'rejected' }
  | { state: 'unknown' };

export type SupportReportTransport = {
  availability(): Promise<SupportReportAvailability>;
  send(message: string): Promise<SupportReportDelivery>;
};

export type HomeyReportRuntime = {
  manifest: { id: string };
  api: { getOwnerApiToken(): Promise<string>; getLocalUrl(): Promise<string> };
};

const SEND_TIMEOUT_MS = 45_000;
const logger = getLogger('diagnostics/report-transport');

/** Homey's manager API requires the owner token; the app-session API cannot submit diagnostics. */
export class HomeyReportTransport implements SupportReportTransport {
  constructor(private readonly homey: HomeyReportRuntime) {}

  async availability(): Promise<SupportReportAvailability> {
    try {
      const response = await this.request('', 'GET', undefined, 10_000);
      if (!response.ok) return 'unavailable';
      const app = response.body;
      if (!isUnknownRecord(app) || typeof app.origin !== 'string') return 'unavailable';
      return app.origin === 'appstore' ? 'available' : 'app_store_required';
    } catch {
      return 'unavailable';
    }
  }

  async send(message: string): Promise<SupportReportDelivery> {
    try {
      const response = await this.request('/crashlog', 'POST', message, SEND_TIMEOUT_MS);
      // Homey can return an error after forwarding the report. Even a 4xx
      // cannot prove non-delivery, so it must not authorize an early retry.
      if (!response.ok) {
        logger.warn({ event: 'support_report_delivery_uncertain', status: response.status });
        return { state: 'unknown' };
      }
      const result = response.body;
      if (result === false || (isUnknownRecord(result) && result.error)) return { state: 'unknown' };
      return { state: 'accepted', reference: readReportReference(result) };
    } catch {
      return { state: 'unknown' };
    }
  }

  private async request(suffix: string, method: 'GET' | 'POST', message: string | undefined, timeoutMs: number) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Homey diagnostics request timed out'));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.performRequest(suffix, method, message, controller.signal), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async performRequest(
    suffix: string, method: 'GET' | 'POST', message: string | undefined, signal: AbortSignal,
  ) {
    const [baseUrl, token] = await Promise.all([
      this.homey.api.getLocalUrl(), this.homey.api.getOwnerApiToken(),
    ]);
    signal.throwIfAborted();
    if (!token) throw new Error('Homey authentication unavailable');
    const path = `/api/manager/apps/app/${encodeURIComponent(this.homey.manifest.id)}${suffix}`;
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(message === undefined ? {} : { body: JSON.stringify({ message }) }),
      signal,
      redirect: 'error',
    });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  }
}

// Homey answers an accepted report with its identifier as a bare JSON string.
function readReportReference(result: unknown): string {
  return typeof result === 'string' && /^[a-zA-Z0-9:_-]{6,100}$/.test(result) ? result : '';
}
