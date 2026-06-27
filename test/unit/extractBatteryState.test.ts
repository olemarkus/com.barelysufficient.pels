import { describe, it, expect } from 'vitest';
import { extractBatteryState } from '../../lib/device/managerEnergy';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const battery = (
  id: string,
  caps: { measure_battery?: number | null; measure_power?: number | null },
  detect: { class?: string; homeBattery?: boolean; available?: boolean } = { class: 'battery' },
): HomeyDeviceLike => ({
  id,
  name: id,
  class: detect.class,
  energyObj: detect.homeBattery ? { homeBattery: true } : null,
  ...(detect.available !== undefined ? { available: detect.available } : {}),
  // The real SDK can present a capability with a `null` value (present-but-
  // unreadable); the typed shape models value as optional, so cast for those.
  capabilitiesObj: {
    ...(caps.measure_battery !== undefined ? { measure_battery: { value: caps.measure_battery } } : {}),
    ...(caps.measure_power !== undefined ? { measure_power: { value: caps.measure_power } } : {}),
  } as HomeyDeviceLike['capabilitiesObj'],
});

const nonBattery = (id: string, powerW: number): HomeyDeviceLike => ({
  id,
  name: id,
  class: 'socket',
  capabilitiesObj: { measure_power: { value: powerW } },
});

