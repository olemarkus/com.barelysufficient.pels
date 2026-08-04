import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import {
  formatStepDisplayLabel,
  resolveSteppedActiveStepId,
  resolveSteppedEvExceptionLabel,
  resolveSteppedLevelFact,
  resolveSteppedPowerText,
  resolveSteppedStatusLine,
  resolveSteppedTemperatureText,
} from '../../../../shared-domain/src/planSteppedCardText.ts';
import {
  PLAN_STATE_HELD_FALLBACK_STATUS,
} from '../../../../shared-domain/src/planStateLabels.ts';
import {
  displayStateLabel,
  isDimmedDisplayStateKind,
  resolveDisplayStateKind,
  resolveIntentStateKind,
  resolveRawPlanStateKind,
  type PlanDisplayStateKind,
} from '../../../../shared-domain/src/planCardGrammar.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { toSimulationReasonLine } from '../../../../shared-domain/src/simulationReasonMood.ts';
import { resolveDisplayPlanDeviceSnapshot } from '../planLiveData.ts';
import { cardActivationProps } from '../cardActivation.ts';
import { DeadlineChip, PlanCardStatusChipView } from './PlanDeviceCards.tsx';
import type { PlanDeviceSnapshot, PlanSnapshot } from '../planTypes.ts';
import type { SteppedLoadProfile } from '../../../../contracts/src/types.ts';

// Display state kind under the shared card grammar: hold/wait reasons upgrade
// `idle` to `held`; simulation collapses PELS-acted kinds to the factual
// device state (see `planCardGrammar.ts`).
//
// Target-only EV nuance: a `not_applicable` currentState resolves `active`
// under a keep plan, but an EV in any exceptional charging state (paused /
// not charging / discharging / unplugged) is not delivering the planned
// charge — asserting `Running` beside a "Paused" reason would contradict on
// one card. When an exceptional EV state exists, the active word demotes to
// `Idle` (the reason slot names the specific state).
const resolveStateKind = (dev: PlanDeviceSnapshot, dryRun: boolean): PlanDisplayStateKind => {
  const kind = resolveDisplayStateKind({
    kind: resolveRawPlanStateKind(dev),
    dryRun,
    currentState: dev.currentState,
    reasonCode: (dev.reason as { code?: string } | undefined)?.code,
    starved: dev.starvation?.isStarved === true,
  });
  if (
    kind === 'active'
    && dev.currentState === 'not_applicable'
    && resolveSteppedEvExceptionLabel(dev) !== null
  ) {
    return 'idle';
  }
  return kind;
};

// ─── Step rail ────────────────────────────────────────────────────────────────

const StepRail = ({ dev, profile }: { dev: PlanDeviceSnapshot; profile: SteppedLoadProfile }) => {
  const activeStepId = resolveSteppedActiveStepId(dev, profile);

  const hasExplicitOff = profile.steps.some((s) => s.id.toLowerCase() === 'off');
  const hasBinaryOff = dev.currentState !== 'not_applicable';
  const steps = hasExplicitOff || !hasBinaryOff
    ? profile.steps
    : [{ id: 'off', planningPowerW: 0 }, ...profile.steps];
  const n = steps.length;
  const normActive = activeStepId?.toLowerCase() ?? null;
  const activeIdx = normActive === null ? -1 : steps.findIndex((s) => s.id.toLowerCase() === normActive);
  const hasPosition = n > 1 && activeIdx >= 0;
  const filledPct = hasPosition ? (activeIdx / (n - 1)) * 100 : 0;

  // Non-interactive level indicator: a thin segmented track whose fill reaches
  // the current step. No thumb or stop dots (those read as a draggable slider),
  // and only the endpoint labels render at every width — the same calm
  // treatment the 320px variant already used. The number of discrete steps is
  // expressed by the track's segment ticks, driven by `--step-count`.
  return (
    <div class="plan-card__step-rail">
      <div class="plan-card__step-labels">
        <span class="plan-card__step-label metric-label plan-card__step-label--start">
          {formatStepDisplayLabel(steps[0]?.id ?? '')}
        </span>
        {n > 1 && (
          <span class="plan-card__step-label metric-label plan-card__step-label--end">
            {formatStepDisplayLabel(steps[n - 1]?.id ?? '')}
          </span>
        )}
      </div>
      <div
        class="plan-card__step-track"
        role="img"
        aria-label={`Level ${activeIdx < 0 ? 'unknown' : activeIdx + 1} of ${n}`}
        style={{ '--step-count': n }}
      >
        <div
          class="plan-card__step-filled"
          {...(hasPosition ? { 'data-position': 'true' } : {})}
          style={{ width: `${filledPct}%` }}
        />
      </div>
    </div>
  );
};

