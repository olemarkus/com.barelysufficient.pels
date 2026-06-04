import { describe, expect, it, vi } from 'vitest';
import { buildDeviceActuator } from '../../setup/appInit/buildDeviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';
import type { AppContext } from '../../lib/app/appContext';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

const profile: SteppedLoadProfile = {
  model: 'stepped_load',
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
    const ctx = { deviceManager: undefined, homey: { flow: {} } } as unknown as AppContext;
    expect(buildDeviceActuator(ctx)).toBeNull();
  });
});
