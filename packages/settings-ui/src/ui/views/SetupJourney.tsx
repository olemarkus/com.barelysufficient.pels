import type { DeviceDetailFocus } from '../cardActivation.ts';
import type { SetupPath } from '../setupPathModel.ts';
import type { SolarSetupAction } from '../setupDevices.ts';
import { useState } from 'preact/hooks';
import type { SetupGoalChoices } from '../setupGoals.ts';
import type { SetupBatteryGoal } from '../setupBatteryPlan.ts';
import { BATTERY_PLAN_ORDER_LINE } from './ContinuousBatteryPlan.tsx';
import { AppBar } from './AppBar.tsx';
import {
  MdFilledButton, MdFilledTextField, MdFilledTonalButton, MdTextButton, MdSwitch, readSwitchSelected,
} from './materialWebJSX.tsx';

export type SetupDeviceChoice = {
  id: string;
  name: string;
  detail: string;
  managed: boolean;
  disabled: boolean;
  hint: string | null;
};

export type SetupDeviceChoices =
  | { state: 'loading' | 'unavailable' }
  | { state: 'ready'; devices: readonly SetupDeviceChoice[] };

type SetupDevicePickerProps = {
  choices: SetupDeviceChoices;
  onManaged: (id: string, value: boolean) => void;
  onOpen: (id: string, focus: DeviceDetailFocus) => void;
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
        <p class="pels-card-supporting">{device.detail}</p>
        <label class="md-switch-row">
          <MdSwitch selected={device.managed} disabled={device.disabled}
            aria-label={`Manage ${device.name}`}
            onChange={(event: Event) => props.onManaged(device.id, readSwitchSelected(event))} />
          <span class="md-switch-row__label pels-text-settings-label">Managed by PELS</span>
        </label>
        {device.hint && <p class="pels-card-supporting">{device.hint}</p>}
        <MdTextButton type="button" onClick={() => props.onOpen(device.id, 'top')}>Device settings</MdTextButton>
      </section>
    ))}
    {props.choices.state === 'ready' && props.choices.devices.length === 0 && (
      <p>No suitable devices found. Check the devices available in Homey.</p>
    )}
  </div>
);

type SetupGoalPickerProps = {
  choices: SetupGoalChoices;
  busy: boolean;
  onPrice: (id: string, enabled: boolean) => void;
  onNewSmartTask: (id: string) => void;
  onOpenSmartTask: (id: string) => void;
  /** Turn a battery's plan on with this usable capacity (kWh), or off (`null`). */
  onBatteryPlan: (id: string, enabled: boolean, capacityKWh: number | null) => Promise<void>;
  onOpen: (id: string, focus: DeviceDetailFocus) => void;
  onRetry: () => void;
};

type SolarGoalProps = {
  id: string;
  name: string;
  solar: SolarSetupAction;
  onOpen: (id: string, focus: DeviceDetailFocus) => void;
};

const SolarGoal = ({ id, name, solar, onOpen }: SolarGoalProps) => <>
  <MdTextButton type="button" aria-label={`${solar.actionLabel} for ${name}`} onClick={() => onOpen(id, solar.focus)}>
    {solar.actionLabel}
  </MdTextButton>
  {solar.hint && <p class="pels-card-supporting">{solar.hint}</p>}
</>;

// The same bounds as the battery page's capacity field and the setting's parser.
const parseCapacity = (value: string): number | null => {
  const capacity = Number(value);
  return value.trim() !== '' && Number.isFinite(capacity) && capacity >= 0.1 && capacity <= 500 ? capacity : null;
};

const formatCapacity = (kWh: number): string => `${Number(kWh.toFixed(2))} kWh`;

type BatteryGoalProps = {
  id: string;
  name: string;
  goal: Extract<SetupBatteryGoal, { state: 'ready' }>;
  busy: boolean;
  onBatteryPlan: SetupGoalPickerProps['onBatteryPlan'];
  onOpen: SetupGoalPickerProps['onOpen'];
};

/**
 * Plan charging with PELS, as the battery's device page names it. The plan
 * needs the battery's usable capacity, so the switch waits for one: a saved
 * capacity fills the field, and a battery never saved starts empty rather than
 * on a size PELS would only be guessing.
 */
