import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import {
  capitalizeStepLabel,
  isSteppedTransit,
  resolveEvChargingStateLabel,
  resolveSteppedActiveStepId,
  resolveSteppedChip,
  resolveSteppedPowerText,
  resolveSteppedStateLabel,
  resolveSteppedStatusLine,
  resolveSteppedTemperatureText,
} from '../../../shared-domain/src/planSteppedCardText.ts';
import {
  resolvePlanStateKind,
  type PlanStateKind,
} from '../../../shared-domain/src/planStateLabels.ts';
import { resolveDisplayPlanDeviceSnapshot } from './planLiveData.ts';
import { cardActivationProps } from './cardActivation.ts';
import type { PlanDeviceSnapshot, PlanSnapshot } from './planTypes.ts';
import type { SteppedLoadProfile } from '../../../contracts/src/types.ts';

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
  const transit = isSteppedTransit(dev);
  const activeStepId = resolveSteppedActiveStepId(dev, profile);
  const targetStepId = transit ? (dev.steppedLoad?.targetStepId ?? null) : null;

  const hasExplicitOff = profile.steps.some((s) => s.id.toLowerCase() === 'off');
  const hasBinaryOff = dev.currentState !== 'not_applicable';
  const steps = hasExplicitOff || !hasBinaryOff
    ? profile.steps
    : [{ id: 'off', planningPowerW: 0 }, ...profile.steps];
  const n = steps.length;
  const normActive = activeStepId?.toLowerCase() ?? null;
  const normTarget = targetStepId?.toLowerCase() ?? null;
  const activeIdx = normActive === null ? -1 : steps.findIndex((s) => s.id.toLowerCase() === normActive);
  const filledPct = n <= 1 || activeIdx < 0 ? 0 : (activeIdx / (n - 1)) * 100;

  return (
    <div class="plan-card__step-rail">
      <div class="plan-card__step-labels">
        {steps.map((step, i) => {
          const pct = n <= 1 ? 0 : (i / (n - 1)) * 100;
          return (
            <span key={step.id} class="plan-card__step-label" style={{ left: `${pct}%` }}>
              {capitalizeStepLabel(step.id)}
            </span>
          );
        })}
      </div>
      <div class="plan-card__step-track">
        <div class="plan-card__step-filled" style={{ width: `${filledPct}%` }} />
        {steps.map((step, i) => {
          const pct = n <= 1 ? 0 : (i / (n - 1)) * 100;
          const normId = step.id.toLowerCase();
          const isActive = normActive !== null && normId === normActive;
          const isTarget = normTarget !== null && normId === normTarget && !isActive;
          const isFilled = activeIdx >= 0 && i < activeIdx;
          return (
            <div
              key={step.id}
              class="plan-card__step-stop"
              style={{ left: `${pct}%` }}
              data-active={isActive ? 'true' : undefined}
              data-target={isTarget ? 'true' : undefined}
              data-filled={isFilled ? 'true' : undefined}
            />
          );
        })}
      </div>
    </div>
  );
};

// ─── PlanSteppedCard component ────────────────────────────────────────────────

export const PlanSteppedCard = ({
  dev,
  plan,
  renderedAtMs,
  nowMs,
}: {
  dev: PlanDeviceSnapshot;
  plan: PlanSnapshot | null;
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
  const statusText = profile ? resolveSteppedStatusLine(displayDev, profile, nowMs) : null;

  const cardClasses = [
    'device-row plan-card plan-card--stepped clickable',
    (stateKind === 'idle' || stateKind === 'manual') ? 'plan-card--dim' : '',
    stateKind === 'unavailable' ? 'plan-card--unavailable' : '',
  ].filter(Boolean).join(' ');

  return (
    <article
      class={cardClasses}
      data-device-id={dev.id}
      data-state-kind={stateKind}
      tabIndex={0}
      role="button"
      aria-label={`Open device details for ${dev.name}`}
      {...cardActivationProps(dev.id)}
    >
      <MdElevation aria-hidden="true" />
      <MdRipple aria-hidden="true" />

      <div class="plan-card__header">
        <div class="plan-card__title-wrap">
          <h3 class="plan-card__title">{dev.name}</h3>
        </div>
        <div class="plan-card__chips">
          {chip && <span class={`plan-chip plan-chip--${chip.tone}`}>{chip.label}</span>}
          {displayDev.temperatureBoostActive === true && (
            <span class="plan-chip plan-chip--ok" data-tooltip="Temperature boost is active">Boost</span>
          )}
          {displayDev.temperatureBoostActive !== true && displayDev.evBoostActive === true && (
            <span class="plan-chip plan-chip--ok" data-tooltip="EV boost is active">Boost</span>
          )}
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
          <p class="plan-card__status-line">{statusText}</p>
        )}

        {profile && <StepRail dev={displayDev} profile={profile} />}
      </div>
    </article>
  );
};
