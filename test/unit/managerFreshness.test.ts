import { applyFreshnessOnlyCapabilityUpdate } from '../../lib/device/transport/managerFreshness';
import type { EvObservedProbe, TargetDeviceSnapshot, TemperatureObservedProbe } from '../../packages/contracts/src/types';

// Minimal EV snapshot — the freshness handler only touches the EV fields below.
const evSnapshot = (
  evChargingState: string | undefined,
  evCharging: boolean,
): TargetDeviceSnapshot & EvObservedProbe => ({
  id: 'ev1',
  name: 'EV',
  evChargingState,
  evCharging,
  binaryControl: { on: evCharging },
} as unknown as TargetDeviceSnapshot & EvObservedProbe);

// Minimal numeric snapshot for the scalar boundary seams (measure_power /
// measure_temperature). Pre-seeded with a known-good prior value so a dropped
// junk write is observable as "prior value retained".
const numericSnapshot = (
  fields: { measuredPowerKw?: number; currentTemperature?: number },
): TargetDeviceSnapshot & TemperatureObservedProbe => ({
  id: 'dev1',
  name: 'Device',
  targets: [],
  ...fields,
} as unknown as TargetDeviceSnapshot & TemperatureObservedProbe);

const NON_FINITE: ReadonlyArray<[string, unknown]> = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['a non-number string', '12'],
  ['null', null],
];

describe('applyFreshnessOnlyCapabilityUpdate — evcharger_charging_state', () => {
  it('applies a known→known realtime transition', () => {
    const snapshot = evSnapshot('plugged_in_charging', true);
    const result = applyFreshnessOnlyCapabilityUpdate({
      snapshot,
      capabilityId: 'evcharger_charging_state',
      value: 'plugged_out',
    });
    expect(result.changed).toBe(true);
    expect(snapshot.evChargingState).toBe('plugged_out');
  });

  it('normalises an out-of-enum realtime value to undefined — never strands the prior state', () => {
    // Regression for the realtime-seam P1: a charger that leaves a known state
    // for an unrecognised value must transition to the uncommandable unknown
    // state, not retain the stale (still commandable) `plugged_in_charging`.
    const snapshot = evSnapshot('plugged_in_charging', false);
    const result = applyFreshnessOnlyCapabilityUpdate({
      snapshot,
      capabilityId: 'evcharger_charging_state',
      value: 'mystery',
    });
    expect(result.changed).toBe(true);
    expect(snapshot.evChargingState).toBeUndefined();
    // undefined defers to the evcharger_charging boolean (false here) → off.
    expect(snapshot.binaryControl?.on).toBe(false);
  });

  it('ignores a non-string realtime value, leaving the prior state intact', () => {
    const snapshot = evSnapshot('plugged_in_charging', true);
    const result = applyFreshnessOnlyCapabilityUpdate({
      snapshot,
      capabilityId: 'evcharger_charging_state',
      value: 42,
    });
    expect(result.changed).toBe(false);
    expect(snapshot.evChargingState).toBe('plugged_in_charging');
  });
});

// Boundary invariant for the scalar numeric seams: a realtime value that is not
// a finite number is DROPPED (no write, no `changed`), so the stored snapshot
// only ever holds finite values. Sibling of the measure_temperature P1 fix; this
// block seals the whole class, not just the one capability.
describe('applyFreshnessOnlyCapabilityUpdate — numeric boundary (present implies finite)', () => {
  it('writes a finite measure_power value (in kW)', () => {
    const snapshot = numericSnapshot({ measuredPowerKw: 1 });
    const result = applyFreshnessOnlyCapabilityUpdate({ snapshot, capabilityId: 'measure_power', value: 2000 });
    expect(result.changed).toBe(true);
    expect(snapshot.measuredPowerKw).toBe(2);
  });

  it.each(NON_FINITE)('drops a non-finite measure_power value (%s) — no write, no change', (_label, value) => {
    const snapshot = numericSnapshot({ measuredPowerKw: 2 });
    const result = applyFreshnessOnlyCapabilityUpdate({ snapshot, capabilityId: 'measure_power', value });
    expect(result.changed).toBe(false);
    // Prior finite value retained — junk never reaches the snapshot.
    expect(snapshot.measuredPowerKw).toBe(2);
  });

  it('writes a finite measure_temperature value', () => {
    const snapshot = numericSnapshot({ currentTemperature: 18 });
    const result = applyFreshnessOnlyCapabilityUpdate({ snapshot, capabilityId: 'measure_temperature', value: 21 });
    expect(result.changed).toBe(true);
    expect(snapshot.currentTemperature).toBe(21);
  });

  it.each(NON_FINITE)('drops a non-finite measure_temperature value (%s) — no write, no change', (_label, value) => {
    const snapshot = numericSnapshot({ currentTemperature: 18 });
    const result = applyFreshnessOnlyCapabilityUpdate({ snapshot, capabilityId: 'measure_temperature', value });
    expect(result.changed).toBe(false);
    expect(snapshot.currentTemperature).toBe(18);
  });
});
