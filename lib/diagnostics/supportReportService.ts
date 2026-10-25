import { randomUUID } from 'node:crypto';
import type {
  PreparedSupportReport, SupportReportDocument, SupportReportEvidence, SupportReportRequest,
  SupportReportResponse, SupportReportTrigger,
} from '../../packages/contracts/src/supportReport';
import { MAIN_HOME_ID } from '../home/homeConfig';
import { getLogger } from '../logging/logger';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { SupportReportTransport } from './homeyReportTransport';
import { readSupportReportRequest, SupportReportInputError } from './supportReportInput';

type EvidenceSource = {
  capture(request: SupportReportRequest, capturedAtMs: number): Promise<SupportReportEvidence>;
};

const TTL_MS = 15 * 60_000;
const MAX_REPORTS = 4;
/**
 * The largest message Homey has been seen to deliver. Homey answers a 1 MiB report
 * with a log id but never delivers it, so a larger report is refused before sending.
 */
export const SUPPORT_REPORT_MAX_BYTES = 512 * 1024;
const logger = getLogger('diagnostics/support-report');

const DAILY_REPORT_PROBLEM = 'Daily diagnostics report, sent because the owner turned it on.';

const toMessage = (document: SupportReportDocument): { json: string; message: string; bytes: number } => {
  const json = JSON.stringify(document);
  const message = `PELS PROBLEM REPORT V1\n${json}\nEND PELS REPORT ${document.id}\n`;
  return { json, message, bytes: Buffer.byteLength(message, 'utf8') };
};

type FittedMessage = ReturnType<typeof toMessage> & { document: SupportReportDocument };

/** What an element adds to its array's JSON, the comma after it aside: never more than removing it frees. */
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** How many of `items`, from the first, to leave out to free `excessBytes`: all of them when that is not enough. */
const countToLeaveOut = (items: readonly unknown[], excessBytes: number): number => {
  let freed = 0;
  let count = 0;
  while (count < items.length && freed < excessBytes) {
    freed += jsonBytes(items[count]);
    count += 1;
  }
  return count;
};

/**
 * The document with the oldest of its log lines and, in a daily report, of its
 * activity left out, the fewest that make the message fit, each saying how
 * many; `null` when it is too large without them. An owner's report keeps all
 * its activity: the owner can choose one device or a shorter window instead.
 */
const fitToSize = (document: SupportReportDocument): FittedMessage | null => {
  const whole = toMessage(document);
  if (whole.bytes <= SUPPORT_REPORT_MAX_BYTES) return { ...whole, document };
  const { log, activity } = document;
  // Log lines are oldest first, activity newest first.
  const logLines = log.state === 'available' ? log.lines : [];
  const logLeftOut = countToLeaveOut(logLines, whole.bytes - SUPPORT_REPORT_MAX_BYTES);
  const stillExcess = whole.bytes - SUPPORT_REPORT_MAX_BYTES
    - logLines.slice(0, logLeftOut).reduce((sum, line) => sum + jsonBytes(line), 0);
  const activityLeftOut = document.trigger === 'daily' && activity.state === 'available' && stillExcess > 0
    ? countToLeaveOut([...activity.entries].reverse(), stillExcess) : 0;
  const trimmed: SupportReportDocument = {
    ...document,
    log: log.state === 'available' && logLeftOut > 0
      ? { ...log, lines: log.lines.slice(logLeftOut), leftOutForSize: log.leftOutForSize + logLeftOut } : log,
    activity: activity.state === 'available' && activityLeftOut > 0 ? {
      ...activity,
      entries: activity.entries.slice(0, activity.entries.length - activityLeftOut),
      leftOutForSize: activity.leftOutForSize + activityLeftOut,
    } : activity,
  };
  const fitted = toMessage(trimmed);
  return fitted.bytes <= SUPPORT_REPORT_MAX_BYTES ? { ...fitted, document: trimmed } : null;
};

/**
 * Owns prepared snapshots and dispatch outcomes. A submission starts only from
 * the owner's Send, or from the daily report the owner turned on
 * (`dailyReportSchedule.ts`); no incident starts one on its own.
 */
export class SupportReportService {
  private readonly reports = new Map<string, PreparedSupportReport>();
  private dispatching = false;
  private lastDispatchAtMs = -Infinity;

  constructor(private readonly source: EvidenceSource, private readonly transport: SupportReportTransport) {}

  async prepare(raw: unknown): Promise<SupportReportResponse> {
    try {
      return await this.prepareRequest(readSupportReportRequest(raw, Date.now()), 'owner');
    } catch (error) {
      if (error instanceof SupportReportInputError) return { ok: false, code: error.code };
      throw error;
    }
  }

