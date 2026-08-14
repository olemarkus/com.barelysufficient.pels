// Boundary coverage for the target-name half of the plan-snapshot guard.
//
// `swapped_out` / `reserved_for_start` carry a required `targetName` on the
// runtime type, and the formatters interpolate it into a sentence with no
// fallback. That promise is the CURRENT build's: a snapshot can arrive from an
// older one across an app update, so this seam — not the formatter — is what
// has to reject a reason that cannot name its holder. `swap_pending` is
// deliberately exempt; its `null` is a real unresolved-target state the
// formatter renders on purpose.

import { describe, expect, it } from 'vitest';
import { parsePlanSnapshot } from '../src/ui/planSnapshotParse.ts';

const deviceWith = (reason: unknown): unknown => ({
  devices: [{ id: 'dev-1', name: 'Water heater', controllable: true, available: true, reason }],
});

describe('parsePlanSnapshot target-name guard', () => {
  it('accepts a required target name that can actually be shown', () => {
    for (const code of ['swapped_out', 'reserved_for_start']) {
      expect(parsePlanSnapshot(deviceWith({ code, targetName: 'Bathroom' }))).not.toBeNull();
    }
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['a non-string', 42],
  ])('rejects a %s target name on a code that must name its holder', (_label, targetName) => {
    for (const code of ['swapped_out', 'reserved_for_start']) {
      expect(parsePlanSnapshot(deviceWith({ code, targetName }))).toBeNull();
    }
  });

  it('leaves swap_pending alone — its null target is a real unresolved state', () => {
    expect(parsePlanSnapshot(deviceWith({ code: 'swap_pending', targetName: null }))).not.toBeNull();
    expect(parsePlanSnapshot(deviceWith({ code: 'swap_pending' }))).not.toBeNull();
  });

  it('does not require a target name from codes that never render one', () => {
    expect(parsePlanSnapshot(deviceWith({ code: 'capacity' }))).not.toBeNull();
    expect(parsePlanSnapshot(deviceWith({ code: 'cooldown_restore', remainingSec: 42 }))).not.toBeNull();
  });
});

describe('parsePlanSnapshot resolved boolean guard', () => {
  it.each([
    ['controllable', undefined],
    ['controllable', 'true'],
    ['available', undefined],
    ['available', 1],
  ])('rejects a non-boolean or absent %s field', (field, fieldValue) => {
    const device = {
      id: 'dev-1',
      name: 'Water heater',
      controllable: true,
      available: true,
      reason: { code: 'capacity' },
      [field]: fieldValue,
    };

    expect(parsePlanSnapshot({ devices: [device] })).toBeNull();
  });

  it('preserves explicit false values', () => {
    expect(parsePlanSnapshot({
      devices: [{
        id: 'dev-1',
        name: 'Water heater',
        controllable: false,
        available: false,
        reason: { code: 'capacity' },
      }],
    })).not.toBeNull();
  });
});
