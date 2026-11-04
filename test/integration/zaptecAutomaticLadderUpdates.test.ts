import Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { DEVICE_POWER_CONTROL_MODES, DEVICE_TARGET_POWER_CONFIGS } from '../../lib/utils/settingsKeys';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability, emitDeviceUpdate, settleLiveFeed } from '../helpers/liveFeedSocketHarness';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';

const ID = 'zaptec-target-power';
const SAVED_MODEL = { enabled: true, preset: 'ev_charger_3_phase' as const, max: 22080 };
const CHANGES = [
  { change: 'lower installation maximum', max: 6373, step: 230, excludeMax: 2391,
    firstW: 2530, lastW: 6210, staleW: 12650 },
  { change: 'single-phase supply', max: 7360, step: 230, excludeMax: 1380,
    firstW: 1380, lastW: 7360, staleW: 12650 },
  { change: 'published watt increment', max: 12747, step: 460, excludeMax: 2391,
    firstW: 2760, lastW: 12420, staleW: 2530 },
] as const;

function charger() {
  const source = buildZaptecTargetPowerDevice();
  return buildZaptecTargetPowerDevice({ capabilitiesObj: {
    ...source.capabilitiesObj,
    target_power: { ...source.capabilitiesObj?.target_power, value: 6440 },
    target_power_mode: { ...source.capabilitiesObj?.target_power_mode, value: 'homey' },
    evcharger_charging: { value: true, setable: true, lastUpdated: new Date().toISOString() },
    evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: new Date().toISOString() },
  } });
}

describe.each(['full read', 'device.update'] as const)('Zaptec Automatic settings changes through %s', (readPath) => {
  beforeEach(() => {
    resetMockHomey();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 4, 9));
  });
  afterEach(() => {
    vi.useRealTimers();
    setRestClient({
      get: (path) => mockHomeyInstance.api.get(path), put: (path, body) => mockHomeyInstance.api.put(path, body),
    });
  });

  it.each(CHANGES)('adopts $change and refuses commands from the old ladder', async (change) => {
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, { [ID]: structuredClone(SAVED_MODEL) });
    mockHomeyInstance.settings.set(DEVICE_POWER_CONTROL_MODES, { [ID]: 'automatic' });
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
      { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/zaptec-settings') }, {
        settings: { getDeviceTargetPowerConfig: () => SAVED_MODEL, getDevicePowerControlMode: () => 'automatic' },
      });
    await initWithLiveFeed(transport);
    const [initial] = await seedTransportDevices(transport, [charger()]);
    const oldProfile = initial.steppedLoadProfile;
    if (!oldProfile) throw new Error('Expected initial IT ladder');
    vi.setSystemTime(Date.now() + 1000);
    const next = charger();
    const updated = buildZaptecTargetPowerDevice({ ...next, capabilitiesObj: {
      ...next.capabilitiesObj,
      target_power: { ...next.capabilitiesObj?.target_power,
        max: change.max, step: change.step, excludeMax: change.excludeMax },
    } });
    if (readPath === 'full read') await seedTransportDevices(transport, [updated]);
    else {
      emitDeviceUpdate(updated);
      await settleLiveFeed();
    }
    const current = transport.getSnapshotByDeviceId(ID);
    const profile = current?.steppedLoadProfile;
    if (!profile) throw new Error('Expected refreshed Automatic ladder');
    expect(current?.automaticPowerControl).toEqual({ mode: 'automatic', profile });
    expect(profile.steps[1]).toEqual({ id: `${change.firstW}w`, planningPowerW: change.firstW });
    expect(profile.steps.at(-1)).toEqual({ id: `${change.lastW}w`, planningPowerW: change.lastW });
    expect(current?.targetPowerConfig).toBeUndefined();
    expect(current?.reportedStepId).toBeUndefined();
    expect(transport.deviceConfigurationStore.get(ID)?.controlModel).toBe('stepped_load');

    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });
    expect(await transport.requestSteppedLoadStep({
      deviceId: ID, profile: oldProfile, desiredStepId: `${change.staleW}w`,
      planningPowerW: change.staleW, planningCurrentA: 0,
    })).toEqual({ requested: false });
    expect(put).not.toHaveBeenCalled();

    await transport.requestSteppedLoadStep({
      deviceId: ID, profile, desiredStepId: `${change.firstW}w`, planningPowerW: change.firstW, planningCurrentA: 0,
    });
    expect(put).toHaveBeenCalledExactlyOnceWith(
      `manager/devices/device/${ID}/capability/target_power`, pelsCapabilityWrite(change.firstW),
    );
    vi.setSystemTime(Date.now() + 30_000);
    await emitCapability(ID, 'target_power', change.firstW);
    expect(transport.getSnapshotByDeviceId(ID)?.reportedStepId).toBe(`${change.firstW}w`);
    expect(mockHomeyInstance.settings.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual({ [ID]: SAVED_MODEL });
    expect(mockHomeyInstance.settings.get(DEVICE_POWER_CONTROL_MODES)).toEqual({ [ID]: 'automatic' });
  });
});
