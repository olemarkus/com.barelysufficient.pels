import { h } from 'preact';
import { useRef, useLayoutEffect } from 'preact/hooks';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import { PLAN_REASON_CODES } from '../../../../shared-domain/src/planReasonSemanticsCore.ts';
import {
  readDeviceReasonDetail,
  resolveReportedLoadAfterPauseText,
} from '../../../../shared-domain/src/planReasonFormatting.ts';
import {
  PLAN_STATE_HELD_FALLBACK_STATUS,
  PLAN_STATE_LABEL,
  PLAN_STATE_TONE,
  type PlanStateKind,
  resolvePlanStateKind,
} from '../../../../shared-domain/src/planStateLabels.ts';
import {
  formatStarvationBadge,
  formatStarvationReason,
} from '../../../../shared-domain/src/planStarvation.ts';
import {
  resolveTemperatureOutputState,
  resolveTemperatureLine,
  resolveTemperatureReasonLine,
} from '../../../../shared-domain/src/planTemperatureCardText.ts';
import {
  resolveCooldownBaseSec,
  resolveCooldownRemainingSec,
} from '../../../../shared-domain/src/planCooldown.ts';
import { resolveHeldStateActionLabel } from '../../../../shared-domain/src/deviceOverview.ts';
import { resolveEvCardStateLine } from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatIdleClassificationCopy } from '../../../../shared-domain/src/idleClassificationCopy.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { resolveDisplayPlanDeviceSnapshot } from '../planLiveData.ts';
import { formatReasonSummary } from '../planReasonSummary.ts';
import { cardActivationProps } from '../cardActivation.ts';
import { state } from '../state.ts';
import { buildDeadlineHref } from '../deadlineUrls.ts';
import type { PlanDeviceSnapshot, PlanSnapshot } from '../planTypes.ts';
import type { DeviceReason } from '../../../../shared-domain/src/planReasonSemanticsCore.ts';

const hasActiveDeadlineObjective = (deviceId: string, nowMs: number): boolean => {
  const entry = state.deferredObjectiveSettings?.objectivesByDeviceId?.[deviceId];
  if (!entry || !entry.enabled) return false;
  return Number.isFinite(entry.deadlineAtMs) && entry.deadlineAtMs > nowMs;
};

const formatEvCardTime = (ms: number): string => (
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
);

// Returns null when the device has no active ev_soc deadline or when no state
// line applies (e.g. hours have already elapsed and the car is not unplugged).
const resolveEvStateLineText = (deviceId: string, nowMs: number): string | null => {
  const objective = state.deferredObjectiveSettings?.objectivesByDeviceId?.[deviceId];
  if (!objective || !objective.enabled || objective.kind !== 'ev_soc') return null;
  if (!Number.isFinite(objective.deadlineAtMs) || objective.deadlineAtMs <= nowMs) return null;

  const activePlan = state.deferredObjectiveActivePlans?.plansByDeviceId?.[deviceId];
  const hours = activePlan?.latest?.hours ?? [];
  const isPlugOutPaused = activePlan?.diagnosticReasonCode === 'objective_invalid_session';

  const stateLine = resolveEvCardStateLine({ hours, nowMs, isPlugOutPaused, formatTime: formatEvCardTime });
  return stateLine.kind === 'none' ? null : stateLine.text;
};

const stopActivation = (event: Event): void => {
  event.stopPropagation();
};

const handleChipKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.stopPropagation();
  // Anchors don't activate on Space by default; suppress page scroll so we
  // can treat Space as activation on keyup, matching the parent card model.
  if (event.key === ' ') event.preventDefault();
};

const handleChipKeyUp = (event: KeyboardEvent): void => {
  if (event.key === 'Enter') {
    event.stopPropagation();
    return;
  }
  if (event.key !== ' ') return;
  event.stopPropagation();
  event.preventDefault();
  const target = event.currentTarget;
  if (target instanceof HTMLAnchorElement) target.click();
};

