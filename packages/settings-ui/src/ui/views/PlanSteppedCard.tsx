import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import { isDimmedDisplayStateKind } from '../../../../shared-domain/src/planCardGrammar.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { resolveDisplayPlanDeviceSnapshot } from '../planLiveData.ts';
import { cardActivationProps } from '../cardActivation.ts';
import { DeadlineChip, PlanCardStatusChipView } from './PlanDeviceCards.tsx';
import type { PlanDeviceSnapshot } from '../planTypes.ts';

// ─── Step rail ────────────────────────────────────────────────────────────────

const StepRail = ({ dev }: { dev: PlanDeviceSnapshot }) => {
  const steps = dev.status.rail?.labels ?? [];
  const n = steps.length;
  const activeIdx = dev.status.rail?.activeIndex ?? -1;
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
          {steps[0] ?? ''}
        </span>
        {n > 1 && (
          <span class="plan-card__step-label metric-label plan-card__step-label--end">
            {steps[n - 1] ?? ''}
          </span>
        )}
      </div>
      <div
        class="plan-card__step-track"
        role="img"
        aria-label={`Level ${activeIdx < 0 ? 'unavailable' : activeIdx + 1} of ${n}`}
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
  dryRun,
  nowMs,
}: {
  dev: PlanDeviceSnapshot;
  dryRun: boolean;
  nowMs: number;
}) => {
  const displayDev = resolveDisplayPlanDeviceSnapshot(dev, nowMs);
  const status = displayDev.status;
  const stateKind = status.kind;
  const powerText = status.powerText;
  const factText = status.factText;
  const statusText = status.reason?.text ?? null;

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
          <span class="plan-card__state-label">{status.label}</span>
          {powerText && <span class="plan-card__state-power">{powerText}</span>}
        </div>

        {factText !== null && (
          <span class="plan-card__secondary-line">{factText}</span>
        )}
        {statusText !== null && (
          <p class="plan-card__status-line pels-text-status-line">{statusText}</p>
        )}

        {status.rail && <StepRail dev={displayDev} />}
      </div>
    </article>
  );
};
