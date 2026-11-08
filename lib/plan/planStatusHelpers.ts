import type { PhasePower } from './phase/phasePower';
import type { PelsStatus } from './pelsStatus';
import type { PriceLevel } from '../price/priceLevels';
import type {
  DevicePlan,
  PlanMeasuredMetaFields,
  PlanMeta,
  PlanUnmeasuredMetaFields,
} from './planTypes';

const PLAN_META_KW_STEP = 0.1;
const PLAN_META_KWH_STEP = 0.01;

export type PlanStatusInputChanges = {
  actionSignature?: string;
  detailSignature?: string;
  metaSignature?: string;
};

/**
 * ONE rounding helper, overloaded to preserve its input's nullish-ness.
 *
 * There were four — `roundRequired`, `roundNullable`, `roundOptional`,
 * `roundOptionalNullable` — doing identical arithmetic and differing only in
 * which absent-ness they threaded through. That fan-out was a symptom of the
 * meta type, where the same quantity was required in one place, optional in
 * another and both in a third. With `DevicePlan['meta']` saying what it means,
 * the callers no longer have to pick a variant and the compiler picks for them.
 *
 * The `typeof value !== 'number'` guard is load-bearing for the nullish
 * overloads and not merely an early return: `Math.round(null / 0.1) * 0.1` is
 * `0`, so without it a "no reading" `null` would round into a real-looking
 * zero. For a finite number the guard changes nothing (rounding `NaN` is `NaN`
 * either way), so the required overload behaves exactly as `roundRequired` did.
 */
function roundTo(value: number, step: number): number;
function roundTo(value: number | null, step: number): number | null;
function roundTo(value: number | undefined, step: number): number | undefined;
function roundTo(value: number | null | undefined, step: number): number | null | undefined;
function roundTo(value: number | null | undefined, step: number): number | null | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.round(value / step) * step;
}

const normalizeMinutesRemaining = (value: number): number => {
  if (!Number.isFinite(value)) return value;
  return Math.max(0, Math.round(value));
};

const normalizeDailyPaceComposition = (
  meta: DevicePlan['meta'],
): Pick<DevicePlan['meta'], 'dailySoftLimitKw' | 'budgetPaceKw' | 'projectedExemptKw'> => {
  const dailySoftLimitKw = roundTo(meta.dailySoftLimitKw, PLAN_META_KW_STEP);
  const projectedExemptKw = roundTo(meta.projectedExemptKw, PLAN_META_KW_STEP);
  const hasCompleteComposition = typeof dailySoftLimitKw === 'number'
    && Number.isFinite(dailySoftLimitKw)
    && typeof projectedExemptKw === 'number'
    && Number.isFinite(projectedExemptKw)
    && typeof meta.budgetPaceKw === 'number'
    && Number.isFinite(meta.budgetPaceKw);

  return {
    dailySoftLimitKw,
    budgetPaceKw: hasCompleteComposition
      ? Number((dailySoftLimitKw - projectedExemptKw).toFixed(1))
      : roundTo(meta.budgetPaceKw, PLAN_META_KW_STEP),
    projectedExemptKw,
  };
};

// Rounded like every other published kW, so a phase moving a few watts does not change the plan signature.
const roundPhasePower = (power: PhasePower): PhasePower => (
  power.kind === 'off' ? power : {
    kind: 'on',
    phases: power.phases.map((phase) => ({
      ...phase,
      drawKw: roundTo(phase.drawKw, PLAN_META_KW_STEP),
      targetKw: roundTo(phase.targetKw, PLAN_META_KW_STEP),
      roomKw: roundTo(phase.roomKw, PLAN_META_KW_STEP),
    })),
  }
);

// The measured figures, rounded — or nothing, on the unmeasured build. The one
// branch on the signal this normalizer makes; it keeps the meta's variant intact.
const normalizeMeasuredMetaFields = (
  meta: PlanMeta,
): PlanMeasuredMetaFields | PlanUnmeasuredMetaFields => (
  meta.powerIsMeasured
    ? {
      powerIsMeasured: true,
      physicalLimitBreached: meta.physicalLimitBreached,
      phase: roundPhasePower(meta.phase),
      unrelievedPhase: meta.unrelievedPhase,
      headroomKw: roundTo(meta.headroomKw, PLAN_META_KW_STEP),
      shortfallBudgetHeadroomKw: roundTo(meta.shortfallBudgetHeadroomKw, PLAN_META_KW_STEP),
      hardCapHeadroomKw: roundTo(meta.hardCapHeadroomKw, PLAN_META_KW_STEP),
      controlledKw: roundTo(meta.controlledKw, PLAN_META_KW_STEP),
      uncontrolledKw: roundTo(meta.uncontrolledKw, PLAN_META_KW_STEP),
    }
    : { powerIsMeasured: false }
);