export const DeadlineChip = (
  { deviceId, deviceName, nowMs }: { deviceId: string; deviceName?: string; nowMs: number },
) => {
  if (!hasActiveDeadlineObjective(deviceId, nowMs)) return null;
  // Screen readers otherwise hear only the chip text ("Smart task") + link
  // role; in a clickable card the chip's destination is then ambiguous.
  // Naming it after the device disambiguates from the parent card-navigation
  // hit-target. Spec: TODO #3 (2026-05-16).
  const displayName = deviceName ? formatDisplayDeviceName(deviceName) : '';
  const ariaLabel = displayName !== '' ? `Smart task for ${displayName}` : 'Smart task';
  return (
    <a
      class="plan-chip plan-chip--info plan-chip--link"
      href={buildDeadlineHref(deviceId)}
      onClick={stopActivation}
      onKeyDown={handleChipKeyDown}
      onKeyUp={handleChipKeyUp}
      aria-label={ariaLabel}
      data-tooltip="Open smart task"
    >
      Smart task
    </a>
  );
};

export const EvDeadlineStateLine = ({ deviceId, nowMs }: { deviceId: string; nowMs: number }) => {
  const text = resolveEvStateLineText(deviceId, nowMs);
  if (text === null) return null;
  return <p class="plan-card__ev-state">{text}</p>;
};

const resolveIdleCopy = (dev: PlanDeviceSnapshot) => {
  if (
    dev.idleClassification !== 'near_target_idle'
    && dev.idleClassification !== 'unresponsive'
    && dev.idleClassification !== 'capped_idle'
  ) {
    return null;
  }
  return formatIdleClassificationCopy({
    classification: dev.idleClassification,
    currentTemperatureC: typeof dev.currentTemperature === 'number' ? dev.currentTemperature : undefined,
    targetTemperatureC: typeof dev.currentTarget === 'number' ? dev.currentTarget : undefined,
  });
};

export const IdleClassificationLine = ({ dev }: { dev: PlanDeviceSnapshot }) => {
  const copy = resolveIdleCopy(dev);
  if (!copy) return null;
  return (
    <p
      class={`plan-card__idle-line plan-card__idle-line--${copy.tone}`}
      data-tooltip={copy.detail}
    >
      {copy.statusLine}
    </p>
  );
};

export const IdleClassificationChip = ({ dev }: { dev: PlanDeviceSnapshot }) => {
  if (dev.idleClassification !== 'unresponsive') return null;
  const copy = resolveIdleCopy(dev);
  if (!copy) return null;
  return (
    <span class="plan-chip plan-chip--warn" data-tooltip={copy.detail}>
      Not responding
    </span>
  );
};

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

// Maps a `PlanStateTone` (active/idle/held/resuming/neutral/warning) onto the
// `plan-chip--{modifier}` family so the device-state chip uses the same
// primitive as the "Always on", Boost, Smart-task, and starvation chips. Spec:
// TODO #2 (chip-primitive consolidation, 2026-05-16). Previous family
// `plan-state-chip` is no longer referenced from app code.
const PLAN_STATE_CHIP_MODIFIER: Record<string, string> = {
  active: 'good',
  resuming: 'good',
  held: 'limited',
  idle: 'muted',
  neutral: 'muted',
  warning: 'alert',
};

