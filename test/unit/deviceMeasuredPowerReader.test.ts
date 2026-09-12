import { readDeviceMeasuredPowerObservation } from '../../lib/device/measuredPowerReader';

type CapabilityObj = Parameters<typeof readDeviceMeasuredPowerObservation>[0]['capabilityObj'];

const STAMP = '2026-01-01T00:00:00.000Z';

const read = (capabilityObj: CapabilityObj) => readDeviceMeasuredPowerObservation({
  deviceId: 'dev-1',
  capabilities: Object.keys(capabilityObj),
  capabilityObj,
});

// The reader is where "a meter reading" is decided. A rate is derived from two
// readings on the device's own clock, so a value without a stamp is not one —
// resolving that here is what lets the resolver take a `MeterEnergyReading`
// and never ask whether its halves are present.
describe('readDeviceMeasuredPowerObservation — meter_power', () => {
  it('pairs a finite value with its stamp into one reading', () => {
    expect(read({ meter_power: { value: 100.5, lastUpdated: STAMP } }).meterEnergy)
      .toEqual({ kwh: 100.5, observedAtMs: Date.parse(STAMP) });
  });

  it('resolves a value with no stamp to absence', () => {
    expect(read({ meter_power: { value: 100.5 } }).meterEnergy).toBeUndefined();
  });

  it('resolves a stamp with no finite value to absence', () => {
    expect(read({ meter_power: { value: null, lastUpdated: STAMP } }).meterEnergy).toBeUndefined();
  });

  // A cumulative meter is non-negative by definition. Rejecting a negative here
  // is also what keeps the resolver's energy difference finite: with both
  // operands in [0, MAX], `kwh - previous.kwh` cannot overflow.
  it('resolves a negative meter value to absence', () => {
    expect(read({ meter_power: { value: -1, lastUpdated: STAMP } }).meterEnergy).toBeUndefined();
  });

  // A finite number is not automatically a timestamp. Beyond the ECMAScript
  // time-value range (|t| <= 8.64e15 ms) `Date` cannot represent it, and two
  // such stamps of opposite sign would subtract to Infinity in any consumer —
  // which is why the range is enforced here and nowhere downstream.
  it('resolves a numeric stamp outside the time-value range to absence', () => {
    expect(read({ meter_power: { value: 100.5, lastUpdated: 1.7e308 } }).meterEnergy).toBeUndefined();
    expect(read({ meter_power: { value: 100.5, lastUpdated: -1.7e308 } }).meterEnergy).toBeUndefined();
  });

  it('accepts a numeric stamp inside the time-value range', () => {
    const epochMs = Date.parse(STAMP);
    expect(read({ meter_power: { value: 100.5, lastUpdated: epochMs } }).meterEnergy)
      .toEqual({ kwh: 100.5, observedAtMs: epochMs });
  });
});
