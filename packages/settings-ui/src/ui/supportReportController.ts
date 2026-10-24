import type {
  SupportReportResponse,
  SupportReportRequest,
  SupportReportSubject,
} from '../../../contracts/src/supportReport.ts';
import {
  draftFromRequest,
  newReportDraft,
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
      // An unsent description follows the user to the new context; a sent one does not.
      const draft = this.state.report?.submission.state === 'sent'
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

  editDetails(): void {
    if (reportIsLocked(this.state) || !this.state.report) return;
    this.edit(draftFromRequest(this.state.report.document.request));
  }

  private accept(response: SupportReportResponse): void {
    if (!response.ok) {
      const { report, draft } = this.state;
      // An expired preview keeps its incident time, so another preview reads the same activity.
      this.state = { ...this.state, notice: reportErrorMessage(response.code),
        ...(response.code === 'report_expired'
          ? { report: null, draft: report ? draftFromRequest(report.document.request) : draft } : {}) };
      return;
    }
    this.state = { ...this.state, report: response.report, notice: reportSubmissionMessage(response.report) };
  }

  async prepare(): Promise<void> {
    if (reportIsLocked(this.state)) return;
    const request = reportRequest(this.state.draft);
    if (!request.problem.trim()) {
      this.state = { ...this.state, notice: 'Describe what happened before previewing the report.' };
      this.show();
      return;
    }
    if (!Number.isFinite(request.occurredAtMs) || request.occurredAtMs > Date.now() + 60_000) {
      this.state = { ...this.state, notice: reportErrorMessage('invalid_time') };
      this.show();
      return;
    }
    this.state = { ...this.state, report: null, operation: 'preparing', notice: 'Preparing your report…' };
    const generation = ++this.operationGeneration;
    this.show();
    try {
      const response = await this.api.prepare(request);
      if (generation === this.operationGeneration) this.accept(response);
    } catch {
      if (generation === this.operationGeneration) {
        this.state = { ...this.state, notice: reportErrorMessage('capture_failed') };
      }
    } finally { this.finishOperation(generation); }
  }

  async send(): Promise<void> {
    const { report } = this.state;
    if (this.state.operation !== 'idle' || !report || report.submission.state !== 'draft'
      || report.availability !== 'available') return;
    this.state = { ...this.state, operation: 'sending', notice: 'Sending your report through Homey…',
      report: { ...report, submission: { state: 'sending' } } };
    const generation = ++this.operationGeneration;
    this.show();
    try {
      const response = await this.api.send(report.document.id);
      if (generation !== this.operationGeneration) return;
      // Explicit API rejections occur before dispatch. Retain the reviewed snapshot.
      if (!response.ok) this.state = { ...this.state, report };
      this.accept(response);
    } catch {
      if (generation !== this.operationGeneration) return;
      const uncertain = { ...report, submission: { state: 'unknown' as const } };
      this.state = { ...this.state, report: uncertain, notice: reportSubmissionMessage(uncertain) };
    } finally { this.finishOperation(generation); }
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
          ...this.state, notice: 'This report is no longer available. Start another report to prepare a new preview.',
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

  notice(message: string): void {
    this.state = { ...this.state, notice: message };
    this.show();
  }
}
