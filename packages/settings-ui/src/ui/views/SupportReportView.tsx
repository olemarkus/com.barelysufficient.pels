import { render } from 'preact';
import { useRef } from 'preact/hooks';
import type { PreparedSupportReport } from '../../../../contracts/src/supportReport.ts';
import {
  SUPPORT_REPORT_EXPECTED_MAX_LENGTH,
  SUPPORT_REPORT_PROBLEM_MAX_LENGTH,
} from '../../../../shared-domain/src/supportReport.ts';
import {
  reportIsLocked,
  localReportTime,
  reportTimeZone,
  type ReportDraft,
  type SupportReportViewState,
} from '../supportReportModel.ts';
import { AppBar } from './AppBar.tsx';
import { DeviceLogContent } from './DeviceLogView.tsx';
import {
  MdFilledButton, MdFilledSelect, MdFilledTextField, MdOutlinedButton, MdSelectOption, MdTextButton,
} from './materialWebJSX.tsx';

export type SupportReportActions = {
  edit(draft: ReportDraft): void;
  prepare(): Promise<void>;
  send(): Promise<void>;
  check(): Promise<void>;
  startAnother(): void;
  notice(message: string): void;
};

type SupportReportViewProps = {
  state: SupportReportViewState;
  actions: SupportReportActions;
  homeName: string;
  backTarget: string;
};

const timestamp = (atMs: number): string => new Date(atMs).toLocaleString(undefined, {
  dateStyle: 'medium', timeStyle: 'short',
});

const fieldValue = (event: Event): string => (event.currentTarget as HTMLElement & { value: string }).value;

const ReportForm = ({ state, actions, homeName }: SupportReportViewProps) => {
  const { draft } = state;
  const disabled = reportIsLocked(state);
  const selectedId = draft.subject.kind === 'device' ? draft.subject.deviceId : '';
  return (
    <form class="support-report__form" onSubmit={(event) => {
      event.preventDefault();
      if (event.currentTarget.reportValidity()) void actions.prepare();
    }}>
      <p class="pels-text-supporting muted">Home: {homeName}</p>
      <MdFilledSelect label="What does the problem affect?" value={selectedId} disabled={disabled}
        data-report-field="device" onChange={(event: Event) => {
          const device = state.devices.find((candidate) => candidate.id === fieldValue(event));
          actions.edit({ ...draft, subject: device
            ? { kind: 'device', deviceId: device.id, homeId: device.homeId }
            : { kind: 'app', homeId: draft.subject.homeId } });
        }}>
        <MdSelectOption value=""><div slot="headline">App or several devices</div></MdSelectOption>
        {selectedId && !state.devices.some((device) => device.id === selectedId) && (
          <MdSelectOption value={selectedId}><div slot="headline">Selected device</div></MdSelectOption>
        )}
        {state.devices.map((device) => (
          <MdSelectOption key={device.id} value={device.id}><div slot="headline">{device.name}</div></MdSelectOption>
        ))}
      </MdFilledSelect>
      {state.devicesUnavailable && <p class="pels-text-supporting muted">
        Some devices could not be loaded. You can still describe the problem.
      </p>}
      <MdFilledTextField type="textarea" rows="4" label="What happened?" required
        value={draft.problem} maxlength={SUPPORT_REPORT_PROBLEM_MAX_LENGTH} disabled={disabled}
        supporting-text={`Up to ${SUPPORT_REPORT_PROBLEM_MAX_LENGTH} characters. Include what you noticed.`}
        data-report-field="problem" onInput={(event: Event) => actions.edit({ ...draft, problem: fieldValue(event) })} />
      <MdFilledTextField type="textarea" rows="3" label="What did you expect?"
        value={draft.expected} maxlength={SUPPORT_REPORT_EXPECTED_MAX_LENGTH} disabled={disabled}
        supporting-text={`Optional · up to ${SUPPORT_REPORT_EXPECTED_MAX_LENGTH} characters`}
        data-report-field="expected" onInput={(event: Event) => actions.edit({ ...draft, expected: fieldValue(event) })} />
      <MdFilledSelect label="When did it happen?" value={draft.when} disabled={disabled}
        data-report-field="when" onChange={(event: Event) => actions.edit({
          ...draft, when: fieldValue(event) === 'custom' ? 'custom' : 'now',
        })}>
        <MdSelectOption value="now"><div slot="headline">Now</div></MdSelectOption>
        <MdSelectOption value="custom"><div slot="headline">Choose date and time</div></MdSelectOption>
      </MdFilledSelect>
      {draft.when === 'custom' && (
        <MdFilledTextField type="datetime-local" label="Incident date and time" value={localReportTime(draft.atMs)}
          required step="any" disabled={disabled} supporting-text={`Time zone: ${reportTimeZone()}`}
          data-report-field="time" onInput={(event: Event) => actions.edit({ ...draft, atMs: new Date(fieldValue(event)).getTime() })} />
      )}
      <MdFilledSelect label="Activity to include" value={draft.historyWindow} disabled={disabled}
        data-report-field="history" onChange={(event: Event) => actions.edit({
          ...draft, historyWindow: fieldValue(event) === 'day' ? 'day' : 'incident',
        })}>
        <MdSelectOption value="incident"><div slot="headline">Around the incident</div></MdSelectOption>
        <MdSelectOption value="day"><div slot="headline">Previous 24 hours</div></MdSelectOption>
      </MdFilledSelect>
      <p class="pels-text-supporting muted">{draft.historyWindow === 'incident'
        ? 'Includes available activity one hour before and after the incident, plus the preceding recorded state.'
        : 'Includes available activity in the 24 hours before the incident, plus the preceding recorded state.'}</p>
      <MdOutlinedButton type="submit" disabled={disabled} data-report-action="preview">
        {state.operation === 'preparing' ? 'Preparing…' : 'Preview report'}
      </MdOutlinedButton>
    </form>
  );
};

