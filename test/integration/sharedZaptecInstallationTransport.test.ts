import Homey from 'homey';
import { getLogger } from '../../lib/logging/logger';
import { HomeyHttpStatusError } from '../../lib/utils/homeyHttpStatusError';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { DEVICES_API_PATH, setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { mockHomeyInstance } from '../mocks/homey';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';

const logger = (): Logger => ({ log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/zaptec-shared') });
// The Homey ids sort the other way round from the Zaptec charger ids, which pick the main.
const charger = (id: string, zaptecId: string): HomeyDeviceLike => {
  const base = buildZaptecTargetPowerDevice();
  return buildZaptecTargetPowerDevice({
    id, name: `Go ${id}`, data: { id: zaptecId, installationId: 'zaptec-installation' },
    capabilitiesObj: {
      available_installation_current: { ...base.capabilitiesObj?.available_installation_current, setable: true },
      evcharger_charging: { ...base.capabilitiesObj?.evcharger_charging, value: true },
      evcharger_charging_state: { ...base.capabilitiesObj?.evcharger_charging_state, value: 'plugged_in_charging' },
    },
  });
};
const MAIN = 'homey-b';
const SECONDARY = 'homey-a';
const installation = () => [charger(SECONDARY, 'zaptec-2'), charger(MAIN, 'zaptec-1')];

afterEach(() => {
  setRestClient({
    get: (path) => mockHomeyInstance.api.get(path),
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
});

async function seeded() {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger());
  await seedTransportDevices(transport, installation());
  const put = vi.fn().mockResolvedValue(undefined);
  setRestClient({ get: vi.fn(), put });
  return { transport, put };
}

test('each member carries the neutral installation fact; only the main keeps its watt control', async () => {
  const { transport } = await seeded();
  const main = transport.getSnapshotByDeviceId(MAIN);
  const secondary = transport.getSnapshotByDeviceId(SECONDARY);
  const fact = { id: 'zaptec-installation', mainId: MAIN, memberIds: [MAIN, SECONDARY] };
  expect(main?.controlAdapter?.chargingInstallation).toEqual({ ...fact, role: 'main' });
  expect(secondary?.controlAdapter?.chargingInstallation).toEqual({ ...fact, role: 'secondary' });
  expect(main).toMatchObject({ nativeWriteCapabilities: ['target_power'] });
  expect(secondary?.nativeWriteCapabilities).toBeUndefined();
  expect(secondary?.steppedLoadProfile).toBeUndefined();
  expect(secondary?.capabilities).not.toContain('target_power');
});

test('a step goes to the main alone; a secondary takes no amp or watt write', async () => {
  const { transport, put } = await seeded();
  const profile = transport.getSnapshotByDeviceId(MAIN)?.steppedLoadProfile;
  const step = profile?.steps.find((entry) => entry.planningPowerW > 0);
  if (!profile || !step) throw new Error('Expected the main to carry the installation ladder');
  await transport.requestSteppedLoadStep({
    deviceId: MAIN, profile, desiredStepId: step.id, planningPowerW: step.planningPowerW, planningCurrentA: 0,
  });
  const paths = put.mock.calls.map(([path]) => String(path));
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((path) => path.startsWith(`manager/devices/device/${MAIN}/`))).toBe(true);

  put.mockClear();
  for (const capabilityId of ['available_installation_current', 'target_power', 'target_power_mode']) {
    await expect(transport.setCapability(SECONDARY, capabilityId, 10)).rejects.toThrow('another charger');
  }
  await expect(transport.requestSteppedLoadStep({
    deviceId: SECONDARY, profile, desiredStepId: step.id, planningPowerW: step.planningPowerW, planningCurrentA: 0,
  })).rejects.toThrow('another charger');
  expect(put).not.toHaveBeenCalled();
});

test('the primary preserves the published ladder while its exact watt observation advances', async () => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger());
  await initWithLiveFeed(transport);
  const main = charger(MAIN, 'zaptec-1');
  await seedTransportDevices(transport, [charger(SECONDARY, 'zaptec-2'), {
    ...main,
    capabilitiesObj: {
      ...main.capabilitiesObj,
      target_power: { ...main.capabilitiesObj.target_power, value: 2391 },
      target_power_mode: { ...main.capabilitiesObj.target_power_mode, value: 'homey' },
    },
  }]);
  const initial = transport.getSnapshotByDeviceId(MAIN);
  expect(initial?.reportedStepPowerW).toBe(2391);
  const profile = initial?.steppedLoadProfile;
  const exactWatts = 2531;
  expect(profile?.steps.some((step) => step.planningPowerW === exactWatts)).toBe(false);
  await emitCapability(MAIN, 'target_power', exactWatts);
  expect(transport.getSnapshotByDeviceId(MAIN)).toMatchObject({
    reportedStepPowerW: exactWatts, steppedLoadProfile: profile,
  });
});

test.each([MAIN, SECONDARY])('a binary command sent to %s reaches its own switch', async (id) => {
  const { transport, put } = await seeded();
  await transport.requestBinaryControl(id, false, vi.fn());
  expect(put).toHaveBeenCalledExactlyOnceWith(
    `manager/devices/device/${id}/capability/evcharger_charging`, pelsCapabilityWrite(false),
  );
});

test('each member confirms commands using its own switch reading', async () => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
    settings: { getDevicePowerControlMode: () => 'automatic' },
  });
  const main = charger(MAIN, 'zaptec-1');
  await seedTransportDevices(transport, [charger(SECONDARY, 'zaptec-2'), {
    ...main,
    capabilitiesObj: {
      ...main.capabilitiesObj,
      evcharger_charging: { ...main.capabilitiesObj.evcharger_charging, value: false },
    },
  }]);
  const confirmations = transport.getBinaryCommandConfirmationSnapshot();
  expect(confirmations.find(({ id }) => id === MAIN)?.binaryCommandConfirmation)
    .toMatchObject({ state: 'observed', observedValue: false });
  expect(confirmations.find(({ id }) => id === SECONDARY)?.binaryCommandConfirmation)
    .toMatchObject({ state: 'observed', observedValue: true });
});

