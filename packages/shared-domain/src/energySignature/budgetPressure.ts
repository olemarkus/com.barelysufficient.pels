import type {
  BudgetPressureState,
  WeatherDailyRecord,
} from '../../../contracts/src/weatherAdvisorTypes';

/**
 * The budget-pressure loop: the integral half of the daily-budget suggestion.
 *
 * The energy signature is a *model* of what the home usually needs. It has real
 * blind spots — an away stretch sitting in the fit as ordinary warm-regime days,
 * a new EV, an occupancy change — and every one of them shows up the same way:
 * the suggested budget lands under real demand, the daily budget becomes the
 * binding pace constraint, and the home gets genuinely hurt while the model
 * happily reports a good fit. The residual headroom (`residualQ80`/`Q90`) is
 * proportional control: one fixed nudge that cannot track a mismatch bigger
 * than itself.
 *
 * This term closes the loop instead, on the owner's damage model: **deferral is
 * the feature working; only unserved denial is damage.** A device held at noon
 * and admitted at one contributed nothing — the budget shaped the day and the
 * home got its energy. The evidence that grows this term is the day-close
 * verdict (`budgetDeniedKwh`): energy the budget was still denying latched
 * devices when the local day ended, plus however far the day measurably ran
 * past its budget. Days without damage decay the term — including days that
 * overshot but denied nothing, because a budget that hurt nobody needs no
 * correction.
 *
 * It composes with the residual headroom rather than duplicating it: the step is
 * measured against the budget that was actually applied, which already carried
 * that headroom, so what accumulates here is the error the proportional term
 * left behind.
 *
 * Layering: this is pure and browser-safe. It consumes only the flat evidence
 * already stamped on `WeatherDailyRecord` at rollup. Diagnostics never reaches
 * the planner — the loop's one and only output is the *suggested* budget, which
 * still passes through the user's auto-apply opt-in.
 */

/**
 * Legacy bar for records written before the day-close verdict existed: a day
 * counted as suppressed past this much hold-time censoring. Those records keep
 * the meaning they were written with; verdict-bearing records never reach it.
 */
const MIN_SUPPRESSION_MS = 60 * 60 * 1000;
/** One day may add at most this much, so the loop ramps instead of jumping. */
const MAX_STEP_KWH = 10;
/**
 * Leak applied on every day that did NOT overshoot its budget. A leaky
 * integrator is what keeps this honest: without it the term would only ever
 * grow, and it would never discover that the budget it pushed up is now more
 * than the home needs. Gentle enough that one mild day cannot undo a week of
 * evidence.
 */
const NO_OVERSHOOT_DECAY = 0.75;
/**
 * Below this the term is spent, and it snaps to EXACTLY zero. Load-bearing, not
 * cosmetic: 0.75^n never reaches zero, and a non-zero term keeps auto-apply's
 * lowering guard armed forever. Without the snap a home could never have its
 * budget automatically lowered again after one suppressed stretch.
 */
const NEGLIGIBLE_KWH = 0.25;
/**
 * The term may not push the suggestion more than half again over what the model
 * predicts. Generous enough to cover the mismatches actually seen (an away-biased
 * base load ran ~40% low), tight enough that a stuck meter or a misattributed
 * device cannot double a home's budget.
 */
export const PRESSURE_CEILING_FRACTION = 0.5;
/**
 * Absolute backstop for the accumulator when no prediction is available to bound
 * it against. Kept close to the reachable output rather than far above it: an
 * accumulator allowed to run far past what the suggestion can apply is classic
 * integrator windup — it would keep integrating with no visible effect, then owe
 * the owner a week of decay before the correction even began to relax.
 */
const MAX_ACCUMULATED_KWH = 40;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const isFinitePositive = (value: number | undefined): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

/**
 * Did the daily budget DAMAGE the home on this day?
 *
 * Damage is the day-close verdict: an episode still latched when the local day
 * ended, attributed to the daily budget — deferred-then-served holds are the
 * feature working and count for nothing. When the verdict is present it is
 * authoritative either way; a recorded 0 means "watched to the close, nothing
 * denied" and must NOT fall through to the legacy counters, which measured
 * something weaker (hold time, served or not) and would re-arm the loop on
 * ordinary shaping.
 *
 * Cause attribution here is deliberate and does not conflict with the old
 * "no instantaneous attribution" rule: at day close, "the budget was still
 * denying this device when the day ran out" is exactly the day-granularity
 * question that rule said instantaneous filtering could not answer.
 *
 * Records written before the verdict existed fall back to the legacy hold-time
 * bar, keeping the meaning they were written with.
 */
export function dayWasBudgetDamaged(record: WeatherDailyRecord): boolean {
  const suppression = record.suppression;
  if (!suppression) return false;
  if (typeof suppression.budgetDeniedKwh === 'number' && Number.isFinite(suppression.budgetDeniedKwh)) {
    return suppression.budgetDeniedKwh > 0;
  }
  // A verdict-capable build watched this day but could not witness its close
  // (restart / gap / catch-up). Unprovable is not damage — and the legacy
  // counters below must not answer for it, because they count served deferrals.
  if (suppression.budgetDeniedUnwitnessed === true) return false;
  return (suppression.targetDeficitMs ?? 0) >= MIN_SUPPRESSION_MS
    || (suppression.blockedByHeadroomMs ?? 0) >= MIN_SUPPRESSION_MS;
}