const BatteryGoal = ({ id, name, goal, busy, onBatteryPlan, onOpen }: BatteryGoalProps) => {
  const [draft, setDraft] = useState(goal.capacityKWh === null ? '' : String(goal.capacityKWh));
  const [error, setError] = useState<string | null>(null);
  const capacity = parseCapacity(draft);
  const invalid = draft.trim() !== '' && capacity === null;
  return <>
    <label class="md-switch-row">
      {/* Material owns the checkbox state. Remount after a failed save so its
          native checkbox also returns to the unchanged accepted value. */}
      <MdSwitch key={error ?? 'saved'} selected={goal.enabled} disabled={busy || (!goal.enabled && capacity === null)}
        aria-label={`Plan charging with PELS for ${name}`}
        onChange={(event: Event) => {
          const enabled = readSwitchSelected(event);
          setError(null);
          void onBatteryPlan(id, enabled, enabled ? capacity : null).catch((caught: unknown) => {
            setError(caught instanceof Error && caught.message ? caught.message : 'Battery plan could not be saved. Try again.');
          });
        }} />
      <span class="md-switch-row__label pels-text-settings-label">Plan charging with PELS</span>
    </label>
    <p class="pels-card-supporting">
      PELS plans charging and household supply around your prices and solar. The battery’s own schedule
      resumes when you turn this off.
    </p>
    {!goal.enabled && (
      <MdFilledTextField class="setup-journey__battery-capacity" label="Usable capacity (kWh)" type="number"
        inputmode="decimal" min="0.1" max="500" step="0.1" value={draft} disabled={busy}
        aria-label={`Usable capacity of ${name} in kWh`}
        {...(invalid ? { error: true, 'error-text': 'Enter 0.1 to 500 kWh.' } : {})}
        supporting-text="From your battery’s specification. PELS needs it to plan."
        onInput={(event: Event) => setDraft((event.currentTarget as HTMLInputElement).value)} />
    )}
    {goal.enabled && goal.othersPlanned && <p class="pels-card-supporting">{BATTERY_PLAN_ORDER_LINE}</p>}
    {goal.enabled && goal.capacityKWh !== null && (
      <p class="pels-card-supporting">
        {`Planned for ${formatCapacity(goal.capacityKWh)} usable capacity.`}
        {goal.simulating ? ' The plan runs once you start managing.' : ''}
      </p>
    )}
    {error && <p role="alert" class="pels-notice-warning">{error}</p>}
    {error && <MdTextButton type="button" data-settings-target="electricity-prices" data-setup-journey="prices">Electricity prices</MdTextButton>}
    <MdTextButton type="button" aria-label={`Device settings for ${name}`} onClick={() => onOpen(id, 'top')}>
      Device settings
    </MdTextButton>
  </>;
};

const BatteryGoalState = ({ id, name, goal, busy, onBatteryPlan, onOpen }: Omit<BatteryGoalProps, 'goal'> & {
  goal: SetupBatteryGoal;
}) => {
  if (goal.state === 'ready') {
    // Keyed by the saved capacity, so a capacity that arrives or changes refills the field.
    return <BatteryGoal key={`${id}:${goal.capacityKWh ?? ''}`} id={id} name={name} goal={goal} busy={busy}
      onBatteryPlan={onBatteryPlan} onOpen={onOpen} />;
  }
  if (goal.state === 'loading') return <p class="pels-card-supporting">Loading battery plan…</p>;
  return <>
    <p class="pels-card-supporting">
      {goal.state === 'blocked' ? goal.reason : 'Battery plan settings could not be read.'}
    </p>
    <MdTextButton type="button" aria-label={`Device settings for ${name}`} onClick={() => onOpen(id, 'top')}>
      Device settings
    </MdTextButton>
  </>;
};

export const SetupGoalPicker = (props: SetupGoalPickerProps) => (
  <div class="setup-journey__devices">
    {props.choices.state === 'loading' && <p>Loading devices…</p>}
    {props.choices.state === 'unavailable' && <>
      <p>Device setup could not be read.</p>
      <MdTextButton type="button" onClick={props.onRetry}>Try again</MdTextButton>
    </>}
    {props.choices.state === 'ready' && props.choices.devices.map((device) => (
      <section class="pels-surface-card setup-journey__device" key={device.id} data-device-id={device.id}>
        <h3 class="plan-card__title">{device.name}</h3>
        {device.price && <>
          <label class="md-switch-row">
            <MdSwitch selected={device.price.enabled} disabled={props.busy}
              aria-label={`Price-based control for ${device.name}`}
              onChange={(event: Event) => props.onPrice(device.id, readSwitchSelected(event))} />
            <span class="md-switch-row__label pels-text-settings-label">Price-based control</span>
          </label>
          <p class="pels-card-supporting">Raises the temperature a little in cheap hours and lowers it in expensive ones.</p>
        </>}
        {device.smartTask?.state === 'none' && <>
          <p class="pels-card-supporting">{device.smartTask.charger
            ? 'A smart task charges to the level you set by a ready-by time, in the cheapest hours.'
            : 'A smart task reaches the goal you set by a ready-by time, in the cheapest hours.'}</p>
          <MdTextButton type="button" disabled={props.busy} aria-label={`New smart task for ${device.name}`}
            onClick={() => props.onNewSmartTask(device.id)}>
            New smart task
          </MdTextButton>
        </>}
        {device.smartTask?.state === 'open' && <>
          <p class="pels-card-supporting">{device.smartTask.summary}</p>
          <MdTextButton type="button" aria-label={`View the smart task for ${device.name}`}
            onClick={() => props.onOpenSmartTask(device.id)}>View task</MdTextButton>
        </>}
        {device.solar && <SolarGoal id={device.id} name={device.name} solar={device.solar} onOpen={props.onOpen} />}
        {device.battery && <BatteryGoalState id={device.id} name={device.name} goal={device.battery} busy={props.busy}
          onBatteryPlan={props.onBatteryPlan} onOpen={props.onOpen} />}
      </section>
    ))}
  </div>
);

