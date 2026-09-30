/**
 * The plan payload's shape guard, in a leaf module of its own so BOTH the
 * surface that renders a plan (`planRedesign.ts`) and the adapters that read
 * one (`overviewPlanRead.ts`) can resolve an untrusted payload before it
 * travels inward. It cannot live with the renderer: `planRedesign.ts` imports
 * the reader, so the reader importing it back would be a cycle.
 *
 * `null` means "this value is not a plan" — never "no plan committed". Callers
 * own that distinction: the realtime handler drops a malformed push, and the
 * scoped reader classifies a malformed payload as `unavailable`.
 */
import type { PlanDeviceSnapshot, PlanSnapshot } from './planTypes.ts';
import { isCapacityPeriodMinutes } from '../../../shared-domain/src/settings/capacityPeriod.ts';


const STATUS_KINDS: ReadonlySet<unknown> = new Set([
  'active', 'idle', 'held', 'resuming', 'off', 'manual', 'unavailable',
]);
const STATUS_TONES: ReadonlySet<unknown> = new Set(['active', 'idle', 'held', 'resuming', 'neutral', 'warning']);
const isNullableText = (value: unknown): boolean => value === null || typeof value === 'string';
const isFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isCountdown = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const timer = value as Record<string, unknown>;
  return isFinite(timer.endsAtMs) && isFinite(timer.totalSec) && timer.totalSec >= 0
    && typeof timer.prefix === 'string' && typeof timer.suffix === 'string';
};

const isStatusReason = (value: unknown): boolean => {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const reason = value as Record<string, unknown>;
  return typeof reason.text === 'string'
    && (reason.tone === undefined || reason.tone === 'neutral' || reason.tone === 'warning')
    && (reason.detail === undefined || typeof reason.detail === 'string')
    && isCountdown(reason.countdown);
};

const isStatusRail = (value: unknown): boolean => {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const rail = value as Record<string, unknown>;
  if (!Array.isArray(rail.labels) || !rail.labels.every((label: unknown) => typeof label === 'string')) return false;
  return rail.activeIndex === null || (isFinite(rail.activeIndex) && Number.isInteger(rail.activeIndex)
    && rail.activeIndex >= 0 && rail.activeIndex < rail.labels.length);
};

const isStatus = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const status = value as Record<string, unknown>;
  return ['binary', 'temperature', 'stepped'].includes(status.cardKind as string)
    && STATUS_KINDS.has(status.kind) && STATUS_TONES.has(status.tone)
    && typeof status.label === 'string' && isNullableText(status.powerText) && isNullableText(status.factText)
    && ['live', 'expected', 'reported'].includes(status.powerVariant as string)
    && ['limited', 'wouldLimit', 'canEaseOff', 'controlOffDrawing'].every((key) => typeof status[key] === 'boolean')
    && (status.holdCause === null || status.holdCause === 'smart_task' || status.holdCause === 'daily_budget')
    && isStatusReason(status.reason) && isStatusRail(status.rail);
};

const isPlanDeviceSnapshot = (value: unknown): value is PlanDeviceSnapshot => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as { id?: unknown }).id === 'string'
  && typeof (value as { name?: unknown }).name === 'string'
  && typeof (value as { controllable?: unknown }).controllable === 'boolean'
  && typeof (value as { available?: unknown }).available === 'boolean'
  && isStatus((value as { status?: unknown }).status)
);

const isFiniteNumber = isFinite;

// Never forward retired state inputs, even if a producer accidentally spreads them.
const RETIRED_STATE_KEYS = [
  'currentState', 'plannedState', 'reason', 'stateKind', 'stateTone', 'temperature', 'steppedLoad',
  'binaryCommandPending', 'pendingTargetCommand', 'shedAction', 'shedTemperature',
  'evChargingState', 'carChargingState', 'idleClassification', 'surplusAbsorbActive',
  'binaryControllable', 'reportedStepId', 'selectedStepId', 'desiredStepId', 'targetStepId',
  'steppedLoadProfile', 'execution', 'expectedPowerKw',
] as const;

