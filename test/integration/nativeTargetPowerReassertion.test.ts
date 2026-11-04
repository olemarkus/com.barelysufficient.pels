import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeSteppedLoadCommandAdapters } from '../../lib/device/managerNativeSteppedCommand';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { DevicePowerControlMode, SteppedLoadProfile } from '../../packages/contracts/src/types';
import { buildZaptecCurrentOnlyDevice, buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { transportSnapshotFixture } from '../utils/deviceSnapshotFixture';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

const ID = 'zaptec-target-power';
const PROFILE: SteppedLoadProfile = { steps: [
  { id: 'off', planningPowerW: 0 },
  ...Array.from({ length: 45 }, (_, index) => {
    const planningPowerW = (index + 11) * 230;
    return { id: `${planningPowerW}w`, planningPowerW };
  }),
] };
const AMP_PROFILE: SteppedLoadProfile = { steps: [
  { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
  ...Array.from({ length: 27 }, (_, index) => {
    const amps = index + 6;
    return { id: `${amps}a`, planningPowerW: amps * 230, planningCurrentA: amps };
  }),
] };

/** The direct command-owner fixture supplies Homey's complete accepted inventory. */
class NativeAdaptersFixture extends NativeSteppedLoadCommandAdapters {
  readonly inventory: Map<string, HomeyDeviceLike>;

  constructor(devices: readonly HomeyDeviceLike[] = []) {
    const inventory = new Map(devices.map((device) => [device.id, device]));
    super(() => [...inventory.values()]);
    this.inventory = inventory;
  }

  override observe(deviceId: string, device: HomeyDeviceLike): void {
    this.inventory.set(deviceId, device);
    super.observe(deviceId, device);
  }

  override projectObservation(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot {
    return super.projectObservation(snapshot, this.inventory.get(snapshot.id) ?? rawDevice());
  }
}

const easeeDevice = (max = 32): HomeyDeviceLike => ({
  id: ID, name: 'Easee', ownerUri: 'homey:app:no.easee', driverId: 'homey:app:no.easee:charger',
  settings: { phaseMode: 'Locked to single phase' }, capabilities: ['target_charger_current'],
  capabilitiesObj: { target_charger_current: { value: 16, min: 0, max, step: 1, setable: true } },
});

function rawDevice(mode: 'homey' | 'device' = 'homey') {
  const device = buildZaptecTargetPowerDevice();
  return buildZaptecTargetPowerDevice({ capabilitiesObj: {
    target_power: { ...device.capabilitiesObj?.target_power, value: 6440, lastUpdated: new Date().toISOString() },
    target_power_mode: { ...device.capabilitiesObj?.target_power_mode,
      value: mode, lastUpdated: new Date().toISOString() },
  } });
}

const snapshot = (mode: DevicePowerControlMode) => transportSnapshotFixture({
  id: ID, name: 'Zaptec', deviceClass: 'evcharger', available: true, targets: [],
  expectedPowerKw: 6.44, expectedPowerSource: 'manual',
  controlModel: 'stepped_load', steppedLoadProfile: PROFILE,
  automaticPowerControl: { mode, profile: PROFILE },
  reportedStepId: '6440w', reportedStepPowerW: 6440, reportedStepObservedAtMs: Date.now(),
});

function manualThenAutomatic(
  mode: 'homey' | 'device' = 'homey', inventory: readonly HomeyDeviceLike[] = [],
) {
  const adapters = new NativeAdaptersFixture(inventory);
  // The first parse can precede construction of the raw-device command adapter.
  adapters.projectObservation(snapshot('manual'));
  adapters.observe(ID, rawDevice(mode));
  vi.setSystemTime(Date.now() + 1000);
  expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBeUndefined();
  return adapters;
}

describe('native watt ownership after Manual control', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 4, 8));
  });
  afterEach(() => vi.useRealTimers());

  it('accepts a generic native watt observation on initial Automatic without changing its protocol', () => {
    const adapters = new NativeAdaptersFixture();
    adapters.observe(ID, { ...rawDevice(), driverId: 'homey:app:other:charger' });
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBe('6440w');
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBe('6440w');
  });

  it('requires a cold Zaptec reclaim even when Automatic was saved before the restart', async () => {
    const adapters = new NativeAdaptersFixture();
    adapters.projectObservation(snapshot('automatic'));
    adapters.observe(ID, rawDevice());
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBeUndefined();
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(false);
    expect(write).toHaveBeenCalledExactlyOnceWith('evcharger_charging', false);
  });

  it('claims an exclusive Zaptec already in device mode without resetting or stopping it', async () => {
    const adapters = new NativeAdaptersFixture();
    adapters.observe(ID, rawDevice('device'));
    adapters.projectObservation({ ...snapshot('automatic'), reportedStepId: undefined });
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(true);
    expect(write.mock.calls).toEqual([['target_power', 6440], ['target_power_mode', 'homey']]);
  });

  it('does not accept retained target polls or mode echoes before issuing a fresh target', () => {
    const adapters = manualThenAutomatic();
    vi.setSystemTime(Date.now() + 30_000);
    adapters.observe(ID, rawDevice());
    adapters.observeCapabilityUpdate(ID, 'target_power', 6440);
    adapters.observeCapabilityUpdate(ID, 'target_power_mode', 'homey');
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBeUndefined();
    expect(adapters.projectObservation(snapshot('manual')).reportedStepId).toBe('6440w');
  });

  it('reasserts an unchanged target and then waits for independent readback', async () => {
    const adapters = manualThenAutomatic();
    vi.setSystemTime(Date.now() + 30_000);
    adapters.observe(ID, rawDevice());
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(true);
    expect(write.mock.calls).toEqual([
      ['target_power_mode', 'device'], ['target_power', 6440], ['target_power_mode', 'homey'],
    ]);
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBeUndefined();

    vi.setSystemTime(Date.now() + 1000);
    adapters.observe(ID, rawDevice());
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBe('6440w');
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBe('6440w');
  });

  it.each([
    ['target_power', 6440], ['target_power_mode', 'device'], ['target_power_mode', 'homey'],
  ] as const)(
    'keeps reassertion required when %s=%s fails', async (failedCapability, failedValue) => {
      const adapters = manualThenAutomatic();
      vi.setSystemTime(Date.now() + 1000);
      adapters.observe(ID, rawDevice());
      const write = vi.fn(async (capability: string, value: unknown) => {
        if (capability === failedCapability && value === failedValue) throw new Error('Rejected');
      });
      await expect(adapters.setStep(ID, PROFILE, '6440w', write)).rejects.toThrow('Rejected');
      expect(write).toHaveBeenCalledWith(failedCapability, failedValue);
      vi.setSystemTime(Date.now() + 30_000);
      adapters.observe(ID, rawDevice());
      adapters.observeCapabilityUpdate(ID, 'target_power_mode', 'homey');
      expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
      expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBeUndefined();
    },
  );

  it.each(['removed', 'capability gone'] as const)('requires a new cold claim when the device returns after %s', (change) => {
    const adapters = manualThenAutomatic();
    if (change === 'removed') adapters.sync([], () => true);
    else adapters.observe(ID, { id: ID, name: 'Zaptec', capabilities: ['measure_power'] });
    adapters.observe(ID, rawDevice());
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBeUndefined();
  });

  it.each([false, true])(
    'does not let an older ACK reclaim ownership after a mode change (Automatic again: %s)',
    async (automaticAgain) => {
      const adapters = manualThenAutomatic('device');
      vi.setSystemTime(Date.now() + 1000);
      adapters.observe(ID, rawDevice('device'));
      let finishWrite: () => void = () => { throw new Error('Write has not started'); };
      const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
      const write = vi.fn(async () => pendingWrite);
      const sent = adapters.setStep(ID, PROFILE, '6440w', write);
      await Promise.resolve();
      expect(write).toHaveBeenCalledExactlyOnceWith('target_power', 6440);
      adapters.projectObservation(snapshot('manual'));
      if (automaticAgain) adapters.projectObservation(snapshot('automatic'));
      finishWrite();
      expect(await sent).toBe(true);
      expect(write.mock.calls).toEqual([['target_power', 6440]]);

      vi.setSystemTime(Date.now() + 30_000);
      adapters.observe(ID, rawDevice());
      expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
      if (automaticAgain) {
        expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBeUndefined();
      } else {
        const staleWrite = vi.fn();
        expect(await adapters.setStep(ID, PROFILE, '6440w', staleWrite)).toBe(false);
        expect(staleWrite).not.toHaveBeenCalled();
      }
    },
  );

  it('stops before resetting the cached native target and never starts charging during reclaim', async () => {
    const adapters = manualThenAutomatic();
    let charging = true;
    let currentA = 32;
    let cachedTargetA: number | undefined = 16;
    let mode = 'homey';
    let targetW = 6440;
    const write = vi.fn(async (capability: string, value: unknown) => {
      if (capability === 'evcharger_charging' && value === false) charging = false;
      if (capability === 'target_power_mode' && value === 'device') {
        expect(charging).toBe(false);
        cachedTargetA = undefined;
        currentA = 32;
        mode = 'device';
      }
      if (capability === 'target_power') targetW = Number(value);
      if (capability === 'target_power_mode' && value === 'homey') mode = 'homey';
      if ((capability === 'target_power' || capability === 'target_power_mode') && mode === 'homey') {
        const nextA = Math.floor(targetW / (Math.sqrt(3) * 230));
        if (cachedTargetA !== nextA) {
          currentA = nextA;
          cachedTargetA = nextA;
        }
      }
    });
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(false);
    expect(write.mock.calls).toEqual([['evcharger_charging', false]]);
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
    // A successful stop request alone cannot permit the release that restores 32 A.
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(false);
    expect(write.mock.calls).toEqual([['evcharger_charging', false], ['evcharger_charging', false]]);

    vi.setSystemTime(Date.now() + 1000);
    adapters.observe(ID, rawDevice());
    write.mockClear();
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(true);
    expect(write.mock.calls).toEqual([
      ['target_power_mode', 'device'], ['target_power', 6440], ['target_power_mode', 'homey'],
    ]);
    expect(currentA).toBe(16);
    expect(charging).toBe(false);
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
  });

  it.each(['charging', 'drawing', 'undated stop', 'undated power'] as const)(
    'does not reset control with %s evidence after reclaim', async (evidence) => {
      const adapters = manualThenAutomatic();
      vi.setSystemTime(Date.now() + 1000);
      const device = rawDevice();
      adapters.observe(ID, { ...device, capabilitiesObj: {
        ...device.capabilitiesObj,
        evcharger_charging: { ...device.capabilitiesObj?.evcharger_charging,
          value: evidence === 'charging', lastUpdated: evidence === 'undated stop' ? undefined : Date.now() },
        measure_power: { ...device.capabilitiesObj?.measure_power,
          value: evidence === 'drawing' ? 500 : 0,
          lastUpdated: evidence === 'undated power' ? undefined : Date.now() },
      } });
      const write = vi.fn().mockResolvedValue(undefined);
      expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(false);
      expect(write).toHaveBeenCalledExactlyOnceWith('evcharger_charging', false);
      expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
    },
  );

  it('abandons the old reclaim after Manual is selected during the safe mode reset', async () => {
    const adapters = manualThenAutomatic();
    vi.setSystemTime(Date.now() + 1000);
    adapters.observe(ID, rawDevice());
    const write = vi.fn(async (capability: string, value: unknown) => {
      if (capability === 'target_power_mode' && value === 'device') adapters.projectObservation(snapshot('manual'));
    });
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(false);
    expect(write).toHaveBeenCalledExactlyOnceWith('target_power_mode', 'device');
  });

  it('refuses an installation reset when an unmanaged active peer exists in the full inventory', async () => {
    const source = rawDevice();
    const peer = { ...source, id: 'unmanaged-peer', capabilitiesObj: {
      ...source.capabilitiesObj,
      evcharger_charging: { ...source.capabilitiesObj?.evcharger_charging, value: true },
      measure_power: { ...source.capabilitiesObj?.measure_power, value: 10_000 },
    } };
    const adapters = manualThenAutomatic('homey', [peer]);
    vi.setSystemTime(Date.now() + 1000);
    // Only the managed charger is observed by the command adapters. The peer
    // still exists in Homey's full inventory and shares the reset's current.
    adapters.observe(ID, rawDevice());
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(false);
    expect(write).toHaveBeenCalledExactlyOnceWith('evcharger_charging', false);
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
  });

  it('uses fresh independent inventory reports even before the command adapter receives another full read', async () => {
    const adapters = manualThenAutomatic();
    vi.setSystemTime(Date.now() + 1000);
    adapters.inventory.set(ID, rawDevice());
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(true);
    expect(write.mock.calls).toEqual([
      ['target_power_mode', 'device'], ['target_power', 6440], ['target_power_mode', 'homey'],
    ]);
  });

  it('does not authorize a reset when the full inventory cannot resolve the current charger', async () => {
    const adapters = manualThenAutomatic();
    vi.setSystemTime(Date.now() + 1000);
    adapters.observe(ID, rawDevice());
    adapters.inventory.delete(ID);
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(false);
    expect(write).toHaveBeenCalledExactlyOnceWith('evcharger_charging', false);
  });

  it('stops and proves the declared legacy charging button before resetting control', async () => {
    const source = rawDevice();
    const legacy = buildZaptecCurrentOnlyDevice({ id: ID, capabilitiesObj: {
      target_power: source.capabilitiesObj?.target_power,
      target_power_mode: source.capabilitiesObj?.target_power_mode,
    } });
    const device = { ...legacy, capabilities: [...(legacy.capabilities ?? []), 'target_power', 'target_power_mode'] };
    const adapters = manualThenAutomatic();
    adapters.observe(ID, device);
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(false);
    expect(write).toHaveBeenCalledExactlyOnceWith('charging_button', false);
    vi.setSystemTime(Date.now() + 1000);
    adapters.observe(ID, { ...device, capabilitiesObj: {
      ...device.capabilitiesObj,
      charging_button: { ...device.capabilitiesObj?.charging_button, value: false, lastUpdated: Date.now() },
      measure_power: { ...device.capabilitiesObj?.measure_power, value: 0, lastUpdated: Date.now() },
    } });
    write.mockClear();
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(true);
    expect(write.mock.calls).toEqual([
      ['target_power_mode', 'device'], ['target_power', 6440], ['target_power_mode', 'homey'],
    ]);
  });

  it('keeps a generic native watt reassertion on its existing command protocol', async () => {
    const adapters = new NativeAdaptersFixture();
    const device = { ...rawDevice(), driverId: 'homey:app:other:charger' };
    adapters.projectObservation(snapshot('manual'));
    adapters.observe(ID, device);
    vi.setSystemTime(Date.now() + 1000);
    adapters.projectObservation(snapshot('automatic'));
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, PROFILE, '6440w', write)).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith('target_power', 6440);
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
  });

  it('clears Automatic history when an amp device loses its derivable profile', async () => {
    const adapters = new NativeAdaptersFixture();
    adapters.observe(ID, easeeDevice());
    const manualProfile: SteppedLoadProfile = { steps: [
      { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
      { id: '16a', planningPowerW: 11040, planningCurrentA: 16 },
    ] };
    const automatic = { ...snapshot('automatic'), steppedLoadProfile: AMP_PROFILE,
      automaticPowerControl: { mode: 'automatic' as const, profile: AMP_PROFILE },
      reportedStepId: '16a', reportedStepPowerW: 3680 };
    adapters.projectObservation(automatic);
    const { automaticPowerControl: _unavailable, ...withoutAutomatic } = automatic;
    const fallback = { ...withoutAutomatic, steppedLoadProfile: manualProfile,
      reportedStepId: '16a', reportedStepPowerW: 11040 };
    expect(adapters.projectObservation(fallback).reportedStepId).toBe('16a');
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, manualProfile, '16a', write)).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith('target_charger_current', 16);
  });

  it('keeps Automatic current bounds after a fresh raw sync before the next projection', async () => {
    const adapters = new NativeAdaptersFixture();
    adapters.observe(ID, easeeDevice());
    adapters.projectObservation({ ...snapshot('automatic'), steppedLoadProfile: AMP_PROFILE,
      automaticPowerControl: { mode: 'automatic', profile: AMP_PROFILE }, reportedStepId: '16a' });
    adapters.observe(ID, easeeDevice(10));
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await adapters.setStep(ID, AMP_PROFILE, '16a', write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(await adapters.setStep(ID, AMP_PROFILE, '6a', write)).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith('target_charger_current', 6);
  });
});
