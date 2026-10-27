import { useState } from 'preact/hooks';
import type { ContinuousBatteryPlanConfig, ContinuousBatteryPlanRead } from '../../../../contracts/src/continuousBatteryPlan.ts';
import type { BatteryEnergyPlanPeriod } from '../../../../contracts/src/batteryPlan.ts';
import { parseContinuousBatteryPlanConfig } from '../../../../shared-domain/src/settings/continuousBatteryPlan.ts';
import { formatDayFirstInTimeZone, formatTimeInTimeZone, getDateKeyInTimeZone, shiftDateKey } from '../../../../shared-domain/src/utils/dateUtils.ts';
import { MdFilledButton, MdFilledTextField, MdOutlinedButton, MdSwitch, readSwitchSelected } from './materialWebJSX.tsx';

export type ContinuousBatteryPlanProps = {
  read: ContinuousBatteryPlanRead;
  priceUnit: string;
  timeZone: string;
  blockedReason: string;
  busy: boolean;
  error: string;
  previewAvailable: boolean;
  onSave: (config: ContinuousBatteryPlanConfig) => Promise<boolean>;
  onRefresh: () => Promise<void>;
};

type Draft = { enabled: boolean; capacity: string; reserve: string; efficiency: string; wear: string };
const draftFrom = (config: ContinuousBatteryPlanConfig): Draft => ({
  enabled: config.enabled,
  capacity: String(config.usableCapacityKWh),
  reserve: String(config.minimumReservePercent),
  efficiency: String(Math.round(config.roundTripEfficiency * 100)),
  wear: config.priceUnit === 'price units' ? '0' : String(config.wearCostPerKWh),
});

export const readBatteryPlanDraft = (draft: Draft, priceUnit: string): ContinuousBatteryPlanConfig | null => {
  if ([draft.capacity, draft.reserve, draft.efficiency, draft.wear].some(value => value.trim() === '')) return null;
  const config = {
    enabled: draft.enabled,
    usableCapacityKWh: Number(draft.capacity),
    minimumReservePercent: Number(draft.reserve),
    roundTripEfficiency: Number(draft.efficiency) / 100,
    wearCostPerKWh: Number(draft.wear),
    priceUnit,
  };
  return parseContinuousBatteryPlanConfig(config);
};

type WaitingReason = Extract<ContinuousBatteryPlanRead, { status: 'waiting' }>['reason'];
const WAITING_COPY: Record<WaitingReason, string> = {
  settings_unavailable: 'Battery plan settings could not be read. Try again.',
  battery_unavailable: 'Waiting for the battery’s power and charge level.',
  prices_unavailable: 'Waiting for electricity prices.',
  forecast_unavailable: 'Waiting for a solar forecast.',
  solar_scope_shared: 'Solar production includes another meter area. PELS needs a forecast for the Main home to plan this battery.',
  background_unavailable: 'Waiting for a household consumption forecast.',
  control_unavailable: 'PELS cannot currently control this battery.',
  horizon_infeasible: 'The available power cannot cover this plan. PELS continues normal power-limit control.',
  price_unit_changed: 'The electricity price unit changed. Review the wear allowance and save the battery plan.',
};

const REASON_COPY: Record<BatteryEnergyPlanPeriod['reason'], string> = {
  charge_grid: 'Charge from grid',
  store_solar: 'Store solar',
  supply_house: 'Supply the house',
  hold_energy: 'Keep energy for later',
};

/** Calendar-day labels follow the Homey's zone, including 23/25-hour DST days. */
export const batteryPlanTimeLabel = (timestamp: number, generatedAtMs: number, timeZone: string): string => {
  const date = new Date(timestamp);
  const dateKey = getDateKeyInTimeZone(date, timeZone);
  const todayKey = getDateKeyInTimeZone(new Date(generatedAtMs), timeZone);
  let day = formatDayFirstInTimeZone(date, { weekday: 'short', day: 'numeric', month: 'short' }, timeZone);
  if (dateKey === todayKey) day = 'Today';
  else if (dateKey === shiftDateKey(todayKey, 1)) day = 'Tomorrow';
  const time = formatTimeInTimeZone(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, timeZone);
  return `${day} ${time}`;
};

type PlanWindow = { startsAtMs: number; endsAtMs: number; reason: BatteryEnergyPlanPeriod['reason']; energyAfterKWh: number };

/** Consecutive periods with the same job read as one window; power may vary within it. */
export const batteryPlanWindows = (periods: readonly BatteryEnergyPlanPeriod[]): PlanWindow[] => {
  const windows: PlanWindow[] = [];
  for (const period of periods) {
    const previous = windows.at(-1);
    if (previous && previous.reason === period.reason && previous.endsAtMs === period.startsAtMs) {
      previous.endsAtMs = period.startsAtMs + period.durationMs;
      previous.energyAfterKWh = period.energyAfterKWh;
    } else {
      windows.push({ startsAtMs: period.startsAtMs, endsAtMs: period.startsAtMs + period.durationMs,
        reason: period.reason, energyAfterKWh: period.energyAfterKWh });
    }
  }
  return windows;
};

