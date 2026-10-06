// A claim write the battery's app rejects, through the real stack below the
// planner: the executor's storage lane, the battery control owner, the device
// actuator and the device transport, down to the Homey Web API (`api.put`)
// against a MockDevice. A Sessy on its cloud login rejects every claim
// (nl.sessy `setControlStrategy`), so PELS only watches it; any other battery
// whose claim write fails is judged not responding and re-probed after its
// back-off. Only the SDK seam is simulated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Homey from 'homey';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { HomeBatteryControlOwner } from '../../lib/battery/batteryControlOwner';
import { BATTERY_WATCH_ONLY_MS } from '../../lib/battery/batteryWatchOnly';
import { BATTERY_REPROBE_BACKOFF_MS } from '../../lib/battery/batteryVerification';
import { BatteryManagedSettings } from '../../lib/battery/batteryControlSettings';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import { BatteryExecutor, VERIFICATION_MAX_WAIT_MS } from '../../lib/executor/batteryExecutor';
import type { StorageDecidedDevice } from '../../lib/planContract/storageDecision';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { ExecutorDeviceReadDeps, ObserverDeviceRead } from '../../lib/executor/executorDeviceRead';
import { PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX } from '../../lib/utils/settingsKeys';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { createTestDeviceTransport } from '../helpers/deviceTransportHarness';
import { buildSessyBatteryDevice, buildSetpointBatteryDevice } from '../helpers/homeBatteryMock';
import { mockHomeyInstance, MockDriver, setMockDrivers, type MockDevice } from '../mocks/homey';
import { buildPlanDevice } from '../utils/planTestUtils';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

const homeyMock = mockHomeyInstance as unknown as Homey.App;
const noop = (): void => undefined;
const loggerMock: Logger = {
  log: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};
const BATTERY = 'battery-1';
const CLAIM_KEY = `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}${BATTERY}`;
const MINUTE_MS = 60_000;

const unusedWrite = (): Promise<never> => Promise.reject(new Error('Only storage intents in this spec'));

const setpoint = (setpointW: number): StorageDecidedDevice => ({
  ...buildPlanDevice({ id: BATTERY, name: 'Battery' }),
  storageDecision: { kind: 'setpoint', setpointW, stepW: 1 },
});

const setup = (device: MockDevice) => {
  setMockDrivers({ batteries: new MockDriver('batteries', [device]) });
  const settings = mockHomeyInstance.settings;
  const managed = new BatteryManagedSettings(settings);
  const transport: DeviceTransport = createTestDeviceTransport(homeyMock, loggerMock, {
    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
    getManaged: (deviceId: string) => managed.isManaged(deviceId),
    isManagedFilterActive: () => true,
  });
  const parse = (): void => {
    transport.setSnapshotForTests(transport.parseDeviceListForTests([device.toHomeyApiDevice() as HomeyDeviceLike]));
  };
  parse();
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
  const tracker: PowerTrackerState = { lastPowerW: 4000, lastTimestamp: Date.now() };
  // The battery reports nothing new after the claim: it is never driven.
  const power = { signedW: 0, observedAtMs: Date.now() - MINUTE_MS };
  // The observer's record of the battery; no managed load is metered.
  const devices: ExecutorDeviceReadDeps = {
    getDeviceConfiguration: () => undefined,
    getDeviceConfigurations: () => [],
    getObservedState: (deviceId) => ({ id: deviceId, batteryPower: power }) as ObserverDeviceRead,
  };
  const lane = new BatteryExecutor(
    owner,
    actuator,
    devices,
    () => tracker,
    { hasShedOrRestoreSince: () => false },
    vi.fn(),
  );
  const put = vi.spyOn(mockHomeyInstance.api, 'put');
  const writes = (): Array<[string, unknown]> => put.mock.calls.map(([path, body]) => [
    path.replace(`manager/devices/device/${BATTERY}/capability/`, ''),
    (body as { value?: unknown } | undefined)?.value,
  ]);
  /** One plan reading: the lane judges what is in flight, then converges the decision. */
  const reading = async (afterMs: number, setpointW: number): Promise<boolean> => {
    vi.advanceTimersByTime(afterMs);
    tracker.lastTimestamp = Date.now();
    lane.sync(Date.now());
    return lane.apply(setpoint(setpointW));
  };
  return { owner, lane, settings, writes, reading, parse };
};