describe('extractBatteryState', () => {
  it('returns all-null absent state when no battery device is present', () => {
    const result = extractBatteryState([nonBattery('ev', 2000)]);
    expect(result).toEqual({
      batterySoc: null,
      batteryPowerW: null,
      batteryDeviceCount: 0,
      batteryDeviceIds: [],
    });
  });

  it('reads a single class:battery device directly (no averaging)', () => {
    const result = extractBatteryState([battery('b1', { measure_battery: 62, measure_power: 1200 })]);
    expect(result.batterySoc).toBe(62);
    expect(result.batteryPowerW).toBe(1200);
    expect(result.batteryDeviceCount).toBe(1);
    expect(result.batteryDeviceIds).toEqual(['b1']);
  });

  it('preserves the negative sign of a discharging battery', () => {
    const result = extractBatteryState([battery('b1', { measure_battery: 40, measure_power: -1500 })]);
    expect(result.batteryPowerW).toBe(-1500);
  });

  it('detects a battery via the homeBattery energy role even when class differs', () => {
    const dev = battery('b1', { measure_battery: 80, measure_power: 500 }, { class: 'other', homeBattery: true });
    const result = extractBatteryState([dev]);
    expect(result.batteryDeviceCount).toBe(1);
    expect(result.batterySoc).toBe(80);
  });

  it('sums power and means SoC across multiple batteries', () => {
    const result = extractBatteryState([
      battery('b1', { measure_battery: 60, measure_power: 1000 }),
      battery('b2', { measure_battery: 80, measure_power: -400 }),
    ]);
    expect(result.batteryPowerW).toBe(600); // 1000 + (-400)
    expect(result.batterySoc).toBe(70); // mean of 60 and 80
    expect(result.batteryDeviceCount).toBe(2);
    expect(result.batteryDeviceIds).toEqual(['b1', 'b2']);
  });

  it('treats a real 0 as a value, distinct from absent', () => {
    const result = extractBatteryState([battery('b1', { measure_battery: 0, measure_power: 0 })]);
    expect(result.batterySoc).toBe(0);
    expect(result.batteryPowerW).toBe(0);
  });

  it('reports null fields (but still counts the device) when caps are unreadable', () => {
    const result = extractBatteryState([battery('b1', { measure_battery: null, measure_power: null })]);
    expect(result.batterySoc).toBeNull();
    expect(result.batteryPowerW).toBeNull();
    expect(result.batteryDeviceCount).toBe(1);
    expect(result.batteryDeviceIds).toEqual(['b1']);
  });

  it('ignores non-battery device power in the aggregate', () => {
    const result = extractBatteryState([
      battery('b1', { measure_battery: 50, measure_power: 800 }),
      nonBattery('ev', 5000),
    ]);
    expect(result.batteryPowerW).toBe(800);
    expect(result.batteryDeviceCount).toBe(1);
  });

  // FIX 2 — all-or-null aggregation: a partial subset must not be silently summed/meaned.
  it('returns null batteryPowerW when one of multiple batteries is missing measure_power', () => {
    const result = extractBatteryState([
      battery('b1', { measure_battery: 60, measure_power: 1000 }),
      battery('b2', { measure_battery: 80, measure_power: null }), // power unreadable
    ]);
    expect(result.batteryPowerW).toBeNull(); // NOT 1000 (would understate / risk wrong sign)
    expect(result.batterySoc).toBe(70); // SoC complete across both -> mean still resolves
    expect(result.batteryDeviceCount).toBe(2);
  });

  it('returns null batterySoc when one of multiple batteries is missing measure_battery', () => {
    const result = extractBatteryState([
      battery('b1', { measure_battery: 60, measure_power: 1000 }),
      battery('b2', { measure_battery: null, measure_power: -400 }), // SoC unreadable
    ]);
    expect(result.batterySoc).toBeNull(); // NOT 60 (would mean a partial subset)
    expect(result.batteryPowerW).toBe(600); // power complete across both -> sum still resolves
  });

  // FIX 3 — detection checks energyObj AND energy independently (no short-circuit).
  it('detects a battery via energy.homeBattery even when energyObj exists but lacks the role', () => {
    const dev: HomeyDeviceLike = {
      id: 'b1',
      name: 'b1',
      class: 'other',
      energyObj: {}, // present but no homeBattery -> must NOT short-circuit detection
      energy: { homeBattery: true },
      capabilitiesObj: {
        measure_battery: { value: 55 },
        measure_power: { value: 300 },
      },
    };
    const result = extractBatteryState([dev]);
    expect(result.batteryDeviceCount).toBe(1);
    expect(result.batterySoc).toBe(55);
    expect(result.batteryPowerW).toBe(300);
  });

  // FIX A: an offline battery KEEPS its id (so targeted refreshes re-poll it and it
  // recovers when back online) but is EXCLUDED from the emitted aggregate (its
  // retained caps are stale).
  it('keeps an offline battery id but excludes it from the emitted aggregate', () => {
    const result = extractBatteryState([
      battery('b1', { measure_battery: 62, measure_power: 1200 }, { class: 'battery', available: false }),
    ]);
    expect(result.batteryDeviceIds).toEqual(['b1']); // id kept for re-poll
    expect(result.batteryDeviceCount).toBe(0); // no AVAILABLE battery contributes
    expect(result.batterySoc).toBeNull(); // stale caps not emitted
    expect(result.batteryPowerW).toBeNull();
  });

  it('treats an available:true and an omitted-available battery as available', () => {
    const explicit = extractBatteryState([
      battery('b1', { measure_battery: 50, measure_power: 800 }, { class: 'battery', available: true }),
    ]);
    expect(explicit.batteryDeviceCount).toBe(1);
    expect(explicit.batterySoc).toBe(50);
    // The default helper omits `available` entirely -> still considered available.
    const omitted = extractBatteryState([battery('b2', { measure_battery: 40, measure_power: -100 })]);
    expect(omitted.batteryDeviceCount).toBe(1);
    expect(omitted.batterySoc).toBe(40);
  });

  it('aggregates only the AVAILABLE battery when one of two is offline (but keeps both ids)', () => {
    const result = extractBatteryState([
      battery('b1', { measure_battery: 60, measure_power: 1000 }),
      battery('b2', { measure_battery: 80, measure_power: 999 }, { class: 'battery', available: false }),
    ]);
    expect(result.batteryDeviceIds.sort()).toEqual(['b1', 'b2']); // both ids kept for re-poll
    expect(result.batteryDeviceCount).toBe(1); // only the available one contributes
    expect(result.batterySoc).toBe(60); // the offline b2 does not skew the mean
    expect(result.batteryPowerW).toBe(1000); // nor the sum
  });

  // FIX B: SoC validated at the boundary — out-of-range is malformed external input.
  it('rejects an out-of-range SoC (below 0) so the only battery emits no SoC', () => {
    const result = extractBatteryState([battery('b1', { measure_battery: -5, measure_power: 800 })]);
    expect(result.batterySoc).toBeNull(); // -5 rejected
    expect(result.batteryPowerW).toBe(800); // power still valid
    expect(result.batteryDeviceCount).toBe(1);
  });

  it('rejects an out-of-range SoC (above 100) so the only battery emits no SoC', () => {
    const result = extractBatteryState([battery('b1', { measure_battery: 150, measure_power: 800 })]);
    expect(result.batterySoc).toBeNull(); // 150 rejected
    expect(result.batteryPowerW).toBe(800);
  });

  it('accepts the SoC range endpoints 0 and 100', () => {
    expect(extractBatteryState([battery('b1', { measure_battery: 0, measure_power: 0 })]).batterySoc).toBe(0);
    expect(extractBatteryState([battery('b2', { measure_battery: 100, measure_power: 0 })]).batterySoc).toBe(100);
  });

  it('drops a non-finite SoC / power (NaN-like external input)', () => {
    const result = extractBatteryState([battery('b1', { measure_battery: 50, measure_power: null })]);
    expect(result.batteryPowerW).toBeNull(); // null power rejected
    expect(result.batterySoc).toBe(50);
  });
});
