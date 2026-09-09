import { PriceLevel } from '../price/priceLevels';
import { PLAN_REASON_CODES, type DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  computeProjectedHourEnergyKWh,
  isProjectedOverHardCap,
} from '../../packages/shared-domain/src/hourEnergyProjection';
import type { DevicePlan, DevicePlanDevice, PlanMeta } from './planTypes';
import { NEUTRAL_STARTUP_HOLD_REASON } from './restore/devices';

/**
 * The live status of a home, published by its plan service into
 * `planStatusRegistry.ts` and read by the settings-UI API, the headroom widget
 * and the Insights driver — whose capabilities mirror these fields by name, so
 * a published field is a contract even when nothing else in the repo reads it.
 */
export type PelsStatus = {
  /**
   * JSON-omitted when the plan behind this status had no measurement
   * (`powerKnown: false`): the blob carries no headroom then rather than a
   * stand-in number an automation could compare against (owner ruling
   * 2026-09-02). The same goes for the other measured figures below. Omission
   * is how this blob spells "not measured" (`totalKw` included);
   * `powerNowKw` is the one field whose `null` spelling predates that and stays.
   */
  headroomKw?: number;
  hourlyLimitKw?: number;
  hourlyUsageKwh: number;
  dailyBudgetRemainingKwh?: number;
  dailyBudgetExceeded?: boolean;
  limitReason?: 'none' | 'hourly' | 'daily' | 'both';
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  shortfallBudgetHeadroomKw?: number | null;
  hardCapHeadroomKw?: number | null;
  projectedOverHardCap?: boolean;
  totalKw?: number;
  controlledKw?: number;
  uncontrolledKw?: number;
  powerNowKw?: number | null;
  powerKnown?: boolean;
  priceLevel: PriceLevel;
  devicesOn: number;
  devicesOff: number;
  /**
   * Always a number on every write this app makes: a status is computed from a
   * plan, a plan exists only behind the measurement gate, and the gate implies
   * a stamped sample. (Old persisted blobs may carry `null`; readers of the
   * PERSISTED shape classify that at their own adapter.)
   */
  lastPowerUpdate: number;
  /**
   * The dry-run the writing home's PLANNER gates on. A meter area's folds in its
   * membership and source-epoch gates, so it is genuinely effective; Main's is
   * the persisted intent, because Main's separate actuation fence
   * (`isMainActuationFenced`) is applied at the actuator seam and not to the
   * planner. So Main can read "active" here inside its boot fence window. The
   * name is the one the field has published since R7b and is kept.
   */
  dryRunEffective: boolean;
};

export function buildPelsStatus(params: {
  plan: DevicePlan;
  /**
   * Producer-resolved (`PriceService.getCurrentHourPriceLevel`), including the
   * `UNKNOWN` case. This used to arrive as two raw flags plus the combined-price
   * blob, which the status then shape-checked to decide whether a level existed
   * at all — a consumer re-deriving what the price service already knew, and the
   * reason the status had to read the (uncached) price store to build at all.
   */
  priceLevel: PriceLevel;
  lastPowerUpdate: number;
  /**
   * The dry-run this home's planner gates on — `getCapacityDryRun()`, which for
   * a meter area folds in the R7b boot-window zone-tree gate (persisted-live but
   * no committed zone tree still reads Simulating on its Limits card) and for
   * Main is the persisted intent, per the field doc above. EVERY home has one
   * and writes it. The main home used to pass `undefined` to keep its blob
   * byte-identical, which made one optional boolean carry two orthogonal
   * meanings — actuation posture AND home kind — and left main's own posture
   * flips invisible to the write-forcing that exists for that transition.
   */
  dryRunEffective: boolean;
}): PelsStatus {
  const { plan, priceLevel, lastPowerUpdate, dryRunEffective } = params;
  const summary = summarizePlanForStatus(plan);
  const limitReason = resolveLimitReason(plan, summary);
  return {
    ...resolveMeasuredStatusFields(plan.meta),
    hourlyLimitKw: plan.meta.softLimitKw,
    hourlyUsageKwh: plan.meta.usedKWh ?? 0,
    dailyBudgetRemainingKwh: plan.meta.dailyBudgetRemainingKWh ?? 0,
    dailyBudgetExceeded: plan.meta.dailyBudgetExceeded ?? false,
    limitReason,
    capacityShortfall: plan.meta.capacityShortfall ?? false,
    shortfallBudgetThresholdKw: plan.meta.shortfallBudgetThresholdKw,
    priceLevel,
    devicesOn: summary.devicesOn,
    devicesOff: summary.devicesOff,
    lastPowerUpdate,
    dryRunEffective,
  };
}

/**
 * The status blob's measured figures, from the meta's measured variant — the
 * one branch on the signal this writer makes. An unmeasured plan contributes
 * nothing here, so the persisted blob spells "no measurement" by JSON omission
 * (its existing convention — `totalKw` too) and never by a
 * number; `powerNowKw` keeps its published `null` spelling.
 *
 * `hardCapHeadroomKw`: no PELS surface consumes it any more (the headroom
 * widget moved to `projectedOverHardCap`); kept because the field names are
 * the shape the Insights driver and the widget were built against.
 */
