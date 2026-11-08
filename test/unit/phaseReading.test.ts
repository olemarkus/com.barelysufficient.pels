import { describe, expect, it } from 'vitest';
import type { MeterPhasesRead, PhaseTriple } from '../../lib/ports/homeMeterReadings';
import { PhaseReadingTracker } from '../../lib/power/phaseReading';
import { resolveMeterPhases } from '../../lib/device/meterPhases';

const power = (powerW: PhaseTriple): MeterPhasesRead => ({ state: 'read', capabilityIds: [], powerW });
const caps = (entries: Record<string, unknown>) => ({
  capabilitiesObj: Object.fromEntries(Object.entries(entries).map(([id, value]) => [id, { value }])),
});

describe('resolveMeterPhases', () => {
  it.each(['l', 'L', 'p', 'phase', 'phase_'])('recognises measure_power.%s1-3', (prefix) => {
    const read = resolveMeterPhases(caps({
      [`measure_power.${prefix}1`]: 100, [`measure_power.${prefix}2`]: -50, [`measure_power.${prefix}3`]: 0,
    }));
    expect(read).toMatchObject({ state: 'read', powerW: [100, -50, 0] });
  });

  it('nets split import and export per phase', () => {
    const read = resolveMeterPhases(caps({
      'measure_power.l1i': 500, 'measure_power.l1e': 0,
      'measure_power.l2i': 0, 'measure_power.l2e': 300,
      'measure_power.l3i': 100, 'measure_power.l3e': 100,
    }));
    expect(read).toMatchObject({ state: 'read', powerW: [500, -300, 0] });
  });

  it('treats a facet with a missing phase as absent', () => {
    const read = resolveMeterPhases(caps({ 'measure_power.l1': 1, 'measure_power.l2': 2, measure_power: 3 }));
    expect(read).toEqual({ state: 'none', capabilityIds: ['measure_power.l1', 'measure_power.l2', 'measure_power'] });
  });

  it('treats a non-finite value as absent', () => {
    expect(resolveMeterPhases(caps({
      'measure_current.l1': 1, 'measure_current.l2': null, 'measure_current.l3': 3,
    })).state).toBe('none');
  });
});

describe('PhaseReadingTracker', () => {
  it('accepts phases that agree with net, even when import and export cancel', () => {
    const tracker = new PhaseReadingTracker();
    tracker.admit(power([6000, -3000, -3000]), 0, 1);
    expect(tracker.current()).toMatchObject({ kind: 'healthy', signed: true });
  });

  it('keeps the last accepted set through a rejection, then degrades', () => {
    const tracker = new PhaseReadingTracker();
    tracker.admit(power([1000, 1000, 1000]), 3000, 1);
    for (let i = 0; i < 5; i += 1) tracker.admit(power([9000, 9000, 9000 + i]), 3000, 2);
    expect(tracker.current()).toMatchObject({ kind: 'healthy', acceptedAtMs: 1 });
    tracker.admit(power([9000, 9000, 9100]), 3000, 3);
    expect(tracker.current()).toEqual({ kind: 'degraded' });
  });

  it('rejects a frozen set while net moves', () => {
    const tracker = new PhaseReadingTracker();
    tracker.admit(power([1000, 1000, 1000]), 3000, 1);
    tracker.admit(power([1000, 1000, 1000]), 3300, 2);
    expect(tracker.current()).toMatchObject({ acceptedAtMs: 1 });
  });

  it('leaves the picture alone on a failed read', () => {
    const tracker = new PhaseReadingTracker();
    tracker.admit(power([1000, 1000, 1000]), 3000, 1);
    tracker.admit({ state: 'unavailable' }, 3000, 2);
    expect(tracker.current()).toMatchObject({ kind: 'healthy', acceptedAtMs: 1 });
  });

  it('checks a current-only meter one-sidedly and marks it unsigned', () => {
    const tracker = new PhaseReadingTracker();
    tracker.admit({ state: 'read', capabilityIds: [], currentA: [10, 5, 5] }, 2000, 1);
    expect(tracker.current()).toMatchObject({ kind: 'healthy', signed: false });
    const impossible = new PhaseReadingTracker();
    impossible.admit({ state: 'read', capabilityIds: [], currentA: [1, 1, 1] }, 9000, 1);
    expect(impossible.current()).toEqual({ kind: 'degraded' });
  });
});