test('the main reports the installation\'s level: its watt target under Homey\'s control, else the available current', async () => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {
    settings: { getDevicePowerControlMode: () => 'automatic' },
  });
  const base = charger(MAIN, 'zaptec-1').capabilitiesObj;
  const withMain = (capabilitiesObj: HomeyDeviceLike['capabilitiesObj']) => [
    charger(SECONDARY, 'zaptec-2'),
    { ...charger(MAIN, 'zaptec-1'), capabilitiesObj: { ...base, ...capabilitiesObj } },
  ];
  const control = transport.chargingCurrentControl;

  // A 0 W target stops only the main's car: the installation stays at its 23 A.
  await seedTransportDevices(transport, withMain({
    available_installation_current: { ...base.available_installation_current, value: 23 },
    target_power: { ...base.target_power, value: 0 },
    target_power_mode: { ...base.target_power_mode, value: 'homey' },
  }));
  // The app's 6 A target (2391 W on this IT installation) gives its watts per amp.
  expect(control.installationLevelW(MAIN)).toBe(Math.round(23 * (2391 / 6)));
  expect(control.installationLevelW(SECONDARY)).toBeUndefined();

  await seedTransportDevices(transport, withMain({
    available_installation_current: { ...base.available_installation_current, value: 23 },
    target_power: { ...base.target_power, value: 5520 },
    target_power_mode: { ...base.target_power_mode, value: 'homey' },
  }));
  expect(control.installationLevelW(MAIN)).toBe(5520);

  await seedTransportDevices(transport, withMain({
    available_installation_current: { ...base.available_installation_current, value: 4 },
    target_power_mode: { ...base.target_power_mode, value: 'device' },
  }));
  expect(control.installationLevelW(MAIN)).toBe(0);
});

test('a member moving to another meter area withdraws the ladder and fences an old step at dispatch', async () => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger(), {}, {}, {
    externalPower: {
      settings: {
        devicePowerSources: {}, managedDevices: {}, isMeteringSocketReserved: () => false,
        isMainFusePhaseMeter: () => false,
      },
      resolveHome: (_id, zoneId) => zoneId === 'other-zone' ? 'other-home' : 'main',
    },
  });
  const devices = installation();
  await seedTransportDevices(transport, devices);
  const profile = transport.getSnapshotByDeviceId(MAIN)?.steppedLoadProfile;
  const step = profile?.steps.find((entry) => entry.planningPowerW > 0);
  if (!profile || !step) throw new Error('Expected the main to carry the installation ladder');

  const snapshots = await seedTransportDevices(transport, devices.map((device) => (
    device.id === SECONDARY ? { ...device, zone: 'other-zone' } : device
  )));
  expect(snapshots).toHaveLength(2);
  for (const snapshot of snapshots) {
    expect(snapshot.controlAdapter?.chargingInstallation).toBeUndefined();
    expect(snapshot.steppedLoadProfile).toBeUndefined();
  }

  const put = vi.fn().mockResolvedValue(undefined);
  setRestClient({ get: vi.fn(), put });
  await expect(transport.requestSteppedLoadStep({
    deviceId: MAIN, profile, desiredStepId: step.id, planningPowerW: step.planningPowerW, planningCurrentA: 0,
  })).rejects.toThrow('PELS cannot set the shared current');
  await expect(transport.setCapability(MAIN, 'target_power', step.planningPowerW))
    .rejects.toThrow('PELS cannot set the shared current');
  expect(put).not.toHaveBeenCalled();
  await transport.requestBinaryControl(MAIN, false, vi.fn());
  expect(put).toHaveBeenCalledExactlyOnceWith(
    `manager/devices/device/${MAIN}/capability/evcharger_charging`, pelsCapabilityWrite(false),
  );
});


test('a refused automatic current claim leaves both switches available until the ordinary retry is due', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { transport } = await seeded();
    const devices = installation();
    const get = async (path: string) => path === DEVICES_API_PATH
      ? Object.fromEntries(devices.map((device) => [device.id, device])) : mockHomeyInstance.api.get(path);
    const put = vi.fn().mockRejectedValue(new HomeyHttpStatusError(400, 'Not supported'));
    setRestClient({ get, put });

    await expect(transport.requestTargetPowerControlClaim({ deviceId: MAIN }))
      .resolves.toMatchObject({ kind: 'refused' });
    await vi.waitFor(() => {
      for (const id of [MAIN, SECONDARY]) {
        const snapshot = transport.getSnapshotByDeviceId(id);
        expect(snapshot?.binaryCapabilityId).toBe('evcharger_charging');
        expect(snapshot?.controlAdapter?.chargingInstallation).toBeUndefined();
        expect(snapshot?.steppedLoadProfile).toBeUndefined();
      }
    });
    expect(transport.getTargetPowerControlClaim(MAIN)).toBe('refused');
    expect(transport.getTargetPowerControlClaim(SECONDARY)).toBeUndefined();

    vi.setSystemTime(Date.now() + 15 * 60_000);
    await seedTransportDevices(transport, devices);
    expect(transport.getTargetPowerControlClaim(MAIN)).toBe('needed');
    expect(transport.getTargetPowerControlClaim(SECONDARY)).toBeUndefined();
    expect(transport.getSnapshotByDeviceId(MAIN)?.steppedLoadProfile).toBeDefined();
    expect(transport.getSnapshotByDeviceId(SECONDARY)?.steppedLoadProfile).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
