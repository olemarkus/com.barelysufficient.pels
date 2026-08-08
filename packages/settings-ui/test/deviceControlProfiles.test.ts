import { normalizeTargetPowerConfig } from '../src/ui/deviceControlProfiles.ts';

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
});
