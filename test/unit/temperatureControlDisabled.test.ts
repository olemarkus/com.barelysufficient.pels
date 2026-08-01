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

const thermostat = (): TargetDeviceSnapshot => ({
  id: 'thermostat-1',
  name: 'Thermostat',
  deviceType: 'temperature',
  targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
  capabilities: ['onoff', 'target_temperature', 'measure_temperature'],
  controlCapabilityId: 'onoff',
  binaryControl: { on: true },
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
      model: 'stepped_load' as const,
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
      profile: { model: 'stepped_load', steps: [{ id: 'off', planningPowerW: 0 }] },
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
