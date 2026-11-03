import { describe, expect, it } from 'vitest';
import type {
  AssociatedCarSnapshot, CarConfirmation, EvCarCurrentLimits, SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import { EvChargingCurrentLimitPolicy } from '../../lib/device/evChargingCurrentLimitPolicy';
import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import { EV_CAR_CURRENT_LIMITS, EV_CHARGER_CURRENT_LIMITS } from '../../lib/utils/settingsKeys';
import { DeviceConfigurationStore } from '../../lib/device/deviceConfiguration';
import { TransportSnapshotStore } from '../../lib/device/transport/transportSnapshotStore';
import { resolveEvTargetPowerPlannerProfile } from '../../lib/device/targetPowerReachability';
import { resolveEaseeSwitchWrite } from '../../lib/device/easee/switch';
import { transportSnapshotFixture } from '../utils/deviceSnapshotFixture';
import type { SteppedLoadWrite } from '../../lib/ports/steppedLoadWrite';

const amps = (currents: number[]): SteppedLoadProfile => ({ steps: [
  { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
  ...currents.map((current) => ({
    id: `${current}a`, planningPowerW: current * 230, planningCurrentA: current,
  })),
] });

const charger = (id = 'charger') => transportSnapshotFixture({
  id, name: id, deviceClass: 'evcharger', available: true, targets: [], expectedPowerKw: 7.36,
  expectedPowerSource: 'default', controlModel: 'stepped_load',
  steppedLoadProfile: amps([6, 8, 10, 12, 14, 16, 20, 24, 28, 32]),
  targetPowerConfig: { preset: 'ev_charger_1_phase', max: 32 * 230 },
  reportedStepId: '32a', reportedStepPowerW: 32 * 230,
});

const associated = (carId: string): AssociatedCarSnapshot => ({
  carId, carName: carId, chargingState: 'plugged_in', chargingStateObservedAtMs: 1,
});

const setup = (ranges: EvCarCurrentLimits, settings: Pick<DeviceControlSettings, 'resolveEvCarCurrentLimits' | 'resolveEvChargerCurrentLimits'> = {
  resolveEvCarCurrentLimits: (id) => ranges[id]
    ? { kind: 'limited', limits: ranges[id] } : { kind: 'unrestricted' },
  resolveEvChargerCurrentLimits: () => ({ kind: 'unrestricted' }),
}) => {
  const links = new Map<string, AssociatedCarSnapshot>();
  const confirmations = new Map<string, CarConfirmation>();
  const snapshots = new TransportSnapshotStore();
  const owner = new EvChargingCurrentLimitPolicy(settings, {
    getAssociatedCar: (id) => links.get(id),
    getCarConfirmation: (id) => confirmations.get(id),
  }, snapshots);
  const configurations = new DeviceConfigurationStore(owner);
  const planned = (id = 'charger') => {
    const configuration = configurations.get(id);
    if (configuration?.controlModel !== 'stepped_load') throw new Error('Expected a stepped charger');
    return resolveEvTargetPowerPlannerProfile({
      config: configuration.targetPowerConfig, confirmedProfile: configuration.steppedLoadProfile, nowMs: 1,
    });
  };
  return { links, confirmations, snapshots, owner, configurations, planned };
};

const persistedPolicy = (initialValue: unknown, listed = true) => {
  const read = { value: initialValue, listed };
  const settings = new DeviceControlSettings({
    get: (key) => key === EV_CAR_CURRENT_LIMITS ? read.value : null,
    getKeys: () => read.listed ? [EV_CAR_CURRENT_LIMITS] : [],
  });
  const runtime = setup({}, settings);
  runtime.links.set('charger', associated('a'));
  runtime.configurations.set(charger());
  return { ...runtime, settings, read };
};

const persistedPolicies = (carValue: unknown, chargerValue: unknown, chargerListed = true) => {
  const read = { carValue, chargerValue, chargerListed };
  const settings = new DeviceControlSettings({
    get: (key) => {
      if (key === EV_CAR_CURRENT_LIMITS) return read.carValue;
      return key === EV_CHARGER_CURRENT_LIMITS ? read.chargerValue : null;
    },
    getKeys: () => [EV_CAR_CURRENT_LIMITS, ...(read.chargerListed ? [EV_CHARGER_CURRENT_LIMITS] : [])],
  });
  const runtime = setup({}, settings);
  runtime.configurations.set(charger());
  runtime.snapshots.replaceSnapshot([charger()]);
  return { ...runtime, settings, read };
};

describe('car charging current limits', () => {
  it('uses the charger default for an unidentified car and a matched car without its own range', () => {
    const runtime = persistedPolicies({}, { charger: { minA: 9, maxA: 25 } });
    expect(runtime.planned().steps.at(-1)?.id).toBe('25a');
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toEqual({ minA: 9, maxA: 25 });
    runtime.links.set('charger', associated('without-own-range'));
    expect(runtime.planned().steps.at(-1)?.id).toBe('25a');
  });

  it('lets an identified car override the charger default and returns to that default after the match clears', () => {
    const runtime = persistedPolicies({ a: { minA: 6, maxA: 32 } }, { charger: { minA: 9, maxA: 25 } });
    expect(runtime.planned().steps.at(-1)?.id).toBe('25a');
    runtime.links.set('charger', associated('a'));
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toEqual({ minA: 6, maxA: 32 });
    expect(runtime.planned().steps.at(-1)?.id).toBe('32a');
    runtime.links.clear();
    expect(runtime.planned().steps.at(-1)?.id).toBe('25a');
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toEqual({ minA: 9, maxA: 25 });
  });

  it('keeps the physical ceiling when the car overrides a lower charger default', () => {
    const runtime = persistedPolicies({ a: { minA: 6, maxA: 32 } }, { charger: { minA: 6, maxA: 10 } });
    runtime.links.set('charger', associated('a'));
    runtime.configurations.set({ ...charger(), targetPowerConfig: { preset: 'ev_charger_1_phase', max: 16 * 230 } });
    expect(runtime.planned().steps.at(-1)?.id).toBe('16a');
  });

  it('does not bypass an unread identified-car policy through a configured charger default', () => {
    const runtime = persistedPolicies(null, { charger: { minA: 6, maxA: 25 } });
    expect(runtime.planned().steps.at(-1)?.id).toBe('25a');
    runtime.links.set('charger', associated('a'));
    expect(runtime.owner.resolve('charger')).toEqual({ kind: 'hold' });
    expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBe(true);
    expect(() => runtime.owner.assertStartAllowed(charger())).toThrow('charging current limits are unavailable');
  });

  it('uses a configured car range even when the lower-priority charger default cannot be read', () => {
    const runtime = persistedPolicies({ a: { minA: 6, maxA: 32 } }, null);
    expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBe(true);
    runtime.links.set('charger', associated('a'));
    expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBeUndefined();
    expect(runtime.planned().steps.at(-1)?.id).toBe('32a');
  });

  it.each([null, { charger: { minA: 25, maxA: 9 } }])(
    'holds on an unread charger-default map and retains an accepted default after a later failed read (%j)', (raw) => {
      const runtime = persistedPolicies({}, raw);
      expect(runtime.owner.resolve('charger')).toEqual({ kind: 'hold' });
      expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBe(true);
      runtime.read.chargerValue = { charger: { minA: 9, maxA: 25 } };
      expect(runtime.planned().steps.at(-1)?.id).toBe('25a');
      expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBeUndefined();
      runtime.read.chargerValue = raw;
      runtime.settings.reload();
      expect(runtime.owner.resolve('charger')).toEqual({ kind: 'limited', limits: { minA: 9, maxA: 25 } });
      expect(runtime.planned().steps.at(-1)?.id).toBe('25a');
    },
  );

  it('treats a charger-default key as unrestricted only after confirming it was never saved', () => {
    const runtime = persistedPolicies({}, null, false);
    expect(runtime.owner.resolve('charger')).toEqual({ kind: 'unrestricted' });
    expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBeUndefined();
  });

  it('switches the range on each read and removes it when the car leaves, preserving device observations', () => {
    const runtime = setup({ a: { minA: 9, maxA: 25 }, b: { minA: 6, maxA: 16 } });
    const snapshot = charger();
    runtime.configurations.set(snapshot);
    runtime.links.set(snapshot.id, associated('a'));
    expect(runtime.planned().steps.map((step) => step.id)).toEqual([
      'off', '9a', '10a', '12a', '14a', '16a', '20a', '24a', '25a',
    ]);
    runtime.links.set(snapshot.id, associated('b'));
    expect(runtime.planned().steps.at(-1)?.id).toBe('16a');
    runtime.links.delete(snapshot.id);
    expect(runtime.configurations.get(snapshot.id)?.targetPowerConfig?.currentLimits).toBeUndefined();
    expect(runtime.planned().steps.at(-1)?.id).toBe('32a');
    expect(snapshot.reportedStepId).toBe('32a');
    expect(snapshot.targetPowerConfig?.currentLimits).toBeUndefined();
  });

  it('uses one car entry across chargers while preserving each charger ceiling', () => {
    const runtime = setup({ a: { minA: 9, maxA: 25 } });
    const first = charger('first');
    const second = { ...charger('second'), targetPowerConfig: { preset: 'ev_charger_1_phase' as const, max: 16 * 230 } };
    runtime.configurations.replace([first, second]);
    runtime.links.set('first', associated('a'));
    runtime.links.set('second', associated('a'));
    expect(runtime.planned('first').steps.at(-1)?.id).toBe('25a');
    expect(runtime.planned('second').steps.at(-1)?.id).toBe('16a');
    expect(runtime.configurations.getAll().map((device) => device.targetPowerConfig?.currentLimits))
      .toEqual([{ minA: 9, maxA: 25 }, { minA: 9, maxA: 25 }]);
  });

  it('keeps an explicitly confirmed car identity during a car-app outage', () => {
    const runtime = setup({ a: { minA: 9, maxA: 25 } });
    runtime.configurations.set(charger());
    runtime.confirmations.set('charger', { carId: 'a', carName: 'a', available: false });
    expect(runtime.planned().steps.at(-1)?.id).toBe('25a');
    runtime.confirmations.clear();
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toBeUndefined();
  });

  it('does not apply a charger-ID setting without a matched car or substitute it for an unconfigured car', () => {
    const runtime = setup({ charger: { minA: 9, maxA: 25 } });
    runtime.configurations.set(charger());
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toBeUndefined();
    runtime.links.set('charger', associated('unconfigured-car'));
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toBeUndefined();
  });

  it('filters Automatic amp rungs and refuses an Automatic watt ladder without an amp mapping', () => {
    const runtime = setup({ a: { minA: 9, maxA: 25 } });
    const snapshot = { ...charger(), targetPowerConfig: undefined, steppedLoadProfile: amps([6, 8, 10, 16, 32]) };
    runtime.configurations.set(snapshot);
    runtime.links.set('charger', associated('a'));
    expect(runtime.planned().steps.map((step) => step.id)).toEqual(['off', '10a', '16a']);
    runtime.configurations.set({ ...snapshot, steppedLoadProfile: {
      steps: [{ id: 'off', planningPowerW: 0 }, { id: '2000w', planningPowerW: 2000 }],
    } });
    expect(runtime.planned().steps.map((step) => step.id)).toEqual(['off']);
  });

  it('does not lower the car minimum when the physical charger cannot provide it', () => {
    const runtime = setup({ a: { minA: 9, maxA: 25 } });
    const snapshot = { ...charger(), automaticPowerControl: { mode: 'manual' as const, profile: amps([6, 8]) } };
    runtime.snapshots.replaceSnapshot([snapshot]);
    runtime.configurations.set(snapshot);
    runtime.links.set('charger', associated('a'));
    expect(runtime.planned().steps.map((step) => step.id)).toEqual(['off']);
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits?.minA).toBe(9);
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toEqual({ minA: 9, maxA: 25 });
    expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBe(true);
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.max).toBe(8 * 230);
  });

  it.each([6, 10])('uses native 2 A rungs with physical minimum %s A for planning and Easee resume', (physicalMinimum) => {
    const ranges = { a: { minA: 9, maxA: 25 } };
    const runtime = setup(ranges);
    const physical = amps(Array.from({ length: (32 - physicalMinimum) / 2 + 1 }, (_, index) => physicalMinimum + index * 2));
    const snapshot = {
      ...charger(), automaticPowerControl: { mode: 'manual' as const, profile: physical },
      evChargingState: 'plugged_in_charging' as const, capabilities: ['target_charger_current'],
      controlAdapter: { kind: 'capability_adapter' as const, activationAvailable: true,
        activationRequired: false, activationEnabled: true },
    };
    runtime.snapshots.replaceSnapshot([snapshot]);
    runtime.configurations.set(snapshot);
    runtime.links.set('charger', associated('a'));
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toEqual({ minA: 10, maxA: 24 });
    expect(runtime.planned().steps.map((step) => step.id)).toEqual(['off', '10a', '12a', '14a', '16a', '20a', '24a']);
    expect(resolveEaseeSwitchWrite(runtime.owner.projectSwitchSnapshot(snapshot), true, {
      hasCarStopEvidence: () => false,
    })).toEqual({ kind: 'current', write: { capabilityId: 'target_charger_current', value: 10 } });
    expect(ranges.a).toEqual({ minA: 9, maxA: 25 });
  });

  it('resumes Easee at the current car minimum without storing the match on its snapshot', () => {
    const runtime = setup({ a: { minA: 9, maxA: 25 } });
    const snapshot = {
      ...charger(), evChargingState: 'plugged_in_charging' as const,
      capabilities: ['target_charger_current'],
      controlAdapter: { kind: 'capability_adapter' as const, activationAvailable: true,
        activationRequired: false, activationEnabled: true },
    };
    runtime.links.set('charger', associated('a'));
    const write = resolveEaseeSwitchWrite(runtime.owner.projectSwitchSnapshot(snapshot), true, {
      hasCarStopEvidence: () => false,
    });
    expect(write).toEqual({ kind: 'current', write: { capabilityId: 'target_charger_current', value: 9 } });
    expect(snapshot.targetPowerConfig?.currentLimits).toBeUndefined();
  });

  it.each([null, { a: { minA: 25, maxA: 9 } }])(
    'holds a matched car when its listed saved range has never been readable (%j)', (raw) => {
      const runtime = persistedPolicy(raw);
      expect(runtime.owner.resolve('charger')).toEqual({ kind: 'hold' });
      const configuration = runtime.configurations.get('charger');
      expect(configuration?.carCurrentRangeUnavailable).toBe(true);
      expect(configuration?.controlModel === 'stepped_load' && configuration.steppedLoadProfile.steps.at(-1)?.id)
        .toBe('32a');
      expect(() => runtime.owner.assertStartAllowed(charger())).toThrow('charging current limits are unavailable');
      runtime.links.clear();
      expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBeUndefined();
      expect(() => runtime.owner.assertStartAllowed(charger())).not.toThrow();
    },
  );

  it('authorizes the ordinary range only when the key list confirms no car ranges were saved', () => {
    const runtime = persistedPolicy(null, false);
    expect(runtime.owner.resolve('charger')).toEqual({ kind: 'unrestricted' });
    expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBeUndefined();
    expect(() => runtime.owner.assertStartAllowed(charger())).not.toThrow();
  });

  it.each([null, { a: { minA: 25, maxA: 9 } }])(
    'retains an accepted 25 A car range when a later read fails (%j)', (raw) => {
      const runtime = persistedPolicy({ a: { minA: 9, maxA: 25 } });
      expect(runtime.owner.resolve('charger')).toEqual({ kind: 'limited', limits: { minA: 9, maxA: 25 } });
      runtime.read.value = raw;
      runtime.settings.reload();
      expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toEqual({ minA: 9, maxA: 25 });
      expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBeUndefined();
      expect(runtime.planned().steps.at(-1)?.id).toBe('25a');
    },
  );

  it('retries an unresolved car policy on the next control read and clears its hold after recovery', () => {
    const runtime = persistedPolicy(null);
    expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBe(true);
    runtime.read.value = { a: { minA: 9, maxA: 25 } };
    expect(runtime.configurations.get('charger')?.carCurrentRangeUnavailable).toBeUndefined();
    expect(runtime.configurations.get('charger')?.targetPowerConfig?.currentLimits).toEqual({ minA: 9, maxA: 25 });
    expect(() => runtime.owner.assertStartAllowed(charger())).not.toThrow();
  });

  it('refuses an older 32 A decision after identifying a car while always permitting its off request', () => {
    const runtime = persistedPolicy(null);
    runtime.snapshots.replaceSnapshot([charger()]);
    const profile = amps([6, 25, 32]);
    const request: SteppedLoadWrite = {
      deviceId: 'charger', profile, desiredStepId: '32a', planningCurrentA: 32, planningPowerW: 32 * 230,
    };
    const off = { ...request, desiredStepId: 'off', planningCurrentA: 0, planningPowerW: 0 };
    runtime.links.clear();
    expect(() => runtime.owner.assertStepAllowed(request)).not.toThrow();
    runtime.confirmations.set('charger', { carId: 'a', carName: 'a', available: true });
    expect(() => runtime.owner.assertStepAllowed(request)).toThrow('charging current limits are unavailable');
    expect(() => runtime.owner.assertStepAllowed(off)).not.toThrow();
    runtime.read.value = { a: { minA: 9, maxA: 25 } };
    expect(() => runtime.owner.assertStepAllowed(request)).toThrow('outside the active charging range');
    expect(() => runtime.owner.assertStepAllowed(off)).not.toThrow();
    expect(() => runtime.owner.assertStepAllowed({
      ...request, desiredStepId: '25a', planningCurrentA: 25, planningPowerW: 25 * 230,
    })).not.toThrow();
  });

  it('refuses a stale step absent from a complete native amp ladder even inside the car bounds', () => {
    const runtime = setup({ a: { minA: 9, maxA: 25 } });
    runtime.links.set('charger', associated('a'));
    runtime.snapshots.replaceSnapshot([{
      ...charger(), automaticPowerControl: { mode: 'manual', profile: amps([6, 10, 18, 26]) },
    }]);
    const request: SteppedLoadWrite = {
      deviceId: 'charger', profile: amps([10, 14, 18]), desiredStepId: '14a',
      planningCurrentA: 14, planningPowerW: 14 * 230,
    };
    expect(() => runtime.owner.assertStepAllowed(request)).toThrow('not supported by this charger');
    expect(() => runtime.owner.assertStepAllowed({
      ...request, desiredStepId: '10a', planningCurrentA: 10, planningPowerW: 10 * 230,
    })).not.toThrow();
  });
});
