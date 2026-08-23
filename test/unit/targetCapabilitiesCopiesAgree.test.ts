/**
 * `lib/utils/targetCapabilities.ts` is a deliberate copy of the shared helper in
 * `packages/contracts/src/targetCapabilities.ts`. It exists because contracts is
 * types-only at runtime — a value import from it crashes app boot — so runtime
 * code cannot call the published helper and keeps its own copy. Two copies can
 * drift silently; this is the executable check that they do not.
 *
 * Importing contracts value-side is safe HERE because a vitest lane is not the
 * app boot path. It is not licence to do the same from `lib/**` or `setup/**`.
 *
 * This compares the two implementations to each other, so it catches drift, not
 * a bug they share. The absolute-value anchor is
 * `packages/settings-ui/test/targetCapabilities.test.ts`, which asserts the
 * contracts helper's own results.
 */
import {
  getPrimaryTargetCapability as contractsGetPrimaryTargetCapability,
  normalizeTargetCapabilityValue as contractsNormalizeTargetCapabilityValue,
} from '../../packages/contracts/src/targetCapabilities';
import {
  getPrimaryTargetCapability as runtimeGetPrimaryTargetCapability,
  normalizeTargetCapabilityValue as runtimeNormalizeTargetCapabilityValue,
} from '../../lib/utils/targetCapabilities';
import type { TargetCapabilitySnapshot } from '../../packages/contracts/src/types';

type NormalizeTarget = Partial<Pick<TargetCapabilitySnapshot, 'min' | 'max' | 'step'>> | null;

// Every branch the two copies share: absent target, clamping at each end,
// step rounding off a non-zero base, a step that must be ignored, decimals
// inherited from min/max, and the scientific-notation step whose precision the
// `toFixed` path exists to preserve.
const NORMALIZE_CASES: ReadonlyArray<{ name: string; target: NormalizeTarget; value: number }> = [
  { name: 'no target', target: null, value: 21.37 },
  { name: 'empty target', target: {}, value: 21.37 },
  { name: 'clamped to min', target: { min: 5, max: 30, step: 0.5 }, value: 1 },
  { name: 'clamped to max', target: { min: 5, max: 30, step: 0.5 }, value: 99 },
  { name: 'rounded down to step', target: { min: 5, max: 30, step: 0.5 }, value: 21.2 },
  { name: 'rounded up to step', target: { min: 5, max: 30, step: 0.5 }, value: 21.3 },
  { name: 'step off a non-integer base', target: { min: 4.25, max: 30, step: 0.5 }, value: 21.37 },
  { name: 'zero step ignored', target: { min: 5, max: 30, step: 0 }, value: 21.37 },
  { name: 'negative step ignored', target: { min: 5, max: 30, step: -1 }, value: 21.37 },
  { name: 'non-finite min ignored', target: { min: Number.NaN, max: 30, step: 1 }, value: 21.37 },
  { name: 'decimals inherited from max', target: { min: 0, max: 30.125, step: 1 }, value: 21.37 },
  // Rounding overshoots `max` (10/4 rounds to 3 steps = 12), so only the final
  // re-clamp brings it back. Nothing else in this table reaches that step.
  { name: 'rounding must not escape max', target: { min: 0, max: 10, step: 4 }, value: 10 },
  { name: 'scientific-notation step', target: { min: 1.23e-7, step: 1.23e-7 }, value: 2.46e-7 },
];

const TARGET_A: TargetCapabilitySnapshot = { id: 'target_temperature', unit: 'C', min: 5, max: 30 };
const TARGET_B: TargetCapabilitySnapshot = { id: 'target_temperature.2', unit: 'C' };

describe('targetCapabilities runtime copy agrees with the contracts helper', () => {
  it.each(NORMALIZE_CASES)('normalizeTargetCapabilityValue: $name', ({ target, value }) => {
    expect(runtimeNormalizeTargetCapabilityValue({ target, value }))
      .toBe(contractsNormalizeTargetCapabilityValue({ target, value }));
  });

  it('getPrimaryTargetCapability agrees on absent, empty and populated lists', () => {
    for (const targets of [null, undefined, [], [TARGET_A], [TARGET_A, TARGET_B]]) {
      expect(runtimeGetPrimaryTargetCapability(targets))
        .toEqual(contractsGetPrimaryTargetCapability(targets));
    }
  });
});
