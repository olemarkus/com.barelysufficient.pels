import { describe, expect, it } from 'vitest';

import type { DeferredObjectiveActivePlanV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import { toResolvedActivePlan } from '../../packages/shared-domain/src/deferredActivePlanResolvedView';

const buildRaw = (
  overrides: Partial<DeferredObjectiveActivePlanV1> = {},
): DeferredObjectiveActivePlanV1 => ({
  liveCompletion: { kind: 'unavailable' },
  deviceId: 'dev-1',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetValue: 65,
  deadlineAtMs: 100,
  startedAtMs: 0,
  pending: false,
  objectiveSignature: 'sig',
  original: null,
  latest: null,
  ...overrides,
});

const nothingDelivered = () => 0;

describe('toResolvedActivePlan', () => {
  it('keeps the target in the task\'s own unit', () => {
    expect(toResolvedActivePlan(buildRaw(), nothingDelivered, null).targetValue).toBe(65);
    expect(toResolvedActivePlan(buildRaw({ objectiveKind: 'ev_soc', targetValue: 80 }), nothingDelivered, null).targetValue)
      .toBe(80);
  });

  it('carries an energy task\'s delivered energy, and nothing of the kind on other plans', () => {
    const readDelivered = (deviceId: string, deadlineAtMs: number) => (
      deviceId === 'dev-1' && deadlineAtMs === 100 ? 6.5 : 0
    );
    const energy = toResolvedActivePlan(buildRaw({ objectiveKind: 'energy', targetValue: 16 }), readDelivered, null);
    expect(energy).toMatchObject({ objectiveKind: 'energy', deliveredKWh: 6.5 });
    expect(toResolvedActivePlan(buildRaw(), readDelivered, null)).not.toHaveProperty('deliveredKWh');
  });

  it('preserves non-value fields (objectiveKind, latest, signature)', () => {
    const resolved = toResolvedActivePlan(buildRaw({
      liveCompletion: { kind: 'unavailable' as const }, objectiveSignature: 'sig-2' }), nothingDelivered, null);
    expect(resolved.objectiveKind).toBe('temperature');
    expect(resolved.objectiveSignature).toBe('sig-2');
    expect(resolved.latest).toBeNull();
    expect(resolved.progressDirection).toBe('unknown');
  });

  it('defaults a historical revision without direction to heating', () => {
    const resolved = toResolvedActivePlan(buildRaw({
      latest: {
        revision: 1,
        revisedAtMs: 0,
        computedFromPricesUpTo: null,
        reason: 'flow_card',
        hours: [],
        energyNeededKWh: 0,
        planStatus: 'on_track',
      },
    }), nothingDelivered, null);
    expect(resolved.progressDirection).toBe('increasing');
  });

  it('omits startProgressValue + progressSamples on a plan with no live trajectory', () => {
    const resolved = toResolvedActivePlan(buildRaw(), nothingDelivered, null);
    expect(resolved).not.toHaveProperty('startProgressValue');
    expect(resolved).not.toHaveProperty('progressSamples');
  });

  it('carries the stitched trajectory (startProgress + samples) when present', () => {
    const resolved = toResolvedActivePlan(buildRaw(), nothingDelivered, {
      startProgressValue: 50,
      progressSamples: [
        { atMs: 0, value: 50 },
        { atMs: 10, value: 56 },
      ],
    });
    expect(resolved.startProgressValue).toBe(50);
    expect(resolved.progressSamples).toEqual([
      { atMs: 0, value: 50 },
      { atMs: 10, value: 56 },
    ]);
  });
});