function resolveMeasuredStatusFields(
  meta: PlanMeta,
): Pick<
  PelsStatus,
  | 'powerNowKw' | 'powerKnown' | 'headroomKw' | 'shortfallBudgetHeadroomKw'
  | 'hardCapHeadroomKw' | 'controlledKw' | 'uncontrolledKw' | 'totalKw'
  | 'projectedOverHardCap'
> {
  // `powerNowKw` is the status's "measured draw or null" and `powerKnown` its
  // backward-compatible twin; the driver and the widget were built against
  // both, so both keep their published spelling.
  if (!meta.powerIsMeasured) return { powerNowKw: null, powerKnown: false };
  return {
    powerNowKw: meta.totalKw,
    powerKnown: true,
    // Same figure as `powerNowKw`, under the name the blob has published for a
    // meter area since R7b. No PELS surface reads it — the per-home Limits card
    // reads `powerNowKw` — and it is kept for the same reason as
    // `hardCapHeadroomKw` below: a field the status has shipped is not withdrawn
    // on the strength of having no reader in this repo. What DID change is that it used
    // to be resolved out in `buildPelsStatus` from `dryRunEffective !== undefined`
    // — i.e. from home kind — which both overloaded that boolean and published
    // the figure on a meter area's UNMEASURED plan.
    totalKw: meta.totalKw,
    // A projection FROM the reading, so it stands or falls with the reading. On
    // the silent-meter fail-closed pass `meta.totalKw` is the carried pre-outage
    // kW, and publishing a cap-trajectory verdict derived from it — beside a blob
    // that withholds every figure it was derived from — is the same stand-in an
    // automation could compare against that the omission ruling (2026-09-02)
    // keeps out, wearing a boolean instead of a number. The silence block stops
    // rebuilding after that pass, so such a verdict would sit frozen in the blob
    // for the whole outage with nothing scheduled to correct it.
    projectedOverHardCap: resolveProjectedOverHardCap(meta),
    headroomKw: meta.headroomKw,
    shortfallBudgetHeadroomKw: meta.shortfallBudgetHeadroomKw,
    hardCapHeadroomKw: meta.hardCapHeadroomKw,
    controlledKw: meta.controlledKw,
    uncontrolledKw: meta.uncontrolledKw,
  };
}

// "Above hard cap" is a trajectory judgement: the hour is on pace to land past
// the cap's hourly kWh. Never derived from instantaneous kW vs the cap — the
// cap is an hourly-average tariff-step ceiling, and no control path treats a
// momentary excursion as a breach to correct directly (instantaneous over-cap
// only escalates plan-rebuild urgency and shortfall-detection timing — see
// `lib/plan/rebuildScheduler`, `lib/power/capacityGuard.ts`;
// `notes/ui-terminology.md` § "Hard cap is an hourly ceiling"). Consumed by
// the headroom widget's danger state so it reconciles with the Overview
// hero's chip, which computes the same projection and predicate live via the
// shared helpers.
function resolveProjectedOverHardCap(meta: PlanMeta): boolean {
  const { totalKw, usedKWh, minutesRemaining, hardCapLimitKw } = meta;
  if (typeof totalKw !== 'number' || typeof usedKWh !== 'number'
    || typeof minutesRemaining !== 'number' || typeof hardCapLimitKw !== 'number') {
    return false;
  }
  const projectedKWh = computeProjectedHourEnergyKWh({
    usedKWh,
    totalKw,
    minutesRemainingInHour: minutesRemaining,
  });
  return isProjectedOverHardCap({ projectedKWh, hardCapKWh: hardCapLimitKw });
}

type LimitSource = DevicePlan['meta']['softLimitSource'];

type SharedLimitParams = {
  plan: DevicePlan;
  summary: PlanStatusSummary;
  hasLimitDrivenShedDevices: boolean;
  headroomNegative: boolean;
};

type HourlyLimitParams = SharedLimitParams & {
  limitSource: LimitSource;
  capacitySourceActive: boolean;
};

type DailyLimitParams = SharedLimitParams & {
  dailySourceActive: boolean;
};

type PlanStatusSummary = {
  devicesOn: number;
  devicesOff: number;
  hasLimitDrivenShedDevices: boolean;
  hasHourlyReason: boolean;
  hasDailyReason: boolean;
};

// The `|| limitSource === 'both'` arms these used to carry were dead: the
// producer (`resolveSoftLimitSource`) answers `'capacity'` when the two paces
// coincide, never a third "both" state. Not to be confused with `limitReason`
// below, whose four-member union DOES include a real `'both'`.
function isDailySourceActive(limitSource: LimitSource): boolean {
  return limitSource === 'daily';
}

