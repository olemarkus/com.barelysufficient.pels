import { h } from 'preact';
import { useRef, useLayoutEffect } from 'preact/hooks';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import { formatDeviceOverview } from '../../../shared-domain/src/deviceOverview.ts';
import { PLAN_REASON_CODES } from '../../../shared-domain/src/planReasonSemanticsCore.ts';
import {
  PLAN_STATE_LABEL,
  PLAN_STATE_TONE,
  type PlanStateKind,
  resolvePlanStateKind,
} from '../../../shared-domain/src/planStateLabels.ts';
import {
  formatStarvationBadge,
  formatStarvationReason,
} from '../../../shared-domain/src/planStarvation.ts';
import {
  resolveTemperatureOutputState,
  resolveTemperatureLine,
  resolveTemperatureReasonLine,
} from '../../../shared-domain/src/planTemperatureCardText.ts';
import {
  resolveCooldownBaseSec,
  resolveCooldownRemainingSec,
} from '../../../shared-domain/src/planCooldown.ts';
import { resolveDisplayPlanDeviceSnapshot } from './planLiveData.ts';
import { formatReasonSummary } from './planReasonSummary.ts';
import { cardActivationProps } from './cardActivation.ts';
import type { PlanDeviceSnapshot, PlanSnapshot } from './planTypes.ts';
import type { DeviceReason } from '../../../shared-domain/src/planReasonSemanticsCore.ts';

const formatKw = (value: number | undefined): string => (
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '–'
);

const isPlanStateKind = (value: string | undefined): value is PlanStateKind => (
  value === 'active'
  || value === 'idle'
  || value === 'held'
  || value === 'resuming'
  || value === 'manual'
  || value === 'unavailable'
  || value === 'unknown'
);

const resolveStatePresentation = (dev: PlanDeviceSnapshot) => {
  const kind = isPlanStateKind(dev.stateKind) ? dev.stateKind : resolvePlanStateKind(dev);
  return {
    kind,
    label: PLAN_STATE_LABEL[kind],
    tone: dev.stateTone ?? PLAN_STATE_TONE[kind],
  };
};

const isTrivialReason = (reason: unknown): boolean => {
  if (!reason || typeof reason !== 'object') return false;
  const code = (reason as { code?: unknown }).code;
  if (code === PLAN_REASON_CODES.none) return true;
  if (code === PLAN_REASON_CODES.keep) {
    const detail = (reason as { detail?: unknown }).detail;
    return detail === null || detail === undefined || detail === '';
  }
  return false;
};

const isDeviceReason = (reason: unknown): reason is DeviceReason => (
  Boolean(reason)
  && typeof reason === 'object'
  && typeof (reason as { code?: unknown }).code === 'string'
);

const resolveReasonText = (dev: PlanDeviceSnapshot): string => {
  if (dev.starvation?.isStarved && dev.starvation.cause === 'capacity') {
    const override = formatStarvationReason(dev.starvation);
    if (override) return override;
  }
  const kind = isPlanStateKind(dev.stateKind) ? dev.stateKind : resolvePlanStateKind(dev);
  if (isTrivialReason(dev.reason)) {
    return kind === 'held' ? 'Limited · staying under the hard cap' : '';
  }
  if (isDeviceReason(dev.reason)) return formatReasonSummary(dev.reason);
  if (kind === 'held') return 'Limited · staying under the hard cap';
  return formatDeviceOverview(dev).statusMsg;
};

const isDrawing = (dev: PlanDeviceSnapshot): boolean => (
  dev.currentState === 'on'
  && typeof dev.measuredPowerKw === 'number'
  && dev.measuredPowerKw > 0.05
);

const resolveExpectedKw = (dev: PlanDeviceSnapshot): number | null => {
  for (const value of [dev.planningPowerKw, dev.expectedPowerKw]) {
    if (typeof value === 'number' && value > 0.05) return value;
  }
  return null;
};

const shouldShowStateChip = (kind: PlanStateKind, hasTimer: boolean): boolean => (
  (kind !== 'held' && kind !== 'idle') || hasTimer
);


// ─── Cooldown progress ────────────────────────────────────────────────────────

type ProgressEl = HTMLElement & { value?: number };

