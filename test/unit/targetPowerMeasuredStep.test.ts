import { describe, expect, it } from 'vitest';
import type { TargetPowerSteppedLoadConfig } from '../../packages/contracts/src/types';
import {
  buildEvTargetPowerProfileFingerprint,
  resolveEvMeasuredStep,
  resolveEvTargetPowerConfirmedProfile,
  resolveValidTargetPowerReachability,
} from '../../lib/device/targetPowerReachability';

const evConfig: TargetPowerSteppedLoadConfig = { enabled: true, preset: 'ev_charger_1_phase', max: 7_360 };

const measured = (powerW: number, config = evConfig): string | undefined => resolveEvMeasuredStep(config, powerW)?.id;

describe('resolveEvMeasuredStep', () => {
  it.each([
    ['exactly on a rung', 4_600, '20a'],
    ['off', 0, 'off'],
    ['over nominal mains', 4_614, '20a'],
    ['over nominal mains on 24 A', 5_623, '24a'],
    ['just under a rung', 1_320, '6a'],
    ['at the just-under margin', 7_210, '32a'],
    ['one watt past the just-under margin', 7_209, '28a'],
    ['between rungs', 5_112, '20a'],
    ['a non-standard current', 5_750, '24a'],
    ['one watt under a non-standard current', 5_749, '24a'],
    ['a charger settling short of a 32 A probe', 7_000, '28a'],
  ])('reads %s', (_name, powerW, stepId) => {
    expect(measured(powerW)).toBe(stepId);
  });

  it('accepts mains drift over the top rung and nothing more', () => {
    expect(measured(7_456)).toBe('32a');
    expect(measured(7_728)).toBe('32a');
    expect(measured(7_729)).toBeUndefined();
  });

  it('takes the top rung from the configured current limit', () => {
    const limited: TargetPowerSteppedLoadConfig = { ...evConfig, currentLimits: { minA: 6, maxA: 16 } };

    expect(measured(3_864, limited)).toBe('16a');
    expect(measured(3_865, limited)).toBeUndefined();
  });

  it('leaves a reading below the lowest rung unmatched', () => {
    expect(measured(356)).toBeUndefined();
    expect(measured(998)).toBeUndefined();
    expect(measured(-5)).toBeUndefined();
  });

  it('counts the phases on a three-phase charger', () => {
    const threePhase: TargetPowerSteppedLoadConfig = { enabled: true, preset: 'ev_charger_3_phase' };

    expect(measured(13_842, threePhase)).toBe('20a');
  });

  it('leaves a device without an EV preset alone', () => {
    expect(measured(4_614, { ...evConfig, enabled: false })).toBeUndefined();
    expect(resolveEvMeasuredStep(undefined, 4_614)).toBeUndefined();
  });
});

describe('saved maximum just over a rung', () => {
  const withMaximum = (maxReachedPowerW: number, config = evConfig) => ({
    ...config,
    reachability: {
      profileFingerprint: buildEvTargetPowerProfileFingerprint(config),
      maxReachedPowerW,
      probeFailureCount: 37,
      nextProbeAtMs: 1_000,
    },
  });
  const readMaximum = (maxReachedPowerW: number): number | undefined => (
    resolveValidTargetPowerReachability(withMaximum(maxReachedPowerW))?.maxReachedPowerW
  );

  it('reads as the rung and keeps the rest of the evidence', () => {
    expect(resolveValidTargetPowerReachability(withMaximum(6_514))).toEqual({
      profileFingerprint: buildEvTargetPowerProfileFingerprint(evConfig),
      maxReachedPowerW: 6_440,
      probeFailureCount: 37,
      nextProbeAtMs: 1_000,
    });
  });

  it('adds no off-ladder step to the confirmed ladder', () => {
    const stepIds = resolveEvTargetPowerConfirmedProfile(withMaximum(6_514)).steps.map((step) => step.id);

    expect(stepIds.at(-1)).toBe('28a');
    expect(stepIds).not.toContain('28.322a');
  });

  it.each([
    ['exactly on a rung', 4_600],
    ['a full amp over a rung', 5_750],
    ['past 5% of a rung', 1_452],
    ['well between rungs', 5_112],
  ])('keeps a maximum %s', (_name, maxReachedPowerW) => {
    expect(readMaximum(maxReachedPowerW)).toBe(maxReachedPowerW);
  });

  it('caps the correction at half the gap to the rung above', () => {
    const closeRungs: TargetPowerSteppedLoadConfig = { ...evConfig, currentLimits: { minA: 20, maxA: 21 } };
    const read = (powerW: number) => resolveValidTargetPowerReachability(withMaximum(powerW, closeRungs))?.maxReachedPowerW;

    expect(read(4_715)).toBe(4_600);
    expect(read(4_716)).toBe(4_716);
  });
});
