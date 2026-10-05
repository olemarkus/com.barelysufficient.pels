// A battery claimed and handed back in one run through the real stack below
// the executor: the battery control owner, the device actuator and the device
// transport, down to the Homey Web API (`api.put`) against a MockDevice. Only
// the SDK seam is simulated; no realtime echo reaches the transport, so every
// decision is made against the snapshot as it was before PELS wrote.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Homey from 'homey';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { HomeBatteryControlOwner } from '../../lib/battery/batteryControlOwner';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import { toBatteryControlRead } from '../../setup/appInit/createBatteryControl';
import { BATTERY_CONTROL_DEVICES, PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX } from '../../lib/utils/settingsKeys';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { createTestDeviceTransport } from '../helpers/deviceTransportHarness';
import { buildSetpointBatteryDevice } from '../helpers/homeBatteryMock';
import { mockHomeyInstance, MockDriver, setMockDrivers } from '../mocks/homey';

const homeyMock = mockHomeyInstance as unknown as Homey.App;
const noop = (): void => undefined;
const loggerMock: Logger = {
  log: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};
const BATTERY = 'battery-1';
const CLAIM_KEY = `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}${BATTERY}`;

const unusedWrite = (): Promise<never> => Promise.reject(new Error('Only storage intents in this spec'));

const setup = () => {
  const device = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed', targetPowerW: 0 });
  setMockDrivers({ batteries: new MockDriver('batteries', [device]) });
  const transport: DeviceTransport = createTestDeviceTransport(homeyMock, loggerMock, {
    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
  });
  transport.setSnapshotForTests(transport.parseDeviceListForTests([device.toHomeyApiDevice() as HomeyDeviceLike]));
  const actuator = createDeviceActuator({
    canTurnOnDevice: () => false,
    resolveTemperatureTarget: (_deviceId, desired) => desired,
    requestBinaryControl: unusedWrite,
    requestTemperatureTarget: unusedWrite,
    requestSteppedLoadStep: unusedWrite,
    requestStoragePower: (command) => transport.requestStoragePower(command),
    releaseStorageControl: (command) => transport.releaseStorageControl(command),
  });
  const settings = mockHomeyInstance.settings;
  const owner = new HomeBatteryControlOwner({
    settings,
    actuation: actuator,
    getBattery: (deviceId) => toBatteryControlRead(transport.getSnapshotByDeviceId(deviceId)),
    isMainHomeMember: () => true,
    isActuationFenced: () => false,
    isCapacityDryRun: () => false,
  });
  const put = vi.spyOn(mockHomeyInstance.api, 'put');
  const writes = (): Array<[string, unknown]> => put.mock.calls.map(([path, body]) => [
    path.replace(`manager/devices/device/${BATTERY}/capability/`, ''),
    (body as { value?: unknown } | undefined)?.value,
  ]);
  /** What the executor will do in slice 3: admit, then command through the actuator. */
  const command = async (setpointW: number) => {
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'admitted' });
    await actuator.apply({ kind: 'storage_power', deviceId: BATTERY, setpointW });
  };
  return { device, owner, settings, writes, command };
};

describe('home battery claim and hand-back through the real transport', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(Date.now() + 60_000);
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set('capacity_limit_kw', 10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('hands back an opted-out battery whose claim echo never arrived: setpoint 0, then the pre-claim value', async () => {
    const { device, owner, settings, writes, command } = setup();

    await command(1500);
    expect(settings.get(CLAIM_KEY)).toMatchObject({ capabilityId: 'target_power_mode', previousValue: 'anti_feed' });
    settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    owner.applyControlSettings();
    await vi.advanceTimersByTimeAsync(0);

    expect(writes()).toEqual([
      ['target_power_mode', 'homey'], ['target_power', 1500],
      ['target_power', 0], ['target_power_mode', 'anti_feed'],
    ]);
    expect(device.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('hands back a claimed battery the owner opts out, after a failed first attempt is retried', async () => {
    const { device, owner, settings, writes, command } = setup();
    await command(-800);

    device.configureCapabilityBehavior('target_power', { onApiWrite: { accept: false } });
    settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    owner.applyControlSettings();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.get(CLAIM_KEY)).not.toBeNull();
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'refused', reason: 'control_disabled' });

    device.clearCapabilityBehavior('target_power');
    vi.setSystemTime(Date.now() + 60_000);
    owner.onSnapshotCommitted({ entries: [] });
    await vi.advanceTimersByTimeAsync(0);

    expect(writes().slice(-2)).toEqual([['target_power', 0], ['target_power_mode', 'anti_feed']]);
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });
});
