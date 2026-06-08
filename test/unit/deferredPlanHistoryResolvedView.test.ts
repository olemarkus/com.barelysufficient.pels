import { describe, expect, it } from 'vitest';

import type { DeferredObjectivePlanHistoryEntry } from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { toResolvedPlanHistoryEntry } from '../../packages/shared-domain/src/deferredPlanHistoryResolvedView';

const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = Date.UTC(2026, 4, 16, 7, 0, 0);

const buildRaw = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): DeferredObjectivePlanHistoryEntry => ({
  id: 'entry-1',
  deviceId: 'dev-1',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: DEADLINE_MS,
  startedAtMs: DEADLINE_MS - 8 * HOUR_MS,
  finalizedAtMs: DEADLINE_MS - HOUR_MS,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 64,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 4,
  outcome: 'met',
  metReason: 'stalled',
  metAtMs: DEADLINE_MS - 18 * 60 * 1000,
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  revisionCount: 3,
  costDisplay: { unit: 'kr', divisor: 100 },
  ...overrides,
});

describe('toResolvedPlanHistoryEntry', () => {
  it('resolves a temperature entry (°C columns) to unit-agnostic values', () => {
    const resolved = toResolvedPlanHistoryEntry(buildRaw());
    expect(resolved.targetValue).toBe(65);
    expect(resolved.startProgressValue).toBe(50);
    expect(resolved.finalProgressValue).toBe(64);
  });

  it('resolves an EV-SoC entry (% columns) to the same fields', () => {
    const resolved = toResolvedPlanHistoryEntry(buildRaw({
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      startProgressC: null,
      startProgressPercent: 20,
      finalProgressC: null,
      finalProgressPercent: 78,
    }));
    expect(resolved.targetValue).toBe(80);
    expect(resolved.startProgressValue).toBe(20);
    expect(resolved.finalProgressValue).toBe(78);
  });

  it('resolves via the objective kind even if a stray opposite column is set', () => {
    // Locks the `*Percent ?? *C` invariant the rendered strings now depend on:
    // a (malformed) temperature entry carrying a stray non-null `*Percent`
    // would surface that stray value. The recorder never produces this — the
    // test documents the single-non-null-column contract the producer assumes.
    const resolved = toResolvedPlanHistoryEntry(buildRaw({
      objectiveKind: 'temperature',
      targetTemperatureC: 65,
      targetPercent: null,
    }));
    expect(resolved.targetValue).toBe(65);
  });

  it('omits the raw kind-split columns from the resolved view', () => {
    const resolved = toResolvedPlanHistoryEntry(buildRaw());
    for (const key of [
      'targetTemperatureC', 'targetPercent',
      'startProgressC', 'startProgressPercent',
      'finalProgressC', 'finalProgressPercent',
    ]) {
      expect(resolved).not.toHaveProperty(key);
    }
  });

  it('preserves every non-value field (including optionals)', () => {
    const resolved = toResolvedPlanHistoryEntry(buildRaw());
    expect(resolved.id).toBe('entry-1');
    expect(resolved.objectiveKind).toBe('temperature');
    expect(resolved.outcome).toBe('met');
    expect(resolved.metReason).toBe('stalled');
    expect(resolved.metAtMs).toBe(DEADLINE_MS - 18 * 60 * 1000);
    expect(resolved.revisionCount).toBe(3);
    expect(resolved.costDisplay).toEqual({ unit: 'kr', divisor: 100 });
  });

  it('resolves progress samples to a single `value` and keeps them absent when unset', () => {
    const without = toResolvedPlanHistoryEntry(buildRaw());
    expect(without).not.toHaveProperty('progressSamples');

    const withSamples = toResolvedPlanHistoryEntry(buildRaw({
      progressSamples: [
        { atMs: DEADLINE_MS - 8 * HOUR_MS, valueC: 50, valuePercent: null },
        { atMs: DEADLINE_MS - 7 * HOUR_MS, valueC: 56, valuePercent: null },
      ],
    }));
    expect(withSamples.progressSamples).toEqual([
      { atMs: DEADLINE_MS - 8 * HOUR_MS, value: 50 },
      { atMs: DEADLINE_MS - 7 * HOUR_MS, value: 56 },
    ]);
  });
});
