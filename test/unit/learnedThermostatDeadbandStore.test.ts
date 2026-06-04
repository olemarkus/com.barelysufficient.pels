import {
  LEARNED_THERMOSTAT_DEADBAND_EMA_NEW,
  LEARNED_THERMOSTAT_DEADBAND_EMA_OLD,
  LEARNED_THERMOSTAT_DEADBAND_MAX_C,
  getLearnedThermostatDeadbandC,
  normaliseLearnedThermostatDeadbandMap,
  updateLearnedThermostatDeadband,
} from '../../lib/utils/learnedThermostatDeadbandStore';

describe('normaliseLearnedThermostatDeadbandMap', () => {
  it('returns empty map for null / undefined / non-object', () => {
    expect(normaliseLearnedThermostatDeadbandMap(null)).toEqual({});
    expect(normaliseLearnedThermostatDeadbandMap(undefined)).toEqual({});
    expect(normaliseLearnedThermostatDeadbandMap('not-a-map')).toEqual({});
    expect(normaliseLearnedThermostatDeadbandMap(42)).toEqual({});
    expect(normaliseLearnedThermostatDeadbandMap([1, 2, 3])).toEqual({});
  });

  it('drops keys whose values are not finite numbers', () => {
    expect(normaliseLearnedThermostatDeadbandMap({
      a: 0.3,
      b: 'not-a-number',
      c: NaN,
      d: Infinity,
      e: null,
    })).toEqual({ a: 0.3 });
  });

  it('clamps negative values to 0', () => {
    expect(normaliseLearnedThermostatDeadbandMap({ a: -0.5 })).toEqual({ a: 0 });
  });

  it('clamps values above max to LEARNED_THERMOSTAT_DEADBAND_MAX_C', () => {
    const result = normaliseLearnedThermostatDeadbandMap({ a: 2.5 });
    expect(result.a).toBe(LEARNED_THERMOSTAT_DEADBAND_MAX_C);
  });
});

describe('getLearnedThermostatDeadbandC', () => {
  it('returns 0 for a device not in the map', () => {
    expect(getLearnedThermostatDeadbandC({}, 'dev-1')).toBe(0);
  });

  it('returns the persisted value when present', () => {
    expect(getLearnedThermostatDeadbandC({ 'dev-1': 0.4 }, 'dev-1')).toBe(0.4);
  });

  it('clamps on read in case persisted state is out of range', () => {
    expect(getLearnedThermostatDeadbandC({ 'dev-1': 2.5 }, 'dev-1'))
      .toBe(LEARNED_THERMOSTAT_DEADBAND_MAX_C);
    expect(getLearnedThermostatDeadbandC({ 'dev-1': -0.3 }, 'dev-1')).toBe(0);
  });

  it('returns 0 when stored value is not finite', () => {
    expect(getLearnedThermostatDeadbandC({ 'dev-1': NaN as unknown as number }, 'dev-1')).toBe(0);
  });
});

describe('updateLearnedThermostatDeadband', () => {
  it('updates a fresh device with the observed value weighted by EMA_NEW', () => {
    const next = updateLearnedThermostatDeadband({
      map: {},
      deviceId: 'dev-1',
      observedDeadbandC: 0.4,
    });
    expect(next['dev-1']).toBeCloseTo(0.4 * LEARNED_THERMOSTAT_DEADBAND_EMA_NEW);
  });

  it('EMA-mixes against the existing value', () => {
    const next = updateLearnedThermostatDeadband({
      map: { 'dev-1': 0.2 },
      deviceId: 'dev-1',
      observedDeadbandC: 0.6,
    });
    const expected = 0.2 * LEARNED_THERMOSTAT_DEADBAND_EMA_OLD
      + 0.6 * LEARNED_THERMOSTAT_DEADBAND_EMA_NEW;
    expect(next['dev-1']).toBeCloseTo(expected);
  });

  it('clamps an EMA result above max', () => {
    const next = updateLearnedThermostatDeadband({
      map: { 'dev-1': LEARNED_THERMOSTAT_DEADBAND_MAX_C },
      deviceId: 'dev-1',
      observedDeadbandC: 5,
    });
    expect(next['dev-1']).toBe(LEARNED_THERMOSTAT_DEADBAND_MAX_C);
  });

  it('clamps a negative observed reading to 0 before mixing', () => {
    const next = updateLearnedThermostatDeadband({
      map: { 'dev-1': 0.4 },
      deviceId: 'dev-1',
      observedDeadbandC: -0.5,
    });
    // observed clamps to 0; result = 0.4 * 0.7 = 0.28
    expect(next['dev-1']).toBeCloseTo(0.4 * LEARNED_THERMOSTAT_DEADBAND_EMA_OLD);
  });

  it('skips non-finite observed readings entirely', () => {
    const map = { 'dev-1': 0.4 };
    expect(updateLearnedThermostatDeadband({
      map, deviceId: 'dev-1', observedDeadbandC: NaN,
    })).toBe(map);
    expect(updateLearnedThermostatDeadband({
      map, deviceId: 'dev-1', observedDeadbandC: Infinity,
    })).toBe(map);
  });

  it('does not churn the map when the EMA produces no movement on an existing zero', () => {
    const map = { 'dev-1': 0 };
    const next = updateLearnedThermostatDeadband({
      map, deviceId: 'dev-1', observedDeadbandC: 0,
    });
    expect(next).toBe(map);
  });

  it('preserves other devices when updating one', () => {
    const next = updateLearnedThermostatDeadband({
      map: { 'dev-1': 0.2, 'dev-2': 0.5 },
      deviceId: 'dev-1',
      observedDeadbandC: 0.4,
    });
    expect(next['dev-2']).toBe(0.5);
  });
});