const resolveStatePresentation = (dev: PlanDeviceSnapshot) => {
  const kind = isPlanStateKind(dev.stateKind) ? dev.stateKind : resolvePlanStateKind(dev);
  const tone = dev.stateTone ?? PLAN_STATE_TONE[kind];
  return {
    kind,
    label: PLAN_STATE_LABEL[kind],
    tone,
    chipModifier: PLAN_STATE_CHIP_MODIFIER[tone] ?? 'muted',
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
    return kind === 'held' ? PLAN_STATE_HELD_FALLBACK_STATUS : '';
  }
  if (isDeviceReason(dev.reason)) return formatReasonSummary(dev.reason);
  if (kind === 'held') return PLAN_STATE_HELD_FALLBACK_STATUS;
  // Final fallback for malformed snapshots — keep it user-facing so internal
  // planner terms never leak when the upstream reason payload is missing.
  return '';
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
type PowerReadout = { text: string; variant: 'live' | 'expected' | 'reported' };

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

const isReportedLoadConflict = (dev: PlanDeviceSnapshot, kind: PlanStateKind): boolean => (
  kind === 'held'
  && typeof dev.measuredPowerKw === 'number'
  && dev.measuredPowerKw > 0.05
);

const resolveReportedLoadReason = (dev: PlanDeviceSnapshot): string => resolveReportedLoadAfterPauseText({
  measuredPowerKw: dev.measuredPowerKw,
  detail: readDeviceReasonDetail(dev.reason),
});

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
    'pels-surface-card device-row plan-card clickable',
    (presentation.kind === 'idle' || presentation.kind === 'manual') ? 'plan-card--dim' : '',
  ].filter(Boolean).join(' ');

  const remainingSec = resolveCooldownRemainingSec(displayDev);
  const baseSec = resolveCooldownBaseSec(displayDev);
  const hasTimer = baseSec !== null && remainingSec !== null && remainingSec > 0;
  const reportedLoadConflict = isReportedLoadConflict(displayDev, presentation.kind);
  const reasonText = reportedLoadConflict ? resolveReportedLoadReason(displayDev) : resolveReasonText(displayDev);

  let powerReadout: PowerReadout | null = null;
  if (reportedLoadConflict) {
    powerReadout = { text: `Reported ${formatKw(displayDev.measuredPowerKw)} kW`, variant: 'reported' };
  } else if (isDrawing(displayDev)) {
    powerReadout = { text: `${formatKw(displayDev.measuredPowerKw)} kW`, variant: 'live' };
  } else {
    const expected = resolveExpectedKw(displayDev);
    if (expected !== null) powerReadout = { text: `~${expected.toFixed(1)} kW when active`, variant: 'expected' };
  }

  const starvationBadge = formatStarvationBadge(dev.starvation);
  const displayName = formatDisplayDeviceName(dev.name);

  return (
    <article
      class={cardClasses}
      data-device-id={dev.id}
      data-state-kind={presentation.kind}
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
          {shouldShowStateChip(presentation.kind, hasTimer) && (
            <span class="plan-state-chip-wrap">
              <span
                class={`plan-chip plan-chip--${presentation.chipModifier}`}
                data-state-kind={presentation.kind}
                data-state-tone={presentation.tone}
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
          <DeadlineChip deviceId={dev.id} deviceName={dev.name} nowMs={nowMs} />
        </div>
      </div>

      {reportedLoadConflict && powerReadout && (
        <div class="plan-card__state-row">
          <span class="plan-card__state-label">{resolveHeldStateActionLabel(displayDev)}</span>
          <span class="plan-card__state-power">{powerReadout.text}</span>
        </div>
      )}

      {!reportedLoadConflict && powerReadout && (
        <div class="plan-card__metric plan-card__metric--power" data-variant={powerReadout.variant}>
          <span class="plan-card__metric-label metric-label">{powerReadout.text}</span>
        </div>
      )}

      {reasonText !== '' && <p class="plan-card__reason">{reasonText}</p>}
      <EvDeadlineStateLine deviceId={dev.id} nowMs={nowMs} />
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
    'pels-surface-card device-row plan-card plan-card--temperature clickable',
    (kind === 'idle' || kind === 'manual') ? 'plan-card--dim' : '',
  ].filter(Boolean).join(' ');

  const temperatureLine = resolveTemperatureLine(displayDev);
  const reasonLine = resolveTemperatureReasonLine(displayDev);
  const starvationBadge = formatStarvationBadge(dev.starvation);
  const displayName = formatDisplayDeviceName(dev.name);

  return (
    <article
      class={cardClasses}
      data-device-id={dev.id}
      data-state-kind={kind}
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
          {dev.temperatureBoostActive === true && (
            <span class="plan-chip plan-chip--ok" data-tooltip="Temperature boost is active">Boost</span>
          )}
          {starvationBadge && (
            <span class={`plan-chip plan-chip--${starvationBadge.tone}`} data-tooltip={starvationBadge.tooltip}>
              {starvationBadge.label}
            </span>
          )}
          <IdleClassificationChip dev={displayDev} />
          <DeadlineChip deviceId={dev.id} deviceName={dev.name} nowMs={nowMs} />
        </div>
      </div>

      <div class="plan-card__output-row">
        <span class="plan-card__output-state">{resolveTemperatureOutputState(displayDev)}</span>
        <span class="plan-card__output-power">{formatKw(displayDev.measuredPowerKw)} kW</span>
      </div>

      {temperatureLine !== null && <p class="plan-card__temp-line">{temperatureLine}</p>}
      {reasonLine !== null && <p class="plan-card__temp-reason">{reasonLine}</p>}
      <IdleClassificationLine dev={displayDev} />
    </article>
  );
};
