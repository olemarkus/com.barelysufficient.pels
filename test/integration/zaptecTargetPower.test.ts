import Homey from 'homey';
import { getLogger } from '../../lib/logging/logger';
import type { Logger } from '../../lib/utils/types';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { mockHomeyInstance } from '../mocks/homey';

const logger = (): Logger => ({ log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/zaptec') });

afterEach(() => {
  vi.useRealTimers();
  setRestClient({
    get: (path) => mockHomeyInstance.api.get(path),
    post: (path, body) => mockHomeyInstance.api.post(path, body),
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
});

describe('Zaptec native target power', () => {
  it.each([
    ['single-phase', 7360, 1380, 1380, 7360],
    ['TN three-phase', 22080, 4140, 4140, 22080],
    ['IT three-phase', 12747, 2391, 2530, 12650],
  ] as const)('builds a watt ladder from the runtime %s options without an EV preset', async (
    _installation, max, excludeMax, firstW, lastW,
  ) => {
    const device = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
    const [parsed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: { target_power: { ...device.capabilitiesObj?.target_power, max, excludeMax } },
    })]);

    expect(parsed).toMatchObject({
      controlModel: 'stepped_load',
      binaryCapabilityId: 'evcharger_charging',
      nativeWriteCapabilities: ['target_power'],
    });
    expect(parsed.reportedStepId).toBeUndefined();
    const steps = parsed.steppedLoadProfile?.steps ?? [];
    expect(steps[1]).toEqual({ id: `${firstW}w`, planningPowerW: firstW });
    expect(steps.at(-1)).toEqual({ id: `${lastW}w`, planningPowerW: lastW });
    expect(steps.every((step) => step.planningCurrentA === undefined)).toBe(true);
    expect(parsed.targetPowerConfig?.preset).toBeUndefined();
  });

  it('stores the desired watt limit before claiming control over a saved higher target', async () => {
    const base = buildZaptecTargetPowerDevice();
    const device = buildZaptecTargetPowerDevice({
      capabilitiesObj: { target_power: { ...base.capabilitiesObj?.target_power, value: 11040 } },
    });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
    await initWithLiveFeed(transport);
    const [parsed] = await seedTransportDevices(transport, [device]);
    const profile = parsed.steppedLoadProfile;
    if (!profile) throw new Error('Expected native target-power control');
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });

    await expect(transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '2530w', planningPowerW: 2530, planningCurrentA: 0,
    })).resolves.toEqual({ requested: true, acknowledged: true, transport: 'native_capability' });

    expect(put.mock.calls).toEqual([
      [`manager/devices/device/${device.id}/capability/target_power`, { value: 2530 }],
      [`manager/devices/device/${device.id}/capability/target_power_mode`, { value: 'homey' }],
    ]);
    await emitCapability(device.id, 'target_power_mode', 'homey');
    // A malformed event cannot revoke the last accepted mode observation.
    await emitCapability(device.id, 'target_power_mode', 'external');
    put.mockClear();
    await transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '2760w', planningPowerW: 2760, planningCurrentA: 0,
    });
    expect(put.mock.calls).toEqual([
      [`manager/devices/device/${device.id}/capability/target_power`, { value: 2760 }],
    ]);
  });

  it('does not claim Homey control when the requested watt limit fails', async () => {
    const device = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
    const [parsed] = await seedTransportDevices(transport, [device]);
    const profile = parsed.steppedLoadProfile;
    if (!profile) throw new Error('Expected native target-power control');
    const put = vi.fn().mockRejectedValue(new Error('Watt limit rejected'));
    setRestClient({ get: vi.fn(), put });

    await expect(transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '2530w', planningPowerW: 2530, planningCurrentA: 0,
    })).rejects.toThrow();
    expect(put.mock.calls).toEqual([
      [`manager/devices/device/${device.id}/capability/target_power`, { value: 2530 }],
    ]);
  });

  it('retries a failed mode claim and reports the saved watts only while Homey owns control', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
    await initWithLiveFeed(transport);
    const [parsed] = await seedTransportDevices(transport, [device]);
    const profile = parsed.steppedLoadProfile;
    if (!profile) throw new Error('Expected native target-power control');
    const put = vi.fn(async (path: string) => {
      if (path.endsWith('/target_power_mode')) throw new Error('Mode claim rejected');
    });
    setRestClient({ get: vi.fn(), put });

    await expect(transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '2530w', planningPowerW: 2530, planningCurrentA: 0,
    })).rejects.toThrow();
    expect(put.mock.calls.map(([path]) => path)).toEqual([
      `manager/devices/device/${device.id}/capability/target_power`,
      `manager/devices/device/${device.id}/capability/target_power_mode`,
    ]);

    vi.setSystemTime(Date.now() + 1000);
    const later = buildZaptecTargetPowerDevice();
    const [unclaimed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: { target_power: { ...later.capabilitiesObj?.target_power, value: 2530 } },
    })]);
    // Successful storage of a target cannot confirm the step when mode is still device.
    expect(unclaimed.reportedStepId).toBeUndefined();

    const retryPut = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put: retryPut });
    await transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '2530w', planningPowerW: 2530, planningCurrentA: 0,
    });
    expect(retryPut.mock.calls).toEqual([
      [`manager/devices/device/${device.id}/capability/target_power`, { value: 2530 }],
      [`manager/devices/device/${device.id}/capability/target_power_mode`, { value: 'homey' }],
    ]);
    await emitCapability(device.id, 'target_power_mode', 'homey');
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBe('2530w');
    await emitCapability(device.id, 'target_power_mode', 'device');
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBeUndefined();
    await emitCapability(device.id, 'target_power_mode', 'homey');
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBe('2530w');
  });

  it.each(['external', 42, undefined])('rejects a full read with an invalid target-power mode %s', async (value) => {
    const base = buildZaptecTargetPowerDevice();
    const device = buildZaptecTargetPowerDevice({
      capabilitiesObj: { target_power_mode: { ...base.capabilitiesObj?.target_power_mode, value } },
    });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});

    expect(await seedTransportDevices(transport, [device])).toEqual([]);
  });

  it('keeps requested watt limits separate from observed charger power and native pause/resume', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
    await initWithLiveFeed(transport);
    const [parsed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power_mode: { ...device.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    })]);
    const profile = parsed.steppedLoadProfile;
    if (!profile) throw new Error('Expected native target-power control');
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });

    for (const watts of [2530, 2760]) {
      await transport.requestSteppedLoadStep({
        deviceId: device.id, profile, desiredStepId: `${watts}w`, planningPowerW: watts, planningCurrentA: 0,
      });
      expect(put).toHaveBeenLastCalledWith(
        `manager/devices/device/${device.id}/capability/target_power`, { value: watts },
      );
      await emitCapability(device.id, 'target_power', watts);
    }
    await transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: 'off', planningPowerW: 0, planningCurrentA: 0,
    });
    expect(put).toHaveBeenLastCalledWith(
      `manager/devices/device/${device.id}/capability/evcharger_charging`, { value: false },
    );
    await emitCapability(device.id, 'evcharger_charging', false);
    await emitCapability(device.id, 'evcharger_charging_state', 'plugged_in_paused');
    await transport.requestBinaryControl(device.id, true, vi.fn().mockRejectedValue(new Error('Unexpected Flow write')));
    expect(put).toHaveBeenLastCalledWith(
      `manager/devices/device/${device.id}/capability/evcharger_charging`, { value: true },
    );
    await emitCapability(device.id, 'evcharger_charging', true);
    await emitCapability(device.id, 'evcharger_charging_state', 'plugged_in_charging');
    await emitCapability(device.id, 'measure_power', 2390);

    // A write echo alone is not confirmation. Read Homey's independently dated
    // state after delivery, including the saved target retained through pause.
    vi.setSystemTime(Date.now() + 1000);
    const observedDevice = buildZaptecTargetPowerDevice();
    const readAt = new Date().toISOString();
    const [observed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...observedDevice.capabilitiesObj?.target_power, value: 2760 },
        target_power_mode: { ...observedDevice.capabilitiesObj?.target_power_mode, value: 'homey' },
        evcharger_charging: { value: true, setable: true, lastUpdated: readAt },
        evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: readAt },
        measure_power: { value: 2390, lastUpdated: readAt },
      },
    })]);
    expect(observed).toMatchObject({
      reportedStepId: '2760w', measuredPowerKw: 2.39, binaryControl: { on: true },
    });
    setRestClient({ get: vi.fn(), put });
    await transport.requestBinaryControl(device.id, false, vi.fn().mockRejectedValue(new Error('Unexpected Flow write')));
    expect(put).toHaveBeenLastCalledWith(
      `manager/devices/device/${device.id}/capability/evcharger_charging`, { value: false },
    );
  });
});
