import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import { SteppedLoadTransportError } from '../../lib/ports/steppedLoadWrite';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';

const buildTransport = (overrides: Partial<ActuatorTransport> = {}): ActuatorTransport => ({
requestProductionControl: async () => { throw new Error('Unexpected inverter control'); },
  requestBinaryControl: vi.fn(async () => undefined),
  requestTemperatureTarget: vi.fn(async (_deviceId: string, desired: number) => desired),
  canTurnOnDevice: () => true,
  resolveTemperatureTarget: vi.fn((_deviceId: string, desired: number) => desired),
  requestSteppedLoadStep: vi.fn(async () => ({ requested: false as const })),
  requestStoragePower: vi.fn(async () => ({ kind: 'written' as const, setpointW: 0 })),
  releaseStorageControl: vi.fn(async () => undefined),
  ...overrides,
});

describe('createDeviceActuator — intent → transport mapping', () => {
  it('passes a semantic binary command to transport', async () => {
    const transport = buildTransport();
    const actuator = createDeviceActuator(transport);
    const outcome = await actuator.apply({
      kind: 'binary', deviceId: 'ev1', desired: false,
    });
    expect(outcome).toEqual({
      requested: true,
      kind: 'binary', acknowledged: true,
    });
    expect(transport.requestBinaryControl).toHaveBeenCalledWith('ev1', false);
  });

  it('passes a semantic temperature target to transport', async () => {
    const transport = buildTransport();
    const actuator = createDeviceActuator(transport);
    await actuator.apply({ kind: 'target', deviceId: 'th1', target: 'temperature', value: 5 });
    expect(transport.requestTemperatureTarget).toHaveBeenCalledWith('th1', 5);
  });

  it('propagates a semantic target write failure', async () => {
    const transport = buildTransport({
      requestTemperatureTarget: vi.fn(async () => { throw new Error('write failed'); }),
    });
    const actuator = createDeviceActuator(transport);
    await expect(actuator.apply({
      kind: 'target', deviceId: 'd', target: 'temperature', value: 5,
    })).rejects.toThrow('write failed');
  });

  it('passes a step command through and surfaces the stepped result', async () => {
    const requestSteppedLoadStep = vi.fn(async () => ({ requested: true as const, acknowledged: true as const, transport: 'native_capability' as const }));
    const transport = buildTransport({ requestSteppedLoadStep });
    const actuator = createDeviceActuator(transport);
    const outcome = await actuator.apply({
      kind: 'step', deviceId: 's1', profile: { steps: [{ id: 'low', planningPowerW: 1000 }] },
      desiredStepId: 'low', planningPowerW: 1000, planningCurrentA: 0 });
    expect(requestSteppedLoadStep).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 's1', desiredStepId: 'low' }));
    expect(outcome).toEqual({
      requested: true,
      kind: 'step',
      acknowledged: true, transport: 'native_capability',
    });
  });

  it('reports requested:false for a step command when the transport has no stepped-load surface', async () => {
    const actuator = createDeviceActuator(buildTransport());
    const outcome = await actuator.apply({
      kind: 'step', deviceId: 's1', profile: { steps: [{ id: 'low', planningPowerW: 1000 }] },
      desiredStepId: 'low', planningPowerW: 1000, planningCurrentA: 0,
    });
    expect(outcome).toEqual({ requested: false });
  });

  it('carries an unacknowledged Flow trigger reason across the seam', async () => {
    // Not the same outcome as "no stepped surface": flattening both to a bare
    // `{ requested: false }` here left the executor unable to tell an abandoned
    // trigger from a device it cannot command at all.
    const actuator = createDeviceActuator(buildTransport({
      requestSteppedLoadStep: vi.fn(async () => ({
        requested: true as const, acknowledged: false as const, transport: 'flow' as const, reasonCode: 'flow_trigger_timeout' as const,
      })),
    }));
    const outcome = await actuator.apply({
      kind: 'step', deviceId: 's1', profile: { steps: [{ id: 'low', planningPowerW: 1000 }] },
      desiredStepId: 'low', planningPowerW: 1000, planningCurrentA: 0,
    });
    expect(outcome).toEqual({
      kind: 'step', requested: true, acknowledged: false, transport: 'flow', reasonCode: 'flow_trigger_timeout',
    });
  });

  it('passes a battery setpoint to transport and surfaces the watts it sent', async () => {
    const requestStoragePower = vi.fn(async () => ({ kind: 'written' as const, setpointW: 1000 }));
    const actuator = createDeviceActuator(buildTransport({ requestStoragePower }));
    const outcome = await actuator.apply({ kind: 'storage_power', deviceId: 'b1', setpointW: 990 });
    expect(requestStoragePower).toHaveBeenCalledWith({ kind: 'storage_power', deviceId: 'b1', setpointW: 990 });
    expect(outcome).toEqual({ requested: true, kind: 'storage_power', requestedSetpointW: 1000 });
  });

  it('carries a claim the battery app rejected as a setpoint not sent, with the app\'s message', async () => {
    const requestStoragePower = vi.fn(async () => ({ kind: 'claim_rejected' as const, errorMessage: 'not in control' }));
    const actuator = createDeviceActuator(buildTransport({ requestStoragePower }));
    const outcome = await actuator.apply({ kind: 'storage_power', deviceId: 'b1', setpointW: 990 });
    expect(outcome).toEqual({ requested: false, reason: 'claim_rejected', errorMessage: 'not in control' });
  });

  it('passes a battery hand-back to transport', async () => {
    const releaseStorageControl = vi.fn(async () => undefined);
    const actuator = createDeviceActuator(buildTransport({ releaseStorageControl }));
    const command = { kind: 'storage_release' as const, deviceId: 'b1', restoreClaimValue: 'anti_feed' };
    const outcome = await actuator.apply(command);
    expect(releaseStorageControl).toHaveBeenCalledWith(command);
    expect(outcome).toEqual({ requested: true, kind: 'storage_release' });
  });
});

