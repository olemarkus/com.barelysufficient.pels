import { describe, expect, it, vi } from 'vitest';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  buildControlModelMap,
  createDeviceControlRuntimeState,
  decorateSnapshotWithDeviceControl,
  markSteppedLoadDesiredStepIssued,
  reportSteppedLoadActualStep,
  resolveTemperatureControlDisabled,
} from '../../setup/appDeviceControlHelpers';
import { createTemperatureControlFencedActuator } from '../../setup/appInit/buildDeviceActuator';
import { readTemperatureControlDisabledDevicesSetting } from '../../setup/appSettingsHelpers';

/**
 * Settings double for the reader's structural port. No cast: a wrong shape is a
 * compile error rather than a `TypeError` the reader's `catch` would swallow
 * into the `unavailable` several of these cases assert.
 *
 * `absent` is the shape an unwritten key reads back as. The SDK answers `null`;
 * object doubles elsewhere in the suite answer `undefined`, and the reader
 * accepts both, so the cases below drive each explicitly.
 */
const settingsStore = (params: {
  entries: Record<string, unknown>;
  absent?: unknown;
  get?: (key: string) => unknown;
  getKeys?: () => unknown;
}) => ({
  get: params.get
    ?? ((key: string) => {
      if (Object.prototype.hasOwnProperty.call(params.entries, key)) return params.entries[key];
      // Presence of the field, not its value: `absent: undefined` is a case to
      // drive, and `?? null` would quietly turn it back into the null case.
      return Object.prototype.hasOwnProperty.call(params, 'absent') ? params.absent : null;
    }),
  getKeys: params.getKeys ?? (() => Object.keys(params.entries)),
});

const UNAVAILABLE = { devices: {}, state: 'unavailable' as const };

const thermostat = (): TargetDeviceSnapshot => ({
  id: 'thermostat-1',
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Thermostat',
  deviceType: 'temperature',
  targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
  capabilities: ['onoff', 'target_temperature', 'measure_temperature'],
  controlCapabilityId: 'onoff',
  binaryControl: { on: true },
});

describe('temperature-control policy read', () => {
  // The absence classification itself (fresh install, listed-but-empty, empty
  // key list, malformed-value retention) is covered end-to-end through
  // `buildCapacitySettingsSnapshot` in test/integration/appSettingsHelpers.test.ts.
  // These cases pin only what that tier does not reach: both absence shapes,
  // and the guards that fire when the key list itself cannot be trusted.

  it.each([
    ['null, as the SDK answers', null],
    ['undefined, as object doubles answer', undefined],
  ])('resolves a never-written key that reads back as %s', (_label, absent) => {
    expect(readTemperatureControlDisabledDevicesSetting({
      settings: settingsStore({ entries: { capacity_limit_kw: 10 }, absent }),
      current: UNAVAILABLE,
    })).toEqual({ devices: {}, state: 'resolved' });
  });

  it.each([
    ['a non-array key list', () => null],
    ['a key list holding non-strings', () => [42, 'capacity_limit_kw']],
  ])('stays unavailable on %s', (_label, getKeys) => {
    // A key list we cannot read is not evidence of absence, so the policy must
    // not resolve to "nothing opted out" off the back of it.
    expect(readTemperatureControlDisabledDevicesSetting({
      settings: settingsStore({ entries: { capacity_limit_kw: 10 }, getKeys }),
      current: UNAVAILABLE,
    })).toEqual(UNAVAILABLE);
  });

  it('stays unavailable when either settings read throws', () => {
    expect(readTemperatureControlDisabledDevicesSetting({
      settings: settingsStore({
        entries: {},
        get: () => { throw new Error('settings unavailable'); },
      }),
      current: UNAVAILABLE,
    })).toEqual(UNAVAILABLE);
    expect(readTemperatureControlDisabledDevicesSetting({
      settings: settingsStore({
        entries: { capacity_limit_kw: 10 },
        getKeys: () => { throw new Error('settings unavailable'); },
      }),
      current: UNAVAILABLE,
    })).toEqual(UNAVAILABLE);
  });

  it('clears a previously resolved map once the key is proven gone', () => {
    // Clearing the last opt-out through the UI unsets the key. Retaining the
    // old map there would keep fencing a device the owner just re-enabled.
    expect(readTemperatureControlDisabledDevicesSetting({
      settings: settingsStore({ entries: { capacity_limit_kw: 10 } }),
      current: { devices: { 'thermostat-1': true }, state: 'resolved' },
    })).toEqual({ devices: {}, state: 'resolved' });
  });
});

