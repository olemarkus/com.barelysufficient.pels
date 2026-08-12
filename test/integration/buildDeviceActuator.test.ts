import { describe, expect, it, vi } from 'vitest';
import { buildDeviceActuator } from '../../setup/appInit/buildDeviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';
import type { AppContext } from '../../lib/app/appContext';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

const profile: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1000 },
  ],
};

describe('buildDeviceActuator', () => {
  it('returns an actuator whose step command routes to deviceManager.requestSteppedLoadStep', async () => {
    type StepParams = Parameters<NonNullable<ActuatorTransport['requestSteppedLoadStep']>>[0];
    const requestSteppedLoadStep = vi.fn(async (_params: StepParams) => (
      { requested: true as const, transport: 'flow' as const }
    ));
    const ctx = {
      deviceManager: {
        setCapability: vi.fn(async () => undefined),
        applyDeviceTargets: vi.fn(async () => undefined),
        requestSteppedLoadStep,
      },
      homey: { flow: { getTriggerCard: vi.fn() } },
      isTemperatureControlDisabled: vi.fn(() => false),
    } as unknown as AppContext;

    const actuator = buildDeviceActuator(ctx);
    expect(actuator).not.toBeNull();

    const outcome = await actuator!.apply({
      kind: 'step',
      deviceId: 'stepped-1',
      profile,
      desiredStepId: 'low',
      planningPowerW: 1000,
      planningCurrentA: 4,
    });

    expect(outcome.steppedResult).toEqual({ requested: true, transport: 'flow' });
    expect(requestSteppedLoadStep).toHaveBeenCalledTimes(1);
    expect(requestSteppedLoadStep).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'stepped-1',
      desiredStepId: 'low',
      planningPowerW: 1000,
      planningCurrentA: 4,
    }));
  });

  it('returns null when the device manager is absent', () => {
    const ctx = {
      deviceManager: undefined,
      homey: { flow: {} },
      isTemperatureControlDisabled: vi.fn(() => false),
    } as unknown as AppContext;
    expect(buildDeviceActuator(ctx)).toBeNull();
  });

  it('fences a snapshotless terminal temperature target while the policy is unavailable', async () => {
    const applyDeviceTargets = vi.fn(async () => undefined);
    const ctx = {
      deviceManager: {
        setCapability: vi.fn(async () => undefined),
        applyDeviceTargets,
      },
      homey: { flow: { getTriggerCard: vi.fn() } },
      temperatureControlPolicyState: 'unavailable',
      isTemperatureControlDisabled: vi.fn(() => false),
    } as unknown as AppContext;
    const actuator = buildDeviceActuator(ctx);

    await expect(actuator!.apply({
      kind: 'target',
      deviceId: 'missing-thermostat',
      targetKind: 'temperature',
      value: 5,
    })).resolves.toEqual({ requested: false });
    expect(applyDeviceTargets).not.toHaveBeenCalled();
  });
});