const stepCommand = {
  kind: 'step' as const, deviceId: 's1', profile: { steps: [{ id: 'low', planningPowerW: 1000 }] },
  desiredStepId: 'low', planningPowerW: 1000, planningCurrentA: 0,
};

it.each(['native_capability', 'homey_action'] as const)('resolves a %s write timeout at the actuator', async (transport) => {
  const timeout = new HomeyRequestTimeoutError('PUT', '/write');
  const failure = transport === 'homey_action' ? new SteppedLoadTransportError(transport, timeout) : timeout;
  const actuator = createDeviceActuator(buildTransport({
    requestSteppedLoadStep: vi.fn().mockRejectedValue(failure),
  }));
  await expect(actuator.apply(stepCommand)).resolves.toEqual({
    kind: 'step', requested: true, acknowledged: false, transport,
    reasonCode: 'command_request_timed_out', err: timeout,
  });
});

it('resolves binary timeouts without changing target or storage failures', async () => {
  const timeout = new HomeyRequestTimeoutError('PUT', '/write');
  const actuator = createDeviceActuator(buildTransport({
    requestBinaryControl: vi.fn().mockRejectedValue(timeout),
    requestTemperatureTarget: vi.fn().mockRejectedValue(timeout),
    requestStoragePower: vi.fn().mockRejectedValue(timeout),
  }));
  await expect(actuator.apply({ kind: 'binary', deviceId: 's1', desired: true })).resolves.toEqual({
    kind: 'binary', requested: true, acknowledged: false, err: timeout,
  });
  await expect(actuator.apply({ kind: 'target', deviceId: 's1', target: 'temperature', value: 20 }))
    .rejects.toBe(timeout);
  await expect(actuator.apply({ kind: 'storage_power', deviceId: 's1', setpointW: 1000 })).rejects.toBe(timeout);
});

it.each(['metadata', 'action'] as const)('preserves definite %s failures without recursive cause guessing', async (kind) => {
  const failure = kind === 'metadata'
    ? new Error('Metadata unavailable', { cause: new HomeyRequestTimeoutError('GET', '/metadata') })
    : new SteppedLoadTransportError('homey_action', new Error('Rejected'));
  const actuator = createDeviceActuator(buildTransport({ requestSteppedLoadStep: vi.fn().mockRejectedValue(failure) }));
  await expect(actuator.apply(stepCommand)).rejects.toBe(failure);
});
