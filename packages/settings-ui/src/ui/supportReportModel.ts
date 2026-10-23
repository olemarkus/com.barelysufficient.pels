import type {
  PreparedSupportReport,
  SupportReportErrorCode,
  SupportReportRequest,
  SupportReportSubject,
} from '../../../contracts/src/supportReport.ts';

export type ReportDeviceOption = { id: string; name: string; homeId: string };

export type ReportDraft = {
  subject: SupportReportSubject;
  problem: string;
  expected: string;
  when: 'now' | 'custom';
  atMs: number;
  historyWindow: SupportReportRequest['historyWindow'];
};

export type ReportOperation = 'idle' | 'preparing' | 'sending' | 'checking';

export type SupportReportViewState = {
  draft: ReportDraft;
  devices: readonly ReportDeviceOption[];
  devicesUnavailable: boolean;
  report: PreparedSupportReport | null;
  recoveryId: string | null;
  operation: ReportOperation;
  notice: string;
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** datetime-local uses the browser's timezone, which the form names explicitly. */
export const localReportTime = (atMs: number): string => {
  if (!Number.isFinite(atMs)) return '';
  const at = new Date(atMs);
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  return `${date}T${time}.${String(at.getMilliseconds()).padStart(3, '0')}`;
};

export const reportTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const newReportDraft = (subject: SupportReportSubject, atMs?: number): ReportDraft => ({
  subject, problem: '', expected: '', when: atMs === undefined ? 'now' : 'custom',
  atMs: atMs ?? Date.now(), historyWindow: 'incident',
});

export const reportRequest = (draft: ReportDraft): SupportReportRequest => ({
  subject: draft.subject,
  problem: draft.problem,
  expected: draft.expected,
  occurredAtMs: draft.when === 'now' ? Date.now() : draft.atMs,
  historyWindow: draft.historyWindow,
});

export const reportIsLocked = (state: SupportReportViewState): boolean => (
  state.operation !== 'idle' || state.recoveryId !== null || (state.report !== null
    && ['sending', 'unknown', 'sent'].includes(state.report.submission.state))
);

const REPORT_ERRORS: Record<SupportReportErrorCode, string> = {
  invalid_description: 'Describe what happened and keep the text within the displayed limits.',
  invalid_time: 'Choose a valid date and time that is not in the future.',
  invalid_subject: 'Choose an available device or report a problem with the app.',
  invalid_window: 'Choose how much activity to include.',
  report_expired: 'This preview has expired. Your description is kept; preview it again to capture current details.',
  report_too_large: 'The report is too large to prepare. Choose one device or activity around the incident.',
  report_busy: 'A report is being sent or was just sent. Wait a moment before trying again.',
  consent_required: 'Use Send report after reviewing the preview.',
  app_store_required: 'Sending requires an App Store installation. You can copy the report instead.',
  sender_unavailable: 'Homey’s reporting service is unavailable. You can copy the report instead.',
  capture_failed: 'Could not prepare the report. Your description is kept. Try Preview report again.',
};

export const reportErrorMessage = (code: SupportReportErrorCode): string => REPORT_ERRORS[code];

export const reportSubmissionMessage = (report: PreparedSupportReport): string => {
  switch (report.submission.state) {
    case 'draft': return 'Your report is ready to review.';
    case 'sending': return 'Sending your report through Homey…';
    case 'sent': return 'Homey accepted your report.';
    case 'unknown':
      return 'Submission could not be confirmed. It may have arrived. Check submission before sending another report.';
    case 'failed': return 'The report was not sent. Your description is kept. Preview again to try another submission.';
    default: return '';
  }
};
