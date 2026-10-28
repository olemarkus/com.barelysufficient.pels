import { describe, expect, it } from 'vitest';
import { resolveInverterReleaseTarget } from '../../lib/executor/inverterRestoration';
import type { InverterClaim } from '../../lib/ports/inverterControl';
import type { InverterControlSurface } from '../../packages/contracts/src/inverterControl';

const control: InverterControlSurface = {
  maxW: 6000, stepW: 1, mode: 'switchable', modeValues: ['homey', 'device', 'eco'], authority: 'limit_and_release',
};
const autonomous: InverterClaim = {
  previousLimitW: 0, previousMode: { kind: 'autonomous', value: 'eco', observedAtMs: 0 }, claimedAtMs: 1000,
  restoration: { kind: 'native', binding: control },
};

describe('inverter hand-back targets', () => {
  it('restores both dormant watts and mode when the original binding remains valid', () => {
    expect(resolveInverterReleaseTarget(autonomous, control)).toEqual({
      kind: 'watts_and_mode', limitW: 0, binding: control, mode: autonomous.previousMode,
    });
  });

  it.each([5000, 7000])('restores the effective autonomous ceiling after a range change to %i', (maxW) => {
    expect(resolveInverterReleaseTarget(autonomous, { ...control, maxW }))
      .toEqual({ kind: 'watts_only', limitW: Math.min(6000, maxW) });
  });

  it('uses the saved accepted ceiling when current metadata cannot be read', () => {
    expect(resolveInverterReleaseTarget(autonomous, undefined)).toEqual({ kind: 'watts_only', limitW: 6000 });
    expect(resolveInverterReleaseTarget(autonomous, { ...control, authority: 'release_only' }))
      .toEqual({ kind: 'watts_only', limitW: 6000 });
  });

  it.each(['direct', 'controlled'] as const)('preserves the saved active zero for prior %s control', (kind) => {
    const previousMode: InverterClaim['previousMode'] = kind === 'direct' ? { kind }
      : { kind, value: 'homey', observedAtMs: 0 };
    expect(resolveInverterReleaseTarget({ ...autonomous, previousMode, restoration: { kind: 'native', binding: { ...control, maxW: 7000 } } }, control))
      .toEqual({ kind: 'watts_only', limitW: 0 });
  });

  it('represents a saved active ceiling without exceeding it after a step change', () => {
    const claim: InverterClaim = { ...autonomous, previousLimitW: 2555,
      previousMode: { kind: 'controlled', value: 'homey', observedAtMs: 0 } };
    expect(resolveInverterReleaseTarget(claim, { ...control, stepW: 100 }))
      .toEqual({ kind: 'watts_only', limitW: 2500 });
  });
});
