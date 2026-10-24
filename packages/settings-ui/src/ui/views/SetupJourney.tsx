import type { SetupPath } from '../setupPathModel.ts';
import type { SolarSetupAction } from '../setupDevices.ts';
import { AppBar } from './AppBar.tsx';
import {
  MdFilledButton, MdFilledTonalButton, MdTextButton, MdSwitch, readSwitchSelected,
} from './materialWebJSX.tsx';

export type SetupDeviceChoice = {
  id: string;
  name: string;
  managed: boolean;
  disabled: boolean;
  hint: string | null;
  solar: SolarSetupAction | null;
};

export type SetupDeviceChoices =
  | { state: 'loading' | 'unavailable' }
  | { state: 'ready'; devices: readonly SetupDeviceChoice[] };

type SetupDevicePickerProps = {
  choices: SetupDeviceChoices;
  solar: boolean;
  onManaged: (id: string, value: boolean) => void;
  onOpen: (id: string) => void;
  onRetry: () => void;
};

export const SetupDevicePicker = (props: SetupDevicePickerProps) => (
  <div class="setup-journey__devices">
    {props.choices.state === 'loading' && <p>Loading devices…</p>}
    {props.choices.state === 'unavailable' && <>
      <p>Device setup could not be read.</p>
      <MdTextButton type="button" onClick={props.onRetry}>Try again</MdTextButton>
    </>}
    {props.choices.state === 'ready' && props.choices.devices.map((device) => (
      <section class="pels-surface-card setup-journey__device" key={device.id} data-device-id={device.id}>
        <h3 class="plan-card__title">{device.name}</h3>
        <label class="md-switch-row">
          <MdSwitch selected={device.managed} disabled={device.disabled}
            aria-label={`Manage ${device.name}`}
            onChange={(event: Event) => props.onManaged(device.id, readSwitchSelected(event))} />
          <span class="md-switch-row__label pels-text-settings-label">Managed by PELS</span>
        </label>
        {device.hint && <p class="pels-card-supporting">{device.hint}</p>}
        <MdTextButton type="button" onClick={() => props.onOpen(device.id)}>
          {props.solar && device.solar ? device.solar.label : 'Device settings'}
        </MdTextButton>
        {props.solar && device.solar?.hint && <p class="pels-card-supporting">{device.solar.hint}</p>}
      </section>
    ))}
    {props.choices.state === 'ready' && props.choices.devices.length === 0 && (
      <p>No suitable devices found. Check the devices available in Homey.</p>
    )}
  </div>
);

export type SetupJourneyHeaderProps = {
  title: string;
  progress: string;
  detail: string | null;
  busy: boolean;
  canContinue: boolean;
  error: string | null;
  meterHelp: boolean;
  fluviusHelp: boolean;
  continueLabel: string;
  onContinue: () => void;
  onCheckMeter: () => void;
  quarterHourAdvice: boolean;
  onQuarterHour: () => void;
  onDismissQuarterHour: () => void;
  capacityOffAction: boolean;
  onCapacityOff: () => void;
};

export const SetupJourneyHeader = (props: SetupJourneyHeaderProps) => (
  <section class="pels-surface-card setup-journey" aria-label="Setup progress">
    <div class="setup-recommendation-card__header">
      <h3 class="plan-card__title">{props.title}</h3>
      <span class="plan-chip plan-chip--muted">{props.progress}</span>
    </div>
    {props.detail && <p class="pels-card-supporting">{props.detail}</p>}
    {/* Tonal, not text: while it shows, Continue is disabled, so this is the
        step's next action and must not read as a peer of Back to setup. */}
    {props.capacityOffAction && (
      <div class="setup-recommendation-card__actions">
        <MdFilledTonalButton type="button" disabled={props.busy} onClick={props.onCapacityOff}>
          Turn off Capacity limit
        </MdFilledTonalButton>
      </div>
    )}
    {props.quarterHourAdvice && <div>
      <p class="pels-card-supporting">In Flanders? Use the 15-minute average for measured peaks.</p>
      <div class="setup-recommendation-card__actions">
        <MdTextButton type="button" disabled={props.busy} onClick={props.onQuarterHour}>Use 15-minute average</MdTextButton>
        <MdTextButton type="button" disabled={props.busy} onClick={props.onDismissQuarterHour}>Dismiss</MdTextButton>
      </div>
    </div>}
    {props.meterHelp && <MdTextButton type="button" onClick={props.onCheckMeter}>Check meter</MdTextButton>}
    {props.fluviusHelp && <a href="https://www.fluvius.be/nl/meters-en-meterstanden/maak-je-meter-slim" target="_blank" rel="noopener noreferrer">Activate the Fluvius P1 port</a>}
    {props.error && <p role="alert" class="pels-notice-warning">{props.error}</p>}
    <div class="setup-recommendation-card__actions">
      <MdTextButton type="button" data-settings-target="recommendations">Back to setup</MdTextButton>
      <MdFilledButton type="button" disabled={props.busy || !props.canContinue} onClick={props.onContinue}>
        {props.busy ? 'Saving…' : props.continueLabel}
      </MdFilledButton>
    </div>
  </section>
);

export type SetupReviewDevice = { id: string; name: string; control: string; status: string | null };
export type SetupReviewProps = {
  path: SetupPath | null;
  meterSummary: string | null;
  devices: readonly SetupReviewDevice[];
  busy: boolean;
  error: string | null;
  solarPending: boolean;
  onStart: () => void;
  onContinue: () => void;
};

export const SetupReview = (props: SetupReviewProps) => {
  const complete = props.path !== null && props.path.doneCount === props.path.steps.length;
  return (
    <>
      <AppBar title="Review setup" back={{ label: 'Back to setup', target: 'recommendations' }} />
      {props.path === null ? <p>Setup could not be read yet. Return to setup to check your settings.</p> : (
        <section class="pels-surface-card setup-journey">
          <h3 class="plan-card__title">{props.path.simulating ? 'Simulation mode is on' : 'Simulation mode is off'}</h3>
          <dl class="setup-journey__summary">
            {props.path.steps.filter((step) => step.id !== 'devices').map((step) => (
              <div key={step.id}><dt>{step.title}</dt><dd>{step.id === 'power' && step.status === 'done' ? props.meterSummary ?? step.detail : step.detail}</dd></div>
            ))}
          </dl>
          {props.devices.map((device) => (
            <div class="setup-journey__review-device" key={device.id}>
              <strong>{device.name}</strong>
              <p class="pels-card-supporting">{device.control}</p>
              {device.status && <p class="pels-card-supporting">{device.status}</p>}
            </div>
          ))}
          {props.solarPending && <p class="pels-notice-info">Solar control is not configured yet.</p>}
          {props.error && <p role="alert" class="pels-notice-warning">{props.error}</p>}
          <div class="setup-recommendation-card__actions">
            {complete && props.path.simulating && (
              <MdFilledButton type="button" disabled={props.busy} onClick={props.onStart}>
                {props.busy ? 'Starting…' : 'Start managing'}
              </MdFilledButton>
            )}
            {!complete && <MdFilledButton type="button" disabled={props.busy} onClick={props.onContinue}>Continue setup</MdFilledButton>}
            <MdTextButton type="button" data-settings-target="overview" disabled={props.busy}>
              {props.path.simulating ? 'Keep simulating' : 'Open Overview'}
            </MdTextButton>
          </div>
        </section>
      )}
    </>
  );
};
