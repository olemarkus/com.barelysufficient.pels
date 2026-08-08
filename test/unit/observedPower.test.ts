import {
  getCurrentDrawKw,
  getHighestKnownPowerKw,
  getRestoreDrawKw,
  isActivelyDrawing,
} from '../../lib/observer/observedPower';

describe('getRestoreDrawKw', () => {
  it('returns the highest known non-zero value across all configured sources', () => {
    const result = getRestoreDrawKw({
      currentDrawKw: 0.8,
      expectedPowerKw: 1.4,
      planningPowerKw: 1.0,
      powerKw: 3,
    });
    expect(result).toEqual({ kw: 3, source: 'configured' });
  });

  it('is stable across observed-on/off state changes — current draw does not erase configured demand', () => {
    // The two inputs must actually DIFFER on the draw, or the assertion proves
    // nothing. A thermostat mid-duty-cycle reads 0 one moment and 0.6 the next;
    // the restore reservation must not move with it.
    const off = getRestoreDrawKw({ currentDrawKw: 0, expectedPowerKw: 1 });
    const on = getRestoreDrawKw({ currentDrawKw: 0.6, expectedPowerKw: 1 });
    expect(off.kw).toBe(1);
    expect(on.kw).toBe(1);
  });

  it('falls back to the EV default for evcharger_charging with no known power', () => {
    expect(getRestoreDrawKw({ currentDrawKw: 0, controlCapabilityId: 'evcharger_charging' }).kw).toBeCloseTo(1.38, 6);
  });

  it('falls back to the default for any other device with no known power', () => {
    expect(getRestoreDrawKw({ currentDrawKw: 0}).kw).toBe(1);
    expect(getRestoreDrawKw({ currentDrawKw: 0, expectedPowerKw: -1 }).kw).toBe(1);
  });

  it('reports the source label that drove the result', () => {
    expect(getRestoreDrawKw({ currentDrawKw: 2 }).source).toBe('measured');
    expect(getRestoreDrawKw({ currentDrawKw: 0, powerKw: 1 }).source).toBe('configured');
    expect(getRestoreDrawKw({ currentDrawKw: 0}).source).toBe('fallback');
  });
});

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

describe('getHighestKnownPowerKw', () => {
  it('returns null when no source is positive', () => {
    expect(getHighestKnownPowerKw({ currentDrawKw: 0})).toBeNull();
    expect(getHighestKnownPowerKw({ currentDrawKw: 0, expectedPowerKw: -1 })).toBeNull();
  });

  it('returns the highest non-zero value across all sources', () => {
    const result = getHighestKnownPowerKw({
      currentDrawKw: 0.8,
      expectedPowerKw: 1.4,
      planningPowerKw: 1.0,
      powerKw: 3,
    });
    expect(result).toEqual({ kw: 3, source: 'configured' });
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
