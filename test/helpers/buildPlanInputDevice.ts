import type { PlanInputDevice } from '../../lib/plan/planTypes';

/**
 * Test fixture builder for `PlanInputDevice`. Applies a small set of safe
 * defaults so call sites only need to specify what's relevant to the test.
 *
 * Defaults:
 *   - `name` falls back to `id`
 *   - `targets` defaults to `[]`
 *   - `currentOn` defaults to `true`
 *
 * Every other `PlanInputDevice` field is left `undefined` unless supplied via
 * `overrides`, so tests never accidentally rely on a fabricated value.
 *
 * Existing inline fixtures (e.g. the local `buildEvDevice` in
 * `test/deferredObjectiveAdmission.unit.test.ts`) follow the same shape; this
 * helper centralises the pattern so the upcoming planner-detype refactor can
 * add fields without churning every fixture by hand.
 */
export function buildPlanInputDevice(
  overrides: Partial<PlanInputDevice> & { id: string },
): PlanInputDevice {
  return {
    name: overrides.id,
    targets: [],
    currentOn: true,
    ...overrides,
  };
}
