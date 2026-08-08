import {
  buildEvTargetPowerCandidateProfile,
  buildTargetPowerReachabilityState,
  resolveEvTargetPowerConfirmedProfile,
  resolveEvTargetPowerPlannerProfile,
  resolveValidTargetPowerReachability,
  type TargetPowerConfigWithReachability,
} from '../../lib/device/targetPowerReachability';
import { buildSyntheticTargetPowerCapabilityMap } from '../../lib/device/nativeSteppedLoadWiring';
import {
  resolveTargetPowerProbeRetryAtMs,
  resolveTargetPowerReachabilityTransition,
} from '../../lib/executor/targetPowerReachability';
import type { TargetPowerSteppedLoadConfig } from '../../packages/contracts/src/types';

const buildConfig = (maxReachedPowerW = 5_750): TargetPowerConfigWithReachability => {
  const base: TargetPowerSteppedLoadConfig = {
    enabled: true,
    preset: 'ev_charger_1_phase',
    min: 0,
    max: 7_360,
    step: 460,
    excludeMin: 1,
    excludeMax: 1_380,
  };
  return {
    ...base,
    reachability: buildTargetPowerReachabilityState({
      config: base,
      maxReachedPowerW,
    }),
  };
};

describe('targetPowerReachability', () => {
  it('keeps the candidate ceiling while ending the confirmed ladder at an exact 25 A rung', () => {
    const config = buildConfig();
    const candidate = buildEvTargetPowerCandidateProfile(config);
    const confirmed = resolveEvTargetPowerConfirmedProfile(config);

    expect(candidate.steps.at(-1)).toMatchObject({ id: '32a', planningPowerW: 7_360 });
    expect(confirmed.steps.at(-1)).toMatchObject({
      id: '25a',
      planningPowerW: 5_750,
      planningCurrentA: 25,
    });
    expect(config.max).toBe(7_360);
  });

  it('stops the candidate ladder at the highest real rung below an off-ladder cap', () => {
    // A 25 A fuse leaves 24 A as the highest step. Minting a `25a` rung to sit
    // on the cap would invent a step no charger ever offered, and drop a 1 A
    // increment into a ladder whose rungs are 2-4 A apart.
    const config: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      min: 0,
      max: 25 * 230,
      step: 460,
      excludeMin: 1,
      excludeMax: 1_380,
    };

    const candidate = buildEvTargetPowerCandidateProfile(config);

    expect(candidate.steps.at(-1)).toMatchObject({ id: '24a', planningCurrentA: 24 });
    expect(candidate.steps.map((step) => step.id)).not.toContain('25a');
  });

  it('still ends the confirmed ladder on a rung the device reached but the cap excludes', () => {
    // The counterpart to the rule above, on the SAME off-ladder cap: PELS never
    // mints `25a` from the 25 A cap, but a charger that demonstrably reached
    // 5750 W keeps it. This pairing is where the two rules meet, so it is the
    // case a future simplification of either append would silently break.
    const config: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 25 * 230,
    };

    expect(resolveEvTargetPowerConfirmedProfile(config, 5_750).steps.at(-1))
      .toMatchObject({ id: '25a', planningPowerW: 5_750 });
    expect(resolveEvTargetPowerConfirmedProfile(config, 5_520).steps.at(-1))
      .toMatchObject({ id: '24a', planningPowerW: 5_520 });
  });

  it('offers only the next candidate when a probe is due', () => {
    const config = buildConfig();
    const confirmedProfile = resolveEvTargetPowerConfirmedProfile(config);
    const due = resolveEvTargetPowerPlannerProfile({ config, confirmedProfile, nowMs: 1_000 });

    expect(due.steps.at(-1)).toMatchObject({ id: '28a', planningPowerW: 6_440 });
    expect(due.steps.some((step) => step.id === '32a')).toBe(false);
  });

  it('starts cold at the lowest safe rung and exposes only one planner probe', () => {
    const config: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    const confirmed = resolveEvTargetPowerConfirmedProfile(config);
    const planner = resolveEvTargetPowerPlannerProfile({ config, confirmedProfile: confirmed, nowMs: 1_000 });

    expect(confirmed.steps.map((step) => step.id)).toEqual(['off', '6a']);
    expect(planner.steps.map((step) => step.id)).toEqual(['off', '6a', '8a']);
  });

  it('retains an exact current rung below a higher persisted maximum', () => {
    const config = buildConfig(6_440);

    expect(resolveEvTargetPowerConfirmedProfile(config, 5_750).steps.map((step) => step.id))
      .toEqual(['off', '6a', '8a', '10a', '12a', '14a', '16a', '20a', '24a', '25a', '28a']);
  });

  it('rejects out-of-range exact evidence instead of clamping it into false proof', () => {
    const config: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };

    expect(resolveEvTargetPowerConfirmedProfile(config, 17_250).steps.at(-1)?.id).toBe('6a');
  });

  it('does not offer the next candidate before its persisted retry time', () => {
    const base = buildConfig();
    const config = {
      ...base,
      reachability: {
        ...base.reachability!,
        nextProbeAtMs: 2_000,
      },
    };
    const confirmedProfile = resolveEvTargetPowerConfirmedProfile(config);

    expect(resolveEvTargetPowerPlannerProfile({ config, confirmedProfile, nowMs: 1_999 }))
      .toBe(confirmedProfile);
    expect(resolveEvTargetPowerPlannerProfile({ config, confirmedProfile, nowMs: 2_000 }).steps.at(-1)?.id)
      .toBe('28a');
  });

  it('uses the confirmed maximum for synthetic target-power emulation', () => {
    const config = buildConfig();
    const capabilityObj = buildSyntheticTargetPowerCapabilityMap({
      capabilityObj: {},
      config,
      observedValue: 5_750,
    });

    expect(capabilityObj.target_power?.max).toBe(5_750);
    expect(capabilityObj.target_power?.value).toBe(5_750);
  });

  it('rejects stale reachability fingerprints and caps retry backoff at one hour', () => {
    const config = buildConfig();
    const stale = {
      ...config,
      reachability: {
        ...config.reachability!,
        profileFingerprint: 'old-profile',
      },
    };

    expect(resolveValidTargetPowerReachability(stale)).toBeUndefined();
    expect(resolveTargetPowerProbeRetryAtMs(1_000, 1)).toBe(901_000);
    expect(resolveTargetPowerProbeRetryAtMs(1_000, 2)).toBe(1_801_000);
    expect(resolveTargetPowerProbeRetryAtMs(1_000, 9)).toBe(3_601_000);
  });

  it('keeps the proven maximum when only an early lower ramp sample exists at settlement', () => {
    const config = buildConfig();
    const transition = resolveTargetPowerReachabilityTransition({
      profileFingerprint: config.reachability!.profileFingerprint,
      currentReachability: config.reachability,
      command: {
        requestedPowerW: 6_440,
        confirmedMaxPowerW: 5_750,
        issuedAtMs: 1_000,
        settleWindowMs: 100,
      },
      observation: { planningPowerW: 1_380, observedAtMs: 1_050 },
      nowMs: 2_000,
    });

    expect(transition).toMatchObject({
      kind: 'failed',
      reachability: { maxReachedPowerW: 5_750, probeFailureCount: 1, nextProbeAtMs: 902_000 },
    });
    expect(transition).not.toHaveProperty('observedPowerW');
  });

  it('retains backoff while advancing to an early intermediate clamp', () => {
    const config = buildConfig(5_520);
    const transition = resolveTargetPowerReachabilityTransition({
      profileFingerprint: config.reachability!.profileFingerprint,
      currentReachability: config.reachability,
      command: {
        requestedPowerW: 6_440,
        confirmedMaxPowerW: 5_520,
        issuedAtMs: 1_000,
        settleWindowMs: 100,
      },
      observation: { planningPowerW: 5_750, observedAtMs: 1_050 },
      nowMs: 2_000,
    });

    expect(transition).toMatchObject({
      kind: 'failed',
      reachability: {
        maxReachedPowerW: 5_750,
        probeFailureCount: 1,
        nextProbeAtMs: 902_000,
      },
    });
    expect(transition).not.toHaveProperty('observedPowerW');
  });

  it('captures a settled exact intermediate rung without lowering prior proof', () => {
    const config = buildConfig(5_520);
    const transition = resolveTargetPowerReachabilityTransition({
      profileFingerprint: config.reachability!.profileFingerprint,
      currentReachability: config.reachability,
      command: {
        requestedPowerW: 6_440,
        confirmedMaxPowerW: 5_520,
        issuedAtMs: 1_000,
        settleWindowMs: 100,
      },
      observation: { planningPowerW: 5_750, observedAtMs: 1_500 },
      nowMs: 2_000,
    });

    expect(transition).toMatchObject({
      kind: 'failed',
      observedPowerW: 5_750,
      reachability: { maxReachedPowerW: 5_750, probeFailureCount: 1 },
    });
  });
});
