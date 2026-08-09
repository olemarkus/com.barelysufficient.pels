import {
  getCurrentDrawKw,
  getHighestKnownPowerKw,
  isActivelyDrawing,
} from '../../lib/observer/observedPower';

describe('getCurrentDrawKw', () => {
  it('is the meter reading, including a true zero', () => {
    expect(getCurrentDrawKw({ measuredPowerKw: 0.42 })).toBe(0.42);
    expect(getCurrentDrawKw({ measuredPowerKw: 0 })).toBe(0);
  });

  it('resolves a device with no reading to 0 rather than inventing a draw', () => {
    // No declared-load rung and no fallback constant. The population a declared
    // load would have described is already metered — every device on a 124-device
    // fleet carrying `settings.load` also exposes plain `measure_power` — and a
    // declared load is a CONSTANT, so reading it would break the property that
    // `currentDrawKw > 0` means "drawing". A satisfied Elko thermostat reports its
    // own honest 0 W instead.
    expect(getCurrentDrawKw({})).toBe(0);
  });

  it('drops a null or non-finite reading instead of returning it as a number', () => {
    // The producer boundary is the one shape check in a design where every
    // consumer trusts the result implicitly, so a presence check is not enough.
    expect(getCurrentDrawKw({ measuredPowerKw: null as unknown as number })).toBe(0);
    expect(getCurrentDrawKw({ measuredPowerKw: Number.NaN })).toBe(0);
  });

  it('drops a negative reading — a discharging battery is not drawing', () => {
    // A home battery reads negative `measure_power` while discharging, and that is
    // its NORMAL state. Returning it would hand a negative draw to consumers that
    // trust the number implicitly, and would falsify the "present implies finite,
    // non-negative kW" invariant the snapshot contract documents.
    expect(getCurrentDrawKw({ measuredPowerKw: -1.5 })).toBe(0);
  });
});

// Absorbed `getRestoreDrawKw`, which was deleted: it existed only to answer the
// case where every candidate was absent, and `expectedPowerKw` being a required,
// always-positive producer output means the producer no longer emits that case.
// The `'configured'` and `'fallback'` source labels went with it — the first
// named `powerKw`, the second named a state that cannot occur.
describe('getHighestKnownPowerKw', () => {
  it('returns the highest value across measured / expected / planning', () => {
    const result = getHighestKnownPowerKw({
      currentDrawKw: 0.8,
      expectedPowerKw: 3,
      planningPowerKw: 1.0,
    });
    expect(result).toEqual({ kw: 3, source: 'expected' });
  });

  it('is total — the expected demand is the floor, so there is no null arm', () => {
    expect(getHighestKnownPowerKw({ currentDrawKw: 0, expectedPowerKw: 1 }))
      .toEqual({ kw: 1, source: 'expected' });
  });

  it('is stable across observed-on/off changes — current draw does not erase expected demand', () => {
    // The two inputs must actually DIFFER on the draw, or the assertion proves
    // nothing. A thermostat mid-duty-cycle reads 0 one moment and 0.6 the next;
    // the restore reservation must not move with it.
    expect(getHighestKnownPowerKw({ currentDrawKw: 0, expectedPowerKw: 1 }).kw).toBe(1);
    expect(getHighestKnownPowerKw({ currentDrawKw: 0.6, expectedPowerKw: 1 }).kw).toBe(1);
  });

  it('resolves a tie to the earliest candidate, so a device measuring its expected draw reads measured', () => {
    // Order is load-bearing beyond the max: reordering the candidate list to put
    // the guaranteed field first silently relabels every tie as `'expected'`.
    expect(getHighestKnownPowerKw({ currentDrawKw: 1.8, expectedPowerKw: 1.8 }).source).toBe('measured');
  });

  it('reports the source label that drove the result', () => {
    expect(getHighestKnownPowerKw({ currentDrawKw: 2, expectedPowerKw: 1 }).source).toBe('measured');
    expect(getHighestKnownPowerKw({ currentDrawKw: 0, expectedPowerKw: 1 }).source).toBe('expected');
    expect(getHighestKnownPowerKw({ currentDrawKw: 0, expectedPowerKw: 1, planningPowerKw: 4 }).source)
      .toBe('planning');
  });
});

describe('isActivelyDrawing', () => {
  it('is true when currentOn is true', () => {
    expect(isActivelyDrawing({ currentDrawKw: 0, currentOn: true })).toBe(true);
  });

  it('is true when measured power is above the activation threshold', () => {
    expect(isActivelyDrawing({ currentDrawKw: 0.06 })).toBe(true);
  });

  it('is false when measured power is at or below the activation threshold', () => {
    expect(isActivelyDrawing({ currentDrawKw: 0.05 })).toBe(false);
    expect(isActivelyDrawing({ currentDrawKw: 0 })).toBe(false);
  });

  it('is false when available is explicitly false', () => {
    expect(isActivelyDrawing({ available: false, currentOn: true, currentDrawKw: 5 })).toBe(false);
  });

  it('is false when nothing is observed', () => {
    expect(isActivelyDrawing({ currentDrawKw: 0})).toBe(false);
  });
});
