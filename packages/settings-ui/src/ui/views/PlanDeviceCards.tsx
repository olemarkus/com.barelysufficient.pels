import { h } from 'preact';
import { useRef, useLayoutEffect, useState } from 'preact/hooks';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import { chipModifierForTone } from './chipModifier.ts';
import { PLAN_REASON_CODES } from '../../../../shared-domain/src/planReasonSemanticsCore.ts';
import {
  readDeviceReasonDetail,
  resolveReportedLoadAfterPauseText,
  resolveSurplusHoldReportedLoadText,
} from '../../../../shared-domain/src/planReasonFormatting.ts';
import {
  isSatisfiedTargetOnlyDevice,
  PLAN_STATE_TONE,
  type PlanStateKind,
} from '../../../../shared-domain/src/planStateLabels.ts';
import { resolveHeldCardReasonLine } from '../../../../shared-domain/src/planCardReasonLine.ts';
import {
  displayStateLabel,
  displayStateTone,
  isDimmedDisplayStateKind,
  resolveDisplayStateKind,
  resolveIntentStateKind,
  resolvePlanCardStatusChip,
  resolveRawPlanStateKind,
  shouldDisplayExternalOffReason,
  type PlanDisplayStateKind,
  type PlanCardStatusChip,
} from '../../../../shared-domain/src/planCardGrammar.ts';
import {
  resolveBinarySurplusReasonLine,
  resolveTemperatureLine,
  resolveTemperatureReasonLine,
} from '../../../../shared-domain/src/planTemperatureCardText.ts';
import {
  resolveCooldownBaseSec,
  resolveCooldownRemainingSec,
} from '../../../../shared-domain/src/planCooldown.ts';
import { toSimulationReasonLine } from '../../../../shared-domain/src/simulationReasonMood.ts';
import {
  BUDGET_EXEMPT_CARD_ACTION_COPY,
  budgetExemptCardActionAriaLabel,
  formatStarvationRescueArmedCaption,
  shouldOfferBudgetExemptCardAction,
  STARVATION_RESCUE_WIDGET_COPY,
} from '../../../../shared-domain/src/planStarvation.ts';
import { BoltIcon } from './icons.tsx';
import {
  formatGrantedRescuePermissionsLine,
  resolveEvCardStateLine,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatIdleClassificationCopy } from '../../../../shared-domain/src/idleClassificationCopy.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { resolveDisplayPlanDeviceSnapshot } from '../planLiveData.ts';
import { formatReasonSummary } from '../planReasonSummary.ts';
import { cardActivationProps } from '../cardActivation.ts';
import {
  createStarvationRescue,
  isStarvationRescuable,
  previewStarvationRescue,
} from '../starvationRescue.ts';
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
  const isNotResumable = activePlan?.diagnosticReasonCode === 'objective_charger_not_resumable';

  const stateLine = resolveEvCardStateLine({
    hours, nowMs, isPlugOutPaused, isNotResumable, formatTime: formatEvCardTime,
  });
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

// Contextual rescue surfaced on a device card that PELS is holding back BY THE
// DAILY BUDGET (the releasable case): triggers the SAME bounded budget-exempt
// rescue as the held-back widget's "Let it run now" — a fresh deferred objective
// carrying `exemptFromBudget` (≈ now+3h, until the device reaches its normal
// target). It is NOT a deep-link to the standing per-device toggle; a budget
// exemption is always bounded to a smart task (feedback_hard_cap_is_physical).
//
// Two-step confirm (the canonical settings-UI armed-button pattern): the first
// tap arms (and best-effort previews the bounded "By …" window), the second
// commits. A `<button>` activates on Enter/Space natively; we only suppress
// propagation so the parent card's whole-surface tap (which would open the
// device-detail overlay) does not also fire.
//
// GATED on the rescue's REAL preconditions: held back
// (`shouldOfferBudgetExemptCardAction`, from card data) AND server-confirmed
// rescuable (task-free + a known target; `isStarvationRescuable`, mirroring
// `getStarvedRescueDevices`). A device with its own smart task or no known
// target never renders the chip. That set is a snapshot, so a stale chip can
// still be rejected on create — rare, and handled by the reject copy rather than
// prevented. It is NOT gated on which constraint holds the device: the rescue
// clears room on both axes, up to but never above the hard cap.
// `arming` is the window between the first tap and the preview landing. It is a
// distinct state (not `armed`) because Confirm must not be committable until the
// granted-permission disclosure has rendered.
type RescueChipState = 'idle' | 'arming' | 'armed' | 'busy';

