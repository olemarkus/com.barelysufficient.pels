import { describe, expect, it, vi } from 'vitest';
import { steppedStoresForTest } from '../helpers/steppedStores';
import type { TargetDeviceSnapshot, TemperatureObservedProbe } from '../../packages/contracts/src/types';
import type { ActuatorOutcome, DeviceCommand } from '../../lib/actuator/deviceCommand';
import {
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

const thermostat = (): TargetDeviceSnapshot & TemperatureObservedProbe => ({
  available: true,
  id: 'thermostat-1',
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Thermostat',
  deviceType: 'temperature',
  temperature: { currentTemperature: 21, target: { id: 'target_temperature', value: 21, unit: '°C' } },
  targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
  capabilities: ['onoff', 'target_temperature', 'measure_temperature'],
  binaryControllable: true,
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
        available: true,
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

  // The flag denies ONE axis. It used to demote the device wholesale — a
  // `binary_power` rewrite plus a wipe of the whole stepped cluster and its
  // command state — so a stepped water heater whose setpoint another Flow owns
  // could only be switched off, never trimmed to a lower rung.
  it('keeps the stepped axis and its command state while stamping the denial', () => {
    const raw = thermostat();
    const profile = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'high', planningPowerW: 2_000 },
      ],
    };
    const profiles = { [raw.id]: profile };
    const { store, reportedStore } = steppedStoresForTest();
    const runtimeState = store.getStateForTests();
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: raw.id,
      desiredStepId: 'high',
      issuedAtMs: 100,
    });
    // The ladder's lowest ACTIVE rung, so the decorator's ordinary
    // re-initialization check leaves the latch alone.
    runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.set(raw.id, 'high');
    expect(reportSteppedLoadActualStep({
      runtimeState,
      reportedStore,
      profiles,
      deviceId: raw.id,
      stepId: 'high',
      reportedAtMs: 90,
    })).toBe('changed');
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: raw,
      profiles,
      store,
      reportedStore,
      temperatureControlDisabled: true,
      nowMs: 110,
    });

    expect(decorated.deviceType).toBe('temperature');
    expect(decorated.targets).toEqual(raw.targets);
    expect(decorated.temperatureControlDisabled).toBe(true);
    expect(decorated.controlModel).toBe('stepped_load');
    expect(decorated.steppedLoadProfile).toEqual(profile);
    expect(decorated.reportedStepId).toBe('high');
    // Live command state survives the decoration. It has to:
    // `decorateTargetSnapshotList` is a MUTATING read run once per power
    // sample, so tearing the command axis down here would wipe it every few
    // seconds — no command would ever confirm, retry back-off would die, and
    // the lowest-step initialization latch would never latch.
    expect(runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.get(raw.id)).toBe('high');
    expect(runtimeState.steppedLoadStepCommandIssuedByDeviceId.has(raw.id)).toBe(true);
    expect(reportedStore.get(raw.id)?.stepId).toBe('high');
  });

  it('falls the temperature model back to binary when there is no ladder to keep', () => {
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: thermostat(),
      profiles: {},
      ...steppedStoresForTest(),
      temperatureControlDisabled: true,
      nowMs: 110,
    });

    expect(decorated.controlModel).toBe('binary_power');
    expect(decorated.temperatureControlDisabled).toBe(true);
    expect(decorated.deviceType).toBe('temperature');
  });

  // The fence governs the `target_temperature` capability, nothing else. It used
  // to refuse every non-binary command, `kind: 'step'` included, so a planner
  // that had decided to trim a stepped device watched the actuator swallow the
  // command as `{ requested: false }` — the plan believed it had trimmed the
  // device and nothing surfaced the divergence.
  it('fences the setpoint live while letting binary and step commands through', async () => {
    const apply = vi.fn(async (command: DeviceCommand): Promise<ActuatorOutcome> => {
      if (command.kind === 'binary') return { requested: true, kind: 'binary' };
      if (command.kind === 'step') {
        return { requested: true, kind: 'step', steppedResult: { requested: true, transport: 'native_capability' } };
      }
      return { requested: true, kind: 'target', requestedTargetValue: command.value };
    });
    let disabled = true;
    const actuator = createTemperatureControlFencedActuator(
      {
        apply,
        resolveTemperatureTarget: (_deviceId, desired) => desired,
      },
      () => disabled,
    );

    await expect(actuator.apply({
      kind: 'target', deviceId: 'thermostat-1', target: 'temperature', value: 18,
    })).resolves.toEqual({ requested: false });
    await expect(actuator.apply({
      kind: 'step',
      deviceId: 'thermostat-1',
      profile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'high', planningPowerW: 2_000 }] },
      desiredStepId: 'high',
      planningPowerW: 2_000,
      planningCurrentA: 9,
    })).resolves.toEqual({
      requested: true,
      kind: 'step',
      steppedResult: { requested: true, transport: 'native_capability' },
    });
    await expect(actuator.apply({
      kind: 'binary', deviceId: 'thermostat-1', desired: false,
    })).resolves.toEqual({
      requested: true,
      kind: 'binary',
    });
    await expect(actuator.apply({
      kind: 'binary', deviceId: 'thermostat-1', desired: true,
    })).resolves.toEqual({
      requested: true,
      kind: 'binary',
    });
    // Everything but the setpoint reached the base actuator.
    expect(apply).toHaveBeenCalledTimes(3);

    disabled = false;
    await actuator.apply({
      kind: 'target', deviceId: 'thermostat-1', target: 'temperature', value: 20,
    });
    expect(apply).toHaveBeenCalledTimes(4);
  });
});
