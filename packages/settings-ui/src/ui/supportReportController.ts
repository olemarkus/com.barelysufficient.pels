import type {
  PreparedSupportReport,
  SupportReportResponse,
  SupportReportRequest,
  SupportReportSubject,
} from '../../../contracts/src/supportReport.ts';
import {
  draftFromRequest,
  isDeviceSupportRequest,
  newReportDraft,
  REPORT_EXPIRED_UNCERTAIN,
  reportErrorMessage,
  reportIsLocked,
  reportRequest,
  reportSubmissionMessage,
  type ReportDeviceOption,
  type ReportDraft,
  type SupportReportViewState,
} from './supportReportModel.ts';

export type SupportReportApi = {
  prepare(request: SupportReportRequest): Promise<SupportReportResponse>;
  get(id: string): Promise<SupportReportResponse>;
  send(id: string): Promise<SupportReportResponse>;
};

/** A page-session draft. Navigation never writes the user's text to settings or browser storage. */
export class SupportReportController {
  private state: SupportReportViewState;
  private operationGeneration = 0;

  constructor(
    private readonly api: SupportReportApi, private readonly render: (state: SupportReportViewState) => void,
  ) {
    this.state = {
      draft: newReportDraft({ kind: 'app', homeId: 'main' }), devices: [], devicesUnavailable: false,
      report: null, recoveryId: null, operation: 'idle', notice: '',
    };
  }

  show(): void { this.render(this.state); }

  setDevices(devices: readonly ReportDeviceOption[], unavailable: boolean): void {
    this.state = { ...this.state, devices, devicesUnavailable: unavailable };
    this.show();
  }

  selectContext(subject: SupportReportSubject, atMs?: number): void {
    if (reportIsLocked(this.state)) {
      this.state = {
        ...this.state, notice: 'Your previous report is still open. Finish it or start another report first.',
      };
    } else {
      const context = newReportDraft(subject, atMs);
      // An unsent description follows the user to the new context; a sent one does not, and
      // neither does one written for the other kind of report (a problem, a device support request).
      const sameKind = isDeviceSupportRequest(this.state.draft.subject) === isDeviceSupportRequest(subject);
      const draft = this.state.report?.submission.state === 'sent' || !sameKind
        ? context : { ...this.state.draft, subject, when: context.when, atMs: context.atMs };
      this.state = { ...this.state, report: null, notice: '', draft };
    }
    this.show();
  }

  edit(draft: ReportDraft): void {
    if (reportIsLocked(this.state)) return;
    this.state = { ...this.state, draft, report: null, notice: '' };
    this.show();
  }

  private accept(response: SupportReportResponse): void {
    if (!response.ok) {
      const { report, draft } = this.state;
      const uncertain = report !== null && ['sending', 'unknown'].includes(report.submission.state);
      // An expired report keeps its incident time, so sending again reads the same activity.
      this.state = { ...this.state, notice: response.code === 'report_expired' && uncertain
        ? REPORT_EXPIRED_UNCERTAIN : reportErrorMessage(response.code),
        ...(response.code === 'report_expired'
          ? { report: null, draft: report ? draftFromRequest(report.document.request) : draft } : {}) };
      return;
    }
    this.state = { ...this.state, report: response.report, notice: reportSubmissionMessage(response.report) };
  }

