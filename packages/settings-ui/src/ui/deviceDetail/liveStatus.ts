// Device-detail hero (2026-07 coherence train PR-5; onto the `.pels-hero`
// primitive 2026-08): the first block under the app bar shows the SAME
// producer-resolved state word + current draw the Overview card renders, so
// the page answers "is PELS seeing this device right now?" before the ~20
// controls below.
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
import {
  isActionSpecificRestoreWaitReasonCode,
  resolveHeldCardReasonLine,
  resolveHeldCardReasonVerb,
  resolveHeldCardStepView,
} from '../../../../shared-domain/src/planCardReasonLine.ts';
import { toSimulationReasonLine } from '../../../../shared-domain/src/simulationReasonMood.ts';
import {
  resolveSteppedEvExceptionLabel,
  resolveSteppedLevelFact,
} from '../../../../shared-domain/src/planSteppedCardText.ts';
import { resolveTemperatureLine } from '../../../../shared-domain/src/planTemperatureCardText.ts';
import { buildDeadlineHref } from '../deadlineUrls.ts';
import {
  isSatisfiedTargetOnlyDevice,
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
} from '../../../../shared-domain/src/planStateLabels.ts';
import { getApiReadModel } from '../homey.ts';
import { resolveDisplayPlanDeviceSnapshot } from '../planLiveData.ts';
import { parsePlanSnapshot } from '../planSnapshotParse.ts';
import { hasActiveDeadlineObjective, state } from '../state.ts';
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
  dev.steppedLoad !== undefined
  || dev.temperature !== undefined
);

// Mirror of the Overview card's power-fact grammar: `Reported … kW` when the
// plan holds the device but the meter still sees draw (the card's conflict
// variant), plain live measured draw, `≈ … kW when active` for the expected
// projection (generic cards only), nothing when no finite figure is known.
const resolvePowerText = (dev: PlanDeviceSnapshot, intentHeld: boolean): string => {
  const drawing = isFiniteKw(dev.currentDrawKw) && dev.currentDrawKw > 0.05;
  if (drawing) {
    // The `Reported` conflict qualifier is the GENERIC card's grammar;
    // temperature/stepped cards render plain measured kW even while held.
    const reportedConflict = intentHeld && !isMeasuredOnlyCard(dev);
    return reportedConflict
      ? `Reported ${formatKw(dev.currentDrawKw)}`
      : formatKw(dev.currentDrawKw);
  }
  if (!isMeasuredOnlyCard(dev)) {
    // Off the stepped cluster: a non-stepped device has no selected step and
    // therefore no planning power, which `undefined` says exactly.
    for (const value of [dev.steppedLoad?.planningPowerKw, dev.expectedPowerKw]) {
      if (isFiniteKw(value) && value > 0.05) return `≈ ${value.toFixed(1)} kW when active`;
    }
  }
  return isFiniteKw(dev.currentDrawKw) ? formatKw(dev.currentDrawKw) : '';
};

const getRow = (): {
  row: HTMLElement;
  stateEl: HTMLElement;
  powerEl: HTMLElement;
  factEl: HTMLElement | null;
  reasonEl: HTMLElement;
  smartTaskEl: HTMLAnchorElement | null;
  chipRowEl: HTMLElement | null;
} | null => {
  const row = document.getElementById('device-detail-live-status');
  const stateEl = document.getElementById('device-detail-live-state');
  const powerEl = document.getElementById('device-detail-live-power');
  const reasonEl = document.getElementById('device-detail-live-reason');
  if (!row || !stateEl || !powerEl || !reasonEl) return null;
  return {
    row,
    stateEl,
    powerEl,
    factEl: document.getElementById('device-detail-live-fact'),
    reasonEl,
    smartTaskEl: document.getElementById('device-detail-live-smart-task') as HTMLAnchorElement | null,
    chipRowEl: document.getElementById('device-detail-live-chip-row'),
  };
};

