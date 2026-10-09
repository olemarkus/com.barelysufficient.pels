// The transport half of the actuator's storage intents, through the real
// device-write path down to the Homey Web API (`api.put`), against a battery
// served by the shared MockDevice. Only the SDK seam is simulated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Homey from 'homey';
import { createTestDeviceTransport, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { buildSetpointBatteryDevice } from '../helpers/homeBatteryMock';
import { mockHomeyInstance, MockDriver, setMockDrivers, type MockDevice } from '../mocks/homey';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';

const homeyMock = mockHomeyInstance as unknown as Homey.App;
const noop = (): void => undefined;
const loggerMock: Logger = {
  log: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};
const BATTERY = 'battery-1';

const setup = async (
  device: MockDevice,
): Promise<{ transport: DeviceTransport; writes: () => Array<[string, unknown]> }> => {
  setMockDrivers({ batteries: new MockDriver('batteries', [device]) });
  const transport = createTestDeviceTransport(homeyMock, loggerMock, {
    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
  });
  await seedTransportDevices(transport, [device.toHomeyApiDevice() as HomeyDeviceLike]);
  const put = vi.spyOn(mockHomeyInstance.api, 'put');
  const writes = (): Array<[string, unknown]> => put.mock.calls.map(([path, body]) => [
    path.replace(`manager/devices/device/${BATTERY}/capability/`, ''),
    (body as { value?: unknown } | undefined)?.value,
  ]);
  return { transport, writes };
};

describe('home battery storage writes', () => {
  beforeEach(() => {
    setMockDrivers({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('claims the battery for Homey before writing the setpoint, decided against the exclude band', async () => {
    const device = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed', excludeW: 1000 });
    const { transport, writes } = await setup(device);

    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: BATTERY, setpointW: 990 }))
      .resolves.toEqual({ kind: 'written', setpointW: 1000 });

    expect(writes()).toEqual([['target_power_mode', 'homey'], ['target_power', 1000]]);
    expect(device.getActualCapabilityValue('target_power')).toBe(1000);
  });

  it('writes only the setpoint to a battery that already reports Homey\'s claim', async () => {
    const { transport, writes } = await setup(buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'homey', stepW: 100 }));

    await transport.requestStoragePower({ kind: 'storage_power', deviceId: BATTERY, setpointW: -250 });
    await transport.requestStoragePower({ kind: 'storage_power', deviceId: BATTERY, setpointW: 600 });

    expect(writes()).toEqual([['target_power', -300], ['target_power', 600]]);
  });

  it('never writes a setpoint after a claim write the device refused, and says the claim was rejected', async () => {
    const device = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed' });
    device.configureCapabilityBehavior('target_power_mode', { onApiWrite: { accept: false } });
    const { transport, writes } = await setup(device);

    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: BATTERY, setpointW: 1500 }))
      .resolves.toEqual({ kind: 'claim_rejected', errorMessage: expect.stringContaining('rejected') });

    expect(writes()).toEqual([['target_power_mode', 'homey']]);
    expect(device.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
  });

  it('throws for a claim write that timed out: its outcome is unknown, not a rejection', async () => {
    const { transport } = await setup(buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed' }));
    vi.spyOn(mockHomeyInstance.api, 'put').mockRejectedValueOnce(new HomeyRequestTimeoutError('PUT', '/capability'));

    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: BATTERY, setpointW: 1500 }))
      .rejects.toThrow('timed out');
  });

  it('throws for a claim write whose connection reset: no answer is no rejection', async () => {
    const { transport } = await setup(buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed' }));
    vi.spyOn(mockHomeyInstance.api, 'put').mockRejectedValueOnce(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );

    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: BATTERY, setpointW: 1500 }))
      .rejects.toThrow('socket hang up');
  });

  it('hands the battery back: setpoint 0 first, then the recorded claim value', async () => {
    const device = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'homey', targetPowerW: -2000 });
    const { transport, writes } = await setup(device);

    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: BATTERY, restoreClaimValue: 'anti_feed' });

    expect(writes()).toEqual([['target_power', 0], ['target_power_mode', 'anti_feed']]);
    expect(device.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
  });

  it('restores the claim value even when the 0 W write failed, then reports the failure', async () => {
    const device = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'homey', targetPowerW: -2000 });
    device.configureCapabilityBehavior('target_power', { onApiWrite: { accept: false } });
    const { transport, writes } = await setup(device);

    await expect(transport.releaseStorageControl({
      kind: 'storage_release', deviceId: BATTERY, restoreClaimValue: 'anti_feed',
    })).rejects.toThrow();

    expect(writes()).toEqual([['target_power', 0], ['target_power_mode', 'anti_feed']]);
    expect(device.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
  });

  it('refuses a storage intent for a battery PELS can only observe', async () => {
    const device = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed' });
    device.setCapabilityMetadata('target_power', { setable: false, min: -2500, max: 2500, step: 1 });
    const { transport, writes } = await setup(device);

    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: BATTERY, setpointW: 500 }))
      .rejects.toThrow('observe-only (target_power_not_setable)');
    expect(writes()).toEqual([]);
  });
});
