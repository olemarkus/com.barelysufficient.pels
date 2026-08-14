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

export const parsePlanSnapshot = (value: unknown): PlanSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const devices = (value as { devices?: unknown }).devices;
  if (devices !== undefined && (!Array.isArray(devices) || !devices.every(isPlanDeviceSnapshot))) {
    return null;
  }
  return value as PlanSnapshot;
};
