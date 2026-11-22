import { render } from 'preact';
import type {
  ModePreparationPlan, ModePreparationPlanDevice,
} from '../../../../contracts/src/schedules.ts';
import { formatSmartTaskListDateTime } from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { formatTemperature } from '../deadlinePlanFormatters.ts';
import { buildDeadlineHref } from '../deadlineUrls.ts';
import { MdTextButton } from './materialWebJSX.tsx';

type ModePreparationPanelState = Exclude<ModePreparationPlan, { state: 'ready' }>
  | (Extract<ModePreparationPlan, { state: 'ready' }> & { timeZone: string });

const STATUS_LINES = {
  waiting_to_start: 'Waiting to apply the early target',
  preparing: 'Early target planned',
  smart_task: 'Smart task currently takes precedence',
  override: 'Temperature override currently takes precedence',
  unavailable: 'Preparation status unavailable',
} as const;

const DeviceRow = ({ device, timeZone }: { device: ModePreparationPlanDevice; timeZone: string }) => {
  const name = formatDisplayDeviceName(device.name);
  const status = device.state === 'estimated'
    ? `Estimated early target from ${formatSmartTaskListDateTime(device.startAtMs, timeZone)}`
    : STATUS_LINES[device.state];
  return (
    <article class="mode-preparation-panel__device">
      <h4 class="pels-text-card-title">{name}</h4>
      <p class="pels-card-supporting">
        Mode target from {formatTemperature(device.fromC)} to {formatTemperature(device.targetC)}
      </p>
      <p>{status}</p>
      {device.state === 'smart_task' && (
        <MdTextButton href={buildDeadlineHref(device.deviceId)} aria-label={`View Smart task for ${name}`}>
          View Smart task
        </MdTextButton>
      )}
    </article>
  );
};

const ModePreparationPanel = ({ plan }: { plan: ModePreparationPanelState }) => {
  if (plan.state === 'inactive') return null;
  return (
    <section class="pels-surface-card mode-preparation-panel" aria-labelledby="mode-preparation-heading">
      <h3 class="pels-text-section-headline" id="mode-preparation-heading">Mode preparation</h3>
      {plan.state !== 'ready' ? <p>{plan.reason}</p> : (
        <>
          <p class="pels-text-card-title">{plan.scheduleName}</p>
          <p>{plan.currentMode} to {plan.destinationMode} · {formatSmartTaskListDateTime(plan.atMs, plan.timeZone)}</p>
          <p class="pels-card-supporting">
            Early target times are estimates. Power limits and the daily budget still apply.
          </p>
          {plan.devices.length === 0 && <p>No heating devices need an early target for this change.</p>}
          {plan.devices.map((device) => <DeviceRow key={device.deviceId} device={device} timeZone={plan.timeZone} />)}
          <div>
            <MdTextButton data-open-schedules data-schedule-filter="mode" data-schedule-id={plan.scheduleId}>
              View mode schedule
            </MdTextButton>
          </div>
        </>
      )}
    </section>
  );
};

export const renderModePreparationPanel = (surface: HTMLElement, plan: ModePreparationPanelState): void => {
  render(<ModePreparationPanel plan={plan} />, surface);
};
