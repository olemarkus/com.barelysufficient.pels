import { describe, expect, it } from 'vitest';
import { shouldPlanRestores } from '../../lib/plan/restore/timing';

const openTiming = { inCooldown: false, inRestoreCooldown: false, inStartupStabilization: false };

// The full restore pass's gate. The exhausted hour is its own explicit term
// here: the hour's kWh is spent, so no freed power admits anything before it
// rolls over. This used to ride on the context forcing every headroom axis to
// -1 — a decision smuggled inside a measurement (owner ruling 2026-09-02).
describe('shouldPlanRestores', () => {
  it('opens outside every hold on an ordinary hour', () => {
    expect(shouldPlanRestores(false, openTiming, false)).toBe(true);
  });

  it('stays closed while shedding is latched', () => {
    expect(shouldPlanRestores(true, openTiming, false)).toBe(false);
  });

  it('stays closed in an exhausted hour — the flag, not a forced headroom', () => {
    expect(shouldPlanRestores(false, openTiming, true)).toBe(false);
  });

  it.each([
    ['the shed cooldown', { ...openTiming, inCooldown: true }],
    ['the restore cooldown', { ...openTiming, inRestoreCooldown: true }],
    ['startup stabilization', { ...openTiming, inStartupStabilization: true }],
  ])('stays closed during %s', (_label, timing) => {
    expect(shouldPlanRestores(false, timing, false)).toBe(false);
  });
});
