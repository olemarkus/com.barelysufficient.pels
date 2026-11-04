import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeSteppedLoadCommandAdapters } from '../../lib/device/managerNativeSteppedCommand';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { DevicePowerControlMode, SteppedLoadProfile } from '../../packages/contracts/src/types';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { transportSnapshotFixture } from '../utils/deviceSnapshotFixture';

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

function manualThenAutomatic(mode: 'homey' | 'device' = 'homey') {
  const adapters = new NativeSteppedLoadCommandAdapters();
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

  it('accepts native evidence on initial Automatic without requiring a reassertion', () => {
    const adapters = new NativeSteppedLoadCommandAdapters();
    adapters.observe(ID, rawDevice());
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBe('6440w');
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBe('6440w');
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
    expect(write.mock.calls).toEqual([['target_power', 6440]]);
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBeUndefined();

    vi.setSystemTime(Date.now() + 1000);
    adapters.observe(ID, rawDevice());
    expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBe('6440w');
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBe('6440w');
  });

  it.each(['target_power', 'target_power_mode'] as const)(
    'keeps reassertion required when %s fails', async (failedCapability) => {
      const adapters = manualThenAutomatic(failedCapability === 'target_power_mode' ? 'device' : 'homey');
      const write = vi.fn(async (capability: string) => {
        if (capability === failedCapability) throw new Error('Rejected');
      });
      await expect(adapters.setStep(ID, PROFILE, '6440w', write)).rejects.toThrow('Rejected');
      expect(write).toHaveBeenCalledWith('target_power', 6440);
      vi.setSystemTime(Date.now() + 30_000);
      adapters.observe(ID, rawDevice());
      adapters.observeCapabilityUpdate(ID, 'target_power_mode', 'homey');
      expect(adapters.getReportedStepId(ID, PROFILE, undefined)).toBeUndefined();
      expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBeUndefined();
    },
  );

  it.each(['removed', 'capability gone'] as const)('forgets mode history when the device is %s', (change) => {
    const adapters = manualThenAutomatic();
    if (change === 'removed') adapters.sync([], () => true);
    else adapters.observe(ID, { id: ID, name: 'Zaptec', capabilities: ['measure_power'] });
    adapters.observe(ID, rawDevice());
    expect(adapters.projectObservation(snapshot('automatic')).reportedStepId).toBe('6440w');
  });

  it.each([false, true])(
    'does not let an older ACK reclaim ownership after a mode change (Automatic again: %s)',
    async (automaticAgain) => {
      const adapters = manualThenAutomatic('device');
      let finishWrite: () => void = () => { throw new Error('Write has not started'); };
      const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
      const write = vi.fn(async () => pendingWrite);
      const sent = adapters.setStep(ID, PROFILE, '6440w', write);
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

  it('clears Automatic history when an amp device loses its derivable profile', async () => {
    const adapters = new NativeSteppedLoadCommandAdapters();
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
    const adapters = new NativeSteppedLoadCommandAdapters();
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
