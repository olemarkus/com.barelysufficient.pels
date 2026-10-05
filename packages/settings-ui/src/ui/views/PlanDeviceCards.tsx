import { h } from 'preact';
import { useRef, useLayoutEffect, useState } from 'preact/hooks';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import { chipModifierForTone } from './chipModifier.ts';
import {
  isDimmedDisplayStateKind,
  resolvePlanCardStatusChip,
  type PlanCardStatusChip,
  type PlanDisplayStateKind,
} from '../../../../shared-domain/src/planCardGrammar.ts';
import {
  BUDGET_EXEMPT_CARD_ACTION_COPY,
  budgetExemptCardActionAriaLabel,
  formatStarvationRescueArmedCaption,
  shouldOfferBudgetExemptCardAction,
  STARVATION_RESCUE_WIDGET_COPY,
} from '../../../../shared-domain/src/planStarvation.ts';
import { BoltIcon } from './icons.tsx';
import { formatGrantedRescuePermissionsLine } from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { resolveDisplayPlanDeviceSnapshot } from '../planLiveData.ts';
import { cardActivationProps } from '../cardActivation.ts';
import {
  createStarvationRescue,
  isStarvationRescuable,
  previewStarvationRescue,
} from '../starvationRescue.ts';
import { hasActiveDeadlineObjective } from '../state.ts';
import { buildDeadlineHref } from '../deadlineUrls.ts';
import type { PlanDeviceSnapshot } from '../planTypes.ts';

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
  // hit-target. Spec dated 2026-05-16.
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



// Display presentation for the card's state word + `data-state-kind` styling
// hook. `resolveDisplayStateKind` applies the two card-grammar rules on top of
// the raw plan state: a hold/wait reason upgrades `idle` to `held`, and
// simulation collapses PELS-acted kinds to the factual device state (the
// hypothetical action lives in the reason line, never the bold state word).
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
    boostActive: dev.boostActive,
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

// ─── Generic plan card ────────────────────────────────────────────────────────

export const PlanGenericCard = ({
  dev,
  dryRun,
  nowMs,
  evStateLine,
}: {
  dev: PlanDeviceSnapshot;
  dryRun: boolean;
  nowMs: number;
  // The charger's EV smart-task line, resolved by the orchestrator; null when
  // the device has none.
  evStateLine: string | null;
}) => {
  const displayDev = resolveDisplayPlanDeviceSnapshot(dev, nowMs);
  const presentation = displayDev.status;

  const cardClasses = [
    'pels-surface-card device-row plan-card clickable',
    isDimmedDisplayStateKind(presentation.kind) ? 'plan-card--dim' : '',
  ].filter(Boolean).join(' ');

  const countdown = presentation.reason?.countdown;
  const remainingSec = countdown ? Math.max(0, Math.ceil((countdown.endsAtMs - nowMs) / 1000)) : null;
  const baseSec = countdown?.totalSec ?? null;
  const hasTimer = baseSec !== null && remainingSec !== null && remainingSec > 0;
  const powerReadout: PowerReadout | null = presentation.powerText === null ? null
    : { text: presentation.powerText, variant: presentation.powerVariant };
  const displayName = formatDisplayDeviceName(dev.name);
  // One reason line per card: the device's own reason wins; a charger's EV
  // smart-task line fills the slot only when no reason renders.
  const singleReason = presentation.reason?.text ?? evStateLine ?? '';

  return (
    <div
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
                class={`plan-chip plan-chip--${chipModifierForTone(presentation.tone)}`}
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
    </div>
  );
};

// ─── Temperature card ─────────────────────────────────────────────────────────

export const PlanTemperatureCard = ({
  dev,
  dryRun,
  nowMs,
}: {
  dev: PlanDeviceSnapshot;
  dryRun: boolean;
  nowMs: number;
}) => {
  const displayDev = resolveDisplayPlanDeviceSnapshot(dev, nowMs);
  const presentation = displayDev.status;
  const { kind } = presentation;

  const cardClasses = [
    'pels-surface-card device-row plan-card plan-card--temperature clickable',
    isDimmedDisplayStateKind(kind) ? 'plan-card--dim' : '',
  ].filter(Boolean).join(' ');

  const temperatureLine = presentation.factText;
  const reasonLine = presentation.reason?.text ?? null;
  const reasonTooltip = presentation.reason?.detail;
  const reasonTone = presentation.reason?.tone;
  const displayName = formatDisplayDeviceName(dev.name);

  return (
    <div
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
        {/* No power reading, no figure: a thermostat PELS plans for its
            setpoints alone shows nothing rather than a placeholder. */}
        {presentation.powerText !== null && (
          <span class="plan-card__state-power">{presentation.powerText}</span>
        )}
      </div>

      {temperatureLine !== null && <p class="plan-card__temp-line">{temperatureLine}</p>}
      {reasonLine !== null && (
        <p class="plan-card__temp-reason" data-tone={reasonTone} data-tooltip={reasonTooltip}>{reasonLine}</p>
      )}
    </div>
  );
};
