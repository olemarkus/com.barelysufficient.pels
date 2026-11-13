import {
  resolveChargingPhaseFootprint, resolveChargingPhaseObservedPoint,
} from '../../lib/phaseFootprint/chargingPhaseFootprints';

describe('charging phase footprints', () => {
  it('resolves each envelope from the one installation mapping', () => {
    expect(resolveChargingPhaseFootprint('three_L2', 1)).toEqual({ kind: 'single', phase: 'L2' });
    expect(resolveChargingPhaseFootprint('three_L2', 3)).toEqual({ kind: 'all_three' });
    expect(resolveChargingPhaseFootprint('L2', 3)).toEqual({ kind: 'unknown' });
    expect(resolveChargingPhaseFootprint('all', 1)).toEqual({ kind: 'unknown' });
  });

  it('keeps unequal phase load conservative without assuming the other two wires rotation', () => {
    const point = resolveChargingPhaseObservedPoint({ currentLimitA: 10,
      totalPower: { watts: 4200 }, powers: [{ watts: 2000 }, { watts: 1500 }, { watts: 700 }],
    }, 3, 'three_L2');
    expect(point).toEqual({ phases: 3, currentA: 10, totalKw: 4.2,
      perPhaseKw: { L1: 1.5, L2: 2, L3: 1.5 } });
  });

  it('does not spread unknown phase load equally across the house', () => {
    const point = resolveChargingPhaseObservedPoint({ currentLimitA: 6,
      totalPower: { watts: 1380 }, powers: [{ watts: 1380 }, { watts: 0 }, { watts: 0 }],
    }, 1, undefined);
    expect(point.perPhaseKw).toEqual({ L1: 1.38, L2: 1.38, L3: 1.38 });
  });
});
