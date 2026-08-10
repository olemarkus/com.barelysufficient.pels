import { normalizeTargetPowerConfig } from '../src/ui/deviceControlProfiles.ts';
import { createContinuousTargetPowerConfig } from '../src/ui/deviceDetail/targetPowerConfig.ts';
import { resolveTargetPowerLadderIssue } from '../../shared-domain/src/targetPowerLadder.ts';

describe('deviceControlProfiles target-power normalization', () => {
  it('does not admit runtime-owned reachability into the editable user config', () => {
    expect(normalizeTargetPowerConfig({
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
      reachability: {
        profileFingerprint: 'ev_charger_1_phase:off=0,32a=7360',
        maxReachedPowerW: 5750,
        probeFailureCount: 1,
        nextProbeAtMs: 900_000,
      },
    })).toEqual({
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    });
  });

  it('drops malformed reachability without discarding the editable base config', () => {
    expect(normalizeTargetPowerConfig({
      enabled: true,
      preset: 'ev_charger_1_phase',
      reachability: {
        profileFingerprint: '',
        maxReachedPowerW: Number.NaN,
        probeFailureCount: -1,
      },
    })).toEqual({ enabled: true, preset: 'ev_charger_1_phase' });
  });

  it('keeps a large device inside the shared step ceiling when seeding a continuous range', () => {
    // A flat 100 W seed produced 220 rungs for a 22 kW charger, so the screen
    // handed the owner a draft its own Save (and the runtime) would reject.
    const seed = createContinuousTargetPowerConfig({
      id: 'charger', expectedPowerKw: 22,
    } as Parameters<typeof createContinuousTargetPowerConfig>[0]);

    expect(seed.max).toBe(22_000);
    expect(resolveTargetPowerLadderIssue(seed)).toBeUndefined();
    // Ordinary loads keep the familiar 100 W granularity.
    expect(createContinuousTargetPowerConfig({
      id: 'heater', expectedPowerKw: 1.5,
    } as Parameters<typeof createContinuousTargetPowerConfig>[0]).step).toBe(100);
  });

  it('drops a range that yields no step ladder, matching the runtime normalizer', () => {
    // The runtime would refuse this config too, so admitting it here would only
    // show the owner a stepped device the runtime does not agree exists.
    expect(normalizeTargetPowerConfig({ enabled: true, max: 100, step: 500 })).toBeNull();
    expect(normalizeTargetPowerConfig({ max: 3680, step: 0 })).toBeNull();
    expect(normalizeTargetPowerConfig({ min: 1380, max: 3680, step: 460 })).toBeNull();
    expect(normalizeTargetPowerConfig({ max: 3680, step: 460 }))
      .toEqual({ max: 3680, step: 460 });
  });
});