  /**
   * Prepares the report and sends it in one step. A report that cannot be sent is kept so it can be
   * copied, and stays until a new one is prepared.
   */
  async submit(): Promise<void> {
    if (reportIsLocked(this.state)) return;
    const request = reportRequest(this.state.draft);
    if (!request.problem.trim()) {
      this.state = { ...this.state, notice: isDeviceSupportRequest(request.subject)
        ? 'Describe the device before sending the request.' : 'Describe what happened before sending the report.' };
      this.show();
      return;
    }
    if (!Number.isFinite(request.occurredAtMs) || request.occurredAtMs > Date.now() + 60_000) {
      this.state = { ...this.state, notice: reportErrorMessage('invalid_time') };
      this.show();
      return;
    }
    this.state = { ...this.state, operation: 'sending', notice: 'Sending your report through Homey…' };
    const generation = ++this.operationGeneration;
    this.show();
    try {
      let prepared: SupportReportResponse;
      try {
        prepared = await this.api.prepare(request);
      } catch {
        if (generation === this.operationGeneration) {
          this.state = { ...this.state, notice: reportErrorMessage('capture_failed') };
        }
        return;
      }
      if (generation !== this.operationGeneration) return;
      if (!prepared.ok || prepared.report.availability !== 'available') {
        this.accept(prepared);
        return;
      }
      await this.dispatch(prepared.report, generation);
    } finally { this.finishOperation(generation); }
  }

  private async dispatch(report: PreparedSupportReport, generation: number): Promise<void> {
    this.state = { ...this.state, report: { ...report, submission: { state: 'sending' } } };
    this.show();
    try {
      const response = await this.api.send(report.document.id);
      if (generation !== this.operationGeneration) return;
      // Explicit API refusals occur before dispatch. Keep the prepared report so it can be copied.
      if (!response.ok) this.state = { ...this.state, report };
      this.accept(response);
    } catch {
      if (generation !== this.operationGeneration) return;
      const uncertain = { ...report, submission: { state: 'unknown' as const } };
      this.state = { ...this.state, report: uncertain, notice: reportSubmissionMessage(uncertain) };
    }
  }

  async check(): Promise<void> {
    if (this.state.recoveryId) {
      await this.restore(this.state.recoveryId);
      return;
    }
    const { report } = this.state;
    if (this.state.operation !== 'idle' || !report) return;
    this.state = { ...this.state, operation: 'checking', notice: 'Checking submission…' };
    const generation = ++this.operationGeneration;
    this.show();
    try {
      const response = await this.api.get(report.document.id);
      if (generation === this.operationGeneration) this.accept(response);
    } catch {
      if (generation === this.operationGeneration) {
        this.state = {
          ...this.state, notice: 'Could not check submission. Your report is kept; try Check submission again.',
        };
      }
    } finally { this.finishOperation(generation); }
  }

  async restore(id: string): Promise<void> {
    if (this.state.report?.document.id === id
      || (this.state.recoveryId === id && this.state.operation === 'checking')) return;
    const generation = ++this.operationGeneration;
    this.state = { ...this.state, recoveryId: id, report: null, operation: 'checking', notice: 'Loading your report…' };
    this.show();
    try {
      const response = await this.api.get(id);
      if (generation !== this.operationGeneration) return;
      if (response.ok) {
        this.state = { ...this.state, recoveryId: null, draft: draftFromRequest(response.report.document.request) };
      }
      this.accept(response);
      if (!response.ok && response.code === 'report_expired') {
        this.state = {
          ...this.state,
          notice: 'PELS no longer has this report and cannot tell whether it was sent. '
            + 'If it was not, start another report and describe the problem again.',
        };
      }
    } catch {
      if (generation === this.operationGeneration) {
        this.state = { ...this.state, notice: 'Could not retrieve this report. Use Check submission to try again.' };
      }
    } finally { this.finishOperation(generation); }
  }

  private finishOperation(generation: number): void {
    if (generation !== this.operationGeneration) return;
    this.state = { ...this.state, operation: 'idle' };
    this.show();
  }

  startAnother(): void {
    if (this.state.operation !== 'idle' || this.state.report?.submission.state === 'sending') return;
    this.operationGeneration += 1;
    this.state = {
      ...this.state, draft: newReportDraft(this.state.draft.subject), report: null, recoveryId: null, notice: '',
    };
    this.show();
  }

  /** Reopening the page after a sent report starts a new one; a report still being settled stays. */
  leaveSentReport(): void {
    if (this.state.report?.submission.state === 'sent') this.startAnother();
  }

  notice(message: string): void {
    this.state = { ...this.state, notice: message };
    this.show();
  }
}