describe('disabled temperature control', () => {
  it('fails closed only for temperature devices while the policy is unavailable', () => {
    expect(resolveTemperatureControlDisabled({
      policyState: 'unavailable',
      disabledDevices: {},
      deviceId: 'thermostat-1',
      device: thermostat(),
    })).toBe(true);
    expect(resolveTemperatureControlDisabled({
      policyState: 'unavailable',
      disabledDevices: {},
      deviceId: 'charger',
      device: {
        id: 'charger', name: 'EV charger', deviceType: 'onoff', deviceClass: 'evcharger', targets: [],
        expectedPowerKw: 1, expectedPowerSource: 'default',
      },
    })).toBe(false);
    expect(resolveTemperatureControlDisabled({
      policyState: 'resolved',
      disabledDevices: { 'thermostat-1': true },
      deviceId: 'thermostat-1',
      device: undefined,
    })).toBe(true);
  });

  it('preserves observations while decorating the effective model as binary', () => {
    const raw = thermostat();
    const profile = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'high', planningPowerW: 2_000 },
      ],
    };
    const profiles = { [raw.id]: profile };
    const runtimeState = createDeviceControlRuntimeState();
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: raw.id,
      desiredStepId: 'high',
      issuedAtMs: 100,
    });
    runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.set(raw.id, 'off');
    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles,
      deviceId: raw.id,
      stepId: 'off',
      reportedAtMs: 90,
    })).toBe('changed');
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: raw,
      profiles,
      runtimeState,
      temperatureControlDisabled: true,
    });

    expect(decorated.deviceType).toBe('temperature');
    expect(decorated.targets).toEqual(raw.targets);
    expect(decorated.controlModel).toBe('binary_power');
    expect(decorated.temperatureControlDisabled).toBe(true);
    expect(buildControlModelMap([raw], () => true).get(raw.id)).toBe('binary_power');
    expect(runtimeState.steppedLoadDesiredByDeviceId.has(raw.id)).toBe(false);
    expect(runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.has(raw.id)).toBe(false);
    expect(runtimeState.steppedLoadStepCommandIssuedByDeviceId.has(raw.id)).toBe(false);
    expect(runtimeState.steppedLoadReportedByDeviceId.get(raw.id)?.stepId).toBe('off');

    const reenabled = decorateSnapshotWithDeviceControl({
      snapshot: {
        ...raw,
        controlModel: 'stepped_load',
        steppedLoadProfile: profile,
      },
      profiles,
      runtimeState,
      temperatureControlDisabled: false,
      nowMs: 110,
    });
    expect(reenabled.reportedStepId).toBe('off');
    expect(reenabled.desiredStepId).toBeUndefined();
    expect(reenabled.stepCommandPending).toBe(false);
  });

  it('fences target and step commands live while allowing binary commands', async () => {
    const apply = vi.fn(async () => ({ requested: true as const }));
    let disabled = true;
    const actuator = createTemperatureControlFencedActuator(
      { apply },
      () => disabled,
    );

    await expect(actuator.apply({
      kind: 'target', deviceId: 'thermostat-1', capabilityId: 'target_temperature', value: 18,
    })).resolves.toEqual({ requested: false });
    await expect(actuator.apply({
      kind: 'step',
      deviceId: 'thermostat-1',
      profile: { steps: [{ id: 'off', planningPowerW: 0 }] },
      desiredStepId: 'off',
      planningPowerW: 0,
      planningCurrentA: 0,
    })).resolves.toEqual({ requested: false });
    await expect(actuator.apply({
      kind: 'binary', deviceId: 'thermostat-1', control: 'onoff', desired: false, flowBacked: false,
    })).resolves.toEqual({ requested: true });
    await expect(actuator.apply({
      kind: 'binary', deviceId: 'thermostat-1', control: 'onoff', desired: true, flowBacked: false,
    })).resolves.toEqual({ requested: true });
    expect(apply).toHaveBeenCalledTimes(2);

    disabled = false;
    await actuator.apply({
      kind: 'target', deviceId: 'thermostat-1', capabilityId: 'target_temperature', value: 20,
    });
    expect(apply).toHaveBeenCalledTimes(3);
  });
});