type BatteryLevelChartProps = {
  periods: readonly BatteryEnergyPlanPeriod[];
  config: ContinuousBatteryPlanConfig;
  generatedAtMs: number;
  timeZone: string;
};

function BatteryLevelChart(props: BatteryLevelChartProps) {
  const first = props.periods[0];
  const last = props.periods.at(-1);
  if (!first || !last) return null;
  const endMs = last.startsAtMs + last.durationMs;
  const duration = endMs - first.startsAtMs;
  const x = (atMs: number) => ((atMs - first.startsAtMs) / duration) * 1000;
  const y = (energy: number) => 100 - (energy / props.config.usableCapacityKWh) * 100;
  const points = [{ atMs: first.startsAtMs, energy: first.energyBeforeKWh }, ...props.periods.map(period => ({
    atMs: period.startsAtMs + period.durationMs, energy: period.energyAfterKWh,
  }))];
  return <figure class="battery-plan-chart">
    <figcaption class="field__hint">Expected battery level</figcaption>
    <div class="battery-plan-chart__plot">
      <div class="battery-plan-chart__axis field__hint" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={`Expected battery level, with a ${props.config.minimumReservePercent}% minimum reserve`}>
        <path class="battery-plan-chart__grid" d="M0 0H1000 M0 50H1000 M0 100H1000" />
        <path class="battery-plan-chart__reserve" d={`M0 ${100 - props.config.minimumReservePercent}H1000`} />
        <polyline class="battery-plan-chart__line" points={points.map(point => `${x(point.atMs)},${y(point.energy)}`).join(' ')} />
      </svg>
      <div class="battery-plan-chart__times field__hint"><span>{batteryPlanTimeLabel(first.startsAtMs, props.generatedAtMs, props.timeZone)}</span><span>{batteryPlanTimeLabel(endMs, props.generatedAtMs, props.timeZone)}</span></div>
    </div>
    <p class="field__hint">Reserve line: {props.config.minimumReservePercent}%. The plan changes with prices, forecasts and actual charge level.</p>
  </figure>;
}

function BatteryPlanPreview(props: Pick<ContinuousBatteryPlanProps, 'read' | 'timeZone'>) {
  const { read, timeZone } = props;
  if (read.status === 'disabled') return <p class="field__hint">Continuous planning is off. PELS still uses the battery for power limits and solar sharing when its controls allow it.</p>;
  if (read.status === 'waiting') return <p class="field__hint" role="status">{WAITING_COPY[read.reason]}</p>;
  const windows = batteryPlanWindows(read.plan.periods);
  const nextCharge = windows.find(window => window.reason === 'charge_grid' || window.reason === 'store_solar');
  const summary = nextCharge
    ? `Planned: ${Math.round(nextCharge.energyAfterKWh / read.config.usableCapacityKWh * 100)}% by ${batteryPlanTimeLabel(nextCharge.endsAtMs, read.generatedAtMs, timeZone)}`
    : 'Keeping stored energy for the periods where it lowers your bill.';
  return <div class="battery-plan-preview">
    <h4 class="pels-text-settings-label">Battery plan</h4><p class="pels-text-status-line">{summary}</p>
    <BatteryLevelChart periods={read.plan.periods} config={read.config} generatedAtMs={read.generatedAtMs} timeZone={timeZone} />
    <ol class="battery-plan-windows">{windows.map(window => <li key={window.startsAtMs}>
      <span class="field__hint">{batteryPlanTimeLabel(window.startsAtMs, read.generatedAtMs, timeZone)} – {batteryPlanTimeLabel(window.endsAtMs, read.generatedAtMs, timeZone)}</span>
      <span>{REASON_COPY[window.reason]}</span>
      <span class="field__hint">Expected {Math.round(window.energyAfterKWh / read.config.usableCapacityKWh * 100)}% charged at the end</span>
    </li>)}</ol>
    <p class="field__hint">Charging shares available power with your devices and smart tasks. Your minimum reserve and power limits still apply.</p>
  </div>;
}

const canSaveBatteryPlan = (config: ContinuousBatteryPlanConfig | null, enableBlocked: boolean, busy: boolean): boolean => (
  !busy && config !== null && (!config.enabled || !enableBlocked)
);

