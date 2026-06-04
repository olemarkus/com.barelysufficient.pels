import {
  getCurrentDrawKw,
  getHighestKnownPowerKw,
  getMeasuredDrawKw,
  getRestoreDrawKw,
  isActivelyDrawing,
} from '../../lib/observer/observedPower';

describe('getMeasuredDrawKw', () => {
  it('returns the measured value when finite, including zero', () => {
    expect(getMeasuredDrawKw({ measuredPowerKw: 0.42 })).toBe(0.42);
    expect(getMeasuredDrawKw({ measuredPowerKw: 0 })).toBe(0);
  });

  it('returns null when measurement is missing, non-finite, or negative', () => {
    expect(getMeasuredDrawKw({})).toBeNull();
    expect(getMeasuredDrawKw({ measuredPowerKw: -1 })).toBeNull();
  });
});

describe('getRestoreDrawKw', () => {
  it('returns the highest known non-zero value across all configured sources', () => {
    const result = getRestoreDrawKw({
      measuredPowerKw: 0.8,
      expectedPowerKw: 1.4,
      planningPowerKw: 1.0,
      powerKw: 3,
    });
    expect(result).toEqual({ kw: 3, source: 'configured' });
  });

  it('is stable across observed-on/off state changes — current draw does not erase configured demand', () => {
    const off = getRestoreDrawKw({ measuredPowerKw: 0, expectedPowerKw: 1 });
    const on = getRestoreDrawKw({ measuredPowerKw: 1, expectedPowerKw: 1 });
    expect(off.kw).toBe(1);
    expect(on.kw).toBe(1);
  });

  it('falls back to the EV default for evcharger_charging with no known power', () => {
    expect(getRestoreDrawKw({ controlCapabilityId: 'evcharger_charging' }).kw).toBeCloseTo(1.38, 6);
  });

  it('falls back to the default for any other device with no known power', () => {
    expect(getRestoreDrawKw({}).kw).toBe(1);
    expect(getRestoreDrawKw({ measuredPowerKw: 0, expectedPowerKw: -1 }).kw).toBe(1);
  });

  it('reports the source label that drove the result', () => {
    expect(getRestoreDrawKw({ measuredPowerKw: 2 }).source).toBe('measured');
    expect(getRestoreDrawKw({ measuredPowerKw: 0, powerKw: 1 }).source).toBe('configured');
    expect(getRestoreDrawKw({}).source).toBe('fallback');
  });
});

describe('getCurrentDrawKw', () => {
  it('returns the measured value when present, including zero', () => {
    expect(getCurrentDrawKw({ measuredPowerKw: 0.42, currentOn: true })).toBe(0.42);
    expect(getCurrentDrawKw({ measuredPowerKw: 0, currentOn: true })).toBe(0);
  });

  it('returns 0 for an explicitly observed-off device — shedding gives no immediate relief', () => {
    expect(getCurrentDrawKw({ currentOn: false })).toBe(0);
    expect(getCurrentDrawKw({ currentOn: false, expectedPowerKw: 2 })).toBe(0);
  });

  it('falls back to the configured restore draw for an observed-on device with no measurement', () => {
    expect(getCurrentDrawKw({ currentOn: true, expectedPowerKw: 2 })).toBe(2);
    expect(getCurrentDrawKw({ currentOn: true })).toBe(1); // generic fallback
  });

  it('treats unknown state as conservatively active — uses restore draw as the estimate', () => {
    // Observation-stale devices are filtered upstream; reaching here means we
    // do not know the device is off, so be optimistic and use the configured demand.
    expect(getCurrentDrawKw({ expectedPowerKw: 2 })).toBe(2);
    expect(getCurrentDrawKw({})).toBe(1);
  });

  it('treats a stale currentOn=false as unknown and falls through to configured demand', () => {
    // Regression: shed/swap eligibility passes stale devices through to
    // getCurrentDrawKw (resolveEffectiveCurrentOn returns null for stale,
    // which is `!== false`). A stale `currentOn: false` must not zero the
    // device out — the device may still be drawing and shedding it could
    // still relieve load.
    expect(getCurrentDrawKw({
      currentOn: false,
      observationStale: true,
      expectedPowerKw: 2,
    })).toBe(2);
    expect(getCurrentDrawKw({
      currentOn: false,
      observationStale: false,
      expectedPowerKw: 2,
    })).toBe(0);
  });
});

describe('getHighestKnownPowerKw', () => {
  it('returns null when no source is positive', () => {
    expect(getHighestKnownPowerKw({})).toBeNull();
    expect(getHighestKnownPowerKw({ measuredPowerKw: 0, expectedPowerKw: -1 })).toBeNull();
  });

  it('returns the highest non-zero value across all sources', () => {
    const result = getHighestKnownPowerKw({
      measuredPowerKw: 0.8,
      expectedPowerKw: 1.4,
      planningPowerKw: 1.0,
      powerKw: 3,
    });
    expect(result).toEqual({ kw: 3, source: 'configured' });
  });
});

describe('isActivelyDrawing', () => {
  it('is true when currentOn is true', () => {
    expect(isActivelyDrawing({ currentOn: true })).toBe(true);
  });

  it('is true when measured power is above the activation threshold', () => {
    expect(isActivelyDrawing({ measuredPowerKw: 0.06 })).toBe(true);
  });

  it('is false when measured power is at or below the activation threshold', () => {
    expect(isActivelyDrawing({ measuredPowerKw: 0.05 })).toBe(false);
    expect(isActivelyDrawing({ measuredPowerKw: 0 })).toBe(false);
  });

  it('is false when available is explicitly false', () => {
    expect(isActivelyDrawing({ available: false, currentOn: true, measuredPowerKw: 5 })).toBe(false);
  });

  it('is false when nothing is observed', () => {
    expect(isActivelyDrawing({})).toBe(false);
  });
});