// ─── PlanSteppedCard component ────────────────────────────────────────────────

export const PlanSteppedCard = ({
  dev,
  plan,
  dryRun,
  renderedAtMs,
  nowMs,
}: {
  dev: PlanDeviceSnapshot;
  plan: PlanSnapshot | null;
  dryRun: boolean;
  renderedAtMs: number;
  nowMs: number;
}) => {
  const displayDev = resolveDisplayPlanDeviceSnapshot(plan, dev, renderedAtMs, nowMs) as PlanDeviceSnapshot;
  const stateKind = resolveStateKind(displayDev, dryRun);
  // Plan-INTENT kind for the held-fallback reason: it must keep firing under
  // simulation, where only the state word goes factual.
  const intentKind = resolveIntentStateKind({
    kind: resolveRawPlanStateKind(displayDev),
    reasonCode: (displayDev.reason as { code?: string } | undefined)?.code,
    starved: displayDev.starvation?.isStarved === true,
  });
  const profile = displayDev.steppedLoad?.profile;

  const powerText = resolveSteppedPowerText(displayDev);
  // One modality fact line: temperature (for a temp-reporting stepped device
  // like a water heater) wins over the level text — the rail below still
  // carries the level position either way.
  const factText = resolveSteppedTemperatureText(displayDev)
    ?? resolveSteppedLevelFact(displayDev);
  const resolvedStatusText = profile
    ? resolveSteppedStatusLine(displayDev, profile, nowMs, dryRun)
    : null;
  const factualStatusText = resolvedStatusText ?? (intentKind === 'held' ? PLAN_STATE_HELD_FALLBACK_STATUS : null);
  // One reason line: the status pipeline wins; an exceptional EV state
  // (Paused / Not charging / Waiting for car / Discharging / Unplugged)
  // fills the slot only
  // when no status renders. In simulation the held/limited status reads
  // hypothetically (no-op outside simulation / for non-acted lines); the EV
  // state is a device observation and stays factual either way.
  const singleReason = factualStatusText ?? resolveSteppedEvExceptionLabel(displayDev);
  const statusText = singleReason === null ? null : toSimulationReasonLine(singleReason, dryRun);

  const cardClasses = [
    'pels-surface-card device-row plan-card plan-card--stepped clickable',
    isDimmedDisplayStateKind(stateKind) ? 'plan-card--dim' : '',
  ].filter(Boolean).join(' ');
  const displayName = formatDisplayDeviceName(dev.name);

  return (
    <article
      class={cardClasses}
      data-device-id={dev.id}
      data-state-kind={stateKind}
      tabIndex={0}
      role="button"
      aria-label={`Open device details for ${displayName}`}
      {...cardActivationProps(dev.id)}
    >
      <MdElevation aria-hidden="true" />
      <MdRipple aria-hidden="true" />

      <div class="plan-card__header">
        <div class="plan-card__title-wrap">
          <h3 class="plan-card__title">{displayName}</h3>
        </div>
        <div class="plan-card__chips">
          <PlanCardStatusChipView dev={displayDev} displayKind={stateKind} dryRun={dryRun} />
          <DeadlineChip deviceId={dev.id} deviceName={dev.name} nowMs={nowMs} />
        </div>
      </div>

      <div class="plan-card__stepped-body">
        {/* Same anatomy as the generic/temperature cards: bold canonical state
            word + right-aligned power. The former "Level: 6 A" / "Off now"
            bold slot moved to the fact line / state word respectively; the
            former "Applying" chip is carried by the transit status line. */}
        <div class="plan-card__state-row">
          <span class="plan-card__state-label">{displayStateLabel(stateKind)}</span>
          {powerText && <span class="plan-card__state-power">{powerText}</span>}
        </div>

        {factText !== null && (
          <span class="plan-card__secondary-line">{factText}</span>
        )}
        {statusText !== null && (
          <p class="plan-card__status-line pels-text-status-line">{statusText}</p>
        )}

        {profile && <StepRail dev={displayDev} profile={profile} />}
      </div>
    </article>
  );
};
