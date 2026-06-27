import { describe, it, expect } from 'vitest';
import { extractSolarProductionState, isSolarPanelDevice } from '../../lib/device/managerEnergy';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const solar = (
  id: string,
  caps: { measure_power?: number | null },
  detect: { class?: string; available?: boolean } = { class: 'solarpanel' },
): HomeyDeviceLike => ({
  id,
  name: id,
  class: detect.class,
  ...(detect.available !== undefined ? { available: detect.available } : {}),
  // The real SDK can present a capability with a `null` value (present-but-unreadable);
  // the typed shape models value as optional, so cast for those.
  capabilitiesObj: {
    ...(caps.measure_power !== undefined ? { measure_power: { value: caps.measure_power } } : {}),
  } as HomeyDeviceLike['capabilitiesObj'],
});

const nonSolar = (id: string, powerW: number): HomeyDeviceLike => ({
  id,
  name: id,
  class: 'socket',
  capabilitiesObj: { measure_power: { value: powerW } },
});

// A NON-solar BIDIRECTIONAL meter (a grid / P1 import+export meter) declares
// `meterPowerExportedCapability` but is class 'sensor'/'other', NOT 'solarpanel'. It must
// NOT be classified as solar (else its real consumption is wrongly excluded and it emits
// a false production reading). Mirrors the repo's treatment in `meterKwhBackfill.ts`.
const gridMeter = (id: string, powerW: number): HomeyDeviceLike => ({
  id,
  name: id,
  class: 'sensor',
  energy: { meterPowerExportedCapability: 'meter_power.exported' },
  capabilitiesObj: { measure_power: { value: powerW } } as HomeyDeviceLike['capabilitiesObj'],
});

describe('isSolarPanelDevice', () => {
  it('detects a class:solarpanel device', () => {
    expect(isSolarPanelDevice(solar('s1', { measure_power: 3000 }))).toBe(true);
  });

  it('does NOT classify a non-solar bidirectional grid meter (export cap, class:sensor) as solar', () => {
    // FIX 1 regression: the export property is NOT the identity gate — only class is.
    expect(isSolarPanelDevice(gridMeter('grid', 1500))).toBe(false);
  });

  it('does NOT classify a class:other device with energyObj.meterPowerExportedCapability as solar', () => {
    const dev: HomeyDeviceLike = {
      id: 'm1', name: 'm1', class: 'other',
      energyObj: { meterPowerExportedCapability: 'meter_power.exported' },
      capabilitiesObj: { measure_power: { value: 1000 } },
    };
    expect(isSolarPanelDevice(dev)).toBe(false);
  });

  it('does not flag a plain socket as solar', () => {
    expect(isSolarPanelDevice(nonSolar('ev', 2000))).toBe(false);
  });
});

describe('extractSolarProductionState', () => {
  it('returns all-null absent state when no solar device is present', () => {
    const result = extractSolarProductionState([nonSolar('ev', 2000)]);
    expect(result).toEqual({ productionW: null, solarDeviceCount: 0, solarDeviceIds: [] });
  });

  it('reads a single class:solarpanel device production directly', () => {
    const result = extractSolarProductionState([solar('s1', { measure_power: 3000 })]);
    expect(result.productionW).toBe(3000);
    expect(result.solarDeviceCount).toBe(1);
    expect(result.solarDeviceIds).toEqual(['s1']);
  });

  it('excludes a non-solar grid meter (export cap, class:sensor) from the solar aggregate', () => {
    // FIX 1 regression: a bidirectional grid meter is NOT solar — its measure_power is
    // not production and must never surface as solar production.
    const result = extractSolarProductionState([gridMeter('grid', 1500)]);
    expect(result.productionW).toBeNull();
    expect(result.solarDeviceCount).toBe(0);
    expect(result.solarDeviceIds).toEqual([]);
  });

  it('floors a (noisy) negative production sample to 0 — production is non-negative', () => {
    const result = extractSolarProductionState([solar('s1', { measure_power: -50 })]);
    expect(result.productionW).toBe(0);
    expect(result.solarDeviceCount).toBe(1);
  });

  it('sums production across multiple solar devices', () => {
    const result = extractSolarProductionState([
      solar('s1', { measure_power: 3000 }),
      solar('s2', { measure_power: 1200 }),
    ]);
    expect(result.productionW).toBe(4200);
    expect(result.solarDeviceCount).toBe(2);
    expect(result.solarDeviceIds).toEqual(['s1', 's2']);
  });

  it('treats a real 0 as a value, distinct from absent', () => {
    const result = extractSolarProductionState([solar('s1', { measure_power: 0 })]);
    expect(result.productionW).toBe(0);
    expect(result.solarDeviceCount).toBe(1);
  });

  it('ignores non-solar device power in the aggregate', () => {
    const result = extractSolarProductionState([
      solar('s1', { measure_power: 2000 }),
      nonSolar('ev', 5000),
    ]);
    expect(result.productionW).toBe(2000);
    expect(result.solarDeviceCount).toBe(1);
  });

  // ALL-OR-NULL aggregation: one unreadable inverter suppresses the production emission.
  it('returns null productionW when one of multiple solar devices is missing measure_power', () => {
    const result = extractSolarProductionState([
      solar('s1', { measure_power: 3000 }),
      solar('s2', { measure_power: null }), // power unreadable
    ]);
    expect(result.productionW).toBeNull(); // NOT 3000 (would understate)
    expect(result.solarDeviceCount).toBe(2);
  });

  it('returns null productionW (but counts the device) when the only solar device is unreadable', () => {
    const result = extractSolarProductionState([solar('s1', { measure_power: null })]);
    expect(result.productionW).toBeNull();
    expect(result.solarDeviceCount).toBe(1);
    expect(result.solarDeviceIds).toEqual(['s1']);
  });

  // An offline solar device KEEPS its id (so targeted refreshes re-poll it and it
  // recovers when back online) but is EXCLUDED from the emitted aggregate (stale caps).
  it('keeps an offline solar id but excludes it from the emitted aggregate', () => {
    const result = extractSolarProductionState([
      solar('s1', { measure_power: 3000 }, { class: 'solarpanel', available: false }),
    ]);
    expect(result.solarDeviceIds).toEqual(['s1']); // id kept for re-poll
    expect(result.solarDeviceCount).toBe(0); // no AVAILABLE solar contributes
    expect(result.productionW).toBeNull(); // stale caps not emitted
  });

  it('aggregates only the AVAILABLE solar device when one of two is offline (but keeps both ids)', () => {
    const result = extractSolarProductionState([
      solar('s1', { measure_power: 3000 }),
      solar('s2', { measure_power: 999 }, { class: 'solarpanel', available: false }),
    ]);
    expect(result.solarDeviceIds.sort()).toEqual(['s1', 's2']); // both ids kept for re-poll
    expect(result.solarDeviceCount).toBe(1); // only the available one contributes
    expect(result.productionW).toBe(3000); // the offline s2 does not skew the sum
  });

  it('treats an available:true and an omitted-available solar device as available', () => {
    const explicit = extractSolarProductionState([
      solar('s1', { measure_power: 2000 }, { class: 'solarpanel', available: true }),
    ]);
    expect(explicit.solarDeviceCount).toBe(1);
    expect(explicit.productionW).toBe(2000);
    const omitted = extractSolarProductionState([solar('s2', { measure_power: 1000 })]);
    expect(omitted.solarDeviceCount).toBe(1);
    expect(omitted.productionW).toBe(1000);
  });
});