// One modality fact line, from the same shared producers the Overview cards
// use: temperature devices show measured/target, stepped devices (including EV
// chargers, whose battery and charging state fold in) show the level fact.
const resolveFactText = (dev: PlanDeviceSnapshot): string => {
  if (dev.temperature !== undefined) {
    return resolveTemperatureLine(dev) ?? '';
  }
  if (dev.steppedLoad !== undefined) {
    const exception = resolveSteppedEvExceptionLabel(dev);
    const levelFact = resolveSteppedLevelFact(dev);
    return [exception, levelFact].filter((part): part is string => part !== null).join(' · ');
  }
  return '';
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
    // Through the shared parser, not a cast. This was the ONE plan consumer that
    // skipped `parsePlanSnapshot`, and it reads the facets the parser exists to
    // validate: `resolveTemperatureLine` calls `.toFixed()` on the temperature
    // trio and `resolveSteppedLevelFact` calls `.trim()` on a step id. The
    // realtime push primes the cache with an already-parsed plan, so a malformed
    // payload only reached here on a COLD read — which is exactly why it was
    // intermittent rather than obviously broken.
    plan = parsePlanSnapshot(payload?.plan);
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
  );
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
  // (`not_applicable`) in any exceptional charging state (paused / not
  // charging / discharging / unplugged) is
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
  renderHeroRows({
    mounts, dev, deviceId, kind, intentHeld, reasonCode: grammarParams.reasonCode, nowMs,
  });
};

type HeroStateKind = ReturnType<typeof resolveDisplayStateKind>;

const resolveHeroReasonText = (
  dev: PlanDeviceSnapshot,
  kind: HeroStateKind,
  intentHeld: boolean,
  reasonCode: string | undefined,
): string => {
  // The same reason ladder the Overview card renders — the answer to "why is
  // this Limited?" must not be three disclosures down in the activity log.
  if (shouldDisplayExternalOffReason(kind, reasonCode)) return PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS;
  // Fire on plan INTENT, like the card: under simulation the state word goes
  // factual while the hold still exists, and the "Reported N kW" qualifier
  // needs its explaining line. The mood transform keeps the sentence honest
  // ("Would be … (simulation)"); it is a no-op outside simulation.
  const actionWait = isActionSpecificRestoreWaitReasonCode(reasonCode)
    && (kind === 'active' || kind === 'held' || kind === 'resuming');
  if (intentHeld || actionWait || dev.starvation?.isStarved === true) {
    return toSimulationReasonLine(
      resolveHeldCardReasonLine({
        reason: dev.reason,
        starvation: dev.starvation,
        // `steppedLoad` presence is ladder presence (its `profile` is
        // required) — the same test this module already uses for stepped-ness
        // in `isMeasuredOnlyCard` and the power text.
        verb: resolveHeldCardReasonVerb({
          ...resolveHeldCardStepView(dev),
          currentState: dev.currentState,
        }),
      }),
      state.dryRun,
    );
  }
  return '';
};

const renderHeroRows = (params: {
  mounts: NonNullable<ReturnType<typeof getRow>>;
  dev: PlanDeviceSnapshot;
  deviceId: string;
  kind: HeroStateKind;
  intentHeld: boolean;
  reasonCode: string | undefined;
  nowMs: number;
}): void => {
  const { mounts, dev } = params;
  mounts.stateEl.textContent = displayStateLabel(params.kind);
  mounts.row.dataset.stateKind = params.kind;
  mounts.powerEl.textContent = resolvePowerText(dev, params.intentHeld);
  if (mounts.factEl) {
    const factText = resolveFactText(dev);
    mounts.factEl.textContent = factText;
    mounts.factEl.hidden = factText === '';
  }
  const reasonText = resolveHeroReasonText(dev, params.kind, params.intentHeld, params.reasonCode);
  mounts.reasonEl.textContent = reasonText;
  mounts.reasonEl.hidden = reasonText === '';
  if (mounts.smartTaskEl) {
    const hasTask = hasActiveDeadlineObjective(params.deviceId, params.nowMs);
    mounts.smartTaskEl.hidden = !hasTask;
    // The chip rail collapses with its only chip: an empty visible rail
    // would still occupy a hero grid row and double the gap above the
    // headline.
    if (mounts.chipRowEl) mounts.chipRowEl.hidden = !hasTask;
    if (hasTask) mounts.smartTaskEl.href = buildDeadlineHref(params.deviceId);
  }
  mounts.row.hidden = false;
};

export const hideDeviceDetailLiveStatus = (): void => {
  renderSequence += 1;
  const mounts = getRow();
  if (mounts) mounts.row.hidden = true;
};
