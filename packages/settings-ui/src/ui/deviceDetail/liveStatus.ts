// Device-detail one-line live status (2026-07 coherence train, PR-5): the
// first content row under the app bar shows the SAME producer-resolved state
// word + current draw the Overview card renders, so the page answers "is
// PELS seeing this device right now?" before the ~20 controls below.
//
// Data source: the plan-snapshot device from the `/ui_plan` API cache (primed
// on every realtime plan push), resolved through the shared card grammar
// (`resolveRawPlanStateKind` + `resolveDisplayStateKind`) so this row and the
// Overview card can never disagree on the state word. Hidden when the plan
// carries no entry for the device (e.g. an unmanaged device opened from the
// Devices list) — no fabricated status.
import {
  SETTINGS_UI_PLAN_PATH,
  type SettingsUiPlanPayload,
} from '../../../../contracts/src/settingsUiApi.ts';
import {
  displayStateLabel,
  resolveDisplayStateKind,
  resolveIntentStateKind,
  resolveRawPlanStateKind,
  shouldDisplayExternalOffReason,
} from '../../../../shared-domain/src/planCardGrammar.ts';
import { resolveSteppedEvExceptionLabel } from '../../../../shared-domain/src/planSteppedCardText.ts';
import {
  isSatisfiedTargetOnlyDevice,
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
} from '../../../../shared-domain/src/planStateLabels.ts';
import { getApiReadModel } from '../homey.ts';
import { resolveDisplayPlanDeviceSnapshot } from '../planLiveData.ts';
import { state } from '../state.ts';
import type { PlanDeviceSnapshot } from '../planTypes.ts';

const isFiniteKw = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const formatKw = (value: number): string => `${value.toFixed(1)} kW`;

// Temperature and stepped Overview cards always show the measured draw (even
// `0.0 kW`); only the generic card substitutes the `≈ … when active`
// projection for a non-drawing device. Mirror that split so this row never
// disagrees with the card for the same plan snapshot.
const isMeasuredOnlyCard = (dev: PlanDeviceSnapshot): boolean => (
  dev.controlModel === 'stepped_load'
  || dev.controlModel === 'temperature_target'
  || typeof dev.plannedTarget === 'number'
);

// Mirror of the Overview card's power-fact grammar: `Reported … kW` when the
// plan holds the device but the meter still sees draw (the card's conflict
// variant), plain live measured draw, `≈ … kW when active` for the expected
// projection (generic cards only), nothing when no finite figure is known.
const resolvePowerText = (dev: PlanDeviceSnapshot, intentHeld: boolean): string => {
  const drawing = isFiniteKw(dev.measuredPowerKw) && dev.measuredPowerKw > 0.05;
  if (drawing) {
    // The `Reported` conflict qualifier is the GENERIC card's grammar;
    // temperature/stepped cards render plain measured kW even while held.
    const reportedConflict = intentHeld && !isMeasuredOnlyCard(dev);
    return reportedConflict
      ? `Reported ${formatKw(dev.measuredPowerKw as number)}`
      : formatKw(dev.measuredPowerKw as number);
  }
  if (!isMeasuredOnlyCard(dev)) {
    for (const value of [dev.planningPowerKw, dev.expectedPowerKw]) {
      if (isFiniteKw(value) && value > 0.05) return `≈ ${value.toFixed(1)} kW when active`;
    }
  }
  return isFiniteKw(dev.measuredPowerKw) ? formatKw(dev.measuredPowerKw) : '';
};

const getRow = (): {
  row: HTMLElement;
  stateEl: HTMLElement;
  powerEl: HTMLElement;
  reasonEl: HTMLElement;
} | null => {
  const row = document.getElementById('device-detail-live-status');
  const stateEl = document.getElementById('device-detail-live-state');
  const powerEl = document.getElementById('device-detail-live-power');
  const reasonEl = document.getElementById('device-detail-live-reason');
  if (!row || !stateEl || !powerEl || !reasonEl) return null;
  return { row, stateEl, powerEl, reasonEl };
};

// Overlapping renders are last-wins: a slow plan read must not overwrite the
// row after the overlay switched device (or a fresher plan landed).
let renderSequence = 0;
export const renderDeviceDetailLiveStatus = async (deviceId: string): Promise<void> => {
  const mounts = getRow();
  if (!mounts) return;
  renderSequence += 1;
  const sequence = renderSequence;
  let dev: PlanDeviceSnapshot | undefined;
  let plan: { devices?: PlanDeviceSnapshot[]; generatedAtMs?: number } | null | undefined;
  try {
    const payload = await getApiReadModel<SettingsUiPlanPayload>(SETTINGS_UI_PLAN_PATH);
    plan = payload?.plan as typeof plan;
    dev = plan?.devices?.find((candidate) => candidate.id === deviceId);
  } catch {
    dev = undefined;
  }
  if (sequence !== renderSequence) return;
  if (!dev) {
    mounts.row.hidden = true;
    return;
  }
  // Same display-time countdown decay the Overview cards apply: an expired
  // restore-cooldown / settling reason must not keep this row on `Resuming`
  // after the card has already dropped it. The decay anchors on the plan's
  // own `generatedAtMs` (resolveSnapshotGeneratedAtMs), so the now-now
  // fallback renderedAtMs only applies to plans without a timestamp.
  const nowMs = Date.now();
  dev = resolveDisplayPlanDeviceSnapshot(
    plan ?? null,
    dev,
    nowMs,
    nowMs,
  ) as PlanDeviceSnapshot;
  const grammarParams = {
    kind: resolveRawPlanStateKind(dev),
    reasonCode: (dev.reason as { code?: string } | undefined)?.code,
    starved: dev.starvation?.isStarved === true,
  };
  let kind = resolveDisplayStateKind({
    ...grammarParams,
    dryRun: state.dryRun,
    currentState: dev.currentState,
    satisfiedTargetOnly: isSatisfiedTargetOnlyDevice(dev),
  });
  // Same demotion the Overview stepped card applies: a target-only EV
  // (`not_applicable`) that is paused / waiting for the car / unplugged is
  // not running — `Running` beside the card's exceptional EV state would
  // contradict across the two surfaces.
  if (
    kind === 'active'
    && dev.currentState === 'not_applicable'
    && resolveSteppedEvExceptionLabel(dev) !== null
  ) {
    kind = 'idle';
  }
  // The reported-load conflict is a fact about the PLAN (intent kind), so it
  // keeps its `Reported` qualifier even under simulation's factual state word
  // — same split the Overview card makes.
  const intentHeld = resolveIntentStateKind(grammarParams) === 'held';
  mounts.stateEl.textContent = displayStateLabel(kind);
  mounts.row.dataset.stateKind = kind;
  mounts.powerEl.textContent = resolvePowerText(dev, intentHeld);
  const externalOff = shouldDisplayExternalOffReason(kind, grammarParams.reasonCode);
  mounts.reasonEl.textContent = externalOff ? PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS : '';
  mounts.reasonEl.hidden = !externalOff;
  mounts.row.hidden = false;
};

export const hideDeviceDetailLiveStatus = (): void => {
  renderSequence += 1;
  const mounts = getRow();
  if (mounts) mounts.row.hidden = true;
};
