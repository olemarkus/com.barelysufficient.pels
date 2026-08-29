import type { PlanDeviceSnapshot, PlanSnapshot } from './planTypes.ts';
import { isEvChargingState } from '../../../shared-domain/src/evPlugState.ts';

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

// Reason codes whose formatter interpolates `targetName` into a sentence. The
// runtime type makes it a required `string` on `swapped_out` /
// `reserved_for_start`; discriminating here is what lets the formatter
// interpolate without a fallback, per the boundary rule: the adapter classifies,
// the consumer trusts.
//
// Note what this is NOT defending against. The settings UI is compiled into the
// app package and ships with the runtime that feeds it, so there is no
// independent deployment and no "payload from an older build" — an earlier
// version of this comment claimed otherwise and it was wrong. What remains is
// worth guarding: this payload crosses a real JSON transport, and a producer bug
// or a corrupted cache entry can still put a wrong shape on the other side.
//
// `swap_pending` is deliberately absent — its `null` is a real domain state (the
// target is not yet resolved) that the formatter renders.
const TARGET_NAME_REQUIRED_CODES = new Set(['swapped_out', 'reserved_for_start']);

// Blank counts as missing: the formatter interpolates this straight into a
// sentence, so `''` renders "Limited so  can run" — a usable name is the whole
// point of requiring the field.
const hasValidTargetName = (value: { code: string; targetName?: unknown }): boolean => (
  !TARGET_NAME_REQUIRED_CODES.has(value.code)
  || (typeof value.targetName === 'string' && value.targetName.trim().length > 0)
);

const hasStructuredReason = (value: unknown): boolean => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as { code?: unknown }).code === 'string'
  && hasValidTargetName(value as { code: string; targetName?: unknown })
);

const isPlanDeviceSnapshot = (value: unknown): value is PlanDeviceSnapshot => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as { id?: unknown }).id === 'string'
  && typeof (value as { name?: unknown }).name === 'string'
  && typeof (value as { controllable?: unknown }).controllable === 'boolean'
  && typeof (value as { available?: unknown }).available === 'boolean'
  && hasStructuredReason((value as { reason?: unknown }).reason)
);

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

// The temperature facet is atomic: a complete finite trio, or no facet at all.
// The adapter validates ONCE here; inward of this seam (`shared-domain`, the
// views) the facet is trusted as-is — there are no nullable temperature fields
// left for a consumer to hedge on.
const hasValidTemperatureFacet = (value: unknown): boolean => (
  Boolean(value)
  && typeof value === 'object'
  && isFiniteNumber((value as { currentTarget?: unknown }).currentTarget)
  && isFiniteNumber((value as { currentTemperature?: unknown }).currentTemperature)
  && isFiniteNumber((value as { plannedTarget?: unknown }).plannedTarget)
);

// The stepped cluster is atomic for the same reason the temperature facet is,
// and for a sharper one: its PRESENCE is the stepped discriminant. Consumers
// read `dev.steppedLoad !== undefined` as proof the device is stepped and then
// reach straight into it — `resolveSteppedLevelFact` hands `reportedStepId` to
// `formatStepDisplayLabel`, which calls `.trim()` on it. So an unvalidated
// cluster is not a cosmetic problem: a truthy non-object routes a device into
// the stepped card, and a truthy non-string step id throws inside the render.
//
// `profile` is checked for shape only (an object with a `steps` array) — the
// rungs themselves are the producer's business, and the card tolerates a step
// id that names no rung. The two ids are nullable BY CONTRACT: `null` is "no
// step reported yet" / "no target", which is a real state, so `null` passes and
// only a wrong TYPE fails.
const isStepIdOrNull = (value: unknown): boolean => value === null || typeof value === 'string';

const hasValidSteppedLoad = (value: unknown): boolean => (
  Boolean(value)
  && typeof value === 'object'
  && Boolean((value as { profile?: unknown }).profile)
  && typeof (value as { profile?: unknown }).profile === 'object'
  && Array.isArray((value as { profile: { steps?: unknown } }).profile.steps)
  && isStepIdOrNull((value as { reportedStepId?: unknown }).reportedStepId)
  && isStepIdOrNull((value as { targetStepId?: unknown }).targetStepId)
  // REQUIRED on the cluster, so required here — the two move together. A
  // missing `selectedStepId` is not a harmless gap: `hasSteppedRestorePending`
  // compares it against the target, so `undefined !== targetStepId` makes an
  // off device read "Resuming". And `getDeviceOverviewExpectedPowerKw` returns
  // `planningPowerKw` directly now, with no fallback, so a non-finite one would
  // reach the power text.
  && typeof (value as { selectedStepId?: unknown }).selectedStepId === 'string'
  && isFiniteNumber((value as { planningPowerKw?: unknown }).planningPowerKw)
  && typeof (value as { commandPending?: unknown }).commandPending === 'boolean'
);

