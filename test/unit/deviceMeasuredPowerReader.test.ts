import { readDeviceMeasuredPowerObservation } from '../../lib/device/measuredPowerReader';
import { readHomeyEnergyDeviceWatts } from '../../lib/device/managerEnergy';

type CapabilityObj = Parameters<typeof readDeviceMeasuredPowerObservation>[0]['capabilityObj'];

const STAMP = '2026-01-01T00:00:00.000Z';

const read = (capabilityObj: CapabilityObj) => readDeviceMeasuredPowerObservation({
  deviceId: 'dev-1',
  capabilities: Object.keys(capabilityObj),
  capabilityObj,
  homeyEnergyObservedAtMs: Date.parse(STAMP),
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

describe('readDeviceMeasuredPowerObservation — Homey Energy', () => {
  const readEnergy = (live: Record<string, number>, deviceEnergyW: number | null) => (
    readDeviceMeasuredPowerObservation({
      deviceId: 'dev-1',
      capabilities: ['onoff'],
      capabilityObj: {},
      livePowerWByDeviceId: live,
      deviceEnergyW,
      homeyEnergyObservedAtMs: Date.parse(STAMP),
    }).homeyEnergyLive
  );

  it('reads the live report entry when the device is in the top zone', () => {
    expect(readEnergy({ 'dev-1': 1500 }, 1500)).toEqual({ watts: 1500, observedAtMs: Date.parse(STAMP) });
  });

  it('falls back to the device figure when the live report lists only its zone', () => {
    expect(readEnergy({}, 3000)).toEqual({ watts: 3000, observedAtMs: Date.parse(STAMP) });
  });

  it('has no reading when neither source has a figure', () => {
    expect(readEnergy({}, null)).toBeUndefined();
  });
});

describe('readHomeyEnergyDeviceWatts', () => {
  it('reads the device figure, including 0 W', () => {
    expect(readHomeyEnergyDeviceWatts({ id: 'a', name: 'A', energyObj: { W: 3000 } })).toBe(3000);
    expect(readHomeyEnergyDeviceWatts({ id: 'a', name: 'A', energyObj: { W: 0 } })).toBe(0);
  });

  it('has no figure when Homey has none', () => {
    expect(readHomeyEnergyDeviceWatts({ id: 'a', name: 'A', energyObj: { W: null } })).toBeNull();
    expect(readHomeyEnergyDeviceWatts({ id: 'a', name: 'A' })).toBeNull();
  });

  // The live report lists these under their own types, never as a device draw.
  it('skips a whole-home meter and a producer', () => {
    expect(readHomeyEnergyDeviceWatts({ id: 'a', name: 'A', energyObj: { W: 10118, cumulative: true } })).toBeNull();
    expect(readHomeyEnergyDeviceWatts({ id: 'a', name: 'A', energyObj: { W: 2500, generator: true } })).toBeNull();
  });

  it('skips a negative figure', () => {
    expect(readHomeyEnergyDeviceWatts({ id: 'a', name: 'A', energyObj: { W: -800 } })).toBeNull();
  });
});
