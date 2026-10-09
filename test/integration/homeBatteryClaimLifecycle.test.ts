// A battery claimed and handed back in one run through the real stack below
// the executor: the battery control owner, the device actuator and the device
// transport, down to the Homey Web API (`api.put`) against a MockDevice. Only
// the SDK seam is simulated; no realtime echo reaches the transport, so every
// decision is made against the snapshot as it was before PELS wrote.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Homey from 'homey';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { HomeBatteryControlOwner } from '../../lib/battery/batteryControlOwner';
import { BatteryManagedSettings } from '../../lib/battery/batteryControlSettings';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import { BATTERY_CONTROL_DEVICES, PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX } from '../../lib/utils/settingsKeys';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { buildSetpointBatteryDevice } from '../helpers/homeBatteryMock';
import { mockHomeyInstance, MockDriver, setMockDrivers } from '../mocks/homey';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import { captureLogger } from '../utils/loggerCapture';

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

const setup = async () => {
  const device = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed', targetPowerW: 0 });
  setMockDrivers({ batteries: new MockDriver('batteries', [device]) });
  const settings = mockHomeyInstance.settings;
  const managed = new BatteryManagedSettings(settings);
  // The app's managed filter: active, and asking the battery's Managed toggle.
  const transport: DeviceTransport = createTestDeviceTransport(homeyMock, loggerMock, {
    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
    getManaged: (deviceId: string) => managed.isManaged(deviceId),
    isManagedFilterActive: () => true,
  });
  await initWithLiveFeed(transport);
  await seedTransportDevices(transport, [device.toHomeyApiDevice() as HomeyDeviceLike]);
  const actuator = createDeviceActuator({
    canTurnOnDevice: () => false,
    resolveTemperatureTarget: (_deviceId, desired) => desired,
    requestBinaryControl: unusedWrite,
    requestTemperatureTarget: unusedWrite,
    requestSteppedLoadStep: unusedWrite,
    requestStoragePower: (command) => transport.requestStoragePower(command),
    releaseStorageControl: (command) => transport.releaseStorageControl(command),
  });
  const owner = new HomeBatteryControlOwner(
    settings,
    managed,
    actuator,
    (deviceId) => transport.readBatteryControl(deviceId),
    () => true,
    () => false,
    () => false,
  );
  const sdkPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put');
  const writes = (): Array<[string, unknown]> => put.mock.calls.map(([path, body]) => [
    path.replace(`manager/devices/device/${BATTERY}/capability/`, ''),
    (body as { value?: unknown } | undefined)?.value,
  ]);
  /** The executor's serialized claim-and-write path through the real actuator. */
  const command = async (setpointW: number) => {
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'admitted' });
    await owner.dispatchSetpoint(BATTERY, async () => {
      const outcome = await actuator.apply({ kind: 'storage_power', deviceId: BATTERY, setpointW });
      return outcome.requested && outcome.kind === 'storage_power' ? outcome.requestedSetpointW : 'skipped';
    });
  };
  return { device, owner, settings, writes, command, transport, put, sdkPut };
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

  it('finishes an in-flight claim before handing back an opted-out battery', async () => {
    const { device, owner, settings, writes, command, put, sdkPut } = await setup();
    let finish!: () => void;
    put.mockImplementationOnce(async (path, body) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return sdkPut(path, body);
    });
    const pending = command(1500);
    await vi.advanceTimersByTimeAsync(0);
    owner.setControlEnabled(BATTERY, false);
    finish();
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([
      ['target_power_mode', 'homey'], ['target_power', 1500],
      ['target_power', 0], ['target_power_mode', 'anti_feed'],
    ]);
    expect(device.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('hands back an opted-out battery whose claim echo never arrived: setpoint 0, then the pre-claim value', async () => {
    const { device, owner, settings, writes, command } = await setup();

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
    const { device, owner, settings, writes, command } = await setup();
    await command(-800);

    device.configureCapabilityBehavior('target_power', { onApiWrite: { accept: false } });
    settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    owner.applyControlSettings();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.get(CLAIM_KEY)).not.toBeNull();
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'refused', reason: 'control_disabled' });

    device.clearCapabilityBehavior('target_power');
    vi.setSystemTime(Date.now() + 60_000);
    owner.onSnapshotCommitted({ entries: [], ignoredReadIds: [] });
    await vi.advanceTimersByTimeAsync(0);

    expect(writes().slice(-2)).toEqual([['target_power', 0], ['target_power_mode', 'anti_feed']]);
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('keeps a battery turned Managed off on the realtime feed while its hand-back is pending', async () => {
    const { device, owner, settings, command, transport } = await setup();
    await command(-800);

    device.configureCapabilityBehavior('target_power', { onApiWrite: { accept: false } });
    settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    owner.applyControlSettings();
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.isManaged(BATTERY)).toBe(false);
    expect(settings.get(CLAIM_KEY)).not.toBeNull();

    // The owner changes the mode in the battery's own app: the snapshot must
    // see it, or the pending hand-back would act on a claim long gone.
    await emitCapability(BATTERY, 'target_power_mode', 'manual');
    expect(transport.getSnapshotByDeviceId(BATTERY)?.batteryClaim?.value).toBe('manual');
  });

  it('reads the battery app\'s stale echo of its own mode after the claim as no takeover', async () => {
    const { owner, writes, command } = await setup();
    await command(1500);

    // The battery's app read its mode early in a poll, before PELS's claim
    // landed, and writes it back at the end; its next poll reports the claim.
    vi.setSystemTime(Date.now() + 2_000);
    await emitCapability(BATTERY, 'target_power_mode', 'anti_feed');
    owner.onSnapshotCommitted({ entries: [], ignoredReadIds: [] });
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'refused', reason: 'claim_contested' });
    vi.setSystemTime(Date.now() + 5_000);
    await emitCapability(BATTERY, 'target_power_mode', 'homey');
    vi.setSystemTime(Date.now() + CONTROL_COMMAND_CONFIRMATION_MS);
    owner.onSnapshotCommitted({ entries: [], ignoredReadIds: [] });

    expect(owner.isManaged(BATTERY)).toBe(true);
    expect(owner.wasTakenOver(BATTERY)).toBe(false);
    await command(1200);
    expect(writes().at(-1)).toEqual(['target_power', 1200]);
  });

  it('reads a hand-back that landed but reported failure as handed back, not as a takeover', async () => {
    const { owner, settings, command, put, sdkPut } = await setup();
    await command(-800);
    vi.setSystemTime(Date.now() + CONTROL_COMMAND_CONFIRMATION_MS);

    // The restore lands on the battery, but its answer never comes back.
    put.mockImplementation(async (path, body) => {
      const answer = await sdkPut(path, body);
      if (path.endsWith('/target_power_mode')) throw new HomeyRequestTimeoutError('PUT', path);
      return answer;
    });
    expect(await owner.releaseClaim(BATTERY, 'idle')).toBe('not_released');
    expect(settings.get(CLAIM_KEY)).not.toBeNull();

    const logs = captureLogger('info');
    vi.setSystemTime(Date.now() + 1_000);
    await emitCapability(BATTERY, 'target_power_mode', 'anti_feed');
    owner.onSnapshotCommitted({ entries: [], ignoredReadIds: [] });

    expect(owner.isManaged(BATTERY)).toBe(true);
    expect(owner.wasTakenOver(BATTERY)).toBe(false);
    expect(settings.get(CLAIM_KEY)).toBeNull();
    expect(logs.findEvent('battery_control_released')).toMatchObject({
      deviceId: BATTERY, restoredClaimValue: 'anti_feed', recordRemoved: true,
    });
    logs.restore();
  });
});
