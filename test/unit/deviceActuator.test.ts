import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';

const buildTransport = (overrides: Partial<ActuatorTransport> = {}) => ({
  setCapability: vi.fn(async () => undefined),
  applyDeviceTargets: vi.fn(async () => undefined),
  triggerFlowBackedBinaryControl: vi.fn(async () => undefined),
  ...overrides,
});

describe('createDeviceActuator — intent → transport mapping', () => {
  it('routes a non-flow binary command to setCapability on the named control', async () => {
    const transport = buildTransport();
    const actuator = createDeviceActuator(transport);
    const outcome = await actuator.apply({
      kind: 'binary', deviceId: 'ev1', control: 'evcharger_charging', desired: false, flowBacked: false,
    });
    expect(outcome).toEqual({ requested: true });
    expect(transport.setCapability).toHaveBeenCalledWith('ev1', 'evcharger_charging', false);
    expect(transport.triggerFlowBackedBinaryControl).not.toHaveBeenCalled();
  });

  it('routes a flow-backed binary command to the Flow trigger, never setCapability', async () => {
    const transport = buildTransport();
    const actuator = createDeviceActuator(transport);
    await actuator.apply({ kind: 'binary', deviceId: 'd1', control: 'onoff', desired: true, flowBacked: true });
    expect(transport.triggerFlowBackedBinaryControl).toHaveBeenCalledWith('d1', 'onoff', true);
    expect(transport.setCapability).not.toHaveBeenCalled();
  });

  it('maps a target command WITHOUT capabilityId to applyDeviceTargets keyed by deviceId, forwarding context', async () => {
    const transport = buildTransport();
    const actuator = createDeviceActuator(transport);
    await actuator.apply({ kind: 'target', deviceId: 'th1', value: 5, contextInfo: 'ctx' });
    expect(transport.applyDeviceTargets).toHaveBeenCalledWith({ th1: 5 }, 'ctx');
    expect(transport.setCapability).not.toHaveBeenCalled();
  });

  it('routes a capability-addressed target command to setCapability, not applyDeviceTargets', async () => {
    const transport = buildTransport();
    const actuator = createDeviceActuator(transport);
    const outcome = await actuator.apply({
      kind: 'target', deviceId: 'd', capabilityId: 'target_temperature', value: 5,
    });
    expect(outcome).toEqual({ requested: true });
    expect(transport.setCapability).toHaveBeenCalledWith('d', 'target_temperature', 5);
    expect(transport.applyDeviceTargets).not.toHaveBeenCalled();
  });

  it('propagates a setCapability failure for a capability-addressed target (no swallow)', async () => {
    const transport = buildTransport({
      setCapability: vi.fn(async () => { throw new Error('write failed'); }),
    });
    const actuator = createDeviceActuator(transport);
    await expect(actuator.apply({
      kind: 'target', deviceId: 'd', capabilityId: 'target_temperature', value: 5,
    })).rejects.toThrow('write failed');
  });

  it('passes a step command through and surfaces the stepped result', async () => {
    const requestSteppedLoadStep = vi.fn(async () => ({ requested: true as const, transport: 'native_capability' as const }));
    const transport = buildTransport({ requestSteppedLoadStep });
    const actuator = createDeviceActuator(transport);
    const outcome = await actuator.apply({
      kind: 'step', deviceId: 's1', profile: { model: 'stepped_load', steps: [{ id: 'low', planningPowerW: 1000 }] },
      desiredStepId: 'low', planningPowerW: 1000, planningCurrentA: 0, actuationMode: 'plan',
    });
    expect(requestSteppedLoadStep).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 's1', desiredStepId: 'low' }));
    expect(outcome).toEqual({ requested: true, steppedResult: { requested: true, transport: 'native_capability' } });
  });

  it('reports requested:false for a step command when the transport has no stepped-load surface', async () => {
    const actuator = createDeviceActuator(buildTransport());
    const outcome = await actuator.apply({
      kind: 'step', deviceId: 's1', profile: { model: 'stepped_load', steps: [{ id: 'low', planningPowerW: 1000 }] },
      desiredStepId: 'low', planningPowerW: 1000, planningCurrentA: 0,
    });
    expect(outcome).toEqual({ requested: false });
  });
});