export const BudgetExemptChip = ({
  dev,
}: {
  dev: PlanDeviceSnapshot;
}) => {
  const [chipState, setChipState] = useState<RescueChipState>('idle');
  // The previewed deadline (when a preview ran) is echoed to the create call so
  // a confirm left open across an hour boundary persists what the user saw.
  const [deadlineAtMs, setDeadlineAtMs] = useState<number | undefined>(undefined);
  // The server-formatted local "By {time}" anchor (e.g. "Today 17:00"), shown in
  // the armed caption so the bounded horizon is visible on touch. Sourced from
  // the same preview response as `deadlineAtMs` — the producer formats it in the
  // Homey timezone so the view does no Date math (mirrors the rescue widget).
  const [deadlineLabel, setDeadlineLabel] = useState<string | undefined>(undefined);
  // The permissions the per-device gate ACTUALLY granted, listed verbatim under
  // the caption. The rescue requests all three, but
  // `AppSmartTaskApi.gateCandidateExtraPermissions` drops any that would be inert
  // on this device — so this is read from the preview's already-gated
  // `grantedRescuePermissions`, never the request, and it can neither claim a
  // permission the write will drop nor hide one it will persist (the pause grant
  // holds other devices off, which the user must see before authorising).
  const [permissionsLine, setPermissionsLine] = useState<string | null>(null);

  if (!shouldOfferBudgetExemptCardAction(dev.starvation)) return null;
  if (!isStarvationRescuable(dev.id)) return null;

  const displayName = dev.name ? formatDisplayDeviceName(dev.name) : '';
  const ariaLabel = budgetExemptCardActionAriaLabel(displayName);

  const arm = (): void => {
    setChipState('arming');
    // The preview is what resolves BOTH the bounded window and the gated
    // permission set. Confirm stays disabled until it lands, because the rescue
    // requests permissions that hold other devices back: committing before the
    // disclosure has rendered would persist a grant the user never saw. A
    // successful preview always carries `grantedRescuePermissions` — the producer
    // attaches it on the `unavailable` path too — so this cannot deadlock on a
    // house that simply has no price data yet.
    //
    // A rejected preview drops back to idle (the controller surfaces why): the
    // rescue is re-armable, and losing one tap is the right trade against
    // authorising an undisclosed grant.
    void previewStarvationRescue(dev.id).then((response) => {
      if (!response.ok) {
        setChipState('idle');
        return;
      }
      setDeadlineAtMs(response.deadlineAtMs);
      setDeadlineLabel(response.deadlineLabel);
      setPermissionsLine(formatGrantedRescuePermissionsLine(response.estimate.grantedRescuePermissions));
      setChipState('armed');
    }).catch(() => setChipState('idle'));
  };

  const commit = (): void => {
    setChipState('busy');
    void createStarvationRescue(dev.id, deadlineAtMs).finally(() => {
      // The device drops out of the rescuable set on success, so the chip stops
      // rendering; on failure, return to idle so the user can retry.
      setChipState('idle');
      setDeadlineAtMs(undefined);
      setDeadlineLabel(undefined);
      setPermissionsLine(null);
    });
  };

  const activate = (event: Event): void => {
    event.stopPropagation();
    // `arming` and `busy` are both non-committable: the former because the
    // permission disclosure has not rendered yet, the latter because a create is
    // already in flight.
    if (chipState === 'busy' || chipState === 'arming') return;
    if (chipState === 'idle') arm();
    else commit();
  };

  const armed = chipState === 'armed';
  const arming = chipState === 'arming';
  const busy = chipState === 'busy';
  const label = busy || arming
    ? STARVATION_RESCUE_WIDGET_COPY.rescuePending
    : armed
      ? BUDGET_EXEMPT_CARD_ACTION_COPY.confirmLabel
      : BUDGET_EXEMPT_CARD_ACTION_COPY.label;

  return (
    <span class="plan-card__rescue">
      <button
        type="button"
        class={`plan-chip plan-chip--info plan-chip--link plan-chip--leading-icon hy-nostyle${armed ? ' confirming' : ''}`}
        onClick={activate}
        onKeyDown={stopActivation}
        onKeyUp={stopActivation}
        disabled={busy || arming}
        aria-label={ariaLabel}
        data-tooltip={BUDGET_EXEMPT_CARD_ACTION_COPY.tooltip}
      >
        <BoltIcon class="plan-chip__icon" />
        {label}
      </button>
      {armed && (
        <p class="plan-card__rescue-caption" onClick={stopActivation}>
          {formatStarvationRescueArmedCaption(deadlineLabel)}
        </p>
      )}
      {armed && permissionsLine !== null && (
        <p class="plan-card__rescue-perms" onClick={stopActivation}>
          {permissionsLine}
        </p>
      )}
    </span>
  );
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

const formatKw = (value: number | undefined): string => (
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '–'
);

// Display presentation for the card's state word + `data-state-kind` styling
// hook. `resolveDisplayStateKind` applies the two card-grammar rules on top of
// the raw plan state: a hold/wait reason upgrades `idle` to `held`, and
// simulation collapses PELS-acted kinds to the factual device state (the
// hypothetical action lives in the reason line, never the bold state word).
const resolveStatePresentation = (dev: PlanDeviceSnapshot, dryRun: boolean) => {
  const rawKind = resolveRawPlanStateKind(dev);
  const grammarParams = {
    kind: rawKind,
    reasonCode: (dev.reason as { code?: string } | undefined)?.code,
    starved: dev.starvation?.isStarved === true,
  };
  const kind = resolveDisplayStateKind({
    ...grammarParams,
    dryRun,
    currentState: dev.currentState,
    satisfiedTargetOnly: isSatisfiedTargetOnlyDevice(dev),
  });
  const tone = kind === rawKind
    ? (dev.stateTone ?? PLAN_STATE_TONE[rawKind])
    : displayStateTone(kind);
  return {
    kind,
    // The plan-INTENT kind (raw + upgrades, no simulation collapse). Reason
    // plumbing (e.g. the reported-load conflict, which is "plan says held,
    // meter says drawing") keys off this — the conflict is a fact about the
    // PLAN even when simulation renders the factual state word.
    intentKind: resolveIntentStateKind(grammarParams),
    label: displayStateLabel(kind),
    tone,
    chipModifier: chipModifierForTone(tone),
  };
};

// Single status chip per card (ladder in `planCardGrammar.ts`) — `rescue`
// renders the interactive two-step `BudgetExemptChip`; `status` renders a
// plain toned chip. The Smart-task badge is an identity/route badge and may
// coexist with this one chip.
export const PlanCardStatusChipView = ({
  dev,
  displayKind,
  dryRun,
}: {
  dev: PlanDeviceSnapshot;
  displayKind: PlanDisplayStateKind;
  dryRun: boolean;
}) => {
  const chip: PlanCardStatusChip | null = resolvePlanCardStatusChip({
    displayKind,
    dryRun,
    starvation: dev.starvation,
    rescueEligible: shouldOfferBudgetExemptCardAction(dev.starvation)
      && isStarvationRescuable(dev.id),
    temperatureBoostActive: dev.temperatureBoostActive === true,
    evBoostActive: dev.evBoostActive === true,
    budgetExempt: dev.budgetExempt === true,
  });
  if (chip === null) return null;
  if (chip.type === 'rescue') return <BudgetExemptChip dev={dev} />;
  return (
    <span class={`plan-chip plan-chip--${chip.tone}`} data-tooltip={chip.tooltip}>
      {chip.label}
    </span>
  );
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

// In simulation mode the held/limited reason line must read hypothetically to
// agree with the card's "Would be … (simulation)" state — the factual result is
// routed through `toSimulationReasonLine` (a no-op outside simulation and for
// non-acted reasons).
const resolveReasonText = (dev: PlanDeviceSnapshot, dryRun: boolean): string =>
  toSimulationReasonLine(resolveReasonTextFactual(dev), dryRun);

const resolveReasonTextFactual = (dev: PlanDeviceSnapshot): string => {
  // Plan-INTENT kind (raw + the idle→held upgrade) — the held line must fire for
  // a hold-reason card the planner marked inactive, and must keep firing under
  // simulation (only the state word goes factual there).
  const starved = dev.starvation?.isStarved === true;
  const kind = resolveIntentStateKind({
    kind: resolveRawPlanStateKind(dev),
    reasonCode: (dev.reason as { code?: string } | undefined)?.code,
    starved,
  });
  // One shared ladder across all three card variants: the card states what THIS
  // device needs, the hero names the ceiling limiting the house. Starvation
  // DECORATES that ladder with the elapsed hold; it never preempts it — see
  // `planCardReasonLine.ts`.
  const heldLine = (): string => resolveHeldCardReasonLine({
    reason: dev.reason,
    starvation: dev.starvation,
  });
  if (isTrivialReason(dev.reason)) {
    return kind === 'held' || starved ? heldLine() : '';
  }
  if (isDeviceReason(dev.reason)) {
    return kind === 'held' || starved ? heldLine() : formatReasonSummary(dev.reason);
  }
  if (kind === 'held' || starved) return heldLine();
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

const resolveReportedLoadReason = (dev: PlanDeviceSnapshot, dryRun: boolean): string => {
  // A surplus-held dump load the user manually switched on: name the surplus
  // reconcile ("switching off to wait for solar surplus") instead of the
  // generic "after pause" copy, which is wrong (a baseline-off device was never
  // paused) and would hide the surplus explanation. Keyed on the reason code
  // (already on the snapshot) — the awaitingSolarSurplus hold is exactly this
  // state — so no new plan-device field is needed. `dryRun` keeps the copy
  // hypothetical in simulation mode (PELS never actually switches it off).
  if ((dev.reason as { code?: string } | undefined)?.code === PLAN_REASON_CODES.awaitingSolarSurplus) {
    return resolveSurplusHoldReportedLoadText({ measuredPowerKw: dev.measuredPowerKw, dryRun });
  }
  return resolveReportedLoadAfterPauseText({
    measuredPowerKw: dev.measuredPowerKw,
    detail: readDeviceReasonDetail(dev.reason),
    dryRun,
  });
};

// ─── Generic plan card ────────────────────────────────────────────────────────

export const PlanGenericCard = ({
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
  const presentation = resolveStatePresentation(displayDev, dryRun);

  const cardClasses = [
    'pels-surface-card device-row plan-card clickable',
    isDimmedDisplayStateKind(presentation.kind) ? 'plan-card--dim' : '',
  ].filter(Boolean).join(' ');

  const remainingSec = resolveCooldownRemainingSec(displayDev);
  const baseSec = resolveCooldownBaseSec(displayDev);
  const hasTimer = baseSec !== null && remainingSec !== null && remainingSec > 0;
  const reportedLoadConflict = isReportedLoadConflict(displayDev, presentation.intentKind);
  // "Run on solar surplus" dump load, actively running on export: the card's
  // reason line explains WHY it is on ("On to use your solar power"). A held
  // dump load needs no special-casing here — its `awaitingSolarSurplus` reason
  // renders "Waiting for solar surplus" through the normal reason pipeline.
  const surplusActiveLine = reportedLoadConflict
    ? null
    : resolveBinarySurplusReasonLine(displayDev, presentation.kind);
  const reasonCode = (displayDev.reason as { code?: string } | undefined)?.code;
  const externalOffReasonHidden = reasonCode === PLAN_REASON_CODES.externalOffHold
    && !shouldDisplayExternalOffReason(presentation.kind, reasonCode);
  const reasonText = externalOffReasonHidden
    ? ''
    : (
      reportedLoadConflict
        ? resolveReportedLoadReason(displayDev, dryRun)
        : surplusActiveLine ?? resolveReasonText(displayDev, dryRun)
    );

  let powerReadout: PowerReadout | null = null;
  if (reportedLoadConflict) {
    powerReadout = { text: `Reported ${formatKw(displayDev.measuredPowerKw)} kW`, variant: 'reported' };
  } else if (isDrawing(displayDev)) {
    powerReadout = { text: `${formatKw(displayDev.measuredPowerKw)} kW`, variant: 'live' };
  } else {
    const expected = resolveExpectedKw(displayDev);
    if (expected !== null) powerReadout = { text: `≈ ${expected.toFixed(1)} kW when active`, variant: 'expected' };
  }

  const displayName = formatDisplayDeviceName(dev.name);
  // One reason line per card: the plan reason wins; an EV smart-task state
  // line ("Charging · planned finish 06:30") fills the slot only when no
  // reason renders. The dropped line is one tap away on the smart-task page.
  const evStateText = resolveEvStateLineText(dev.id, nowMs);
  const singleReason = reasonText !== '' ? reasonText : evStateText ?? '';

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
          {/* The state word lives in the below-title state row; the header
              chip returns only to anchor the cooldown countdown ring, which
              the state row cannot show. */}
          {hasTimer && (
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
          <PlanCardStatusChipView dev={displayDev} displayKind={presentation.kind} dryRun={dryRun} />
          <DeadlineChip deviceId={dev.id} deviceName={dev.name} nowMs={nowMs} />
        </div>
      </div>

      {/* One anatomy for every card: the bold canonical state word sits below
          the title with the kW right-aligned on the same row. The state word
          is always the state vocabulary (never an action sentence) — in the
          reported-load conflict the "Reported N kW" fact plus the reason line
          carry the conflict, and in simulation the word stays factual while
          the reason line reads hypothetically. */}
      <div class="plan-card__state-row">
        <span class="plan-card__state-label">{presentation.label}</span>
        {powerReadout && (
          <span class="plan-card__state-power" data-variant={powerReadout.variant}>{powerReadout.text}</span>
        )}
      </div>

      {singleReason !== '' && <p class="plan-card__reason">{singleReason}</p>}
    </article>
  );
};

// ─── Temperature card ─────────────────────────────────────────────────────────

export const PlanTemperatureCard = ({
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
  const presentation = resolveStatePresentation(displayDev, dryRun);
  const { kind } = presentation;

  const cardClasses = [
    'pels-surface-card device-row plan-card plan-card--temperature clickable',
    isDimmedDisplayStateKind(kind) ? 'plan-card--dim' : '',
  ].filter(Boolean).join(' ');

  const temperatureLine = resolveTemperatureLine(displayDev);
  // One reason line per card: the plan reason wins; the idle-classification
  // status line ("Not drawing power (20.3 °C / 22 °C)") fills the slot only
  // when no plan reason renders. The chip duplicate is gone — the same copy
  // never renders twice on one card.
  const idleCopy = resolveIdleCopy(displayDev);
  // The plan reason takes the simulation mood exactly as the generic and stepped
  // cards do (`resolveReasonText`, `PlanSteppedCard`); the temperature card used
  // to apply it internally and lost it when the shared ladder landed, leaving one
  // of three variants asserting a hold PELS never performed. The idle-classification
  // fallback stays factual — it describes the device, not a PELS action.
  const planReasonLine = resolveTemperatureReasonLine(displayDev, dryRun);
  const reasonLine = (planReasonLine === null
    ? idleCopy?.statusLine ?? null
    : toSimulationReasonLine(planReasonLine, dryRun));
  const reasonIsIdleCopy = reasonLine !== null && reasonLine === idleCopy?.statusLine;
  const reasonTooltip = reasonIsIdleCopy ? idleCopy?.detail : undefined;
  // The idle-classification copy carries its own tone (warning for
  // unresponsive) — preserve it now that the copy rides the shared reason
  // slot instead of the retired `__idle-line--warning` element.
  const reasonTone = reasonIsIdleCopy ? idleCopy?.tone : undefined;
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
          <PlanCardStatusChipView dev={displayDev} displayKind={kind} dryRun={dryRun} />
          <DeadlineChip deviceId={dev.id} deviceName={dev.name} nowMs={nowMs} />
        </div>
      </div>

      {/* Same anatomy as the generic/stepped cards: the state word distinguishes
          a quiet on-device (`Idle`) from affirmative binary-off evidence
          (`Off`), while a held thermostat reads `Limited` like every other
          held card. */}
      <div class="plan-card__state-row">
        <span class="plan-card__state-label">{presentation.label}</span>
        <span class="plan-card__state-power">{formatKw(displayDev.measuredPowerKw)} kW</span>
      </div>

      {temperatureLine !== null && <p class="plan-card__temp-line">{temperatureLine}</p>}
      {reasonLine !== null && (
        <p class="plan-card__temp-reason" data-tone={reasonTone} data-tooltip={reasonTooltip}>{reasonLine}</p>
      )}
    </article>
  );
};
