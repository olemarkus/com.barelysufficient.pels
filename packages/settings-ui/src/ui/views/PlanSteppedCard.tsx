import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import {
  formatStepDisplayLabel,
  resolveEvChargingStateLabel,
  resolveSteppedActiveStepId,
  resolveSteppedChip,
  resolveSteppedPowerText,
  resolveSteppedStateLabel,
  resolveSteppedStatusLine,
  resolveSteppedTemperatureText,
} from '../../../../shared-domain/src/planSteppedCardText.ts';
import {
  PLAN_STATE_HELD_FALLBACK_STATUS,
  resolvePlanStateKind,
  type PlanStateKind,
} from '../../../../shared-domain/src/planStateLabels.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { toSimulationReasonLine } from '../../../../shared-domain/src/simulationReasonMood.ts';
import { resolveDisplayPlanDeviceSnapshot } from '../planLiveData.ts';
import { cardActivationProps } from '../cardActivation.ts';
import { BudgetExemptChip, DeadlineChip } from './PlanDeviceCards.tsx';
import type { PlanDeviceSnapshot, PlanSnapshot } from '../planTypes.ts';
import type { SteppedLoadProfile } from '../../../../contracts/src/types.ts';

const isPlanStateKind = (value: string | undefined): value is PlanStateKind => (
  value === 'active'
  || value === 'idle'
  || value === 'held'
  || value === 'resuming'
  || value === 'manual'
  || value === 'unavailable'
  || value === 'unknown'
);

const resolveStateKind = (dev: PlanDeviceSnapshot): PlanStateKind => (
  isPlanStateKind(dev.stateKind) ? dev.stateKind : resolvePlanStateKind(dev)
);

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
  const stateKind = resolveStateKind(displayDev);
  const profile = displayDev.steppedLoad?.profile;

  const chip = resolveSteppedChip(displayDev);
  const stateLabel = resolveSteppedStateLabel(displayDev);
  const powerText = resolveSteppedPowerText(displayDev);
  const evState = resolveEvChargingStateLabel(displayDev);
  const tempText = resolveSteppedTemperatureText(displayDev);
  const secondaryText = evState ?? tempText ?? null;
  const resolvedStatusText = profile ? resolveSteppedStatusLine(displayDev, profile, nowMs) : null;
  const factualStatusText = resolvedStatusText ?? (stateKind === 'held' ? PLAN_STATE_HELD_FALLBACK_STATUS : null);
  // In simulation the held/limited status line reads hypothetically to agree with
  // the card's would-be-acted state (no-op outside simulation / for non-acted lines).
  const statusText = factualStatusText === null ? null : toSimulationReasonLine(factualStatusText, dryRun);

  const cardClasses = [
    'pels-surface-card device-row plan-card plan-card--stepped clickable',
    (stateKind === 'idle' || stateKind === 'manual') ? 'plan-card--dim' : '',
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
          {chip && <span class={`plan-chip plan-chip--${chip.tone}`}>{chip.label}</span>}
          {displayDev.budgetExempt === true && (
            <span class="plan-chip plan-chip--muted">Always on</span>
          )}
          {displayDev.temperatureBoostActive === true && (
            <span class="plan-chip plan-chip--ok" data-tooltip="Temperature boost is active">Boost</span>
          )}
          {displayDev.temperatureBoostActive !== true && displayDev.evBoostActive === true && (
            <span class="plan-chip plan-chip--ok" data-tooltip="EV boost is active">Boost</span>
          )}
          <BudgetExemptChip dev={displayDev} />
          <DeadlineChip deviceId={dev.id} deviceName={dev.name} nowMs={nowMs} />
        </div>
      </div>

      <div class="plan-card__stepped-body">
        <div class="plan-card__state-row">
          <span class="plan-card__state-label">{stateLabel}</span>
          {powerText && <span class="plan-card__state-power">{powerText}</span>}
        </div>

        {secondaryText !== null && (
          <span class="plan-card__secondary-line">{secondaryText}</span>
        )}
        {statusText !== null && (
          <p class="plan-card__status-line pels-text-status-line">{statusText}</p>
        )}

        {profile && <StepRail dev={displayDev} profile={profile} />}
      </div>
    </article>
  );
};