describe('a battery whose app rejects PELS\'s claim', () => {
  let logs: LoggerCapture;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(Date.UTC(2026, 9, 6, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set('capacity_limit_kw', 10);
    logs = captureLogger('info');
  });

  afterEach(() => {
    logs.restore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('leaves a Sessy on its cloud login watch-only after the first rejection: no re-probe, one warning', async () => {
    const device = buildSessyBatteryDevice({ id: BATTERY, strategy: 'POWER_STRATEGY_NOM' });
    // nl.sessy `setControlStrategy` throws unless the device uses its local login.
    device.configureCapabilityBehavior('control_strategy', { onApiWrite: { accept: false } });
    const { owner, lane, settings, writes, reading } = setup(device);

    expect(await reading(0, -1500)).toBe(false);

    expect(writes()).toEqual([['control_strategy', 'POWER_STRATEGY_API']]);
    expect(owner.isWatchOnly(BATTERY)).toBe(true);
    // Still read, so its discharge counts against surplus devices, but never admissible.
    expect(owner.readControl(BATTERY)).toMatchObject({ kind: 'setpoint', admissible: false, claimHeld: false });
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'refused', reason: 'watch_only' });
    // The rejected write changed nothing: there is no claim to hand back.
    expect(settings.get(CLAIM_KEY)).toBeNull();
    expect(owner.isManaged(BATTERY)).toBe(true);
    expect(logs.findEvents('battery_control_claim_rejected_watch_only')).toEqual([expect.objectContaining({
      level: 40, // warn
      deviceId: BATTERY,
      claimCapabilityId: 'control_strategy',
      errorMessage: expect.stringContaining('rejected'),
      recordRemoved: true,
    })]);

    // Past the verification window and every re-probe back-off a not-responding
    // battery would wait out, PELS writes nothing more.
    for (const afterMs of [VERIFICATION_MAX_WAIT_MS, ...BATTERY_REPROBE_BACKOFF_MS, 2 * BATTERY_REPROBE_BACKOFF_MS[2]]) {
      expect(await reading(afterMs + MINUTE_MS, -1500)).toBe(false);
    }
    expect(lane.hasDrift(setpoint(-1500))).toBe(false);
    expect(writes()).toHaveLength(1);
    expect(logs.findEvents('battery_control_claim_rejected_watch_only')).toHaveLength(1);
    expect(logs.findEvent('battery_control_not_responding')).toBeUndefined();
  });

  it('lets the next claim decide again 6 h on: a Sessy still rejecting it is watch-only again', async () => {
    const device = buildSessyBatteryDevice({ id: BATTERY, strategy: 'POWER_STRATEGY_NOM' });
    device.configureCapabilityBehavior('control_strategy', { onApiWrite: { accept: false } });
    const { owner, writes, reading } = setup(device);
    await reading(0, -1500);
    expect(await reading(BATTERY_WATCH_ONLY_MS - MINUTE_MS, -1500)).toBe(false);
    expect(owner.isWatchOnly(BATTERY)).toBe(true);
    expect(writes()).toHaveLength(1);

    vi.advanceTimersByTime(MINUTE_MS);
    expect(owner.isWatchOnly(BATTERY)).toBe(false);
    expect(logs.findEvent('battery_control_watch_only_cleared')).toMatchObject({ deviceId: BATTERY, reason: 'expired' });
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'admitted' });

    expect(await reading(0, -1500)).toBe(false);
    expect(writes()).toEqual([['control_strategy', 'POWER_STRATEGY_API'], ['control_strategy', 'POWER_STRATEGY_API']]);
    expect(owner.isWatchOnly(BATTERY)).toBe(true);
    expect(logs.findEvents('battery_control_claim_rejected_watch_only')).toHaveLength(2);
  });

  it('gives a watch-only Sessy another claim once its control surface changes', async () => {
    const device = buildSessyBatteryDevice({ id: BATTERY, strategy: 'POWER_STRATEGY_NOM' });
    device.configureCapabilityBehavior('control_strategy', { onApiWrite: { accept: false } });
    const { owner, writes, reading, parse } = setup(device);
    await reading(0, -1500);
    expect(owner.isWatchOnly(BATTERY)).toBe(true);

    // An app update that declares the battery's range is another surface.
    device.setCapabilityMetadata('target_power', { setable: true, min: -2200, max: 2200, step: 1, units: 'W' });
    parse();

    expect(owner.isWatchOnly(BATTERY)).toBe(false);
    expect(logs.findEvent('battery_control_watch_only_cleared')).toMatchObject({
      deviceId: BATTERY, reason: 'control_surface_changed',
    });
    await reading(MINUTE_MS, -1500);
    expect(writes()).toEqual([['control_strategy', 'POWER_STRATEGY_API'], ['control_strategy', 'POWER_STRATEGY_API']]);
  });

  it('writes no claim to a Sessy already under Homey\'s claim, so a failing claim write never makes it watch-only', async () => {
    // A local-login Sessy PELS has been driving, whose dongle would fail a claim write.
    const device = buildSessyBatteryDevice({ id: BATTERY, strategy: 'POWER_STRATEGY_API' });
    vi.advanceTimersByTime(MINUTE_MS);
    mockHomeyInstance.settings.set(CLAIM_KEY, {
      capabilityId: 'control_strategy', previousValue: 'POWER_STRATEGY_NOM', claimedAtMs: Date.now(),
    });
    device.configureCapabilityBehavior('control_strategy', { onApiWrite: { accept: false } });
    const { owner, settings, writes, reading } = setup(device);

    expect(await reading(0, -1500)).toBe(true);
    expect(writes()).toEqual([['target_power', -1500]]);
    expect(owner.isWatchOnly(BATTERY)).toBe(false);
    expect(logs.findEvent('battery_control_claim_rejected_watch_only')).toBeUndefined();

    device.clearCapabilityBehavior('control_strategy');
    expect(await owner.releaseClaim(BATTERY, 'not_responding')).toBe('released');
    expect(writes().slice(-2)).toEqual([['target_power', 0], ['control_strategy', 'POWER_STRATEGY_NOM']]);
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('keeps a record made before a rejected claim, holds its hand-back while watch-only, then hands it back', async () => {
    const device = buildSessyBatteryDevice({ id: BATTERY, strategy: 'POWER_STRATEGY_NOM' });
    // Recorded after the battery last reported its strategy: no takeover.
    vi.advanceTimersByTime(MINUTE_MS);
    const record = { capabilityId: 'control_strategy', previousValue: 'POWER_STRATEGY_ROI', claimedAtMs: Date.now() };
    mockHomeyInstance.settings.set(CLAIM_KEY, record);
    device.configureCapabilityBehavior('control_strategy', { onApiWrite: { accept: false } });
    const { owner, settings, writes, reading } = setup(device);

    await reading(0, -1500);
    expect(owner.isWatchOnly(BATTERY)).toBe(true);
    expect(settings.get(CLAIM_KEY)).toEqual(record);
    expect(logs.findEvent('battery_control_claim_rejected_watch_only')).toMatchObject({ recordRemoved: false });

    // While watch-only its app refuses the hand-back as well: nothing is written or stopped.
    expect(await owner.releaseClaim(BATTERY, 'not_admissible')).toBe('not_released');
    expect(writes()).toHaveLength(1);
    expect(logs.findEvent('battery_control_release_failed')).toBeUndefined();

    vi.advanceTimersByTime(BATTERY_WATCH_ONLY_MS);
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'admitted' });
    device.clearCapabilityBehavior('control_strategy');
    expect(await owner.releaseClaim(BATTERY, 'not_admissible')).toBe('released');
    expect(writes().slice(-2)).toEqual([['target_power', 0], ['control_strategy', 'POWER_STRATEGY_ROI']]);
    expect(settings.get(CLAIM_KEY)).toBeNull();
  });

  it('judges any other battery whose claim write fails not responding, and re-probes it after the back-off', async () => {
    const device = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed' });
    device.configureCapabilityBehavior('target_power_mode', { onApiWrite: { accept: false } });
    const { owner, writes, reading } = setup(device);

    expect(await reading(0, -1500)).toBe(false);
    expect(writes()).toEqual([['target_power_mode', 'homey']]);
    expect(owner.isWatchOnly(BATTERY)).toBe(false);
    expect(logs.findEvent('battery_storage_setpoint_failed')).toMatchObject({ deviceId: BATTERY, failedWrite: 'claim' });

    // Past the verification window it is judged not responding and backs off.
    expect(await reading(VERIFICATION_MAX_WAIT_MS, -1500)).toBe(false);
    expect(owner.readControl(BATTERY)).toMatchObject({ kind: 'setpoint', verdict: 'not_responding' });
    expect(logs.findEvents('battery_control_not_responding')).toHaveLength(1);
    expect(writes()).toHaveLength(1);

    // When the first back-off ends it is re-probed: the claim goes out again.
    vi.advanceTimersByTime(BATTERY_REPROBE_BACKOFF_MS[0]);
    expect(owner.readControl(BATTERY)).toMatchObject({ kind: 'setpoint', verdict: 'reprobing' });
    await reading(0, -1500);
    expect(writes()).toEqual([['target_power_mode', 'homey'], ['target_power_mode', 'homey']]);
    expect(logs.findEvent('battery_control_claim_rejected_watch_only')).toBeUndefined();
  });
});