  /**
   * The daily report: the whole app over the last day, prepared and sent in
   * one step. Only the owner's switch calls this (`dailyReportSchedule.ts`);
   * `stillWanted` asks it again once the report is prepared, so turning the
   * switch off meanwhile sends nothing. An install that cannot send captures
   * nothing.
   */
  async sendDaily(stillWanted: () => boolean): Promise<SupportReportResponse> {
    const availability = await this.transport.availability();
    if (availability !== 'available') {
      return { ok: false, code: availability === 'app_store_required' ? 'app_store_required' : 'sender_unavailable' };
    }
    const prepared = await this.prepareRequest({
      subject: { kind: 'app', homeId: MAIN_HOME_ID },
      problem: DAILY_REPORT_PROBLEM,
      expected: '',
      occurredAtMs: Date.now(),
      historyWindow: 'day',
    }, 'daily');
    if (!prepared.ok) return prepared;
    if (!stillWanted()) return { ok: false, code: 'consent_required' };
    return this.send(prepared.report.document.id, { consent: true });
  }

  private async prepareRequest(request: SupportReportRequest, trigger: SupportReportTrigger):
    Promise<SupportReportResponse> {
    this.prune();
    try {
      const capturedAtMs = Date.now();
      const evidence = await this.source.capture(request, capturedAtMs);
      const fitted = fitToSize({ ...evidence, version: 1, id: randomUUID(), capturedAtMs, request, trigger });
      if (!fitted) return { ok: false, code: 'report_too_large' };
      const { document, json, message, bytes } = fitted;
      const availability = await this.transport.availability();
      this.prune();
      if (!this.makeRoom()) return { ok: false, code: 'report_busy' };
      this.reports.set(document.id, {
        document: JSON.parse(json) as SupportReportDocument, message,
        expiresAtMs: Date.now() + TTL_MS, availability, submission: { state: 'draft' },
      });
      logger.info({ event: 'support_report_prepared', reportId: document.id, bytes, trigger });
      return this.get(document.id);
    } catch (error) {
      if (error instanceof SupportReportInputError) return { ok: false, code: error.code };
      logger.warn({ event: 'support_report_capture_failed', trigger });
      return { ok: false, code: 'capture_failed' };
    }
  }

  get(id: string): SupportReportResponse {
    this.prune();
    const report = this.reports.get(id);
    return report ? { ok: true, report: structuredClone(report) } : { ok: false, code: 'report_expired' };
  }

  async send(id: string, body: unknown): Promise<SupportReportResponse> {
    if (!isUnknownRecord(body) || body.consent !== true) return { ok: false, code: 'consent_required' };
    this.prune();
    const report = this.reports.get(id);
    if (!report) return { ok: false, code: 'report_expired' };
    if (report.submission.state !== 'draft') return this.get(id);
    if (this.dispatching || Date.now() - this.lastDispatchAtMs < 60_000) return { ok: false, code: 'report_busy' };
    // Lock before the asynchronous origin check so two concurrent calls cannot dispatch the same draft.
    this.dispatching = true;
    report.submission = { state: 'sending' };
    report.expiresAtMs = Date.now() + TTL_MS;
    let dispatchedAtMs: number | undefined;
    try {
      report.availability = await this.transport.availability();
      if (report.availability !== 'available') {
        report.submission = { state: 'draft' };
        return { ok: false, code: report.availability === 'app_store_required'
          ? 'app_store_required' : 'sender_unavailable' };
      }
      dispatchedAtMs = Date.now();
      const delivery = await this.transport.send(report.message);
      // The minute between dispatches starts with a report Homey may have taken.
      // One it refused may be sent again at once.
      if (delivery.state !== 'rejected') this.lastDispatchAtMs = dispatchedAtMs;
      switch (delivery.state) {
        case 'accepted': report.submission = { state: 'sent', reference: delivery.reference }; break;
        case 'rejected': report.submission = { state: 'failed' }; break;
        case 'unknown': report.submission = { state: 'unknown' }; break;
        default: delivery satisfies never;
      }
    } catch {
      // Never classify a possible post-dispatch failure as safe to retry.
      if (dispatchedAtMs !== undefined) this.lastDispatchAtMs = dispatchedAtMs;
      report.submission = { state: 'unknown' };
    } finally {
      this.dispatching = false;
    }
    logger.info({ event: 'support_report_submission', reportId: id, state: report.submission.state });
    return this.get(id);
  }

  private prune(): void {
    for (const [id, report] of this.reports) {
      if (report.expiresAtMs <= Date.now() && report.submission.state !== 'sending') this.reports.delete(id);
    }
  }

  private makeRoom(): boolean {
    if (this.reports.size < MAX_REPORTS) return true;
    // Repeated edits must not exhaust the store. Preserve uncertain/in-flight submissions for status checks.
    for (const [id, report] of this.reports) {
      if (report.submission.state === 'draft' || report.submission.state === 'sent'
        || report.submission.state === 'failed') {
        this.reports.delete(id);
        return true;
      }
    }
    return false;
  }
}