const needsFacetSanitizing = (device: PlanDeviceSnapshot): boolean => (
  RETIRED_STATE_KEYS.some((key) => key in device)
);

const withValidatedFacets = (device: PlanDeviceSnapshot): PlanDeviceSnapshot => {
  if (!needsFacetSanitizing(device)) return device;
  const sanitized: Record<string, unknown> = { ...device };
  for (const key of RETIRED_STATE_KEYS) delete sanitized[key];
  return sanitized as PlanDeviceSnapshot;
};

// The meta is now REQUIRED almost throughout, and the hero reads it without
// hedging — `formatKw(meta.hardCapLimitKw)` calls `.toFixed()` straight on it.
// That is the point of requiring it, but it only holds if something upstream
// guarantees the shape, and this seam is the only thing between the API
// transport and those reads. Before this check, a meta missing one number
// crashed the hero instead of degrading it.
//
// Rejecting the WHOLE payload, not repairing the meta: unlike a device facet,
// there is no useful hero to draw from a partial meta, and `parsePlanSnapshot`
// already answers `null` for a malformed device list. Callers handle it — the
// realtime handler drops the push and logs, the scoped reader reports
// `unavailable`.
const REQUIRED_META_NUMBERS = [
  'softLimitKw', 'capacitySoftLimitKw', 'hardCapLimitKw',
  'usedKWh', 'hourBudgetKWh', 'minutesRemaining',
  // The meter total and its stamp: always numbers — a snapshot exists only
  // behind the measurement gate, so its cycle always carried a reading.
  'totalKw', 'lastPowerUpdateMs',
] as const;

// Present exactly when `powerIsMeasured` is true: the figures derived from
// the total. An unmeasured meta carries none of them, and the hero draws
// nothing computed from it — so the seam requires the discriminant itself
// and, behind it, the numbers only on the measured variant.
const MEASURED_META_NUMBERS = ['controlledKw', 'uncontrolledKw'] as const;

// Required, but `null` is a real value: no daily-budget axis (the pace pair).
const REQUIRED_META_NULLABLE_NUMBERS = [
  'budgetPaceKw', 'projectedExemptKw',
] as const;

const SOFT_LIMIT_SOURCES: ReadonlySet<unknown> = new Set(['capacity', 'daily']);
const isValidPlanMeta = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Record<string, unknown>;
  return REQUIRED_META_NUMBERS.every((key) => isFiniteNumber(meta[key]))
    && REQUIRED_META_NULLABLE_NUMBERS.every(
      (key) => meta[key] === null || isFiniteNumber(meta[key]),
    )
    && SOFT_LIMIT_SOURCES.has(meta.softLimitSource)
    && isCapacityPeriodMinutes(meta.capacityPeriodMinutes)
    && typeof meta.capacityPeriodCoverageComplete === 'boolean'
    && typeof meta.powerIsMeasured === 'boolean'
    && (!meta.powerIsMeasured || MEASURED_META_NUMBERS.every((key) => isFiniteNumber(meta[key])));
};

export const parsePlanSnapshot = (value: unknown): PlanSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const meta = (value as { meta?: unknown }).meta;
  if (meta !== undefined && !isValidPlanMeta(meta)) return null;
  const devices = (value as { devices?: unknown }).devices;
  if (devices === undefined) return value;
  if (!Array.isArray(devices) || !devices.every(isPlanDeviceSnapshot)) {
    return null;
  }
  // Identity-preserving on the clean path: consumers (and the byte-identical
  // Main-scope read) rely on an untouched payload passing through as-is; a
  // copy exists only to carry a sanitized device list.
  if (!devices.some(needsFacetSanitizing)) return value;
  return {
    ...(value as PlanSnapshot),
    devices: devices.map(withValidatedFacets),
  };
};
