import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type {
  PreparedSupportReport, SupportReportDocument, SupportReportEvidence, SupportReportRequest,
  SupportReportResponse, SupportReportTrigger,
} from '../../packages/contracts/src/supportReport';
import { MAIN_HOME_ID } from '../home/homeConfig';
import { getLogger } from '../logging/logger';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { SupportReportTransport } from './homeyReportTransport';
import { readSupportReportRequest, SupportReportInputError } from './supportReportInput';
import { HEATING_SHADOW_REPORT_TITLE } from './heatingShadowReport';

type EvidenceSource = {
  capture(
    request: SupportReportRequest, capturedAtMs: number, trigger?: SupportReportTrigger,
  ): Promise<SupportReportEvidence>;
};

const TTL_MS = 15 * 60_000;
const MAX_REPORTS = 4;
/**
 * The largest message Homey has been seen to deliver, after compression. Homey answers
 * a 1 MiB report with a log id but never delivers it, so a larger report is refused
 * before sending.
 */
export const SUPPORT_REPORT_MAX_BYTES = 512 * 1024;
const logger = getLogger('diagnostics/support-report');

const DAILY_REPORT_PROBLEM = 'Daily diagnostics report, sent because the owner turned it on.';

const gzipAsync = promisify(gzip);

const reportHeader = ({ trigger, request }: SupportReportDocument): string => [
  'PELS PROBLEM REPORT V2',
  `Type: ${trigger}, ${request.subject.kind}`,
  `Description: ${request.problem}`,
  ...(request.expected ? [`Expected: ${request.expected}`] : []),
  'Data (gzip, base64):',
].join('\n');

/**
 * The plain header a person reads, then the whole document as one line, then a
 * closing marker. What the owner wrote can span lines, so a reader takes the
 * data from the line before the closing marker.
 */
const toMessage = async (document: SupportReportDocument): Promise<{
  message: string; bytes: number; jsonBytes: number;
}> => {
  const json = JSON.stringify(document);
  const data = (await gzipAsync(json)).toString('base64');
  const message = `${reportHeader(document)}\n${data}\nEND PELS REPORT ${document.id}\n`;
  return { message, bytes: Buffer.byteLength(message, 'utf8'), jsonBytes: Buffer.byteLength(json, 'utf8') };
};

type EncodedMessage = Awaited<ReturnType<typeof toMessage>>;
type FittedMessage = EncodedMessage & { document: SupportReportDocument };
type LogLine = Extract<SupportReportDocument['log'], { state: 'available' }>['lines'][number];

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

const isOrdinary = (line: LogLine): boolean => line.level === 'info';

/** The log lines to leave out to free `excessBytes`: the oldest ordinary lines, then the oldest of the rest. */
const logLinesToLeaveOut = (lines: readonly LogLine[], excessBytes: number): LogLine[] => {
  const inOrder = [...lines.filter(isOrdinary), ...lines.filter((line) => !isOrdinary(line))];
  return inOrder.slice(0, countToLeaveOut(inOrder, excessBytes));
};

/**
 * The document with enough more left out to bring `encoded` within the limit if
 * what goes compresses like the rest, each part saying how many; `null` when
 * nothing is left to leave out.
 */
const leaveOutMore = (
  document: SupportReportDocument, encoded: EncodedMessage, activityToo: boolean,
): SupportReportDocument | null => {
  const { log, activity } = document;
  const excessJsonBytes = Math.ceil((encoded.bytes - SUPPORT_REPORT_MAX_BYTES) * (encoded.jsonBytes / encoded.bytes));
  const leftOutLines = logLinesToLeaveOut(log.state === 'available' ? log.lines : [], excessJsonBytes);
  const stillExcess = excessJsonBytes - leftOutLines.reduce((sum, line) => sum + jsonBytes(line), 0);
  // Activity is newest first.
  const activityLeftOut = activityToo && activity.state === 'available' && stillExcess > 0
    ? countToLeaveOut([...activity.entries].reverse(), stillExcess) : 0;
  if (leftOutLines.length === 0 && activityLeftOut === 0) return null;
  const goes = new Set(leftOutLines);
  return {
    ...document,
    log: log.state === 'available' && leftOutLines.length > 0 ? {
      ...log,
      lines: log.lines.filter((line) => !goes.has(line)),
      leftOutForSize: log.leftOutForSize + leftOutLines.length,
    } : log,
    activity: activity.state === 'available' && activityLeftOut > 0 ? {
      ...activity,
      entries: activity.entries.slice(0, activity.entries.length - activityLeftOut),
      leftOutForSize: activity.leftOutForSize + activityLeftOut,
    } : activity,
  };
};

