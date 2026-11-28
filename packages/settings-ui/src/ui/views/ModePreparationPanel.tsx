import { render } from 'preact';
import type {
  ModePreparationPlan, ModePreparationPlanDevice,
} from '../../../../contracts/src/schedules.ts';
import { formatSmartTaskListDateTime } from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { formatClockTime } from '../../../../shared-domain/src/deferredPlanHistoryShared.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { dispatchOpenDeviceDetail } from '../cardActivation.ts';
import { formatTemperature } from '../deadlinePlanFormatters.ts';
import { buildDeadlineHref } from '../deadlineUrls.ts';
import { MdTextButton } from './materialWebJSX.tsx';

type ReadyPlan = Extract<ModePreparationPlan, { state: 'ready' }> & { timeZone: string };
type ModePreparationPanelState = Exclude<ModePreparationPlan, { state: 'ready' }> | ReadyPlan;

const DAY_FORMAT = (timeZone: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
});

// A start on the day of the mode change needs only its clock time.
const formatStart = (startAtMs: number, plan: ReadyPlan): string => {
  const day = DAY_FORMAT(plan.timeZone);
  const sameDay = day.format(new Date(startAtMs)) === day.format(new Date(plan.atMs));
  return (sameDay ? formatClockTime(startAtMs, plan.timeZone) : null)
    ?? formatSmartTaskListDateTime(startAtMs, plan.timeZone);
};

const statusLine = (device: ModePreparationPlanDevice, plan: ReadyPlan): string => {
  switch (device.state) {
    case 'estimated': return `Starts heating around ${formatStart(device.startAtMs, plan)}`;
    case 'waiting_to_start': return 'Starts heating now';
    case 'preparing': return `Using the ${plan.destinationMode} temperature now`;
    case 'smart_task': return 'Its Smart task comes first';
    case 'override': return 'Its temperature override comes first';
    case 'manual_temperature_hold': return 'Keeps its manual temperature for now';
    case 'unavailable': return 'Waits until PELS can check its Smart tasks';
  }
};

const DeviceRow = ({ device, plan }: { device: ModePreparationPlanDevice; plan: ReadyPlan }) => {
  const name = formatDisplayDeviceName(device.name);
  return (
    <article class="mode-preparation-panel__device">
      <h4 class="pels-text-settings-label">{name}</h4>
      <p class="pels-text-status-line">{statusLine(device, plan)}</p>
      <p class="pels-card-supporting">
        {plan.currentMode} {formatTemperature(device.fromC)} → {plan.destinationMode} {formatTemperature(device.targetC)}
      </p>
      {device.state === 'smart_task' && (
        <MdTextButton href={buildDeadlineHref(device.deviceId)} aria-label={`View Smart task for ${name}`}>
          View Smart task
        </MdTextButton>
      )}
      {device.state === 'override' && (
        <MdTextButton aria-label={`Open ${name}`} onClick={() => dispatchOpenDeviceDetail(device.deviceId, 'top')}>
          Open device
        </MdTextButton>
      )}
    </article>
  );
};

const ReadyBody = ({ plan }: { plan: ReadyPlan }) => (
  <>
    <p>
      {plan.scheduleName} changes the mode from {plan.currentMode} to {plan.destinationMode} at{' '}
      {formatSmartTaskListDateTime(plan.atMs, plan.timeZone)}.
    </p>
    {plan.devices.length === 0 ? (
      <p class="pels-card-supporting">
        No heater needs to start early. A heater starts early when its {plan.destinationMode} temperature
        is higher than its {plan.currentMode} temperature.
      </p>
    ) : (
      <p class="pels-card-supporting">
        Start times are estimates. Power limits and the daily budget still apply.
      </p>
    )}
    {plan.devices.map((device) => <DeviceRow key={device.deviceId} device={device} plan={plan} />)}
    <div>
      <MdTextButton data-open-schedules data-schedule-filter="mode" data-schedule-id={plan.scheduleId}>
        View mode schedule
      </MdTextButton>
    </div>
  </>
);

const ModePreparationPanel = ({ plan }: { plan: ModePreparationPanelState }) => {
  if (plan.state === 'inactive') return null;
  const heading = plan.state === 'ready' ? `Getting ready for ${plan.destinationMode}` : 'Getting ready for a mode';
  return (
    <section class="pels-surface-card mode-preparation-panel" aria-labelledby="mode-preparation-heading">
      <h3 class="pels-text-card-title" id="mode-preparation-heading">{heading}</h3>
      {plan.state === 'ready' ? <ReadyBody plan={plan} /> : <p>{plan.reason}</p>}
    </section>
  );
};

export const renderModePreparationPanel = (surface: HTMLElement, plan: ModePreparationPanelState): void => {
  render(<ModePreparationPanel plan={plan} />, surface);
};
