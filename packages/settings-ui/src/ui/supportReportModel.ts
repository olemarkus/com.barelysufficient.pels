import type {
  PreparedSupportReport,
  SupportReportErrorCode,
  SupportReportSubmission,
  SupportReportRequest,
  SupportReportSubject,
} from '../../../contracts/src/supportReport.ts';

export type ReportDeviceOption = { id: string; name: string; homeId: string };

/** A request for support for a device PELS does not list, rather than a problem report. */
export const isDeviceSupportRequest = (
  subject: SupportReportSubject,
): subject is Extract<SupportReportSubject, { kind: 'device_support' }> => subject.kind === 'device_support';

export type ReportDraft = {
  subject: SupportReportSubject;
  problem: string;
  expected: string;
  when: 'now' | 'custom';
  atMs: number;
  historyWindow: SupportReportRequest['historyWindow'];
};

export type ReportOperation = 'idle' | 'sending' | 'checking';

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

/** A prepared request as an editable draft, kept at its incident time. */
export const draftFromRequest = (request: SupportReportRequest): ReportDraft => ({
  ...newReportDraft(request.subject, request.occurredAtMs),
  problem: request.problem, expected: request.expected, historyWindow: request.historyWindow,
});

export const reportRequest = (draft: ReportDraft): SupportReportRequest => ({
  subject: draft.subject,
  problem: draft.problem,
  expected: draft.expected,
  occurredAtMs: draft.when === 'now' ? Date.now() : draft.atMs,
  historyWindow: draft.historyWindow,
});

/** A sent report is finished; only an operation or an unsettled submission holds the form. */
export const reportIsLocked = (state: SupportReportViewState): boolean => (
  state.operation !== 'idle' || state.recoveryId !== null || (state.report !== null
    && ['sending', 'unknown'].includes(state.report.submission.state))
);

const REPORT_ERRORS: Record<SupportReportErrorCode, string> = {
  invalid_description: 'Describe what happened and keep the text within the displayed limits.',
  invalid_time: 'Choose a valid date and time that is not in the future.',
  invalid_subject: 'Choose an available device or report a problem with the app.',
  invalid_window: 'Choose how much activity to include.',
  report_expired: 'The report expired before it was sent. Your description is kept; send it again.',
  report_too_large: 'The report is too large to send. Choose one device or activity around the incident.',
  report_busy: 'Another report is being sent or was sent a moment ago. Wait a minute, then send yours.',
  consent_required: 'Use Send report to send the report.',
  app_store_required: 'Sending requires an App Store installation. You can copy the report instead.',
  sender_unavailable: 'Homey’s reporting service is unavailable. You can copy the report instead.',
  capture_failed: 'Could not prepare the report. Your description is kept. Try Send report again.',
};

// A device support request has one field and a Send request button, so the
// problem report's advice about devices, activity and Send report does not fit it.
const DEVICE_SUPPORT_ERRORS: Partial<Record<SupportReportErrorCode, string>> = {
  invalid_subject: 'Homey no longer has this device. Go back to Find a device and choose it again.',
  report_too_large:
    'The request is too large to send through Homey. Email the PELS developer instead, and mention the device.',
  capture_failed: 'Could not prepare the request. Your description is kept. Try Send request again.',
};

export const reportErrorMessage = (code: SupportReportErrorCode, subject: SupportReportSubject): string => (
  (isDeviceSupportRequest(subject) ? DEVICE_SUPPORT_ERRORS[code] : undefined) ?? REPORT_ERRORS[code]
);

/** A report whose delivery was uncertain is gone, so nothing can tell any more whether it arrived. */
export const REPORT_EXPIRED_UNCERTAIN = 'PELS no longer has this report, so it cannot tell whether it arrived. '
  + 'Your description is kept; send it again if you think it did not.';

const SUBMISSION_MESSAGES: Record<Exclude<SupportReportSubmission['state'], 'draft'>, string> = {
  sending: 'Sending your report through Homey…',
  sent: '',
  unknown: 'Submission could not be confirmed. It may have arrived. Check submission before sending another report.',
  failed: 'Homey refused the report. Your description is kept; send it again or copy it.',
};

export const reportSubmissionMessage = (report: PreparedSupportReport): string => {
  const { state } = report.submission;
  if (state !== 'draft') return SUBMISSION_MESSAGES[state];
  if (report.availability === 'available') return '';
  return reportErrorMessage(
    report.availability === 'app_store_required' ? 'app_store_required' : 'sender_unavailable',
    report.document.request.subject,
  );
};
