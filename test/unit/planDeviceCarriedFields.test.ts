import { describe, expect, it } from 'vitest';
import type { ToPlanDeviceInput } from '../../setup/appInit/toPlanDevice';
import type {
  PlanDeviceCarriedKey,
  PlanDeviceStrippedKey,
} from '../../packages/planner-types/src/planInputDevice';

/**
 * A TYPE-level assertion, gated by `tsc -p tsconfig.tests.json` in `ci:checks`.
 *
 * `toPlanDevice` finishes with a `...deviceFields` rest-spread, which is an
 * EXCLUSION list: every field the destructure does not strip reaches the planner,
 * whether or not anyone chose that. It is how `stateOfCharge` and `deviceRole`
 * came to ride the plan device undeclared, and stripping `stateOfCharge` on the
 * contract's word turned every EV smart task's progress into
 * `objective_progress_stale` (2026-08-16, reverted).
 *
 * This pins the carried set as an EQUALITY, so the check fails in both
 * directions: add a field to the device snapshot without deciding where it
 * belongs, or strip one that the planner still needs, and the build breaks here
 * with a name to look up rather than in a smart task's progress months later.
 */
type KeySetsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type _CarriedKeysAreDeclared = Assert<KeySetsEqual<
  Exclude<keyof ToPlanDeviceInput, PlanDeviceStrippedKey>,
  PlanDeviceCarriedKey
>>;

describe('plan device carried fields', () => {
  // The type assertion above is the real check; this keeps the suite honest about
  // having run, since a type-only file would pass by existing.
  it('declares every field the producer spread carries', () => {
    const declared: _CarriedKeysAreDeclared = true;
    expect(declared).toBe(true);
  });

  // Two entries worth naming, because both are the kind of thing the equality
  // exists to surface rather than a reviewer noticing.
  it('states the two disagreements the spread was hiding', () => {
    // The contract still describes a plan device as carrying no battery level.
    const stateOfCharge: PlanDeviceCarriedKey = 'stateOfCharge';
    // And this rides while its own pair member `measuredPowerKw` is stripped,
    // though the contract says the two travel together.
    const measuredPowerObservedAtMs: PlanDeviceCarriedKey = 'measuredPowerObservedAtMs';
    expect([stateOfCharge, measuredPowerObservedAtMs]).toHaveLength(2);
  });
});