export const normalizePlanMeta = (meta: DevicePlan['meta']): DevicePlan['meta'] => {
  const dailyPaceComposition = normalizeDailyPaceComposition(meta);
  return {
    ...meta,
    totalKw: roundTo(meta.totalKw, PLAN_META_KW_STEP),
    // The `?? meta.softLimitKw` tail this used to carry existed only to restore
    // required-ness after `roundOptional` widened it to `| undefined`. The
    // overload keeps a required number required, so the tail is gone.
    //
    // A grid-bound soft limit IS the grid import target (`resolveSoftLimitSource`
    // answers `'grid'` only when the target is the binding minimum), and the
    // target is not rounded here, so neither is the limit: the two keep reading
    // the same number.
    softLimitKw: meta.softLimitSource === 'grid'
      ? meta.softLimitKw : roundTo(meta.softLimitKw, PLAN_META_KW_STEP),
    capacitySoftLimitKw: roundTo(meta.capacitySoftLimitKw, PLAN_META_KW_STEP),
    ...dailyPaceComposition,
    shortfallBudgetThresholdKw: roundTo(meta.shortfallBudgetThresholdKw, PLAN_META_KW_STEP),
    hardCapLimitKw: roundTo(meta.hardCapLimitKw, PLAN_META_KW_STEP),
    hourUsedKWh: roundTo(meta.hourUsedKWh, PLAN_META_KWH_STEP),
    usedKWh: roundTo(meta.usedKWh, PLAN_META_KWH_STEP),
    budgetKWh: roundTo(meta.budgetKWh, PLAN_META_KWH_STEP),
    capacityLimitKw: roundTo(meta.capacityLimitKw, PLAN_META_KW_STEP),
    minutesRemaining: normalizeMinutesRemaining(meta.minutesRemaining),
    hourControlledKWh: roundTo(meta.hourControlledKWh, PLAN_META_KWH_STEP),
    hourUncontrolledKWh: roundTo(meta.hourUncontrolledKWh, PLAN_META_KWH_STEP),
    dailyBudgetRemainingKWh: roundTo(meta.dailyBudgetRemainingKWh, PLAN_META_KWH_STEP),
    dailyBudgetHourKWh: roundTo(meta.dailyBudgetHourKWh, PLAN_META_KWH_STEP),
    ...normalizeMeasuredMetaFields(meta),
  };
};

// `lastPowerUpdate` arrives already bucketed (`PlanStatusWriter.compute`), so it
// passes through as-is.
export const normalizePelsStatus = (status: PelsStatus): PelsStatus => {
  return {
    ...status,
    headroomKw: roundTo(status.headroomKw, PLAN_META_KW_STEP),
    powerLimitKw: roundTo(status.powerLimitKw, PLAN_META_KW_STEP),
    hourlyUsageKwh: roundTo(status.hourlyUsageKwh, PLAN_META_KWH_STEP) ?? status.hourlyUsageKwh,
    dailyBudgetRemainingKwh: roundTo(status.dailyBudgetRemainingKwh, PLAN_META_KWH_STEP),
    shortfallBudgetThresholdKw: roundTo(status.shortfallBudgetThresholdKw, PLAN_META_KW_STEP),
    shortfallBudgetHeadroomKw: roundTo(status.shortfallBudgetHeadroomKw, PLAN_META_KW_STEP),
    hardCapHeadroomKw: roundTo(status.hardCapHeadroomKw, PLAN_META_KW_STEP),
    totalKw: roundTo(status.totalKw, PLAN_META_KW_STEP),
    controlledKw: roundTo(status.controlledKw, PLAN_META_KW_STEP),
    uncontrolledKw: roundTo(status.uncontrolledKw, PLAN_META_KW_STEP),
  };
};

export const normalizeLastPowerUpdate = (
  lastPowerUpdate: number,
  powerBucketMs: number,
): number => {
  const safeBucketMs = Math.max(1, powerBucketMs);
  return Math.floor(lastPowerUpdate / safeBucketMs) * safeBucketMs;
};

const resolveDryRunKey = (dryRunEffective: boolean): string => (dryRunEffective ? 'sim' : 'live');

/**
 * The facts whose change publishes a status at once, inside the volatile
 * throttle. Each is something a reader acts on as soon as it flips:
 *
 * - `dryRunEffective`: the effective (membership-gated) dry-run. Control
 *   activating from an already-planned dry-run shed, or the membership gate
 *   opening, must reach the Limits card promptly, not still read "Simulating".
 * - `powerIsMeasured`: whether the plan was measured (`powerKnown` on the
 *   blob). The one unmeasured build, the silent-meter fail-closed pass, omits
 *   every measured figure, and after it the silence block stops rebuilding; a
 *   swallowed write would leave the widget and the Insights capabilities
 *   asserting a measured headroom for the whole outage.
 * - `capacityShortfall`: the capacity guard's shortfall. The Insights device's
 *   Manual action needed and the Limits card's shortfall line mirror it, and a
 *   shortfall usually starts with every device already held, when no action
 *   changes to force the write.
 */
export type StatusPublishFacts = {
  dryRunEffective: boolean;
  powerIsMeasured: boolean;
  capacityShortfall: boolean;
};

export const buildPelsStatusInputKey = (
  changes: PlanStatusInputChanges | undefined,
  // The RESOLVED level, which is what the status actually depends on. Keying on
  // the two raw flags plus a shape check of the price blob re-derived it here,
  // in a second copy of the precedence the status itself applied.
  priceLevel: PriceLevel,
  lastPowerUpdate: number,
  facts: StatusPublishFacts,
): string => {
  const actionSignature = changes?.actionSignature ?? '';
  const detailSignature = changes?.detailSignature ?? '';
  const metaSignature = changes?.metaSignature ?? '';
  const lastPowerUpdateKey = String(lastPowerUpdate);
  // The FLAG, not the figure: the figure moves every sample and would bust
  // the status cache on each one. What must bust it is the transition between
  // having a measurement and not.
  const powerNowKey = facts.powerIsMeasured ? 'known' : 'unknown';
  // Fold the effective dry-run in so a posture flip (membership becoming ready,
  // or the persisted flag toggled) busts the cache and forces a status write.
  const dryRunKey = resolveDryRunKey(facts.dryRunEffective);
  // And the shortfall, which a publish forced by its change must carry.
  const shortfallKey = facts.capacityShortfall ? 'shortfall' : 'ok';
  return [
    actionSignature,
    detailSignature,
    metaSignature,
    priceLevel,
    lastPowerUpdateKey,
    powerNowKey,
    dryRunKey,
    shortfallKey,
  ].join('|');
};
