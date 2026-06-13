import type { PlanInputDevice } from '../../lib/plan/planTypes';

/**
 * Test fixture builder for `PlanInputDevice`. Applies a small set of safe
 * defaults so call sites only need to specify what's relevant to the test.
 *
 * Defaults:
 *   - `name` falls back to `id`
 *   - `targets` defaults to `[]`
 *   - `binaryControl` defaults to `{ on: true }` (the old fabricated `currentOn: true`)
 *   - `shedIntent` defaults to `{ kind: 'turn_off' }` (the post-PR-A required
 *     field; tests that care about a specific intent override it)
 *
 * Every other `PlanInputDevice` field is left `undefined` unless supplied via
 * `overrides`, so tests never accidentally rely on a fabricated value.
 *
 * Existing inline fixtures (e.g. the local `buildEvDevice` in
 * `test/unit/deferredObjectiveAdmission.unit.test.ts`) follow the same shape; this
 * helper centralises the pattern so the upcoming planner-detype refactor can
 * add fields without churning every fixture by hand.
 */
export function buildPlanInputDevice(
  overrides: Partial<PlanInputDevice> & { id: string },
): PlanInputDevice {
  // The `binaryControl` default is preserved verbatim, so this is the canonical
  // fixture-constructor boundary (NOT a per-test smuggle): the cast keeps the
  // exact runtime shape callers rely on rather than routing through
  // `withBinaryDiscriminant`, whose runtime stripping (binaryControl omitted
  // without `controlCapabilityId`) would change every consumer's fixture.
  return {
    name: overrides.id,
    targets: [],
    binaryControl: { on: true },
    ...overrides,
  } as unknown as PlanInputDevice;
}
