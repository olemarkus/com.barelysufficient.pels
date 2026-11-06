import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
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
import {
  MdFilledButton, MdFilledSelect, MdFilledTextField, MdOutlinedButton, MdSelectOption, MdTextButton,
} from './materialWebJSX.tsx';

export type SupportReportActions = {
  edit(draft: ReportDraft): void;
  submit(): Promise<void>;
  check(): Promise<void>;
  startAnother(): void;
  notice(message: string): void;
};

export type SupportForumTopic = { url: string; label: string };

/**
 * A support request for a device PELS does not list. `name` is `null` until
 * Homey's device list has been read.
 */
type SupportDevice = { name: string | null };

type SupportReportViewProps = {
  state: SupportReportViewState;
  actions: SupportReportActions;
  homeName: string;
  backTarget: string;
  supportDevice: SupportDevice | null;
  forums: readonly SupportForumTopic[];
};

const DEVELOPER_EMAIL = 'olemarkus@gmail.com';

const ForumLinks = ({ forums }: { forums: readonly SupportForumTopic[] }) => <>
  {forums.map((forum, index) => <span key={forum.url}>
    {index > 0 && ' or the '}
    <a class="support-report__link" href={forum.url} target="_blank" rel="noopener noreferrer">{forum.label}</a>
  </span>)}
</>;

// Homey carries no reply address. Keep the next step the same for every report.
// A forum post matches the report only by its reference, so that path asks for
// it; the email link includes it, so the owner need not copy it there.
const SupportContact = ({ forums, report }: {
  forums: readonly SupportForumTopic[]; report: PreparedSupportReport;
}) => {
  const subject = encodeURIComponent(`PELS: ${report.document.subjectName}`);
  const reference = report.submission.state === 'sent' ? report.submission.reference : '';
  const body = encodeURIComponent(`${report.document.request.problem}\n\nReport reference: ${reference || report.document.id}`);
  return (
    <p class="pels-text-supporting muted">
      To hear back, post in the <ForumLinks forums={forums} /> (preferred) and quote the reference, or email{' '}
      <a class="support-report__link" href={`mailto:${DEVELOPER_EMAIL}?subject=${subject}&body=${body}`}
        target="_blank" rel="noopener noreferrer">{DEVELOPER_EMAIL}</a>.
    </p>
  );
};

const DeviceSupportFields = ({ state, actions, supportDevice }: SupportReportViewProps & {
  supportDevice: SupportDevice;
}) => (
  <>
    <h3 class="entity-name" data-report-device-name>{supportDevice.name ?? 'Selected device'}</h3>
    <MdFilledTextField type="textarea" rows="4" label="Describe the device" required
      value={state.draft.problem} maxlength={SUPPORT_REPORT_PROBLEM_MAX_LENGTH} disabled={reportIsLocked(state)}
      supporting-text="What it is and what PELS should do with it, such as a water heater on a relay to turn off when power is short."
      data-report-field="problem" onInput={(event: Event) => actions.edit({
        ...state.draft, problem: fieldValue(event),
      })} />
  </>
);

const fieldValue = (event: Event): string => (event.currentTarget as HTMLElement & { value: string }).value;