export type SetupJourneyHeaderProps = {
  title: string;
  /** The required steps done; `null` on the optional page, which is not one of them. */
  progress: string | null;
  detail: string | null;
  busy: boolean;
  canContinue: boolean;
  error: string | null;
  meterHelp: boolean;
  fluviusHelp: boolean;
  continueLabel: string;
  /** `false` on `Choose what PELS does` once setup is finished: there is no journey to go back to or on with. */
  journeyActions: boolean;
  onContinue: () => void;
  onCheckMeter: () => void;
  quarterHourAdvice: boolean;
  onQuarterHour: () => void;
  onDismissQuarterHour: () => void;
  capacityOffAction: boolean;
  onCapacityOff: () => void;
  /** The setup step still open when the simulation banner sent someone here; `null` hides the way out. */
  simulationExitStep: string | null;
  onOpenSimulation: () => void;
};

export const SetupJourneyHeader = (props: SetupJourneyHeaderProps) => (
  <section class="pels-surface-card setup-journey" aria-label="Setup progress">
    <div class="setup-recommendation-card__header">
      <h3 class="plan-card__title">{props.title}</h3>
      {props.progress !== null && <span class="plan-chip plan-chip--muted">{props.progress}</span>}
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
    {props.simulationExitStep !== null && <div>
      <p class="pels-card-supporting">Continue setup with {props.simulationExitStep} before you start managing, or turn off simulation now.</p>
      <div class="setup-recommendation-card__actions">
        <MdTextButton type="button" onClick={props.onOpenSimulation}>Open Simulation mode</MdTextButton>
      </div>
    </div>}
    {props.error && <p role="alert" class="pels-notice-warning">{props.error}</p>}
    {props.journeyActions && <div class="setup-recommendation-card__actions">
      <MdTextButton type="button" data-settings-target="recommendations">Back to setup</MdTextButton>
      <MdFilledButton type="button" disabled={props.busy || !props.canContinue} onClick={props.onContinue}>
        {props.busy ? 'Saving…' : props.continueLabel}
      </MdFilledButton>
    </div>}
  </section>
);

export type SetupReviewDevice = { id: string; name: string; control: string; status: string | null };
export type SetupReviewProps = {
  path: SetupPath | null;
  meterSummary: string | null;
  devices: readonly SetupReviewDevice[];
  busy: boolean;
  error: string | null;
  solarNote: string | null;
  onStart: () => void;
  onContinue: () => void;
  /** Back to `Choose what PELS does`, while it has something to offer; `null` hides the link. */
  onChooseGoals: (() => void) | null;
};

export const SetupReview = (props: SetupReviewProps) => {
  const complete = props.path !== null && props.path.doneCount === props.path.steps.length;
  return (
    <>
      <AppBar title="Review setup" back={{ label: 'Back to setup', target: 'recommendations' }} />
      {props.path === null ? <p>Setup could not be read yet. Return to setup to check your settings.</p> : (
        <section class="pels-surface-card setup-journey">
          <h3 class="plan-card__title">{props.path.simulating ? 'Simulation mode is on' : 'Simulation mode is off'}</h3>
          {props.path.simulating && <p class="pels-card-supporting">
            PELS shows what it would do without changing your devices. Start managing lets it act on the controls you set.
          </p>}
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
          {props.onChooseGoals && (
            <div class="setup-recommendation-card__actions">
              <MdTextButton type="button" disabled={props.busy} onClick={props.onChooseGoals}>Choose what PELS does</MdTextButton>
            </div>
          )}
          {props.solarNote && <p class="pels-notice-info">{props.solarNote}</p>}
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
