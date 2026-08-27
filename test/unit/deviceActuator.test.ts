import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';

const buildTransport = (overrides: Partial<ActuatorTransport> = {}) => ({
  requestBinaryControl: vi.fn(async () => undefined),
  requestTemperatureTarget: vi.fn(async (_deviceId: string, desired: number) => desired),
  resolveTemperatureTarget: vi.fn((_deviceId: string, desired: number) => desired),
  requestSteppedLoadStep: vi.fn(async () => ({ requested: false as const })),
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
      kind: 'binary',
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
    const requestSteppedLoadStep = vi.fn(async () => ({ requested: true as const, transport: 'native_capability' as const }));
    const transport = buildTransport({ requestSteppedLoadStep });
    const actuator = createDeviceActuator(transport);
    const outcome = await actuator.apply({
      kind: 'step', deviceId: 's1', profile: { steps: [{ id: 'low', planningPowerW: 1000 }] },
      desiredStepId: 'low', planningPowerW: 1000, planningCurrentA: 0 });
    expect(requestSteppedLoadStep).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 's1', desiredStepId: 'low' }));
    expect(outcome).toEqual({
      requested: true,
      kind: 'step',
      steppedResult: { requested: true, transport: 'native_capability' },
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
        requested: false as const,
        reason: 'flow_trigger_timeout' as const,
      })),
    }));
    const outcome = await actuator.apply({
      kind: 'step', deviceId: 's1', profile: { steps: [{ id: 'low', planningPowerW: 1000 }] },
      desiredStepId: 'low', planningPowerW: 1000, planningCurrentA: 0,
    });
    expect(outcome).toEqual({ requested: false, reason: 'flow_trigger_timeout' });
  });
});
