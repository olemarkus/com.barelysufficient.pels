import type { PlanDeviceSnapshot, PlanSnapshot } from './planTypes.ts';

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
// runtime type makes it a required `string` on `swapped_out` / `reserved_for_start`
// — but that promise is the CURRENT build's, and a snapshot can arrive from an
// older one across an app update. Discriminating here is what lets the formatter
// interpolate without a fallback, per the boundary rule: the adapter classifies,
// the consumer trusts. `swap_pending` is deliberately absent — its `null` is a
// real domain state (the target is not yet resolved) that the formatter renders.
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

// Junk in ⇒ the whole facet is dropped (never a partial or nullable field):
// a snapshot from an older build (or a malformed push) renders as a
// non-temperature card rather than a card with invented numbers. `deviceType`
// is demoted with it, exactly as the runtime producer co-produces the two —
// otherwise this seam would emit the one shape the whole refactor forbids: a
// device branded `'temperature'` with no facet behind it.
const withValidatedTemperatureFacet = (device: PlanDeviceSnapshot): PlanDeviceSnapshot => {
  const facet = (device as { temperature?: unknown }).temperature;
  if (facet === undefined || hasValidTemperatureFacet(facet)) return device;
  const { temperature: _dropped, ...rest } = device as PlanDeviceSnapshot & { temperature?: unknown };
  return { ...rest, deviceType: 'onoff' } as PlanDeviceSnapshot;
};

const needsTemperatureFacetSanitizing = (device: PlanDeviceSnapshot): boolean => {
  const facet = (device as { temperature?: unknown }).temperature;
  return facet !== undefined && !hasValidTemperatureFacet(facet);
};

export const parsePlanSnapshot = (value: unknown): PlanSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const devices = (value as { devices?: unknown }).devices;
  if (devices === undefined) return value as PlanSnapshot;
  if (!Array.isArray(devices) || !devices.every(isPlanDeviceSnapshot)) {
    return null;
  }
  // Identity-preserving on the clean path: consumers (and the byte-identical
  // Main-scope read) rely on an untouched payload passing through as-is; a
  // copy exists only to carry a sanitized device list.
  if (!devices.some(needsTemperatureFacetSanitizing)) return value as PlanSnapshot;
  return {
    ...(value as PlanSnapshot),
    devices: devices.map(withValidatedTemperatureFacet),
  };
};
