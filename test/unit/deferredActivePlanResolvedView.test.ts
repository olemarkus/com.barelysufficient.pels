import { describe, expect, it } from 'vitest';

import type { DeferredObjectiveActivePlanV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  toResolvedActivePlan,
  toResolvedActivePlans,
} from '../../packages/shared-domain/src/deferredActivePlanResolvedView';

const buildRaw = (
  overrides: Partial<DeferredObjectiveActivePlanV1> = {},
): DeferredObjectiveActivePlanV1 => ({
  deviceId: 'dev-1',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: 100,
  startedAtMs: 0,
  pending: false,
  objectiveSignature: 'sig',
  original: null,
  latest: null,
  ...overrides,
});

describe('toResolvedActivePlan', () => {
  it('resolves a temperature plan (°C column) to a unit-agnostic targetValue', () => {
    expect(toResolvedActivePlan(buildRaw()).targetValue).toBe(65);
  });

  it('resolves an EV-SoC plan (% column) to targetValue', () => {
    const resolved = toResolvedActivePlan(buildRaw({
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
    }));
    expect(resolved.targetValue).toBe(80);
  });

  it('omits the raw kind-split columns from the resolved view', () => {
    const resolved = toResolvedActivePlan(buildRaw());
    for (const key of [
      'targetTemperatureC', 'targetPercent',
      'startProgressC', 'startProgressPercent',
    ]) {
      expect(resolved).not.toHaveProperty(key);
    }
  });

  it('preserves non-value fields (objectiveKind, latest, signature)', () => {
    const resolved = toResolvedActivePlan(buildRaw({ objectiveSignature: 'sig-2' }));
    expect(resolved.objectiveKind).toBe('temperature');
    expect(resolved.objectiveSignature).toBe('sig-2');
    expect(resolved.latest).toBeNull();
  });

  it('omits startProgressValue + progressSamples on a plan with no live trajectory', () => {
    const resolved = toResolvedActivePlan(buildRaw());
    expect(resolved).not.toHaveProperty('startProgressValue');
    expect(resolved).not.toHaveProperty('progressSamples');
  });

  it('resolves the stitched trajectory (startProgress + samples) when present', () => {
    const resolved = toResolvedActivePlan(buildRaw({
      startProgressC: 50,
      startProgressPercent: null,
      progressSamples: [
        { atMs: 0, valueC: 50, valuePercent: null },
        { atMs: 10, valueC: 56, valuePercent: null },
      ],
    }));
    expect(resolved.startProgressValue).toBe(50);
    expect(resolved.progressSamples).toEqual([
      { atMs: 0, value: 50 },
      { atMs: 10, value: 56 },
    ]);
  });
});

describe('toResolvedActivePlans', () => {
  it('passes a null plan through untouched (degraded-state defense, no crash)', () => {
    const resolved = toResolvedActivePlans({
      version: 1,
      // The record type is non-null, but degraded runtime states can yield null.
      plansByDeviceId: { a: null as unknown as DeferredObjectiveActivePlanV1 },
    });
    expect(resolved.plansByDeviceId.a).toBeNull();
  });

  it('resolves every plan in the container', () => {
    const resolved = toResolvedActivePlans({
      version: 1,
      plansByDeviceId: {
        a: buildRaw({ deviceId: 'a', targetTemperatureC: 65, targetPercent: null }),
        b: buildRaw({
          deviceId: 'b', objectiveKind: 'ev_soc', targetTemperatureC: null, targetPercent: 80,
        }),
      },
    });
    expect(resolved.version).toBe(1);
    expect(resolved.plansByDeviceId.a!.targetValue).toBe(65);
    expect(resolved.plansByDeviceId.b!.targetValue).toBe(80);
  });
});
