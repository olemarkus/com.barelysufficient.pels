import { randomUUID } from 'node:crypto';
import type {
  PreparedSupportReport, SupportReportDocument, SupportReportEvidence, SupportReportRequest,
  SupportReportResponse,
} from '../../packages/contracts/src/supportReport';
import { SUPPORT_REPORT_MAX_BYTES } from '../../packages/shared-domain/src/supportReport';
import { getLogger } from '../logging/logger';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { SupportReportTransport } from './homeyReportTransport';
import { readSupportReportRequest, SupportReportInputError } from './supportReportInput';

type EvidenceSource = {
  capture(request: SupportReportRequest, capturedAtMs: number): Promise<SupportReportEvidence>;
};

const TTL_MS = 15 * 60_000;
const MAX_REPORTS = 4;
const logger = getLogger('diagnostics/support-report');

/** Owns prepared snapshots and dispatch outcomes. No timer or incident can initiate a submission. */
export class SupportReportService {
  private readonly reports = new Map<string, PreparedSupportReport>();
  private dispatching = false;
  private lastDispatchAtMs = -Infinity;

  constructor(private readonly source: EvidenceSource, private readonly transport: SupportReportTransport) {}

  async prepare(raw: unknown): Promise<SupportReportResponse> {
    this.prune();
    try {
      const capturedAtMs = Date.now();
      const request = readSupportReportRequest(raw, capturedAtMs);
      const evidence = await this.source.capture(request, capturedAtMs);
      const document: SupportReportDocument = {
        ...evidence, version: 1, id: randomUUID(), capturedAtMs, request,
      };
      const json = JSON.stringify(document);
      const message = `PELS PROBLEM REPORT V1\n${json}\nEND PELS REPORT ${document.id}\n`;
      const bytes = Buffer.byteLength(message, 'utf8');
      if (bytes > SUPPORT_REPORT_MAX_BYTES) return { ok: false, code: 'report_too_large' };
      const availability = await this.transport.availability();
      this.prune();
      if (!this.makeRoom()) return { ok: false, code: 'report_busy' };
      this.reports.set(document.id, {
        document: JSON.parse(json) as SupportReportDocument, message, bytes,
        expiresAtMs: Date.now() + TTL_MS, availability, submission: { state: 'draft' },
      });
      logger.info({ event: 'support_report_prepared', reportId: document.id, bytes });
      return this.get(document.id);
    } catch (error) {
      if (error instanceof SupportReportInputError) return { ok: false, code: error.code };
      logger.warn({ event: 'support_report_capture_failed' });
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
    try {
      report.availability = await this.transport.availability();
      if (report.availability !== 'available') {
        report.submission = { state: 'draft' };
        return { ok: false, code: report.availability === 'app_store_required'
          ? 'app_store_required' : 'sender_unavailable' };
      }
      this.lastDispatchAtMs = Date.now();
      const delivery = await this.transport.send(report.message);
      switch (delivery.state) {
        case 'accepted': report.submission = { state: 'sent', reference: delivery.reference }; break;
        case 'rejected': report.submission = { state: 'failed', reason: 'Homey refused the report.' }; break;
        case 'unknown': report.submission = { state: 'unknown' }; break;
        default: delivery satisfies never;
      }
    } catch {
      // Never classify a possible post-dispatch failure as safe to retry.
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