const IncidentFields = ({ state, actions, homeName }: SupportReportViewProps) => {
  const { draft } = state;
  const disabled = reportIsLocked(state);
  const selectedId = draft.subject.kind === 'device' ? draft.subject.deviceId : '';
  const deviceSelect = useRef<HTMLElement & { value: string }>(null);
  useLayoutEffect(() => {
    // Material caches the selected option. Re-select after asynchronous options
    // replace the placeholder so the closed field shows the loaded device name.
    if (deviceSelect.current) deviceSelect.current.value = selectedId ? `device:${selectedId}` : 'app';
  }, [selectedId, state.devices]);
  return (
    <>
      <p class="pels-text-supporting muted">Home: {homeName}</p>
      <MdFilledSelect ref={deviceSelect} label="Affected device" disabled={disabled}
        data-report-field="device" onChange={(event: Event) => {
          const device = state.devices.find((candidate) => `device:${candidate.id}` === fieldValue(event));
          actions.edit({ ...draft, subject: device
            ? { kind: 'device', deviceId: device.id, homeId: device.homeId }
            : { kind: 'app', homeId: draft.subject.homeId } });
        }}>
        <MdSelectOption value="app" displayText="App or several devices" typeaheadText="App or several devices">
          <div slot="headline">App or several devices</div>
        </MdSelectOption>
        {selectedId && !state.devices.some((device) => device.id === selectedId) && (
          <MdSelectOption value={`device:${selectedId}`} displayText="Selected device" typeaheadText="Selected device">
            <div slot="headline">Selected device</div>
          </MdSelectOption>
        )}
        {state.devices.map((device) => (
          <MdSelectOption key={device.id} value={`device:${device.id}`} displayText={device.name} typeaheadText={device.name}>
            <div slot="headline">{device.name}</div>
          </MdSelectOption>
        ))}
      </MdFilledSelect>
      {state.devicesUnavailable && <p class="pels-text-supporting muted">
        Some devices could not be loaded. You can still describe the problem.
      </p>}
      <MdFilledTextField type="textarea" rows="3" label="What happened?" required
        value={draft.problem} maxlength={SUPPORT_REPORT_PROBLEM_MAX_LENGTH} disabled={disabled}
        supporting-text="Include what you noticed."
        data-report-field="problem" onInput={(event: Event) => actions.edit({ ...draft, problem: fieldValue(event) })} />
      <MdFilledTextField type="textarea" rows="2" label="What did you expect?"
        value={draft.expected} maxlength={SUPPORT_REPORT_EXPECTED_MAX_LENGTH} disabled={disabled}
        supporting-text="Optional"
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
        <MdSelectOption value="day"><div slot="headline">From 24 hours before</div></MdSelectOption>
      </MdFilledSelect>
      <p class="pels-text-supporting muted">{draft.historyWindow === 'incident'
        ? 'Includes available activity from one hour before the incident until now, plus the preceding recorded state.'
        : 'Includes available activity from 24 hours before the incident until now, plus the preceding recorded state.'}</p>
    </>
  );
};

const ReportForm = (props: SupportReportViewProps) => {
  const { state, actions, supportDevice } = props;
  return (
    <form class="support-report__form" onSubmit={(event) => {
      event.preventDefault();
      if (event.currentTarget.reportValidity()) void actions.submit();
    }}>
      {supportDevice ? <DeviceSupportFields {...props} supportDevice={supportDevice} /> : <IncidentFields {...props} />}
      {/* Keep feedback beside the action, including on narrow screens. */}
      <ReportNotice state={state} />
      <MdFilledButton type="submit" disabled={reportIsLocked(state)} data-report-action="send">
        {state.operation === 'sending' ? 'Sending…' : supportDevice ? 'Send request' : 'Send report'}
      </MdFilledButton>
      <p class="pels-text-supporting muted">Sent to the PELS developer through Homey, with the app’s logs.</p>
      {/* The owner's switches for reports PELS sends by itself (Settings → Advanced); a
          device support request is not a problem those reports would cover. */}
      {!supportDevice && (
        <>
          <p class="pels-text-supporting muted">PELS can also send reports by itself, daily or when something goes wrong.</p>
          <MdTextButton type="button" class="support-report__cross-link" data-settings-target="advanced"
            data-settings-anchor="#advanced-diagnostics-reports" data-report-action="automatic">
            Automatic reports
          </MdTextButton>
        </>
      )}
    </form>
  );
};

// Shown only when the report cannot be sent, so it can be shared another way.
const ReportCopy = ({ report, actions }: { report: PreparedSupportReport; actions: SupportReportActions }) => {
  const subject = report.document.request.subject.kind === 'device_support' ? 'PELS%20device%20support' : 'PELS%20problem%20report';
  const [manual, setManual] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (manual) textRef.current?.select();
  }, [manual]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(report.message);
      actions.notice('Report copied.');
    } catch {
      setManual(true);
      actions.notice('Select and copy the report text below.');
    }
  };
  return (
    <div class="support-report__copy">
      <p class="pels-text-supporting">Copy the report and email it to the PELS developer at{' '}
        <a class="support-report__link" href={`mailto:${DEVELOPER_EMAIL}?subject=${subject}`}
          target="_blank" rel="noopener noreferrer">
          {DEVELOPER_EMAIL}</a>.
      </p>
      <MdOutlinedButton type="button" onClick={() => { void copy(); }} data-report-action="copy">Copy report</MdOutlinedButton>
      {manual && <textarea ref={textRef} readOnly rows={6} class="support-report__text" aria-label="Report text"
        value={report.message} />}
    </div>
  );
};

