import { PriceLevel } from '../price/priceLevels';
import { PLAN_REASON_CODES, type DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  computeProjectedHourEnergyKWh,
  isProjectedOverHardCap,
} from '../../packages/shared-domain/src/hourEnergyProjection';
import type { DevicePlan } from './planTypes';
import type { DevicePlanDevice } from './planTypes';
import { NEUTRAL_STARTUP_HOLD_REASON } from './restore/devices';

/** The persisted `pels_status` payload. External Flow automations read it. */
export type PelsStatus = {
  headroomKw: number;
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
  lastPowerUpdate: number | null;
  dryRunEffective?: boolean;
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
  lastPowerUpdate: number | null;
  /**
   * The EFFECTIVE (membership-gated) dry-run this home actuates on —
   * `getCapacityDryRun()`, which folds in the R7b boot-window zone-tree gate.
   * Written so the per-home Limits card shows honest posture (persisted-live but
   * no committed zone tree still reads Simulating). Sub-homes only: the main
   * home passes `undefined`, so the field is JSON-omitted and its persisted
   * `pels_status` blob stays byte-identical.
   */
  dryRunEffective?: boolean;
}): PelsStatus {
  const { plan, priceLevel, lastPowerUpdate, dryRunEffective } = params;
  const summary = summarizePlanForStatus(plan);
  const limitReason = resolveLimitReason(plan, summary);
  // Sub-home status blobs (the only ones with a defined `dryRunEffective`) also
  // carry the whole-area meter total so the per-home Limits card can render
  // "Power now" from the live total even when per-device attribution
  // (controlledKw/uncontrolledKw) is absent. The main home passes
  // `dryRunEffective: undefined`, so the field is JSON-omitted and its persisted
  // blob stays byte-identical.
  //
  // This overloads one optional boolean with two orthogonal meanings — actuation
  // posture AND home kind. The first time the main home writes its own posture
  // (reasonable enough; main has one too), `totalKw` starts appearing in main's
  // persisted blob, changing a payload external Flow automations read. If you
  // give main a posture, pass the area-total decision explicitly at the same
  // time rather than leaving it inferred from `dryRunEffective !== undefined`.
  const areaTotalKw = dryRunEffective !== undefined && typeof plan.meta.totalKw === 'number'
    ? plan.meta.totalKw
    : undefined;

  return {
    headroomKw: plan.meta.headroomKw,
    hourlyLimitKw: plan.meta.softLimitKw,
    hourlyUsageKwh: plan.meta.usedKWh ?? 0,
    dailyBudgetRemainingKwh: plan.meta.dailyBudgetRemainingKWh ?? 0,
    dailyBudgetExceeded: plan.meta.dailyBudgetExceeded ?? false,
    limitReason,
    capacityShortfall: plan.meta.capacityShortfall ?? false,
    shortfallBudgetThresholdKw: plan.meta.shortfallBudgetThresholdKw,
    shortfallBudgetHeadroomKw: plan.meta.shortfallBudgetHeadroomKw,
    // No PELS surface consumes this any more (the headroom widget moved to
    // `projectedOverHardCap`); kept because `pels_status` is a persisted
    // payload external automations may read.
    hardCapHeadroomKw: plan.meta.hardCapHeadroomKw,
    projectedOverHardCap: resolveProjectedOverHardCap(plan),
    totalKw: areaTotalKw,
    controlledKw: plan.meta.controlledKw,
    // `?? undefined` is an ENCODING translation, not a hedge. The domain
    // spells "no whole-home reading this cycle" as `null`; `pels_status` is a
    // persisted blob external automations read, and it spells absence by JSON
    // omission. Keeping `null` here would change the persisted shape, which
    // the backward-compatibility rule above forbids.
    uncontrolledKw: plan.meta.uncontrolledKw ?? undefined,
    powerNowKw: plan.meta.powerNowKw,
    // Kept for BACKWARD COMPATIBILITY only. `pels_status` is a persisted
    // payload external automations may read, and removing a field from it
    // breaks them — the repo rule is to ADD rather than rename or remove.
    // Derived from `powerNowKw` so it cannot drift from the resolved value;
    // nothing inside PELS reads it any more.
    powerKnown: plan.meta.powerNowKw !== null && plan.meta.powerNowKw !== undefined,
    priceLevel,
    devicesOn: summary.devicesOn,
    devicesOff: summary.devicesOff,
    lastPowerUpdate,
    // Undefined for the main home ⇒ JSON-omitted ⇒ its blob is byte-identical.
    dryRunEffective,
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
function resolveProjectedOverHardCap(plan: DevicePlan): boolean {
  const { totalKw, usedKWh, minutesRemaining, hardCapLimitKw } = plan.meta;
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
    if (device.controllable) {
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
  // Both claims require a MEASUREMENT this cycle: `headroomKw` is synthesized
  // when there is none (silent meter → −1 for the fail-closed pass), and the −1
  // sentinel would otherwise read as a real negative headroom. `powerNowKw` is
  // null in exactly those cycles, so its absence is the gate.
  const measured = plan.meta.powerNowKw !== null && plan.meta.powerNowKw !== undefined;
  const hasShedDevices = measured && summary.hasLimitDrivenShedDevices;
  const headroomNegative = measured && plan.meta.headroomKw < 0;
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