const ReportActivity = ({ report }: { report: PreparedSupportReport }) => {
  const { activity } = report.document;
  if (activity.state === 'unavailable') return <p class="pels-text-supporting">{activity.reason}</p>;
  return (
    <details class="settings-collapse">
      <summary>Included activity ({activity.entries.length})</summary>
      <div class="support-report__detail">
        <p class="pels-text-supporting muted">
          {timestamp(activity.fromMs)} to {timestamp(activity.toMs)}, plus any preceding recorded state.
          {' '}History keeps up to {activity.retentionDays} days with limits on the number of entries.
        </p>
        {activity.entries.length === 0
          ? <p class="pels-text-supporting muted">No retained activity was found for this incident and time window.</p>
          : <DeviceLogContent state={{ status: 'ready', entries: [...activity.entries], persistence: activity.persistence }}
            formatTimestamp={timestamp} showDeviceNames reportable={false} />}
      </div>
    </details>
  );
};

const ReportPreview = ({ state, actions }: SupportReportViewProps) => {
  const textRef = useRef<HTMLPreElement>(null);
  const { report } = state;
  if (!report) return null;
  const { document: snapshot } = report;
  const submission = report.submission.state;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(report.message);
      actions.notice('Report copied.');
    } catch {
      const element = textRef.current;
      const details = element?.closest('details');
      if (details) details.open = true;
      if (element) {
        element.focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      actions.notice('Select and copy the report text below.');
    }
  };
  return (
    <section class="support-report__preview" aria-label="Report preview">
      <h3 class="pels-text-section-title">Report preview</h3>
      <p class="pels-text-card-title entity-name">{snapshot.subjectName}</p>
      <dl class="support-report__summary">
        <dt class="pels-text-caption muted">Incident</dt><dd>{timestamp(snapshot.request.occurredAtMs)}</dd>
        <dt class="pels-text-caption muted">Current details captured</dt><dd>{timestamp(snapshot.capturedAtMs)}</dd>
      </dl>
      <p class="support-report__description">{snapshot.request.problem}</p>
      {snapshot.request.expected && <p class="support-report__description">
        <strong>Expected:</strong> {snapshot.request.expected}
      </p>}
      <p class="pels-text-supporting muted">Current details describe the system when this preview was prepared.
        {' '}Recorded activity retains its original timestamps.</p>
      <ReportActivity report={report} />
      {snapshot.sections.length > 0 && <p class="pels-text-supporting">
        Also included: {snapshot.sections.map((section) => section.title).join(', ')}.
      </p>}
      {snapshot.omissions.length > 0 && <div class="support-report__omissions">
        <p class="pels-text-supporting">Some details could not be included:</p>
        <ul>{snapshot.omissions.map((omission) => <li key={omission}>{omission}</li>)}</ul>
      </div>}
      <details class="settings-collapse" data-report-details>
        <summary>Report and technical details · {Math.ceil(report.bytes / 1024)} KiB</summary>
        <pre ref={textRef} tabIndex={0} class="support-report__text" aria-label="Report text">{report.message}</pre>
      </details>
      <div class="support-report__actions">
        <MdOutlinedButton type="button" onClick={() => { void copy(); }} data-report-action="copy">Copy report</MdOutlinedButton>
      </div>
      {report.availability !== 'available' && <p class="pels-text-supporting" role="status">
        {report.availability === 'app_store_required'
          ? 'Sending requires an App Store installation. You can copy this report instead.'
          : 'Homey’s reporting service is unavailable. You can copy this report instead.'}
      </p>}
      {submission === 'draft' && <div class="support-report__send">
        <p class="pels-text-supporting">Send shares this report with the PELS developer through Homey.
          {' '}Homey also attaches the app’s logs, which are separate from this preview.</p>
        <MdFilledButton type="button" onClick={() => { void actions.send(); }} data-report-action="send"
          disabled={state.operation !== 'idle' || report.availability !== 'available'}>Send report</MdFilledButton>
      </div>}
      {(submission === 'unknown' || submission === 'sending') && <MdOutlinedButton type="button"
        disabled={state.operation !== 'idle'} onClick={() => { void actions.check(); }} data-report-action="check">
        Check submission
      </MdOutlinedButton>}
      {submission === 'sent' && <p class="pels-text-supporting support-report__reference">
        {report.submission.state === 'sent' && report.submission.reference
          ? `Report reference: ${report.submission.reference}` : `PELS reference: ${snapshot.id}`}
      </p>}
      {submission === 'unknown' && <p class="pels-text-supporting support-report__reference">PELS reference: {snapshot.id}</p>}
      {(submission === 'sent' || submission === 'failed' || submission === 'unknown') && (
        <MdTextButton type="button" disabled={state.operation !== 'idle'}
          onClick={() => actions.startAnother()} data-report-action="new">Start another report</MdTextButton>
      )}
    </section>
  );
};

const SupportReportView = (props: SupportReportViewProps) => (
  <>
    <AppBar back={{ target: props.backTarget, label: 'Back' }} title="Report a problem"
      lede="Describe what happened. PELS adds relevant activity and current details for you to review." />
    <div class="support-report">
      {!props.state.recoveryId && <ReportForm {...props} />}
      <p class="pels-text-supporting support-report__notice" role="status" aria-live="polite">{props.state.notice}</p>
      {props.state.recoveryId && props.state.operation === 'idle' && <div class="support-report__actions">
        <MdOutlinedButton type="button" onClick={() => { void props.actions.check(); }} data-report-action="check">
          Check submission
        </MdOutlinedButton>
        <MdTextButton type="button" onClick={() => props.actions.startAnother()} data-report-action="new">
          Start another report
        </MdTextButton>
      </div>}
      <ReportPreview {...props} />
    </div>
  </>
);

export const renderSupportReportView = (surface: HTMLElement, props: SupportReportViewProps): void => {
  render(<SupportReportView {...props} />, surface);
};
