import type {
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../contracts/src/deferredObjectivePlanHistory';
import {
  formatReceiptDurationHours,
  formatReceiptDurationHoursMinutes,
  formatReceiptDurationMinutes,
  RECEIPT_DURATION_ZERO,
} from './deferredPlanHistoryReceiptStrings';
import {
  formatClockTime,
  HOUR_MS,
  MINUTE_MS,
  OVERSHOOT_PERCENT_THRESHOLD_PUBLIC,
  OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC,
  pickLastPlan,
  snapshotShowsBudgetExhausted,
} from './deferredPlanHistoryShared';

// Margin phrasing for the met headlines ("18 min before 01:00"). Composed
// from the SAME receipt duration formatters the Succeeded trio's "Ready" row
// uses (`formatMargin` in `deferredPlanHistoryReceipt.ts`) so the headline
// and the trio render the duration identically — one spacing convention,
// "1 h" never "1h" (review round 2 P2 #11). Floors to whole minutes so a
// sub-hour margin never rounds up across the hour boundary.
const formatDurationMs = (ms: number): string => {
  if (ms <= 0) return RECEIPT_DURATION_ZERO;
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  if (totalMinutes < 60) return formatReceiptDurationMinutes(totalMinutes);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return formatReceiptDurationHours(hours);
  return formatReceiptDurationHoursMinutes(hours, minutes);
};

// Outcome variant the postmortem resolver picks for a finalized entry.
// Concrete success/failure variants plus the `unknown` fallback so the
// consumer never has to handle null. Producer resolves the variant once;
// the view layer reads the resolved sentence and never re-derives.
export type DeferredPlanHistoryPostmortemVariant =
  | 'met-with-margin'
  | 'met-with-overshoot'
  | 'met-at-buzzer'
  // The device's own controller stopped drawing close to its setpoint, and
  // the idle classifier (`lib/observer/idleClassifier.ts`) reported
  // `near_target_idle` — at which point PELS marked the smart task done
  // without the progress series literally crossing the target. The result
  // chip stays the standard `'ok'` "Succeeded", but the postmortem
  // sentence is distinct so the user understands why the final reading is
  // below target.
  | 'met-by-stall'
  // The device parked at a stable plateau several degrees below the PELS
  // target while power cycled — the idle classifier reported `capped_idle`
  // (`lib/observer/idleClassifier.ts`). The device's own internal setpoint
  // cap is below the smart-task target, so the heater is doing the right
  // thing against its own limit while PELS commanded higher. The result
  // chip stays the standard `'ok'` "Succeeded", but the postmortem
  // sentence names the device's own setpoint cap (not the PELS hard cap,
  // per `feedback_hard_cap_is_physical.md`) as the cause.
  | 'met-by-device-cap'
  | 'missed-by-shortfall'
  | 'missed-by-budget-exhaustion'
  | 'abandoned-by-clear'
  | 'abandoned-by-unplug'
  | 'unknown';

export type DeferredPlanHistoryPostmortem = {
  variant: DeferredPlanHistoryPostmortemVariant;
  sentence: string;
};

const MET_AT_BUZZER_WINDOW_MS = HOUR_MS;
// Aliased to the module-private constants used by `formatPlanHistoryOvershootLine`
// so the two helpers can't drift on the threshold definition (5 °C / 10 %).
const OVERSHOOT_TEMPERATURE_THRESHOLD_C = OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC;
const OVERSHOOT_PERCENT_THRESHOLD = OVERSHOOT_PERCENT_THRESHOLD_PUBLIC;

// Format a resolved (unit-agnostic) value with the kind's unit suffix. Shared
// by the target / final-progress formatters so the value selection (resolver)
// and the unit format (kind) stay separated.
const formatValueWithUnit = (
  kind: 'temperature' | 'ev_soc',
  value: number | null,
): string | null => {
  if (value === null) return null;
  return kind === 'temperature' ? `${value.toFixed(1)} °C` : `${value.toFixed(0)} %`;
};

const formatTargetValue = (
  kind: 'temperature' | 'ev_soc',
  targetValue: number | null,
): string | null => formatValueWithUnit(kind, targetValue);

const formatFinalProgressValue = (
  kind: 'temperature' | 'ev_soc',
  finalProgressValue: number | null,
): string | null => formatValueWithUnit(kind, finalProgressValue);

const formatShortfallValue = (
  kind: 'temperature' | 'ev_soc',
  finalProgressValue: number | null,
  targetValue: number | null,
): string | null => {
  if (finalProgressValue === null || targetValue === null) return null;
  const gap = targetValue - finalProgressValue;
  if (gap <= 0) return null;
  return kind === 'temperature' ? `${gap.toFixed(1)} °C` : `${gap.toFixed(0)} %`;
};

// Detect whether a `met` outcome overshot the target meaningfully. Threshold
// matches the Smart-task UI design spec ("Notable extras: overshoot line if
// delivered > target by > 5 °C / 10 %"). The producer surfaces the overshoot
// to the postmortem sentence; the dedicated overshoot line copy lives in PR 6.
const wasOvershoot = (
  kind: 'temperature' | 'ev_soc',
  finalProgressValue: number | null,
  targetValue: number | null,
): boolean => {
  if (finalProgressValue === null || targetValue === null) return false;
  const threshold = kind === 'temperature'
    ? OVERSHOOT_TEMPERATURE_THRESHOLD_C
    : OVERSHOOT_PERCENT_THRESHOLD;
  return finalProgressValue - targetValue > threshold;
};

type PostmortemEntry = Pick<
  ResolvedDeferredObjectivePlanHistoryEntry,
  'outcome'
  | 'metReason'
  | 'objectiveKind'
  | 'targetValue'
  | 'finalProgressValue'
  | 'metAtMs'
  | 'deadlineAtMs'
  | 'finalizedAtMs'
  | 'finalPlan'
  | 'originalPlan'
  | 'discoveredFrom'
>;

type MetTimingLabels = {
  targetLabel: string;
  metAtLabel: string;
  deadlineLabel: string;
  marginMs: number;
};

// Bundles the three labels + margin that the met-postmortem sentences need.
// Returns null when any of the timing pieces are missing — the caller falls
// through to the plain "Reached the target before the deadline" copy.
const resolveMetTimingLabels = (
  entry: PostmortemEntry,
  timeZone: string,
): MetTimingLabels | null => {
  const targetLabel = formatTargetValue(entry.objectiveKind, entry.targetValue);
  const metAtLabel = entry.metAtMs !== null ? formatClockTime(entry.metAtMs, timeZone) : null;
  const deadlineLabel = formatClockTime(entry.deadlineAtMs, timeZone);
  const marginMs = entry.metAtMs === null ? null : entry.deadlineAtMs - entry.metAtMs;
  if (targetLabel === null
    || metAtLabel === null
    || deadlineLabel === null
    || marginMs === null
    || marginMs < 0) return null;
  return { targetLabel, metAtLabel, deadlineLabel, marginMs };
};

const resolveStalledMetPostmortem = (
  entry: PostmortemEntry,
): DeferredPlanHistoryPostmortem => {
  // The stall path's defining feature is that the final reading sits below
  // the configured target — the device's controller decided to stop
  // heating before we crossed it. Lead with the value we accepted, name
  // the target so the gap is obvious, and explicitly tell the user we
  // counted it as done. Falls through to a target-less plain sentence if
  // either piece is missing so a malformed entry still gets a sentence.
  const finalLabel = formatFinalProgressValue(entry.objectiveKind, entry.finalProgressValue);
  const targetLabel = formatTargetValue(entry.objectiveKind, entry.targetValue);
  if (finalLabel !== null && targetLabel !== null) {
    return {
      variant: 'met-by-stall',
      sentence: `Settled at ${finalLabel} — close enough to ${targetLabel} to call it done.`,
    };
  }
  return {
    variant: 'met-by-stall',
    sentence: 'The device settled close to its target and PELS counted the smart task as done.',
  };
};

const resolveDeviceCappedMetPostmortem = (
  entry: PostmortemEntry,
): DeferredPlanHistoryPostmortem => {
  // The capped-idle path's defining feature is that the device parked
  // several degrees below the PELS target because its own internal
  // setpoint cap is lower. The recourse the user can act on is on the
  // device itself — its setpoint cap noun (deliberately not "hard cap",
  // which is the PELS-canonical physical-line concept per
  // `feedback_hard_cap_is_physical.md`).
  const finalLabel = formatFinalProgressValue(entry.objectiveKind, entry.finalProgressValue);
  const targetLabel = formatTargetValue(entry.objectiveKind, entry.targetValue);
  if (finalLabel !== null && targetLabel !== null) {
    return {
      variant: 'met-by-device-cap',
      sentence: `Settled at ${finalLabel} against the device's own setpoint cap`
        + ` — PELS commanded ${targetLabel} but the device holds itself lower.`,
    };
  }
  return {
    variant: 'met-by-device-cap',
    sentence: 'The device reached its own setpoint cap below the smart task target'
      + ' — PELS counted the run as done.',
  };
};

const resolveMetPostmortem = (
  entry: PostmortemEntry,
  timeZone: string,
): DeferredPlanHistoryPostmortem => {
  // The stall promotion path is checked first so the postmortem reflects
  // the *reason* we marked the run done, not the timing math (which would
  // otherwise route a plateau that happens to fall in the final hour
  // through `met-at-buzzer`). The recorder only sets the stall metReasons
  // on outcomes it finalizes as `met`, so the field is authoritative once
  // present. `'stalled'` and `'stalled_device_capped'` produce distinct
  // sentences so the user understands whether the run landed inside the
  // hysteresis band or against the device's own internal cap.
  if (entry.metReason === 'stalled_device_capped') {
    return resolveDeviceCappedMetPostmortem(entry);
  }
  if (entry.metReason === 'stalled') {
    return resolveStalledMetPostmortem(entry);
  }
  const timing = resolveMetTimingLabels(entry, timeZone);
  const overshot = wasOvershoot(entry.objectiveKind, entry.finalProgressValue, entry.targetValue);
  if (overshot && timing !== null) {
    // The `Overshoot N °C` muted subline (rendered separately by
    // `DeadlinePlanHistoryDetail.tsx`) already carries the magnitude — folding
    // an em-dash "— overshot." tail into the headline made the `Succeeded`
    // chip + the headline read as a contradiction. Keep the headline shape
    // identical to `met-with-margin` so the chip is the only signal that
    // distinguishes "clean met" from "met-with-overshoot".
    // No trailing period on the "Hit …" timing headlines: the receipt trio's
    // "18 min before 01:00" detail tail renders period-less directly below,
    // and the same phrase once with and once without a period reads as a
    // typo — one convention (review round 2 P2 #11; mock history-v3).
    return {
      variant: 'met-with-overshoot',
      sentence: `Hit ${timing.targetLabel} at ${timing.metAtLabel}, before ${timing.deadlineLabel}`,
    };
  }
  // Met-at-buzzer: reached the target inside the last planned hour of the
  // window. The window length is hard-coded to one hour so the test is
  // independent of plan length — a deadline that hits 2 minutes early reads
  // the same whether the run was 6 or 24 hours.
  if (timing !== null && timing.marginMs <= MET_AT_BUZZER_WINDOW_MS) {
    return {
      variant: 'met-at-buzzer',
      sentence: `Hit ${timing.targetLabel} at ${timing.metAtLabel}, `
        + `${formatDurationMs(timing.marginMs)} before ${timing.deadlineLabel}`,
    };
  }
  if (timing !== null) {
    return {
      variant: 'met-with-margin',
      sentence: `Hit ${timing.targetLabel} at ${timing.metAtLabel}, `
        + `${formatDurationMs(timing.marginMs)} before ${timing.deadlineLabel}`,
    };
  }
  // Met but we lack the timing detail to compose the receipt sentence (legacy
  // entry without `metAtMs`, malformed deadline). Fall back to a plain
  // confirmation rather than null so the hero always carries a lead line.
  const targetLabel = formatTargetValue(entry.objectiveKind, entry.targetValue);
  return {
    variant: 'met-with-margin',
    sentence: targetLabel !== null
      ? `Reached ${targetLabel} before the deadline.`
      : 'Reached the target before the deadline.',
  };
};

const resolveMissedPostmortem = (
  entry: PostmortemEntry,
  timeZone: string,
): DeferredPlanHistoryPostmortem => {
  const lastPlan = pickLastPlan(entry);
  const deadlineLabel = formatClockTime(entry.deadlineAtMs, timeZone);
  if (snapshotShowsBudgetExhausted(lastPlan)) {
    // Budget-exhaustion gets the most specific copy — the user opening a
    // missed run needs to see that the cause was the budget cap, not a
    // device problem, so the recourse (lower daily budget) lands cleanly.
    return {
      variant: 'missed-by-budget-exhaustion',
      sentence: deadlineLabel !== null
        ? `The daily energy budget ran out before ${deadlineLabel}.`
        : 'The daily energy budget ran out before the deadline.',
    };
  }
  const finalLabel = formatFinalProgressValue(entry.objectiveKind, entry.finalProgressValue);
  const targetLabel = formatTargetValue(entry.objectiveKind, entry.targetValue);
  const shortfallLabel = formatShortfallValue(
    entry.objectiveKind,
    entry.finalProgressValue,
    entry.targetValue,
  );
  if (
    finalLabel !== null
      && targetLabel !== null
      && shortfallLabel !== null
      && deadlineLabel !== null
  ) {
    return {
      variant: 'missed-by-shortfall',
      sentence: `Reached ${finalLabel} by ${deadlineLabel} — ${shortfallLabel} short of ${targetLabel}.`,
    };
  }
  return {
    variant: 'missed-by-shortfall',
    sentence: 'Did not reach the target before the deadline.',
  };
};

const resolveAbandonedPostmortem = (
  entry: PostmortemEntry,
  timeZone: string,
): DeferredPlanHistoryPostmortem => {
  const finalizedLabel = formatClockTime(entry.finalizedAtMs, timeZone);
  // Outcome `'replaced'` is the user-swapped path: the user changed the
  // target / deadline so the previous in-progress run was wrapped up before
  // its deadline (see `DeferredObjectivePlanHistoryRecorder.finalizeForUserChange`).
  // `'abandoned'` covers two distinct underlying paths that aren't
  // distinguishable from the persisted outcome alone:
  //   - `finalizeForUserChange(..., 'abandoned')` when the user clears the
  //     deadline outright; and
  //   - the stale-diagnostic timeout path (`finalizeStaleRecords`) when the
  //     diagnostic stream stops while the deadline is still future — e.g.
  //     EV plugged out, thermal device offline beyond the grace window.
  // Without more signal in the schema, the copy stays kind-aware but
  // cause-neutral so neither branch claims a cause it cannot prove.
  if (entry.outcome === 'replaced') {
    return {
      variant: 'abandoned-by-clear',
      sentence: finalizedLabel !== null
        ? `You replaced this smart task at ${finalizedLabel}.`
        : 'You replaced this smart task before the deadline.',
    };
  }
  // `outcome === 'abandoned'` — either an explicit user-clear or a stale
  // diagnostic. We can't distinguish, so the copy says "stopped" rather
  // than asserting "unplugged" (which would be wrong for the clear path)
  // or "cleared" (which would be wrong for the unplug path). The kind
  // suffix names the most likely underlying device behaviour without
  // claiming a specific cause.
  const kindSuffix = entry.objectiveKind === 'ev_soc'
    ? ' (charger stopped reporting or the smart task was cleared)'
    : ' (device stopped reporting or the smart task was cleared)';
  return {
    variant: 'abandoned-by-unplug',
    sentence: finalizedLabel !== null
      ? `This smart task stopped at ${finalizedLabel}${kindSuffix}.`
      : `This smart task stopped before the deadline${kindSuffix}.`,
  };
};

/**
 * Composes a one-sentence postmortem for a finalized history entry.
 * Variants split across the three outcome shapes from
 * `notes/smart-task-ui/README.md` "Asymmetric treatment of failure":
 *
 *  - `met-with-margin`     — reached the target with > 1h to spare.
 *  - `met-with-overshoot`  — succeeded but the final reading exceeded the
 *                            target by > 5 °C or > 10 %.
 *  - `met-at-buzzer`       — reached the target inside the last planned hour.
 *  - `met-by-stall`        — idle classifier reported `near_target_idle`
 *                            (device parked inside the hysteresis band).
 *  - `met-by-device-cap`   — idle classifier reported `capped_idle` (device
 *                            parked at its own internal setpoint cap below
 *                            the PELS target).
 *  - `missed-by-shortfall` — final progress < target with no daily-budget
 *                            cause recorded.
 *  - `missed-by-budget-exhaustion` — the final revision recorded the daily
 *                                    budget cap collapsing buckets in the run-up.
 *  - `abandoned-by-clear`  — user cleared / replaced the smart task before
 *                            finalization (`outcome === 'replaced'`).
 *  - `abandoned-by-unplug` — diagnostic stream stopped before the deadline
 *                            (EV unplugged, device went offline).
 *
 * Returns the `unknown` variant rather than `null` so the consumer always
 * has a sentence to render — the panic visitor lands on a page that says
 * *something* about why, even when the schema can't fully recover the cause.
 *
 * `timeZone` is supplied by the caller (UI layer) so this stays free of any
 * runtime locale/Date helpers beyond `formatTimeInTimeZone`.
 *
 * Lives in shared-domain so structured log breadcrumbs and the history-detail
 * hero render the same sentence (per `feedback_ui_text_shared_with_logs.md`).
 */
export const formatPlanHistoryPostmortem = (
  entry: PostmortemEntry,
  timeZone = 'UTC',
): DeferredPlanHistoryPostmortem => {
  if (entry.outcome === 'met') return resolveMetPostmortem(entry, timeZone);
  if (entry.outcome === 'missed') return resolveMissedPostmortem(entry, timeZone);
  if (entry.outcome === 'abandoned' || entry.outcome === 'replaced') {
    return resolveAbandonedPostmortem(entry, timeZone);
  }
  // `outcome === 'unknown'` — the recorder couldn't classify (e.g. backfill
  // entry without progress data). Surface that honestly rather than invent a
  // success/failure narrative.
  if (entry.discoveredFrom === 'backfill') {
    return {
      variant: 'unknown',
      sentence: 'PELS was restarted during this smart task — the outcome was reconstructed from settings.',
    };
  }
  // When a plan was recorded (PR #1074: hero re-shows the collapsed chart
  // card as evidence) the bare "could not determine" sentence reads
  // disjointly next to the "View details" toggle — the user sees an
  // affordance but no preview of what they'd be expanding. Lead them to it
  // by naming the plan that the disclosure exposes.
  const hasRecordedPlan = entry.originalPlan !== null || entry.finalPlan !== null;
  if (hasRecordedPlan) {
    return {
      variant: 'unknown',
      sentence: "PELS made a plan for this smart task but couldn't observe how it finished.",
    };
  }
  return {
    variant: 'unknown',
    sentence: 'PELS could not determine how this smart task finished.',
  };
};