export function ContinuousBatteryPlanView(props: ContinuousBatteryPlanProps) {
  const [form, setForm] = useState(() => ({ savedConfig: props.read.config, draft: draftFrom(props.read.config), dirty: false }));
  // A config snapshot and its edits move together. An after-paint effect that
  // captured a clean form could otherwise overwrite an edit made just after
  // loading. New plan reads update clean forms and preserve dirty drafts.
  let currentForm = form;
  if (form.savedConfig !== props.read.config) {
    currentForm = { savedConfig: props.read.config, draft: form.dirty ? form.draft : draftFrom(props.read.config), dirty: form.dirty };
    setForm(currentForm);
  }
  const { draft, dirty } = currentForm;
  const update = (key: keyof Draft, value: string | boolean) => setForm(current => ({
    ...current, draft: { ...current.draft, [key]: value }, dirty: true,
  }));
  const config = draft.enabled ? readBatteryPlanDraft(draft, props.priceUnit)
    : { ...props.read.config, enabled: false };
  const unitAvailable = props.priceUnit.trim() !== '' && props.priceUnit.trim().toLowerCase() !== 'price units';
  const changedUnit = draft.enabled && unitAvailable && props.read.config.priceUnit !== 'price units'
    && props.read.config.priceUnit.trim().toLowerCase() !== props.priceUnit.trim().toLowerCase();
  const enableBlocked = props.blockedReason !== '' || !unitAvailable;
  const canSave = canSaveBatteryPlan(config, enableBlocked, props.busy);
  const priceUnit = props.priceUnit.toLowerCase().includes('/kwh') ? props.priceUnit : `${props.priceUnit}/kWh`;
  return <div class="continuous-battery-plan">
    <label class="md-switch-row">
      <span class="md-switch-row__content"><span class="md-switch-row__label pels-text-settings-label">Plan charging with PELS</span></span>
      <MdSwitch aria-label="Plan charging with PELS" selected={draft.enabled} disabled={props.busy || (enableBlocked && !draft.enabled)}
        onChange={(event: Event) => update('enabled', readSwitchSelected(event))} />
    </label>
    <p class="field__hint">PELS plans charging and household supply. Your battery’s own schedule resumes when you turn this off. Changes apply when you save.</p>
    {props.blockedReason && <p class="field__hint" role="status">{props.blockedReason}</p>}
    {!unitAvailable && <p class="field__hint" role="status">Waiting for the electricity price unit.</p>}
    {changedUnit && <p class="field__hint" role="status">The electricity price unit changed from {props.read.config.priceUnit} to {props.priceUnit}. Review the wear allowance and save the battery plan.</p>}
    {props.error && <p class="field__hint field__hint--alert" role="alert">{props.error}</p>}
    {draft.enabled && <div class="form-grid battery-plan-fields">
      <MdFilledTextField id="device-detail-battery-plan-capacity" label="Usable capacity (kWh)" type="number" min="0.1" max="500" step="0.1" value={draft.capacity} disabled={props.busy}
        onInput={(event: Event) => update('capacity', (event.currentTarget as HTMLInputElement).value)} />
      <MdFilledTextField id="device-detail-battery-plan-reserve" label="Minimum reserve (%)" type="number" min="0" max="95" step="1" value={draft.reserve} disabled={props.busy}
        onInput={(event: Event) => update('reserve', (event.currentTarget as HTMLInputElement).value)} />
    </div>}
    {draft.enabled && <p class="field__hint">Check usable capacity against your battery’s specification before saving. PELS also respects the battery’s own limits.</p>}
    {draft.enabled && <details class="battery-plan-advanced"><summary>Losses and battery wear</summary>
      <div class="form-grid battery-plan-fields">
        <MdFilledTextField id="device-detail-battery-plan-efficiency" label="Round-trip efficiency (%)" type="number" min="50" max="100" step="1" value={draft.efficiency} disabled={props.busy}
          onInput={(event: Event) => update('efficiency', (event.currentTarget as HTMLInputElement).value)} />
        <MdFilledTextField id="device-detail-battery-plan-wear" label={`Wear allowance (${priceUnit})`} type="number" min="0" max="1000" step="any" value={draft.wear} disabled={props.busy}
          onInput={(event: Event) => update('wear', (event.currentTarget as HTMLInputElement).value)} />
      </div>
      <p class="field__hint">Wear is an allowance per kWh supplied from the battery, in the same units as your electricity prices. 0 ignores battery wear.</p>
    </details>}
    {config === null && <p class="field__hint field__hint--alert" role="alert">Enter capacity from 0.1 to 500 kWh, reserve from 0% to 95%, efficiency from 50% to 100%, and wear from 0 to 1000.</p>}
    <div class="form__actions"><MdFilledButton disabled={!canSave || !dirty} onClick={async () => {
      if (config && await props.onSave(config)) setForm(current => ({ ...current, draft: draftFrom(config), dirty: false }));
    }}>{props.busy ? 'Saving…' : 'Save battery plan'}</MdFilledButton>
      <MdOutlinedButton disabled={props.busy} onClick={props.onRefresh}>Refresh plan</MdOutlinedButton>
    </div>
    <div aria-live="polite">
      {props.previewAvailable ? <BatteryPlanPreview read={props.read} timeZone={props.timeZone} />
        : <p class="field__hint">Refresh plan to load the updated battery plan.</p>}
    </div>
  </div>;
}

export function ContinuousBatteryPlanLoading(props: { failed: boolean; onRetry: () => Promise<void> }) {
  return <div class="continuous-battery-plan"><p class="field__hint" role={props.failed ? 'alert' : 'status'}>{props.failed
    ? 'Battery planning could not be loaded. Try again.' : 'Loading battery plan…'}</p>
    {props.failed && <MdOutlinedButton onClick={props.onRetry}>Try again</MdOutlinedButton>}
  </div>;
}
