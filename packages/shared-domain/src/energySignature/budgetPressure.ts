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
 * binding pace constraint, and managed devices are held back all day while the
 * model happily reports a good fit. The residual headroom (`residualQ80`/`Q90`)
 * is proportional control: one fixed nudge that cannot track a mismatch bigger
 * than itself.
 *
 * This term closes the loop instead. It watches what the controller actually
 * did — how long devices sat blocked with the DAILY BUDGET as the counting
 * cause, and by how much the home overshot the budget it was given — and
 * ratchets the suggestion up while that keeps happening, decaying back to zero
 * once it stops. It needs no diagnosis of *which* blind spot is biting.
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
 * A day counts as suppressed past this much censoring. Deliberately the same
 * one-hour bar the shipped raise-lean already used: this change is about WHEN
 * the correction may fire, not about re-tuning what counts as evidence.
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
 * Did PELS hold devices back on this day?
 *
 * Reads the censoring evidence the diagnostics layer already records. An earlier
 * version of this change added a budget-attributed counter so capacity-caused
 * holds could be filtered out — that was dropped, because instantaneous
 * attribution is the wrong granularity for a daily decision: a device blocked by
 * capacity in one hour can still run in another if the DAY had more budget, so
 * excluding those spans just under-counts real evidence. On the home this was
 * built from, capacity was the binding source in 0-8% of plan rebuilds, so the
 * filter bought almost no precision and cost a persisted field.
 */
export function dayWasBudgetSuppressed(record: WeatherDailyRecord): boolean {
  const suppression = record.suppression;
  if (!suppression) return false;
  return (suppression.targetDeficitMs ?? 0) >= MIN_SUPPRESSION_MS
    || (suppression.blockedByHeadroomMs ?? 0) >= MIN_SUPPRESSION_MS;
}

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
  // A day with no budget-attributed suppression means no pressure, and that is
  // true whether or not the day's overshoot could be measured — so this check
  // comes FIRST. Ordering it after the unmeasurable-hold below froze the term
  // forever once the owner switched the daily budget off: with no budget there
  // is nothing to stamp, every day became "unmeasurable", and the term (which
  // arms the auto-apply lowering guard) could never decay again.
  const decay = (): BudgetPressureState => {
    const decayed = carried * NO_OVERSHOOT_DECAY;
    return { kwh: decayed < NEGLIGIBLE_KWH ? 0 : decayed, throughDateKey: record.dateKey };
  };
  if (!dayWasBudgetSuppressed(record)) return decay();
  const overshootKwh = measuredBudgetOvershootKwh(record);
  // A SUPPRESSED day whose overshoot cannot be measured is genuinely ambiguous,
  // so hold. A boot catch-up rolling up an older day deliberately stamps no
  // budget rather than a stale one; letting that decay would mean a badly-timed
  // restart quietly erodes real evidence that the budget is too tight.
  if (overshootKwh === undefined) return { kwh: carried, throughDateKey: record.dateKey };
  // Grow only when the day ALSO ran past its budget. Suppression alone is a
  // duration threshold, and no threshold separates "the budget is too small"
  // from "the budget is doing its job" — holds are the normal output of a
  // working daily budget. The overshoot is the part that cannot be argued with:
  // a day that stayed inside its budget did not run out of budget. If devices
  // were still held back on such a day, the day's ALLOCATION was mis-shaped, and
  // inflating the daily total is the wrong tool for that (see TODO.md).
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
