import type Homey from 'homey';
import { getLogger } from '../../lib/logging/logger';
import { HomeyHttpStatusError } from '../../lib/utils/homeyHttpStatusError';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { homeyDevice, setable } from '../helpers/homeyDevicePayload';
import { mockHomeyInstance } from '../mocks/homey';
import { partialDouble } from '../helpers/partialDouble';
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

/** No write here is timed against a meter; the witness only has to be there. */
const flowBacked = partialDouble<AppContext['flowBacked']>({
  meterResponseTimings: partialDouble<AppContext['flowBacked']['meterResponseTimings']>({
    commandDispatched: vi.fn(), commandSettled: vi.fn(), commandFailed: vi.fn(),
  }),
});

describe('buildDeviceActuator', () => {
  it('returns an actuator whose step command routes to deviceManager.requestSteppedLoadStep', async () => {
    type StepParams = Parameters<NonNullable<ActuatorTransport['requestSteppedLoadStep']>>[0];
    const requestSteppedLoadStep = vi.fn(async (_params: StepParams) => (
      { requested: true as const, acknowledged: true as const, transport: 'flow' as const }
    ));
    const ctx = {
      deviceManager: {
requestProductionControl: async () => { throw new Error('Unexpected inverter control'); },
        setCapability: vi.fn(async () => undefined),
        applyDeviceTargets: vi.fn(async () => undefined),
        requestBinaryControl: vi.fn(async () => undefined),
        requestTemperatureTarget: vi.fn(async () => undefined),
        canTurnOnDevice: () => true,
        resolveTemperatureTarget: vi.fn((_deviceId: string, desired: number) => desired),
        requestSteppedLoadStep,
      },
      homey: { flow: { getTriggerCard: vi.fn() } },
      flowBacked,
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

    expect(outcome).toEqual({
      requested: true,
      kind: 'step',
      acknowledged: true, transport: 'flow',
    });
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
      flowBacked,
      isTemperatureControlDisabled: vi.fn(() => false),
    } as unknown as AppContext;
    expect(buildDeviceActuator(ctx)).toBeNull();
  });

  it('fences a snapshotless terminal temperature target while the policy is unavailable', async () => {
    const applyDeviceTargets = vi.fn(async () => undefined);
    const ctx = {
      deviceManager: {
requestProductionControl: async () => { throw new Error('Unexpected inverter control'); },
        setCapability: vi.fn(async () => undefined),
        applyDeviceTargets,
        requestBinaryControl: vi.fn(async () => undefined),
        requestTemperatureTarget: vi.fn(async () => undefined),
        canTurnOnDevice: () => true,
        resolveTemperatureTarget: vi.fn((_deviceId: string, desired: number) => desired),
        requestSteppedLoadStep: vi.fn(async () => ({ requested: false })),
      },
      homey: { flow: { getTriggerCard: vi.fn() } },
      flowBacked,
      deviceControlSettings: { temperatureControlPolicyState: 'unavailable' },
      isTemperatureControlDisabled: vi.fn(() => false),
    } as unknown as AppContext;
    const actuator = buildDeviceActuator(ctx);

    await expect(actuator!.apply({
      kind: 'target',
      deviceId: 'missing-thermostat',
      target: 'temperature', purpose: 'plan',
      value: 5,
    })).resolves.toEqual({ requested: false });
    expect(applyDeviceTargets).not.toHaveBeenCalled();
  });
});

describe('native metered relay OFF through the actuator', () => {
  const id = 'metered-relay';
  const command = { kind: 'binary', deviceId: id, desired: false } as const;

  async function setup(flags: string[]) {
    const homeyApp = mockHomeyInstance as unknown as Homey.App;
    const deviceManager = createTestDeviceTransport(homeyApp, {
      log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/relay-off'),
    });
    const relay = homeyDevice({ id, name: 'Metered switch', class: 'socket', flags },
      { onoff: setable(true), measure_power: 1000 }, Date.now());
    await initWithLiveFeed(deviceManager);
    await seedTransportDevices(deviceManager, [relay]);
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });
    const actuator = buildDeviceActuator(partialDouble<AppContext>({
      deviceManager, homey: mockHomeyInstance as unknown as AppContext['homey'], flowBacked,
    }));
    if (!actuator) throw new Error('Expected a device actuator');
    return { put, actuator, relay };
  }

  it.each([true, false])('records the accepting native binding and its Z-Wave evidence (flag present: %s)', async (zwave) => {
    const { actuator, relay, put } = await setup(zwave ? ['zwave'] : []);
    expect(actuator.getNativeRelayBinding?.(id)).toEqual({ binding: relay.driverId, zwave, measuresWatts: true });
    await expect(actuator.apply(command)).resolves.toEqual({
      requested: true, kind: 'binary', acknowledged: true, relayBinding: relay.driverId,
      ...(zwave ? {} : { unflaggedRelay: true }),
    });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/capability/onoff'), expect.objectContaining({ value: false }),
    );
  });

  it('recognizes exact NO_ACK in the native OFF response even without a protocol flag', async () => {
    const { actuator, relay, put } = await setup([]);
    const err = new HomeyHttpStatusError(500, JSON.stringify({
      error_description: `${'x'.repeat(240)} (TRANSMIT_COMPLETE_NO_ACK)`,
    }));
    put.mockRejectedValue(err);
    await expect(actuator.apply(command)).resolves.toEqual({
      requested: true, kind: 'binary', acknowledged: false, reason: 'zwave_no_ack', relayBinding: relay.driverId, err,
    });
    await expect(actuator.apply({ ...command, desired: true })).rejects.toBe(err);
  });

  it.each([
    { error: 'Device did not answer' },
    { error: 'TRANSMIT_COMPLETE_NO_ACK_OTHER' },
    { error: 'Internal error', stack: '(TRANSMIT_COMPLETE_NO_ACK)' },
  ])('preserves other write errors', async (body) => {
    const { actuator, put } = await setup(['zwave']);
    const err = new HomeyHttpStatusError(500, JSON.stringify(body));
    put.mockRejectedValue(err);
    await expect(actuator.apply(command)).rejects.toBe(err);
  });
});
