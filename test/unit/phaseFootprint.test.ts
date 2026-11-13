import { resolvePhaseFootprint, type PhaseFootprintFacts } from '../../lib/phaseFootprint/resolvePhaseFootprint';
import { resolveChargerPhaseCurrentsA } from '../../lib/device/chargerPhaseCurrents';
import { isDevicePhaseConnectionMap } from '../../packages/shared-domain/src/settings/devicePhaseConnections';

const noFacts: PhaseFootprintFacts = {
  ownerConnection: undefined, isEvCharger: false, chargerPhaseCurrentsA: undefined,
  evPreset: undefined, learned: undefined, operatingPhases: undefined,
};
const charger: PhaseFootprintFacts = { ...noFacts, isEvCharger: true };

describe('resolvePhaseFootprint', () => {
  it("takes the owner's connection above anything measured", () => {
    expect(resolvePhaseFootprint({
      ...charger, ownerConnection: 'L2', chargerPhaseCurrentsA: [16, 16, 16], evPreset: 'ev_charger_3_phase',
    })).toEqual({ kind: 'single', phase: 'L2' });
    expect(resolvePhaseFootprint({ ...noFacts, ownerConnection: 'all' })).toEqual({ kind: 'all_three' });
    expect(resolvePhaseFootprint({ ...charger, ownerConnection: 'self_balancing' }))
      .toEqual({ kind: 'self_balancing' });
  });

  it('reads a charger drawing on three phases as all three', () => {
    expect(resolvePhaseFootprint({
      ...charger, chargerPhaseCurrentsA: [10, 9, 11], evPreset: 'ev_charger_1_phase',
    })).toEqual({ kind: 'all_three' });
  });

  it('uses the current operating envelope with a switchable installation mapping, including after hand-back', () => {
    expect(resolvePhaseFootprint({ ...charger, ownerConnection: 'three_L2', operatingPhases: 1,
      learned: { kind: 'all_three' } })).toEqual({ kind: 'single', phase: 'L2' });
    expect(resolvePhaseFootprint({ ...charger, ownerConnection: 'three_L2', operatingPhases: 3,
      learned: { kind: 'single', phase: 'L1' } })).toEqual({ kind: 'all_three' });
    expect(resolvePhaseFootprint({ ...charger, ownerConnection: 'three_L2' })).toEqual({ kind: 'unknown' });
    expect(resolvePhaseFootprint({ ...charger, ownerConnection: 'three_L2', operatingPhases: 1,
      chargerPhaseCurrentsA: [6, 6, 6] })).toEqual({ kind: 'all_three' });
  });

  it('does not name a phase for a charger drawing on one, even on a three-phase mode', () => {
    expect(resolvePhaseFootprint({
      ...charger, chargerPhaseCurrentsA: [15, 0.2, 0], evPreset: 'ev_charger_3_phase',
    })).toEqual({ kind: 'unknown' });
  });

  it('falls back to the control mode when no phase is drawing', () => {
    expect(resolvePhaseFootprint({ ...charger, chargerPhaseCurrentsA: [0, 0.5, 0], evPreset: 'ev_charger_3_phase' }))
      .toEqual({ kind: 'all_three' });
    expect(resolvePhaseFootprint({ ...charger, chargerPhaseCurrentsA: undefined, evPreset: 'ev_charger_1_phase' }))
      .toEqual({ kind: 'unknown' });
    expect(resolvePhaseFootprint({ ...charger, chargerPhaseCurrentsA: undefined, evPreset: undefined }))
      .toEqual({ kind: 'unknown' });
  });

  it('leaves everything else unknown', () => {
    expect(resolvePhaseFootprint({ ...noFacts, evPreset: 'ev_charger_3_phase' })).toEqual({ kind: 'unknown' });
  });
});

describe('resolveChargerPhaseCurrentsA', () => {
  const read = (values: Record<string, unknown>, previous?: readonly [number, number, number]) => (
    resolveChargerPhaseCurrentsA({
      capabilitiesObj: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }])),
    }, previous)
  );

  it.each([
    ['measure_current.p1', 'measure_current.p2', 'measure_current.p3'],
    ['measure_current.l1', 'measure_current.l2', 'measure_current.l3'],
    ['measure_current.phase1', 'measure_current.phase2', 'measure_current.phase3'],
    ['measure_current.phase_a', 'measure_current.phase_b', 'measure_current.phase_c'],
  ])('recognises %s and siblings', (a, b, c) => {
    expect(read({ [a]: 1, [b]: 2, [c]: 3 })).toEqual([1, 2, 3]);
  });

  it('has no reading for a charger reporting fewer than three phases', () => {
    expect(read({ measure_current: 10, 'measure_current.p1': 10 })).toBeUndefined();
  });

  it('keeps the previous reading through an unusable value', () => {
    expect(read({ 'measure_current.p1': 1, 'measure_current.p2': null, 'measure_current.p3': 3 }, [4, 5, 6]))
      .toEqual([4, 5, 6]);
    expect(read({ 'measure_current.p1': -2, 'measure_current.p2': 2, 'measure_current.p3': 3 }, [4, 5, 6]))
      .toEqual([4, 5, 6]);
  });
});

describe('isDevicePhaseConnectionMap', () => {
  it('accepts the owner choices and rejects a map with a bad entry', () => {
    expect(isDevicePhaseConnectionMap({ a: 'L1', b: 'all', c: 'self_balancing' })).toBe(true);
    expect(isDevicePhaseConnectionMap({ a: 'L1', b: 'L4' })).toBe(false);
    expect(isDevicePhaseConnectionMap('L1')).toBe(false);
  });
});