function isCapacitySourceActive(limitSource: LimitSource): boolean {
  return limitSource === 'capacity';
}

function isRestoreHoldShedReason(reason: DeviceReason): boolean {
  return reason.code === PLAN_REASON_CODES.meterSettling
    || reason.code === PLAN_REASON_CODES.cooldownRestore
    || reason.code === PLAN_REASON_CODES.restoreThrottled
    || reason.code === NEUTRAL_STARTUP_HOLD_REASON.code
    || reason.code === PLAN_REASON_CODES.restorePending;
}

function isLimitDrivenShedDevice(device: DevicePlanDevice): boolean {
  if (device.plannedState !== 'shed') return false;
  return !isRestoreHoldShedReason(device.reason);
}

function resolveReasonFlags(reason: DeviceReason): {
  hasHourlyReason: boolean;
  hasDailyReason: boolean;
} {
  if (reason.code === NEUTRAL_STARTUP_HOLD_REASON.code) {
    return {
      hasHourlyReason: false,
      hasDailyReason: false,
    };
  }
  return {
    hasHourlyReason: reason.code === PLAN_REASON_CODES.hourlyBudget || reason.code === PLAN_REASON_CODES.capacity,
    hasDailyReason: reason.code === PLAN_REASON_CODES.dailyBudget,
  };
}

function summarizePlanForStatus(plan: DevicePlan): PlanStatusSummary {
  const summary: PlanStatusSummary = {
    devicesOn: 0,
    devicesOff: 0,
    hasLimitDrivenShedDevices: false,
    hasHourlyReason: false,
    hasDailyReason: false,
  };

  for (const device of plan.devices) {
    if (device.control.commandAuthority) {
      if (device.plannedState === 'shed') {
        summary.devicesOff += 1;
      } else if (device.plannedState === 'keep') {
        summary.devicesOn += 1;
      }
    }

    if (device.plannedState !== 'shed') continue;

    const reasonFlags = resolveReasonFlags(device.reason);
    summary.hasHourlyReason = summary.hasHourlyReason || reasonFlags.hasHourlyReason;
    summary.hasDailyReason = summary.hasDailyReason || reasonFlags.hasDailyReason;
    summary.hasLimitDrivenShedDevices = summary.hasLimitDrivenShedDevices || isLimitDrivenShedDevice(device);
  }

  return summary;
}

function resolveHourlyLimited(params: HourlyLimitParams): boolean {
  const {
    plan,
    summary,
    hasLimitDrivenShedDevices,
    headroomNegative,
    limitSource,
    capacitySourceActive,
  } = params;
  const hourlyLimitedByReason = summary.hasHourlyReason;
  const hourlyLimitedByShedState = hasLimitDrivenShedDevices && capacitySourceActive;
  const hourlyLimitedByNegativeHeadroom = headroomNegative && (limitSource ? capacitySourceActive : true);
  return Boolean(plan.meta.hourlyBudgetExhausted)
    || hourlyLimitedByReason
    || hourlyLimitedByShedState
    || hourlyLimitedByNegativeHeadroom;
}

function resolveDailyLimited(params: DailyLimitParams): boolean {
  const { summary, hasLimitDrivenShedDevices, headroomNegative, dailySourceActive } = params;
  const dailyLimitedByReason = summary.hasDailyReason;
  const dailyLimitedByShedState = hasLimitDrivenShedDevices && dailySourceActive;
  const dailyLimitedByNegativeHeadroom = headroomNegative && dailySourceActive;
  return dailyLimitedByReason || dailyLimitedByShedState || dailyLimitedByNegativeHeadroom;
}

function resolveLimitReason(plan: DevicePlan, summary: PlanStatusSummary): 'none' | 'hourly' | 'daily' | 'both' {
  // Both claims require a MEASUREMENT this cycle: `headroomKw` exists only on
  // the measured meta, so the narrowing is also what makes it readable.
  const hasShedDevices = plan.meta.powerIsMeasured && summary.hasLimitDrivenShedDevices;
  const headroomNegative = plan.meta.powerIsMeasured && plan.meta.headroomKw < 0;
  const limitSource = plan.meta.softLimitSource;
  const dailySourceActive = isDailySourceActive(limitSource);
  const capacitySourceActive = isCapacitySourceActive(limitSource);
  const hourlyLimited = resolveHourlyLimited({
    plan,
    summary,
    hasLimitDrivenShedDevices: hasShedDevices,
    headroomNegative,
    limitSource,
    capacitySourceActive,
  });
  const dailyLimitedResolved = resolveDailyLimited({
    plan,
    summary,
    hasLimitDrivenShedDevices: hasShedDevices,
    headroomNegative,
    dailySourceActive,
  });

  // When both limits are active, show 'both' for clarity, but capacity always wins for shedding decisions
  if (dailyLimitedResolved && hourlyLimited) return 'both';
  if (dailyLimitedResolved) return 'daily';
  if (hourlyLimited) return 'hourly';
  return 'none';
}