const CooldownProgress = ({
  remainingSec,
  baseSec,
  tone,
}: {
  remainingSec: number | null;
  baseSec: number | null;
  tone: string;
}) => {
  const ref = useRef<ProgressEl>(null);
  const show = baseSec !== null && remainingSec !== null && remainingSec > 0;
  const ratio = show ? Math.max(0, Math.min(1, remainingSec! / Math.max(1, baseSec!))) : 0;

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.hidden = !show;
    ref.current.value = ratio;
    ref.current.setAttribute('value', String(ratio));
  });

  return h('md-circular-progress', {
    ref,
    class: 'plan-state-chip__timer',
    'data-tone': tone,
    'aria-hidden': 'true',
  } as Record<string, unknown>);
};

// ─── Generic plan card ────────────────────────────────────────────────────────

export const PlanGenericCard = ({
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
  const presentation = resolveStatePresentation(displayDev);

  const cardClasses = [
    'device-row plan-card clickable',
    (presentation.kind === 'idle' || presentation.kind === 'manual') ? 'plan-card--dim' : '',
    presentation.kind === 'unavailable' ? 'plan-card--unavailable' : '',
  ].filter(Boolean).join(' ');

  const remainingSec = resolveCooldownRemainingSec(displayDev);
  const baseSec = resolveCooldownBaseSec(displayDev);
  const hasTimer = baseSec !== null && remainingSec !== null && remainingSec > 0;
  const reasonText = resolveReasonText(displayDev);

  let powerReadout: { text: string; variant: 'live' | 'expected' } | null = null;
  if (isDrawing(displayDev)) {
    powerReadout = { text: `${formatKw(displayDev.measuredPowerKw)} kW`, variant: 'live' };
  } else {
    const expected = resolveExpectedKw(displayDev);
    if (expected !== null) powerReadout = { text: `~${expected.toFixed(1)} kW when active`, variant: 'expected' };
  }

  const starvationBadge = formatStarvationBadge(dev.starvation);

  return (
    <article
      class={cardClasses}
      data-device-id={dev.id}
      data-state-kind={presentation.kind}
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
          {shouldShowStateChip(presentation.kind, hasTimer) && (
            <span class="plan-state-chip-wrap">
              <span
                class={`plan-state-chip plan-state-chip--${presentation.tone}`}
                data-state-kind={presentation.kind}
                role="img"
                aria-label={presentation.label}
                data-tooltip={presentation.label}
              >
                {presentation.label}
              </span>
              <CooldownProgress remainingSec={remainingSec} baseSec={baseSec} tone={presentation.tone} />
            </span>
          )}
          {dev.budgetExempt === true && (
            <span class="plan-chip plan-chip--muted">Always on</span>
          )}
          {starvationBadge && (
            <span class={`plan-chip plan-chip--${starvationBadge.tone}`} data-tooltip={starvationBadge.tooltip}>
              {starvationBadge.label}
            </span>
          )}
        </div>
      </div>

      {powerReadout && (
        <div class="plan-card__metric plan-card__metric--power" data-variant={powerReadout.variant}>
          <span class="plan-card__metric-label">{powerReadout.text}</span>
        </div>
      )}

      {reasonText !== '' && <p class="plan-card__reason">{reasonText}</p>}
    </article>
  );
};

// ─── Temperature card ─────────────────────────────────────────────────────────

export const PlanTemperatureCard = ({
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
  const { kind } = resolveStatePresentation(displayDev);

  const cardClasses = [
    'device-row plan-card plan-card--temperature clickable',
    kind === 'idle' ? 'plan-card--dim' : '',
    kind === 'unavailable' ? 'plan-card--unavailable' : '',
  ].filter(Boolean).join(' ');

  const temperatureLine = resolveTemperatureLine(displayDev);
  const reasonLine = resolveTemperatureReasonLine(displayDev);
  const starvationBadge = formatStarvationBadge(dev.starvation);

  return (
    <article
      class={cardClasses}
      data-device-id={dev.id}
      data-state-kind={kind}
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
          {dev.temperatureBoostActive === true && (
            <span class="plan-chip plan-chip--ok" data-tooltip="Temperature boost is active">Boost</span>
          )}
          {starvationBadge && (
            <span class={`plan-chip plan-chip--${starvationBadge.tone}`} data-tooltip={starvationBadge.tooltip}>
              {starvationBadge.label}
            </span>
          )}
        </div>
      </div>

      <div class="plan-card__output-row">
        <span class="plan-card__output-state">{resolveTemperatureOutputState(displayDev)}</span>
        <span class="plan-card__output-power">{formatKw(displayDev.measuredPowerKw)} kW</span>
      </div>

      {temperatureLine !== null && <p class="plan-card__temp-line">{temperatureLine}</p>}
      {reasonLine !== null && <p class="plan-card__temp-reason">{reasonLine}</p>}
    </article>
  );
};
