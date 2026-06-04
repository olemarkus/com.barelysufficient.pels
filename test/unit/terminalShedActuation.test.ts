import { applyShedBehavior } from '../../lib/actuator/terminalShedActuation';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';

const buildActuator = () => {
  const transport = {
    setCapability: vi.fn(async () => undefined),
    applyDeviceTargets: vi.fn(async () => undefined),
    triggerFlowBackedBinaryControl: vi.fn(async () => undefined),
  };
  return { transport, actuator: createDeviceActuator(transport) };
};

describe('applyShedBehavior (thin set-and-forget terminal actuator)', () => {
  it('turns a binary device off when observed on', async () => {
    const { transport, actuator } = buildActuator();
    const wrote = await applyShedBehavior({
      deviceId: 'd1',
      name: 'Heater',
      command: { kind: 'binary_off', capabilityId: 'onoff', flowBacked: false },
      observed: { binaryState: 'on' },
      actuator,
    });
    expect(wrote).toBe(true);
    expect(transport.setCapability).toHaveBeenCalledWith('d1', 'onoff', false);
  });

  it('routes a flow-backed binary device through its Flow trigger, not setCapability', async () => {
    const { transport, actuator } = buildActuator();
    const wrote = await applyShedBehavior({
      deviceId: 'd1',
      name: 'Flow heater',
      command: { kind: 'binary_off', capabilityId: 'onoff', flowBacked: true },
      observed: { binaryState: 'on' },
      actuator,
    });
    expect(wrote).toBe(true);
    expect(transport.triggerFlowBackedBinaryControl).toHaveBeenCalledWith('d1', 'onoff', false);
    expect(transport.setCapability).not.toHaveBeenCalled();
  });

  it('skips the binary write when already observed off (idempotent)', async () => {
    const { transport, actuator } = buildActuator();
    const wrote = await applyShedBehavior({
      deviceId: 'd1',
      name: 'Heater',
      command: { kind: 'binary_off', capabilityId: 'onoff', flowBacked: false },
      observed: { binaryState: 'off' },
      actuator,
    });
    expect(wrote).toBe(false);
    expect(transport.setCapability).not.toHaveBeenCalled();
  });

  it('skips the binary write on unknown/missing observation (no trusted evidence)', async () => {
    const { transport, actuator } = buildActuator();
    for (const binaryState of ['unknown', undefined] as const) {
      const wrote = await applyShedBehavior({
        deviceId: 'd1',
        name: 'Heater',
        command: { kind: 'binary_off', capabilityId: 'evcharger_charging', flowBacked: false },
        observed: { binaryState },
        actuator,
      });
      expect(wrote).toBe(false);
    }
    expect(transport.setCapability).not.toHaveBeenCalled();
  });

  it('writes the shed setpoint when the observed target differs', async () => {
    const { transport, actuator } = buildActuator();
    const wrote = await applyShedBehavior({
      deviceId: 'd2',
      name: 'Thermostat',
      command: { kind: 'set_temperature', targetValue: 5 },
      observed: { targetValue: 21 },
      actuator,
    });
    expect(wrote).toBe(true);
    expect(transport.applyDeviceTargets).toHaveBeenCalledWith({ d2: 5 }, 'smart-task-terminal-release');
  });

  it('skips the setpoint write when already at the shed target (idempotent)', async () => {
    const { transport, actuator } = buildActuator();
    const wrote = await applyShedBehavior({
      deviceId: 'd2',
      name: 'Thermostat',
      command: { kind: 'set_temperature', targetValue: 5 },
      observed: { targetValue: 5 },
      actuator,
    });
    expect(wrote).toBe(false);
    expect(transport.applyDeviceTargets).not.toHaveBeenCalled();
  });

  it('skips the setpoint write when the observed target is unknown', async () => {
    const { transport, actuator } = buildActuator();
    const wrote = await applyShedBehavior({
      deviceId: 'd2',
      name: 'Thermostat',
      command: { kind: 'set_temperature', targetValue: 5 },
      observed: { targetValue: null },
      actuator,
    });
    expect(wrote).toBe(false);
    expect(transport.applyDeviceTargets).not.toHaveBeenCalled();
  });

  it('no-ops a skip command without touching the transport', async () => {
    const { transport, actuator } = buildActuator();
    const wrote = await applyShedBehavior({
      deviceId: 'd3',
      name: 'Stepped-only',
      command: { kind: 'skip', reasonCode: 'stepped_only_set_step_unsupported' },
      observed: {},
      actuator,
    });
    expect(wrote).toBe(false);
    expect(transport.setCapability).not.toHaveBeenCalled();
    expect(transport.applyDeviceTargets).not.toHaveBeenCalled();
  });
});