const leaveOutUntilItFits = async (
  document: SupportReportDocument, whole: EncodedMessage, activityToo: boolean,
): Promise<FittedMessage | null> => {
  let current = document;
  let encoded = whole;
  while (encoded.bytes > SUPPORT_REPORT_MAX_BYTES) {
    const trimmed = leaveOutMore(current, encoded, activityToo);
    if (!trimmed) return null;
    current = trimmed;
    encoded = await toMessage(trimmed);
  }
  return { ...encoded, document: current };
};

const isHeatingSection = (section: SupportReportDocument['sections'][number]): boolean => (
  section.title === HEATING_SHADOW_REPORT_TITLE
);

/**
 * The document fitted to the message limit, `null` when it cannot be. Compressed,
 * a day's evidence fits, so this is for an unusually large report. The oldest
 * ordinary log lines go first, then warnings and errors, then, in a report nobody
 * pressed Send for, the oldest activity: an owner's report keeps all its activity,
 * since the owner can choose one device or a shorter window instead.
 *
 * A daily report's heating observations stay while log lines can make room, and
 * give way before any activity does.
 */
const fitToSize = async (document: SupportReportDocument): Promise<FittedMessage | null> => {
  const whole = await toMessage(document);
  if (whole.bytes <= SUPPORT_REPORT_MAX_BYTES) return { ...whole, document };
  if (document.trigger !== 'daily' || !document.sections.some(isHeatingSection)) {
    return leaveOutUntilItFits(document, whole, document.trigger !== 'owner');
  }
  return await leaveOutUntilItFits(document, whole, false) ?? fitToSize({
    ...document,
    sections: document.sections.filter((section) => !isHeatingSection(section)),
    omissions: [...document.omissions, 'Daily heating observations was left out to fit the report size limit.'],
  });
};

/**
 * Owns prepared snapshots and dispatch outcomes. A submission starts only from
 * the owner's Send, or from a report the owner turned on: the daily report
 * (`dailyReportSchedule.ts`) or reports on specific events
 * (`eventReportSchedule.ts`).
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
    return this.sendUnattended({
      subject: { kind: 'app', homeId: MAIN_HOME_ID },
      problem: DAILY_REPORT_PROBLEM,
      expected: '',
      occurredAtMs: Date.now(),
      historyWindow: 'day',
    }, 'daily', stillWanted);
  }

  /**
   * A report on a specific event the owner asked to be told about, prepared and
   * sent in one step, like the daily report. Only the owner's switch calls this
   * (`eventReportSchedule.ts`), which also says what the report is about.
   */
  async sendOnEvent(request: SupportReportRequest, stillWanted: () => boolean): Promise<SupportReportResponse> {
    return this.sendUnattended(request, 'event', stillWanted);
  }

  private async sendUnattended(
    request: SupportReportRequest,
    trigger: Exclude<SupportReportTrigger, 'owner'>,
    stillWanted: () => boolean,
  ): Promise<SupportReportResponse> {
    const availability = await this.transport.availability();
    if (availability !== 'available') {
      return { ok: false, code: availability === 'app_store_required' ? 'app_store_required' : 'sender_unavailable' };
    }
    const prepared = await this.prepareRequest(request, trigger);
    if (!prepared.ok) return prepared;
    if (!stillWanted()) return { ok: false, code: 'consent_required' };
    return this.send(prepared.report.document.id, { consent: true });
  }

  private async prepareRequest(request: SupportReportRequest, trigger: SupportReportTrigger):
    Promise<SupportReportResponse> {
    this.prune();
    try {
      const capturedAtMs = Date.now();
      const evidence = await this.source.capture(request, capturedAtMs, trigger);
      const fitted = await fitToSize({
        trigger,
        request: {
          problem: request.problem,
          expected: request.expected,
          subject: request.subject,
          occurredAtMs: request.occurredAtMs,
          historyWindow: request.historyWindow,
        },
        version: 1,
        id: randomUUID(),
        capturedAtMs,
        ...evidence,
      });
      if (!fitted) return { ok: false, code: 'report_too_large' };
      const { document, message, bytes } = fitted;
      const availability = await this.transport.availability();
      this.prune();
      if (!this.makeRoom()) return { ok: false, code: 'report_busy' };
      this.reports.set(document.id, {
        // The evidence is in the message; only this much stays decoded for the settings page.
        document: { id: document.id, request: document.request, subjectName: document.subjectName },
        message,
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