const ReportResult = ({ state, actions, backTarget, supportDevice, forums }: SupportReportViewProps) => {
  const { report } = state;
  if (!report) return null;
  const { submission } = report;
  if (submission.state === 'sent') {
    const title = supportDevice ? 'Request sent' : 'Report sent';
    return (
      <section class="support-report__result" aria-label={title}>
        <h3 class="pels-text-section-headline">{title}</h3>
        <p class="support-report__reference">Reference: {submission.reference || report.document.id}</p>
        {supportDevice && <p class="pels-text-supporting">
          Support for a new device usually comes in an app update within 1–2 days, depending on how complex the device is.
        </p>}
        <SupportContact forums={forums} report={report} />
        <MdFilledButton type="button" data-settings-target={backTarget} data-settings-back data-report-action="done">Done</MdFilledButton>
      </section>
    );
  }
  return (
    <section class="support-report__result" aria-label="Submission not confirmed">
      <h3 class="pels-text-section-headline">
        {submission.state === 'sending' ? 'Sending report…' : 'Submission not confirmed'}
      </h3>
      <p class="support-report__reference">PELS reference: {report.document.id}</p>
      <div class="support-report__actions">
        <MdFilledButton type="button" disabled={state.operation !== 'idle'}
          onClick={() => { void actions.check(); }} data-report-action="check">
          {state.operation === 'checking' ? 'Checking…' : 'Check submission'}
        </MdFilledButton>
        {submission.state === 'unknown' && (
          <MdTextButton type="button" disabled={state.operation !== 'idle'}
            onClick={() => actions.startAnother()} data-report-action="new">Start another report</MdTextButton>
        )}
      </div>
    </section>
  );
};

const ReportNotice = ({ state }: { state: SupportReportViewState }) => (
  <p class="pels-text-supporting support-report__notice" role="status" aria-live="polite">{state.notice}</p>
);

const SupportReportView = (props: SupportReportViewProps) => {
  const { report, recoveryId, operation } = props.state;
  const state = report?.submission.state;
  // A send this page started keeps the form until it settles; one restored mid-flight shows its status.
  const settled = state === 'sent' || state === 'unknown' || (state === 'sending' && operation !== 'sending');
  // Any report kept unsent can be copied and shared another way.
  const copyable = report !== null && operation === 'idle' && (state === 'draft' || state === 'failed');
  let stage = recoveryId ? 'recovery' : 'description';
  if (report && settled) stage = `${report.document.id}:${report.submission.state}`;
  const { supportDevice } = props;
  const lede = supportDevice
    ? 'PELS adds what Homey reports about this device: its type, app and capabilities.'
    : 'Describe what happened. PELS adds recent device activity and its current state.';
  return <>
    <AppBar back={{ target: props.backTarget, label: 'Back' }}
      title={supportDevice ? 'Device support' : 'Report a problem'}
      lede={settled || recoveryId ? undefined : lede} />
    <div class="support-report" data-report-stage={stage} tabIndex={-1}>
      {(settled || recoveryId) && <ReportNotice state={props.state} />}
      {!settled && !recoveryId && <ReportForm {...props} />}
      {copyable && <ReportCopy report={report} actions={props.actions} />}
      {settled && <ReportResult {...props} />}
      {recoveryId && operation === 'idle' && <div class="support-report__actions">
        <MdOutlinedButton type="button" onClick={() => { void props.actions.check(); }} data-report-action="check">
          Check submission
        </MdOutlinedButton>
        <MdTextButton type="button" onClick={() => props.actions.startAnother()} data-report-action="new">
          Start another report
        </MdTextButton>
      </div>}
    </div>
  </>;
};

export const renderSupportReportView = (surface: HTMLElement, props: SupportReportViewProps): void => {
  render(<SupportReportView {...props} />, surface);
};
