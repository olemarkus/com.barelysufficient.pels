/**
 * Coverage for chunk 6 of the planner-detype refactor: `canTurnOnDevice`
 * now reads producer helpers (`isCommandableNow` + `isCanSetControl`)
 * instead of round-tripping through `getBinaryControlPlan` +
 * `getEvRestoreBlockReason`. The behaviour-preserving contract is that
 * for every snapshot shape the executor passes in, the migrated gate
 * returns the same value as the pre-PR version.
 */
import { describe, expect, it } from 'vitest';
import { canTurnOnDevice, type CanTurnOnDeviceSnapshot } from '../../lib/plan/deviceCommandability';
import type { EvObservedProbe } from '../../packages/contracts/src/types';

const baseSnapshot = (
  overrides: Partial<CanTurnOnDeviceSnapshot & EvObservedProbe & {
    deviceClass?: string; canSetOnOff?: boolean;
  }> = {},
): CanTurnOnDeviceSnapshot & EvObservedProbe & { deviceClass?: string } => ({
  id: 'd1',
  name: 'Device',
  targets: [],
  binaryControl: { on: false },
  ...overrides,
}) as CanTurnOnDeviceSnapshot & EvObservedProbe & { deviceClass?: string };

describe('canTurnOnDevice — migrated to commandableNow + canSetControl producers', () => {
  it('returns false when the snapshot is missing', () => {
    expect(canTurnOnDevice(undefined)).toBe(false);
  });

  it('returns false when the device is unavailable', () => {
    expect(canTurnOnDevice(baseSnapshot({
      available: false,
    }))).toBe(false);
  });

  it('returns false for an EV charger that is plugged_out', () => {
    expect(canTurnOnDevice(baseSnapshot({
      deviceClass: 'evcharger',
      evChargingState: 'plugged_out',
      commandableNow: false,
      canSetControl: true,
      available: true,
    }))).toBe(false);
  });

  it('returns false for an EV charger that is discharging', () => {
    expect(canTurnOnDevice(baseSnapshot({
      deviceClass: 'evcharger',
      evChargingState: 'plugged_in_discharging',
      commandableNow: false,
      canSetControl: true,
      available: true,
    }))).toBe(false);
  });

  it('returns true for an EV charger plugged_in_charging with canSetControl=true', () => {
    expect(canTurnOnDevice(baseSnapshot({
      deviceClass: 'evcharger',
      evChargingState: 'plugged_in_charging',
      canSetControl: true,
      available: true,
    }))).toBe(true);
  });

  it('returns true for an EV charger plugged_in_paused with canSetControl=true', () => {
    expect(canTurnOnDevice(baseSnapshot({
      deviceClass: 'evcharger',
      evChargingState: 'plugged_in_paused',
      canSetControl: true,
      available: true,
    }))).toBe(true);
  });

  it('returns false for an EV charger commandable but with canSetControl=false', () => {
    expect(canTurnOnDevice(baseSnapshot({
      deviceClass: 'evcharger',
      evChargingState: 'plugged_in_charging',
      canSetControl: false,
      available: true,
    }))).toBe(false);
  });

  it('returns true for an onoff device with default flags', () => {
    expect(canTurnOnDevice(baseSnapshot({
      deviceClass: 'thermostat',
      available: true,
    }))).toBe(true);
  });

  it('returns false for an onoff device when the legacy canSetOnOff fallback is false', () => {
    // The legacy fallback path: the snapshot may not set `canSetControl`
    // but a stale `canSetOnOff === false` field from older devices still
    // blocks writes on the onoff capability. The migration must preserve
    // this guard (the original chunk-2 TODO explicitly called it out).
    expect(canTurnOnDevice(baseSnapshot({
      deviceClass: 'thermostat',
      available: true,
      canSetOnOff: false,
    }))).toBe(false);
  });

  it('returns false when there is no resolvable binary capability', () => {
    expect(canTurnOnDevice({
      id: 'target-only',
      name: 'Target only',
      targets: [],
      capabilities: ['measure_power'],
      available: true,
    } as CanTurnOnDeviceSnapshot)).toBe(false);
  });

  it('does not reconstruct the binary axis from raw capabilities', () => {
    expect(canTurnOnDevice({
      id: 'target-only',
      name: 'Target only',
      targets: [],
      capabilities: ['onoff'],
      available: true,
    } as CanTurnOnDeviceSnapshot)).toBe(false);
  });
});
