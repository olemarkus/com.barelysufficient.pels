import type { SupportReportAvailability } from '../../packages/contracts/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { getLogger } from '../logging/logger';
import { type HomeyAppManagerRuntime, requestHomeyAppManager } from './homeyAppManagerRequest';

export type SupportReportDelivery =
  | { state: 'accepted'; reference: string }
  | { state: 'rejected' }
  | { state: 'unknown' };

export type SupportReportTransport = {
  availability(): Promise<SupportReportAvailability>;
  send(message: string): Promise<SupportReportDelivery>;
};

export type HomeyReportRuntime = HomeyAppManagerRuntime;

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

  private request(suffix: string, method: 'GET' | 'POST', message: string | undefined, timeoutMs: number) {
    return requestHomeyAppManager(this.homey, suffix, method, message, timeoutMs);
  }
}

// Homey answers an accepted report with its identifier as a bare JSON string.
function readReportReference(result: unknown): string {
  return typeof result === 'string' && /^[a-zA-Z0-9:_-]{6,100}$/.test(result) ? result : '';
}