// The EV plug-state pair is a CLOSED union on the wire type, and until now
// nothing checked it. Three shared-domain helpers call `.trim()` on these
// values, so a non-string threw inside the card text; a junk string degraded
// silently to missing EV copy. `isEvChargingState` is the same exhaustive guard
// the capability-read seam uses — it moved to shared-domain so both ends of the
// app can reach it (the settings UI may not import `lib/**`).
//
// Each field is dropped independently: the charger's own state and the
// associated car's are separate facts, and one being junk says nothing about
// the other.
const EV_STATE_KEYS = ['evChargingState', 'carChargingState'] as const;

const hasInvalidEvState = (device: PlanDeviceSnapshot, key: typeof EV_STATE_KEYS[number]): boolean => {
  const value = (device as Record<string, unknown>)[key];
  return value !== undefined && !isEvChargingState(value);
};

// Junk in ⇒ the whole facet is dropped (never a partial or nullable field):
// a malformed push renders as a non-temperature / non-stepped card rather than
// a card with invented numbers. Dropping the facet is the entire demotion —
// presence of the facet IS the discriminant on this shape, so there is no
// second field to keep in step.
// ONE function decides what a device loses, so the "does anything need fixing"
// pass and the "fix it" pass cannot disagree. They were separate predicates for
// the temperature facet alone and stayed in step by luck; with four fields to
// check, a second copy is a drift waiting to happen.
const resolveDropKeys = (device: PlanDeviceSnapshot): readonly string[] => {
  const dropKeys: string[] = [];
  if (device.temperature !== undefined && !hasValidTemperatureFacet(device.temperature)) {
    dropKeys.push('temperature');
  }
  if (device.steppedLoad !== undefined && !hasValidSteppedLoad(device.steppedLoad)) {
    dropKeys.push('steppedLoad');
  }
  for (const key of EV_STATE_KEYS) {
    if (hasInvalidEvState(device, key)) dropKeys.push(key);
  }
  return dropKeys;
};

const withValidatedFacets = (device: PlanDeviceSnapshot): PlanDeviceSnapshot => {
  const dropKeys = resolveDropKeys(device);
  if (dropKeys.length === 0) return device;
  const sanitized: Record<string, unknown> = { ...(device as Record<string, unknown>) };
  for (const key of dropKeys) delete sanitized[key];
  return sanitized as PlanDeviceSnapshot;
};

const needsFacetSanitizing = (device: PlanDeviceSnapshot): boolean => (
  resolveDropKeys(device).length > 0
);

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
  'softLimitKw', 'capacitySoftLimitKw', 'headroomKw', 'hardCapLimitKw',
  'usedKWh', 'hourBudgetKWh', 'minutesRemaining', 'controlledKw',
] as const;

// Required, but `null` is a real value: no meter reading this cycle
// (`totalKw`/`uncontrolledKw`) and no daily-budget axis (the pace pair).
const REQUIRED_META_NULLABLE_NUMBERS = [
  'totalKw', 'uncontrolledKw', 'budgetPaceKw', 'projectedExemptKw',
] as const;

const SOFT_LIMIT_SOURCES: ReadonlySet<unknown> = new Set(['capacity', 'daily']);
const POWER_FRESHNESS_STATES: ReadonlySet<unknown> = new Set([
  'fresh', 'stale_hold', 'stale_fail_closed',
]);

// `totalKw` and `uncontrolledKw` are ONE fact and must be null together.
// `splitControlledUsageKw` derives the background side as the whole-home total
// minus the managed side, so it is absent exactly when the total is — which is
// why the hero can resolve the pair once and then read both as plain numbers.
//
// Checking them independently would let a mismatched pair through, and the
// consequence is worse than a wrong number: `PlanHero` needs BOTH to build its
// input, so it would fall to the loading skeleton, while the accepted payload
// had already replaced the last good plan. The Overview would sit on a spinner
// with nothing to recover to. Validating the pair as a pair is the same
// atomicity rule the temperature and stepped facets get.
const hasConsistentMeterNullness = (meta: Record<string, unknown>): boolean => (
  (meta.totalKw === null) === (meta.uncontrolledKw === null)
);

const isValidPlanMeta = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Record<string, unknown>;
  return REQUIRED_META_NUMBERS.every((key) => isFiniteNumber(meta[key]))
    && REQUIRED_META_NULLABLE_NUMBERS.every(
      (key) => meta[key] === null || isFiniteNumber(meta[key]),
    )
    && hasConsistentMeterNullness(meta)
    && SOFT_LIMIT_SOURCES.has(meta.softLimitSource)
    && POWER_FRESHNESS_STATES.has(meta.powerFreshnessState);
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