/** The day-close denied energy, 0 when absent or junk. */
const deniedKwhOf = (record: WeatherDailyRecord): number => {
  const value = record.suppression?.budgetDeniedKwh;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * How far the day overran the budget it was given, or `undefined` when that
 * cannot be measured (no kWh total, or no budget stamped — a boot catch-up
 * rolling up an older day deliberately stamps none rather than a stale one).
 */
export function measuredBudgetOvershootKwh(record: WeatherDailyRecord): number | undefined {
  // A day the power tracker flagged unreliable is not evidence. The fit already
  // refuses it, and this term WRITES A SETTING — the "stuck meter" case must not
  // be allowed to grow the budget through a gap the model itself distrusts.
  // (Checked inline rather than through `isUsableSignatureDay` to keep this
  // module free of a cycle with `energySignature.ts`, which imports from here.)
  if (record.quality.unreliablePower) return undefined;
  if (!isFinitePositive(record.appliedBudgetKwh)) return undefined;
  if (typeof record.kwhTotal !== 'number' || !Number.isFinite(record.kwhTotal)) return undefined;
  return Math.max(0, record.kwhTotal - record.appliedBudgetKwh);
}

/**
 * Folds one closed day into the term. Days at or before `throughDateKey` are
 * ignored, which makes repeat rollups and boot catch-ups idempotent — the loop
 * must integrate each day exactly once or a restart would inflate it.
 */
export function foldBudgetPressureDay(
  previous: BudgetPressureState | undefined,
  record: WeatherDailyRecord,
  /**
   * Anti-windup bound: the largest value the suggestion could actually apply,
   * i.e. `PRESSURE_CEILING_FRACTION × predictedKwh` for the day. Pass it whenever
   * a prediction is known. Integrating past what the output can express is what
   * puts dead time between "the budget is adequate now" and "the loop notices".
   */
  applicableCeilingKwh?: number,
): BudgetPressureState {
  if (previous !== undefined && record.dateKey <= previous.throughDateKey) return previous;
  const ceilingKwh = isFinitePositive(applicableCeilingKwh)
    ? Math.min(applicableCeilingKwh, MAX_ACCUMULATED_KWH)
    : MAX_ACCUMULATED_KWH;
  const carried = Math.min(previous?.kwh ?? 0, ceilingKwh);
  // An undamaged day means no pressure, and that is true whether or not the
  // day's overshoot could be measured — so this check comes FIRST. Ordering it
  // after the unmeasurable-hold below froze the term forever once the owner
  // switched the daily budget off: with no budget there is nothing to stamp,
  // every day became "unmeasurable", and the term (which arms the auto-apply
  // lowering guard) could never decay again.
  //
  // Note what this decays THROUGH under the day-close model: a day that overshot
  // its budget but denied nothing. The overshoot alone says the estimate ran
  // low; if nobody was hurt, the budget needs no correction — the estimate for
  // tomorrow is the fit's job, not this term's.
  const decay = (): BudgetPressureState => {
    const decayed = carried * NO_OVERSHOOT_DECAY;
    return { kwh: decayed < NEGLIGIBLE_KWH ? 0 : decayed, throughDateKey: record.dateKey };
  };
  if (!dayWasBudgetDamaged(record)) return decay();
  const overshootKwh = measuredBudgetOvershootKwh(record);
  const deniedKwh = deniedKwhOf(record);
  if (deniedKwh > 0) {
    // Verdict-bearing damage: grow by the energy the budget was still denying at
    // day close, plus however far the day measurably ran past its budget. The
    // denied energy is the failure measure in its own right — a day the budget
    // held everything in check WHILE denying a device shows no overshoot at all,
    // precisely because the denial worked — so an unmeasurable or zero overshoot
    // does not hold or shrink the step; it is simply absent from it. (The
    // overshoot side stays meter-gated via `measuredBudgetOvershootKwh`; the
    // denied side comes from diagnostics, not the meter, so an unreliable-power
    // day still grows by the denial it proved.)
    return {
      kwh: Math.min(carried + clamp(deniedKwh + Math.max(0, overshootKwh ?? 0), 0, MAX_STEP_KWH), ceilingKwh),
      throughDateKey: record.dateKey,
    };
  }
  // Legacy records (no verdict): the rules they were written under, verbatim.
  // An unmeasurable overshoot holds (a badly-timed restart must not erode real
  // evidence); a day inside its budget decays; a day past it grows by the
  // overshoot.
  if (overshootKwh === undefined) return { kwh: carried, throughDateKey: record.dateKey };
  if (overshootKwh <= 0) return decay();
  return {
    kwh: Math.min(carried + clamp(overshootKwh, 0, MAX_STEP_KWH), ceilingKwh),
    throughDateKey: record.dateKey,
  };
}

/**
 * The term as the suggestion should apply it: the accumulated kWh, bounded by a
 * fraction of what the model predicts for the day. The relative ceiling lives
 * here rather than in the accumulator because the prediction is only known at
 * suggestion time, and it is what stops a broken signal from doubling a budget.
 */
export function resolveBudgetPressureKwh(params: {
  state: BudgetPressureState | undefined;
  predictedKwh: number;
  ceilingFraction: number;
}): number {
  const { state, predictedKwh, ceilingFraction } = params;
  const accumulated = state?.kwh ?? 0;
  if (!Number.isFinite(accumulated) || accumulated <= 0) return 0;
  if (!Number.isFinite(predictedKwh) || predictedKwh <= 0) return 0;
  return clamp(accumulated, 0, ceilingFraction * predictedKwh);
}
