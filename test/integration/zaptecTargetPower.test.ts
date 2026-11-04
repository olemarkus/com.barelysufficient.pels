import Homey from 'homey';
import { getLogger } from '../../lib/logging/logger';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability, emitDeviceUpdate, settleLiveFeed } from '../helpers/liveFeedSocketHarness';
import { buildZaptecCurrentOnlyDevice, buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { capabilityReadings } from '../helpers/homeyDevicePayload';
import { mockHomeyInstance } from '../mocks/homey';
import { ownWriteTransactionId, pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { DeviceConfigurationStore } from '../../lib/device/deviceConfiguration';
import { DeviceTargetPowerReachabilityOwner } from '../../lib/device/deviceTargetPowerReachabilityOwner';

const logger = (): Logger => ({ log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/zaptec') });

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });

/** Establish a native claim through fresh stopped proof and independent target readback. */
async function settleNativeTarget(
  transport: ReturnType<typeof createTestDeviceTransport>, device: HomeyDeviceLike, watts: number,
) {
  const read = (overrides: HomeyDeviceLike['capabilitiesObj']) => ({
    ...device,
    capabilitiesObj: Object.fromEntries(Object.entries({ ...device.capabilitiesObj, ...overrides })
      .map(([id, capability]) => [id, { ...capability, lastUpdated: new Date().toISOString() }])),
  });
  vi.setSystemTime(Date.now() + 1000);
  const stopped = read({
    evcharger_charging: { ...device.capabilitiesObj?.evcharger_charging, value: false },
    measure_power: { ...device.capabilitiesObj?.measure_power, value: 0 },
    target_power_mode: { ...device.capabilitiesObj?.target_power_mode, value: 'homey' },
  });
  const [preparing] = await seedTransportDevices(transport, [stopped]);
  const profile = preparing.steppedLoadProfile;
  if (!profile) throw new Error('Expected a native watt ladder');
  const put = vi.fn().mockResolvedValue(undefined);
  setRestClient({ get: async () => stopped, put });
  await transport.requestSteppedLoadStep({
    deviceId: device.id, profile, desiredStepId: `${watts}w`, planningPowerW: watts, planningCurrentA: 0,
  });
  vi.setSystemTime(Date.now() + 1000);
  const [confirmed] = await seedTransportDevices(transport, [read({
    target_power: { ...device.capabilitiesObj?.target_power, value: watts },
    target_power_mode: { ...device.capabilitiesObj?.target_power_mode, value: 'homey' },
  })]);
  return confirmed;
}

afterEach(() => {
  vi.useRealTimers();
  setRestClient({
    get: (path) => mockHomeyInstance.api.get(path),
    post: (path, body) => mockHomeyInstance.api.post(path, body),
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
});

describe('Zaptec native target power', () => {
  it.each([undefined, 'automatic'] as const)(
    'keeps the shipped current-only charger on its Flow route with saved mode %s', async (mode) => {
      const config = { enabled: true, preset: 'ev_charger_3_phase' as const };
      const device = buildZaptecCurrentOnlyDevice();
      const trigger = vi.fn().mockResolvedValue(undefined);
      const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
        settings: { getDeviceTargetPowerConfig: () => config, getDevicePowerControlMode: () => mode },
      }, undefined, { getFlowTriggerCard: () => ({ trigger }) });
      await initWithLiveFeed(transport);
      const [parsed] = await seedTransportDevices(transport, [device]);
      expect(parsed.automaticPowerControl).toBeUndefined();
      expect(parsed.targetPowerConfig).toEqual(config);
      expect(parsed.binaryWriteCapabilityId).toBe('charging_button');
      expect(parsed.reportedStepId).toBe('16a');
      const profile = parsed.steppedLoadProfile;
      if (!profile) throw new Error('Expected saved amp ladder');
      const put = vi.fn();
      setRestClient({ get: vi.fn(), put });
      await transport.requestSteppedLoadStep({
        deviceId: device.id, profile, desiredStepId: '10a', planningPowerW: 6900, planningCurrentA: 10,
      });
      expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
        step_id: '10a', planning_current_a: 10, planning_power_w: 6900,
      }), { deviceId: device.id });
      expect(put).not.toHaveBeenCalled();
      await emitCapability(device.id, 'available_installation_current', 10);
      expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBe('10a');
    },
  );

  it.each([
    ['missing maximum', { max: undefined }],
    ['missing step', { step: undefined }],
    ['zero maximum', { max: 0 }],
    ['negative maximum', { max: -1 }],
    ['non-finite maximum', { max: Number.POSITIVE_INFINITY }],
    ['NaN maximum', { max: Number.NaN }],
    ['zero step', { step: 0 }],
    ['negative step', { step: -1 }],
    ['non-finite step', { step: Number.POSITIVE_INFINITY }],
    ['NaN step', { step: Number.NaN }],
    ['excluded positive range', { excludeMax: 20_000 }],
    ['read-only target', { setable: false }],
  ] as const)('does not advertise Automatic with %s even when Automatic was saved', async (_case, options) => {
    const device = buildZaptecTargetPowerDevice();
    const config = { enabled: true, preset: 'ev_charger_3_phase' as const };
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
      settings: { getDeviceTargetPowerConfig: () => config, getDevicePowerControlMode: () => 'automatic' },
    });
    const [parsed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...device.capabilitiesObj?.target_power, ...options },
        target_power_mode: { ...device.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    })]);
    expect(parsed.automaticPowerControl).toBeUndefined();
    expect(parsed.targetPowerConfig).toEqual(config);
    expect(parsed.steppedLoadProfile?.steps[1]?.id).toBe('6a');
  });

  it.each(['current-only', 'unusable range'] as const)(
    'removes Automatic availability when the same charger later reports %s', async (surface) => {
      const device = buildZaptecTargetPowerDevice();
      const config = { enabled: true, preset: 'ev_charger_3_phase' as const };
      const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
        settings: { getDeviceTargetPowerConfig: () => config, getDevicePowerControlMode: () => 'automatic' },
      });
      const [native] = await seedTransportDevices(transport, [device]);
      expect(native.automaticPowerControl?.mode).toBe('automatic');

      const fallback = surface === 'current-only'
        ? buildZaptecCurrentOnlyDevice({ id: device.id, data: device.data })
        : buildZaptecTargetPowerDevice({
          capabilitiesObj: { target_power: { ...device.capabilitiesObj?.target_power, step: undefined } },
        });
      const [updated] = await seedTransportDevices(transport, [fallback]);
      expect(updated.automaticPowerControl).toBeUndefined();
      expect(transport.getSnapshotByDeviceId(device.id)?.automaticPowerControl).toBeUndefined();
      expect(updated.targetPowerConfig).toEqual(config);
      expect(updated.steppedLoadProfile?.steps[1]?.id).toBe('6a');
    },
  );

  it('keeps an existing phase model and Flow active until Automatic is selected', async () => {
    const config = { enabled: true, preset: 'ev_charger_3_phase' as const, max: 11040 };
    const device = buildZaptecTargetPowerDevice();
    const trigger = vi.fn().mockResolvedValue(undefined);
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
      settings: { getDeviceTargetPowerConfig: () => config },
    }, undefined, { getFlowTriggerCard: () => ({ trigger }) });
    await initWithLiveFeed(transport);
    const [parsed] = await seedTransportDevices(transport, [device]);
    expect(parsed.automaticPowerControl).toMatchObject({ mode: 'manual' });
    expect(parsed.automaticPowerControl?.profile.steps[1]?.id).toBe('2530w');
    expect(parsed.targetPowerConfig).toEqual(config);
    expect(parsed.reportedStepId).toBe('16a');
    const profile = parsed.steppedLoadProfile;
    if (!profile) throw new Error('Expected saved amp ladder');
    const put = vi.fn();
    setRestClient({ get: vi.fn(), put });
    await transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '10a', planningPowerW: 6900, planningCurrentA: 10,
    });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ planning_current_a: 10 }), { deviceId: device.id });
    expect(put).not.toHaveBeenCalled();
    await emitCapability(device.id, 'available_installation_current', 10);
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBe('10a');
    await emitCapability(device.id, 'target_power', 2530);
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBe('10a');
  });

  it('retains a saved EV ladder when no usable native watt range is published', async () => {
    const config = { enabled: true, preset: 'ev_charger_3_phase' as const };
    const device = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
      settings: { getDeviceTargetPowerConfig: () => config },
    });
    const [parsed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { value: 11040, setable: true, lastUpdated: device.capabilitiesObj?.target_power?.lastUpdated },
        target_power_mode: { ...device.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    })]);
    expect(parsed.targetPowerConfig).toEqual(config);
    expect(parsed.reportedStepId).toBe('16a');
    expect(parsed.steppedLoadProfile?.steps[1]?.id).toBe('6a');
  });

  it.each([
    { enabled: true, preset: 'ev_charger_3_phase' as const },
    { enabled: true, min: 0, max: 22080, step: 1380, excludeMax: 4140 },
  ])('uses native IT watts instead of the saved ladder %j', async (config) => {
    const device = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
      settings: { getDeviceTargetPowerConfig: () => config, getDevicePowerControlMode: () => 'automatic' },
    });
    await initWithLiveFeed(transport);
    const [parsed] = await seedTransportDevices(transport, [device]);
    const profile = parsed.steppedLoadProfile;
    if (!profile) throw new Error('Expected native IT watt ladder');
    expect(parsed.targetPowerConfig).toBeUndefined();
    expect(profile.steps[1]).toEqual({ id: '2530w', planningPowerW: 2530 });
    expect(profile.steps.at(-1)).toEqual({ id: '12650w', planningPowerW: 12650 });
    const configuration = new DeviceConfigurationStore();
    configuration.set(parsed);
    const persist = vi.fn();
    const reachability = new DeviceTargetPowerReachabilityOwner(
      () => config, (id) => configuration.get(id), persist,
    );
    expect(reachability.readProbeConfiguration(device.id)).toEqual({ kind: 'unconfigured' });
    reachability.observeMaximum(device.id, 6440);
    expect(reachability.resolveIssuedStepPowers({
      deviceId: device.id, desiredStepId: '6440w',
    })).toEqual({});
    expect(persist).not.toHaveBeenCalled();

    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });
    await transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '6440w', planningPowerW: 6440, planningCurrentA: 0,
    });
    expect(put.mock.calls).toEqual([
      [`manager/devices/device/${device.id}/capability/target_power`, pelsCapabilityWrite(6440)],
      [`manager/devices/device/${device.id}/capability/target_power_mode`, pelsCapabilityWrite('homey')],
    ]);
    await emitCapability(device.id, 'target_power_mode', 'homey');
    await emitCapability(device.id, 'available_installation_current', 16);
    expect(transport.getSnapshotByDeviceId(device.id)?.steppedLoadProfile).toEqual(profile);
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBeUndefined();
  });

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
      automaticPowerControl: { mode: 'automatic' },
    });
    expect(parsed.reportedStepId).toBeUndefined();
    const steps = parsed.steppedLoadProfile?.steps ?? [];
    expect(steps[1]).toEqual({ id: `${firstW}w`, planningPowerW: firstW });
    expect(steps.at(-1)).toEqual({ id: `${lastW}w`, planningPowerW: lastW });
    expect(steps.every((step) => step.planningCurrentA === undefined)).toBe(true);
    expect(parsed.targetPowerConfig?.preset).toBeUndefined();
  });

  it('stores the desired watt limit before claiming control over a saved higher target', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
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

    vi.setSystemTime(Date.now() + 1000);
    await expect(transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '2530w', planningPowerW: 2530, planningCurrentA: 0,
    })).resolves.toEqual({ requested: true, acknowledged: true, transport: 'native_capability' });

    expect(put.mock.calls).toEqual([
      [`manager/devices/device/${device.id}/capability/target_power`, pelsCapabilityWrite(2530)],
      [`manager/devices/device/${device.id}/capability/target_power_mode`, pelsCapabilityWrite('homey')],
    ]);
    // Homey may report the newer mode alongside the target held before the
    // successful write, before either capability's realtime echo arrives.
    const claimedMode = buildZaptecTargetPowerDevice();
    const [staleRead] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...device.capabilitiesObj?.target_power, value: 11040 },
        target_power_mode: { ...claimedMode.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    })]);
    expect(staleRead.reportedStepId).toBeUndefined();
    await emitCapability(device.id, 'target_power', 2530, ownWriteTransactionId(put, device.id, 'target_power'));
    await emitCapability(
      device.id, 'target_power_mode', 'homey', ownWriteTransactionId(put, device.id, 'target_power_mode'),
    );
    // The watt echo is PELS's own write, recognised by its transaction id. A mode echo cannot
    // resurrect the superseded 11,040 W target as a delivered step.
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBeUndefined();
    vi.setSystemTime(Date.now() + 1000);
    const delivered = buildZaptecTargetPowerDevice();
    const [observed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...delivered.capabilitiesObj?.target_power, value: 2530 },
        target_power_mode: { ...delivered.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    })]);
    expect(observed.reportedStepId).toBe('2530w');
    // A malformed event cannot revoke the last accepted mode observation.
    await emitCapability(device.id, 'target_power_mode', 'external');
    put.mockClear();
    setRestClient({ get: vi.fn(), put });
    await transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '2760w', planningPowerW: 2760, planningCurrentA: 0,
    });
    expect(put.mock.calls).toEqual([
      [`manager/devices/device/${device.id}/capability/target_power`, pelsCapabilityWrite(2760)],
    ]);
  });

  describe('on an installation shared with another charger', () => {
    // The app turns each watt target into the installation current, which every
    // charger on the installation then takes, as the charging-current path does.
    const onInstallation = (id: string, installationId: string) => buildZaptecTargetPowerDevice({
      id, name: id, data: { id, installationId },
    });
    const ZAPTEC_ID = 'zaptec-target-power';
    const shared = () => [buildZaptecTargetPowerDevice(), onInstallation('zaptec-second', 'zaptec-installation')];

    it('is not offered watt stepping, so PELS neither claims its mode nor writes watts', async () => {
      const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
      await seedTransportDevices(transport, shared());
      const parsed = transport.getSnapshotByDeviceId(ZAPTEC_ID);

      expect(parsed).toMatchObject({ binaryCapabilityId: 'evcharger_charging', isEvCharger: true });
      expect(parsed?.steppedLoadProfile).toBeUndefined();
      expect(parsed?.nativeWriteCapabilities).toBeUndefined();
      expect(parsed?.capabilities).not.toContain('target_power');
      const put = vi.fn().mockResolvedValue(undefined);
      setRestClient({ get: vi.fn(), put });
      await transport.requestBinaryControl(ZAPTEC_ID, true, vi.fn());
      expect(put.mock.calls).toEqual([
        [`manager/devices/device/${ZAPTEC_ID}/capability/evcharger_charging`, pelsCapabilityWrite(true)],
      ]);
    });

    it('starts again after a stop while the app has never set its watt target', async () => {
      // The app adds both capabilities but sets neither value itself, so Homey
      // reports them null until someone writes them; on a shared installation
      // PELS never does.
      const neverWritten = (device: HomeyDeviceLike): HomeyDeviceLike => {
        const { target_power: power, target_power_mode: mode } = device.capabilitiesObj ?? {};
        return {
          ...device,
          capabilitiesObj: {
            ...device.capabilitiesObj,
            ...capabilityReadings({
              target_power: { ...power, value: null, lastUpdated: null },
              target_power_mode: { ...mode, value: null, lastUpdated: null },
            }),
          },
        };
      };
      const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
      await seedTransportDevices(transport, shared().map(neverWritten));
      expect(transport.getSnapshotByDeviceId(ZAPTEC_ID)?.nativeWriteCapabilities).toBeUndefined();
      const put = vi.fn().mockResolvedValue(undefined);
      setRestClient({ get: vi.fn(), put });

      await transport.requestBinaryControl(ZAPTEC_ID, false, vi.fn());
      expect(transport.canTurnOnDevice(ZAPTEC_ID)).toBe(true);
      await transport.requestBinaryControl(ZAPTEC_ID, true, vi.fn());
      expect(put.mock.calls).toEqual([
        [`manager/devices/device/${ZAPTEC_ID}/capability/evcharger_charging`, pelsCapabilityWrite(false)],
        [`manager/devices/device/${ZAPTEC_ID}/capability/evcharger_charging`, pelsCapabilityWrite(true)],
      ]);
    });

    it('keeps the native channel but refuses to reset an already claimed shared installation', async () => {
      // Hiding the control would leave the installation at PELS's last, low
      // watt target with nothing to hand the mode back.
      const base = buildZaptecTargetPowerDevice();
      const claimed = buildZaptecTargetPowerDevice({
        capabilitiesObj: {
          target_power: { ...base.capabilitiesObj?.target_power, value: 2530 },
          target_power_mode: { ...base.capabilitiesObj?.target_power_mode, value: 'homey' },
        },
      });
      const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
      await seedTransportDevices(transport, [claimed, onInstallation('zaptec-second', 'zaptec-installation')]);
      const parsed = transport.getSnapshotByDeviceId(ZAPTEC_ID);
      expect(parsed).toMatchObject({ nativeWriteCapabilities: ['target_power'] });
      expect(parsed?.reportedStepId).toBeUndefined();
      const profile = parsed?.steppedLoadProfile;
      if (!profile) throw new Error('Expected native target-power control');
      const put = vi.fn().mockResolvedValue(undefined);
      setRestClient({ get: vi.fn(), put });

      expect(await transport.requestSteppedLoadStep({
        deviceId: ZAPTEC_ID, profile, desiredStepId: '2760w', planningPowerW: 2760, planningCurrentA: 0,
      })).toEqual({ requested: false, preparation: 'binary_off' });
      expect(put).not.toHaveBeenCalled();
      await transport.requestBinaryControl(ZAPTEC_ID, false);
      expect(put.mock.calls).toEqual([
        [`manager/devices/device/${ZAPTEC_ID}/capability/evcharger_charging`, pelsCapabilityWrite(false)],
      ]);
    });

    it('steps a saved EV preset through the Flow, never as watts', async () => {
      const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
        settings: { getDeviceTargetPowerConfig: () => ({ enabled: true, preset: 'ev_charger_3_phase', max: 22080 }) },
      });
      await seedTransportDevices(transport, shared());
      const profile = transport.getSnapshotByDeviceId(ZAPTEC_ID)?.steppedLoadProfile;
      if (!profile) throw new Error('Expected the preset ladder');
      const put = vi.fn().mockResolvedValue(undefined);
      setRestClient({ get: vi.fn(), put });

      await expect(transport.requestSteppedLoadStep({
        deviceId: ZAPTEC_ID, profile, desiredStepId: '6a', planningPowerW: 4140, planningCurrentA: 6,
      })).resolves.toEqual({ requested: false });
      expect(put).not.toHaveBeenCalled();
    });

    it('keeps the full refresh\'s decision through a device update, until a refresh lists it alone', async () => {
      const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
      await initWithLiveFeed(transport);
      await seedTransportDevices(transport, shared());

      emitDeviceUpdate(buildZaptecTargetPowerDevice());
      await settleLiveFeed();
      expect(transport.getSnapshotByDeviceId(ZAPTEC_ID)?.steppedLoadProfile).toBeUndefined();

      await seedTransportDevices(transport, [buildZaptecTargetPowerDevice()]);
      expect(transport.getSnapshotByDeviceId(ZAPTEC_ID)).toMatchObject({ nativeWriteCapabilities: ['target_power'] });
    });

    it('is offered watt stepping beside a charger on another installation', async () => {
      const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
      await seedTransportDevices(transport, [
        buildZaptecTargetPowerDevice(), onInstallation('zaptec-elsewhere', 'other-installation'),
      ]);

      expect(transport.getSnapshotByDeviceId(ZAPTEC_ID)).toMatchObject({
        controlModel: 'stepped_load', nativeWriteCapabilities: ['target_power'],
      });
    });
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
      [`manager/devices/device/${device.id}/capability/target_power`, pelsCapabilityWrite(2530)],
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
      [`manager/devices/device/${device.id}/capability/target_power`, pelsCapabilityWrite(2530)],
      [`manager/devices/device/${device.id}/capability/target_power_mode`, pelsCapabilityWrite('homey')],
    ]);
    await emitCapability(device.id, 'target_power_mode', 'homey');
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBeUndefined();
    vi.setSystemTime(Date.now() + 1000);
    await emitCapability(device.id, 'target_power', 2530);
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBe('2530w');
    await emitCapability(device.id, 'target_power_mode', 'device');
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBeUndefined();
    await emitCapability(device.id, 'target_power_mode', 'homey');
    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBe('2530w');
  });

  it('retains an unchanged accepted watt observation when reasserting the same limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const base = buildZaptecTargetPowerDevice();
    const device = buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...base.capabilitiesObj?.target_power, value: 2530 },
        target_power_mode: { ...base.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
    await initWithLiveFeed(transport);
    const [cold] = await seedTransportDevices(transport, [device]);
    expect(cold.reportedStepId).toBeUndefined();
    const parsed = await settleNativeTarget(transport, device, 2530);
    const readAt = Date.now();
    const profile = parsed.steppedLoadProfile;
    if (!profile) throw new Error('Expected native target-power control');
    expect(parsed.reportedStepId).toBe('2530w');
    expect(parsed.reportedStepObservedAtMs).toBe(readAt);

    vi.setSystemTime(Date.now() + 1000);
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });
    await transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: '2530w', planningPowerW: 2530, planningCurrentA: 0,
    });
    expect(put.mock.calls).toEqual([
      [`manager/devices/device/${device.id}/capability/target_power`, pelsCapabilityWrite(2530)],
    ]);
    await emitCapability(device.id, 'target_power_mode', 'homey');
    expect(transport.getSnapshotByDeviceId(device.id)).toMatchObject({
      reportedStepId: '2530w', reportedStepObservedAtMs: readAt,
    });

    const later = buildZaptecTargetPowerDevice();
    const [refreshed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...device.capabilitiesObj?.target_power, value: 2530 },
        target_power_mode: { ...later.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    })]);
    expect(refreshed).toMatchObject({ reportedStepId: '2530w', reportedStepObservedAtMs: readAt });
  });

  it('does not restore a native reported step on a later full read in device mode', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
    const [claimed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...device.capabilitiesObj?.target_power, value: 2530 },
        target_power_mode: { ...device.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    })]);
    expect(claimed.reportedStepId).toBeUndefined();
    expect((await settleNativeTarget(transport, device, 2530)).reportedStepId).toBe('2530w');

    vi.setSystemTime(Date.now() + 1000);
    const later = buildZaptecTargetPowerDevice();
    const [released] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: { target_power: { ...later.capabilitiesObj?.target_power, value: 2530 } },
    })]);
    expect(released.reportedStepId).toBeUndefined();
    expect(released.reportedStepObservedAtMs).toBe(Date.now());
  });

  it.each([
    { enabled: true, min: 0, max: 12747, step: 230, excludeMax: 2391 },
    { enabled: true, preset: 'ev_charger_1_phase', max: 7360 },
  ] as const)('invalidates exact target-power evidence on mode loss with saved config %j', async (config) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
      settings: { getDeviceTargetPowerConfig: () => config, getDevicePowerControlMode: () => 'automatic' },
    });
    await initWithLiveFeed(transport);
    const [claimed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...device.capabilitiesObj?.target_power, value: 2530 },
        target_power_mode: { ...device.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    })]);
    expect(claimed.reportedStepId).toBeUndefined();
    const confirmed = await settleNativeTarget(transport, device, 2530);
    expect(confirmed.reportedStepId).toBe('2530w');
    expect(confirmed.targetPowerConfig).toBeUndefined();
    expect(confirmed.reportedStepObservedAtMs).toBe(Date.now());

    vi.setSystemTime(Date.now() + 1000);
    await emitCapability(device.id, 'target_power_mode', 'device');
    const released = transport.getSnapshotByDeviceId(device.id);
    expect(released?.reportedStepId).toBeUndefined();
    expect(released?.reportedStepPowerW).toBeUndefined();
    expect(released?.reportedStepObservedAtMs).toBe(Date.now());

    vi.setSystemTime(Date.now() + 1000);
    const later = buildZaptecTargetPowerDevice();
    const [refreshed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: { target_power: { ...later.capabilitiesObj?.target_power, value: 2530 } },
    })]);
    expect(refreshed.reportedStepId).toBeUndefined();
    expect(refreshed.reportedStepPowerW).toBeUndefined();
    expect(refreshed.reportedStepObservedAtMs).toBe(Date.now());
  });

  it('reads Automatic watts independently of a dormant saved preset and installation current', async () => {
    // The app converts watts its own way: 4,140 W on this IT installation is
    // about 10 A, which the 3-phase preset would read back as 6,900 W (10 A).
    const base = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
      settings: {
        getDeviceTargetPowerConfig: () => ({ enabled: true, preset: 'ev_charger_3_phase', max: 22080 }),
        getDevicePowerControlMode: () => 'automatic',
      },
    });
    await initWithLiveFeed(transport);
    const [parsed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...base.capabilitiesObj?.target_power, value: 4140 },
        target_power_mode: { ...base.capabilitiesObj?.target_power_mode, value: 'homey' },
        available_installation_current: { ...base.capabilitiesObj?.available_installation_current, value: 10 },
      },
    })]);
    expect(parsed.reportedStepId).toBeUndefined();
    expect((await settleNativeTarget(transport, base, 4140)).reportedStepId).toBe('4140w');
    expect(parsed.targetPowerConfig).toBeUndefined();

    await emitCapability(base.id, 'available_installation_current', 11);
    expect(transport.getSnapshotByDeviceId(base.id)).toMatchObject({ reportedStepId: '4140w' });

    await emitCapability(base.id, 'target_power', 4830);
    expect(transport.getSnapshotByDeviceId(base.id)).toMatchObject({ reportedStepId: '4830w' });
  });

  it.each(['external', 42, undefined])('withholds invalid watt control mode %s while keeping independent charger observations', async (value) => {
    const base = buildZaptecTargetPowerDevice();
    const device = buildZaptecTargetPowerDevice({
      capabilitiesObj: { target_power_mode: { ...base.capabilitiesObj?.target_power_mode, value } },
    });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});

    const [snapshot] = await seedTransportDevices(transport, [device]);
    expect(snapshot).toMatchObject({ id: device.id, evChargingState: 'plugged_in_paused', measuredPowerKw: 0 });
    expect(snapshot.steppedLoadProfile).toBeDefined();
    expect(snapshot.reportedStepId).toBeUndefined();
    expect(snapshot.reportedStepPowerW).toBeUndefined();
  });

  it.each([-1, Number.NaN, undefined])('keeps the accepted watt target after invalid realtime power %s', async (value) => {
    const device = buildZaptecTargetPowerDevice();
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {});
    await initWithLiveFeed(transport);
    const [parsed] = await seedTransportDevices(transport, [buildZaptecTargetPowerDevice({
      capabilitiesObj: {
        target_power: { ...device.capabilitiesObj?.target_power, value: 2530 },
        target_power_mode: { ...device.capabilitiesObj?.target_power_mode, value: 'homey' },
      },
    })]);
    expect(parsed.reportedStepId).toBeUndefined();
    expect((await settleNativeTarget(transport, device, 2530)).reportedStepId).toBe('2530w');

    await emitCapability(device.id, 'target_power', value);
    await emitCapability(device.id, 'target_power_mode', 'homey');

    expect(transport.getSnapshotByDeviceId(device.id)?.reportedStepId).toBe('2530w');
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
    expect(parsed.reportedStepId).toBeUndefined();
    expect((await settleNativeTarget(transport, device, 2530)).reportedStepId).toBe('2530w');
    const profile = parsed.steppedLoadProfile;
    if (!profile) throw new Error('Expected native target-power control');
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });

    for (const watts of [2530, 2760]) {
      await transport.requestSteppedLoadStep({
        deviceId: device.id, profile, desiredStepId: `${watts}w`, planningPowerW: watts, planningCurrentA: 0,
      });
      expect(put).toHaveBeenLastCalledWith(
        `manager/devices/device/${device.id}/capability/target_power`, pelsCapabilityWrite(watts),
      );
      await emitCapability(device.id, 'target_power', watts);
    }
    await transport.requestSteppedLoadStep({
      deviceId: device.id, profile, desiredStepId: 'off', planningPowerW: 0, planningCurrentA: 0,
    });
    expect(put).toHaveBeenLastCalledWith(
      `manager/devices/device/${device.id}/capability/evcharger_charging`, pelsCapabilityWrite(false),
    );
    await emitCapability(device.id, 'evcharger_charging', false);
    await emitCapability(device.id, 'evcharger_charging_state', 'plugged_in_paused');
    await transport.requestBinaryControl(device.id, true, vi.fn().mockRejectedValue(new Error('Unexpected Flow write')));
    expect(put).toHaveBeenLastCalledWith(
      `manager/devices/device/${device.id}/capability/evcharger_charging`, pelsCapabilityWrite(true),
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
      `manager/devices/device/${device.id}/capability/evcharger_charging`, pelsCapabilityWrite(false),
    );
  });
});
