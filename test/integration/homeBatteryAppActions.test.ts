// The transport half of a battery PELS drives through its app's Flow action
// cards: the battery control read (drivable only while every card is
// installed and the owner's Homey API key may run Flow actions), and the
// actuator's storage intents carried out as card runs on the shared key
// owner. The SDK seam is simulated; the key owner's runner is observed, so no
// HTTP leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Homey from 'homey';
import { createTestDeviceTransport, seedTransportDevices } from '../helpers/deviceTransportHarness';
import {
  buildHuaweiLuna2000Device, buildMarstekConnectorBatteryDevice, buildSigenergyDevices, buildZendureLocalBatteryDevice,
} from '../helpers/homeBatteryMock';
import { mockHomeyInstance, MockDriver, setMockDrivers, type MockDevice } from '../mocks/homey';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import type { HomeyFlowAction } from '../../lib/device/transport/homeyActionAccess';
import { HOMEY_FLOW_API_KEY } from '../../lib/device/transport/homeyActionAccess';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const homeyMock = mockHomeyInstance as unknown as Homey.App;
const noop = (): void => undefined;
const loggerMock: Logger = {
  log: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};
const MARSTEK_APP = 'homey:app:com.niewold.marstek';
const SIGENERGY_APP = 'homey:app:com.sigenergy';
const MARSTEK_CARDS = [`${MARSTEK_APP}:marstek_passive_mode`, `${MARSTEK_APP}:marstek_auto_mode`];
const SIGENERGY_CARDS = [
  'force_charge_from_grid', 'set_ess_max_discharge_power', 'set_remote_ems_control_mode', 'set_remote_ems',
  'remove_ess_charge_limit', 'remove_ess_discharge_limit',
].map((id) => `${SIGENERGY_APP}:${id}`);
const ZENDURE_APP = 'homey:app:com.tweakers.zendure';
const HUAWEI_APP = 'homey:app:com.huawei.fusionsolar';
const HUAWEI_CARDS = [
  'luna2000_start_force_charge_duration', 'luna2000_start_force_discharge_duration',
  'luna2000_stop_force_charge_discharge',
].map((id) => `${HUAWEI_APP}:${id}`);

type Setup = { transport: DeviceTransport; runs: () => Array<[string, HomeyFlowAction]> };

const setup = async (devices: MockDevice[], cards: readonly string[]): Promise<Setup> => {
  setMockDrivers({ batteries: new MockDriver('batteries', devices) });
  const original = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
    path === 'manager/flow/flowcardaction' ? cards.map((id) => ({ id })) : original(path)
  ));
  const transport = createTestDeviceTransport(homeyMock, loggerMock);
  await seedTransportDevices(transport, devices.map((device) => device.toHomeyApiDevice() as HomeyDeviceLike));
  await transport.batteryAppActions.refreshCards();
  const run = vi.spyOn(transport.chargingAccess, 'runAction').mockResolvedValue(undefined);
  return {
    transport,
    runs: () => run.mock.calls.map(([deviceId, action, purpose]) => {
      expect(purpose).toBe('home_battery');
      return [deviceId, action];
    }),
  };
};

describe('home battery app actions', () => {
  beforeEach(() => {
    setMockDrivers({});
    mockHomeyInstance.settings.set(HOMEY_FLOW_API_KEY, 'saved-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a Marstek with its cards and a saved key as drivable, its command kept alive', async () => {
    const { transport } = await setup([buildMarstekConnectorBatteryDevice({ id: 'venus' })], MARSTEK_CARDS);

    expect(transport.readBatteryControl('venus')).toEqual({
      kind: 'app_actions',
      range: { minW: -2500, maxW: 2500, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
      keepAlive: { kind: 'resend', everyMs: 150_000 },
    });
  });

  it('commands and hands back a Marstek through its app cards, in the app\'s sign', async () => {
    const { transport, runs } = await setup([buildMarstekConnectorBatteryDevice({ id: 'venus' })], MARSTEK_CARDS);

    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: 'venus', setpointW: 1500.4 }))
      .resolves.toEqual({ kind: 'written', setpointW: 1500 });
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'venus', handBack: 'app_actions' });

    expect(runs()).toEqual([
      ['venus', {
        ownerUri: MARSTEK_APP, cardId: `${MARSTEK_APP}:marstek_passive_mode`,
        args: { device: { id: 'venus' }, power: -1500, seconds: 300 },
      }],
      ['venus', { ownerUri: MARSTEK_APP, cardId: `${MARSTEK_APP}:marstek_auto_mode`, args: { device: { id: 'venus' } } }],
    ]);
  });

  it('only watches a battery whose app actions need a Homey API key none is saved for', async () => {
    mockHomeyInstance.settings.unset(HOMEY_FLOW_API_KEY);
    const { transport, runs } = await setup([buildMarstekConnectorBatteryDevice({ id: 'venus' })], MARSTEK_CARDS);

    expect(transport.readBatteryControl('venus')).toEqual({ kind: 'homey_api_key_missing' });
    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: 'venus', setpointW: 500 }))
      .rejects.toThrow();
    expect(runs()).toEqual([]);
  });

  it('fails closed on a missing card: the battery is observe-only and no card runs', async () => {
    const { transport, runs } = await setup(
      [buildMarstekConnectorBatteryDevice({ id: 'venus' })], [`${MARSTEK_APP}:marstek_passive_mode`],
    );

    expect(transport.readBatteryControl('venus')).toEqual({ kind: 'observe_only' });
    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: 'venus', setpointW: 500 }))
      .rejects.toThrow('unavailable');
    await expect(transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'venus', handBack: 'app_actions' }))
      .rejects.toThrow('unavailable');
    expect(runs()).toEqual([]);
  });

  it('reads a battery as not observed yet until the card inventory has been read', async () => {
    setMockDrivers({ batteries: new MockDriver('batteries', [buildMarstekConnectorBatteryDevice({ id: 'venus' })]) });
    const original = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/flow/flowcardaction') throw new Error('Homey busy');
      return original(path);
    });
    const transport = createTestDeviceTransport(homeyMock, loggerMock);
    await seedTransportDevices(transport, [buildMarstekConnectorBatteryDevice({ id: 'venus' }).toHomeyApiDevice() as HomeyDeviceLike]);
    await transport.batteryAppActions.refreshCards();

    expect(transport.readBatteryControl('venus')).toEqual({ kind: 'unobserved' });
  });

  it('refuses a claim-value hand-back for a battery driven through its app\'s actions', async () => {
    const { transport, runs } = await setup([buildMarstekConnectorBatteryDevice({ id: 'venus' })], MARSTEK_CARDS);

    await expect(transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'venus', restoreClaimValue: 'x' }))
      .rejects.toThrow('does not match');
    expect(runs()).toEqual([]);
  });

  it('drives a Sigenergy battery through its plant\'s cards, in kW, as an ordered sequence', async () => {
    const { battery, plant } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'plant' });
    const { transport, runs } = await setup([battery, plant], SIGENERGY_CARDS);

    expect(transport.readBatteryControl('sigen')).toEqual({
      kind: 'app_actions',
      range: { minW: -5000, maxW: 5000, stepW: 100, excludeMinW: 0, excludeMaxW: 0 },
      keepAlive: { kind: 'none' },
    });
    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: 'sigen', setpointW: -1234 }))
      .resolves.toEqual({ kind: 'written', setpointW: -1200 });
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'sigen', handBack: 'app_actions' });

    const plantCard = (actionId: string, args: Record<string, unknown> = {}): [string, HomeyFlowAction] => [
      'sigen', { ownerUri: SIGENERGY_APP, cardId: `${SIGENERGY_APP}:${actionId}`, args: { device: { id: 'plant' }, ...args } },
    ];
    expect(runs()).toEqual([
      plantCard('set_ess_max_discharge_power', { power: 1.2 }),
      plantCard('set_remote_ems_control_mode', { mode: '6' }),
      plantCard('set_remote_ems', { state: 'off' }),
      plantCard('remove_ess_charge_limit'),
      plantCard('remove_ess_discharge_limit'),
    ]);
  });

  it('stops a sequence at the step that failed', async () => {
    const { battery, plant } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'plant' });
    const { transport, runs } = await setup([battery, plant], SIGENERGY_CARDS);
    vi.mocked(transport.chargingAccess.runAction).mockRejectedValueOnce(new Error('plant offline'));

    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: 'sigen', setpointW: -1000 }))
      .rejects.toThrow('plant offline');
    expect(runs().map(([, action]) => action.cardId)).toEqual([`${SIGENERGY_APP}:set_ess_max_discharge_power`]);
  });

  it('only watches a Sigenergy battery whose plant is not in Homey', async () => {
    const { battery } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'plant' });
    const { transport } = await setup([battery], SIGENERGY_CARDS);

    expect(transport.readBatteryControl('sigen')).toEqual({ kind: 'observe_only' });
  });
  it('drives a local Zendure through set-power in the app\'s sign, held until the next command', async () => {
    const { transport, runs } = await setup([buildZendureLocalBatteryDevice({ id: 'zendure' })], [`${ZENDURE_APP}:set-power`]);

    expect(transport.readBatteryControl('zendure')).toEqual({
      kind: 'app_actions',
      range: { minW: -2400, maxW: 2400, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
      keepAlive: { kind: 'none' },
    });
    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: 'zendure', setpointW: 900 }))
      .resolves.toEqual({ kind: 'written', setpointW: 900 });
    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: 'zendure', setpointW: -3000 }))
      .resolves.toEqual({ kind: 'written', setpointW: -2400 });
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'zendure', handBack: 'app_actions' });

    const setPower = (power: number): [string, HomeyFlowAction] => [
      'zendure', { ownerUri: ZENDURE_APP, cardId: `${ZENDURE_APP}:set-power`, args: { device: { id: 'zendure' }, power } },
    ];
    expect(runs()).toEqual([setPower(-900), setPower(2400), setPower(0)]);
  });

  it('drives a LUNA2000 through forced runs kept alive at half their 10 minutes, and stops them to hand back', async () => {
    const battery = buildHuaweiLuna2000Device({ id: 'luna', maxChargePowerW: 5000, maxDischargePowerW: 4000 });
    const { transport, runs } = await setup([battery], HUAWEI_CARDS);

    expect(transport.readBatteryControl('luna')).toEqual({
      kind: 'app_actions',
      range: { minW: -4000, maxW: 5000, stepW: 100, excludeMinW: 0, excludeMaxW: 0 },
      keepAlive: { kind: 'resend', everyMs: 300_000 },
    });
    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: 'luna', setpointW: -1234 }))
      .resolves.toEqual({ kind: 'written', setpointW: -1200 });
    await expect(transport.requestStoragePower({ kind: 'storage_power', deviceId: 'luna', setpointW: 0 }))
      .resolves.toEqual({ kind: 'written', setpointW: 0 });
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'luna', handBack: 'app_actions' });

    const card = (actionId: string, args: Record<string, unknown> = {}): [string, HomeyFlowAction] => [
      'luna', { ownerUri: HUAWEI_APP, cardId: `${HUAWEI_APP}:${actionId}`, args: { device: { id: 'luna' }, ...args } },
    ];
    expect(runs()).toEqual([
      card('luna2000_start_force_discharge_duration', { power: 1200, duration: 10 }),
      card('luna2000_start_force_charge_duration', { power: 0, duration: 10 }),
      card('luna2000_stop_force_charge_discharge'),
    ]);
  });

  it('only watches a LUNA2000 whose max powers the app has not read yet, or without its stop card', async () => {
    const unread = await setup([buildHuaweiLuna2000Device({ id: 'luna', maxChargePowerW: 0 })], HUAWEI_CARDS);
    expect(unread.transport.readBatteryControl('luna')).toEqual({ kind: 'observe_only' });
    vi.restoreAllMocks();

    const noStop = await setup([buildHuaweiLuna2000Device({ id: 'luna' })], HUAWEI_CARDS.slice(0, 2));
    expect(noStop.transport.readBatteryControl('luna')).toEqual({ kind: 'observe_only' });
    await expect(noStop.transport.requestStoragePower({ kind: 'storage_power', deviceId: 'luna', setpointW: 500 }))
      .rejects.toThrow('unavailable');
    expect(noStop.runs()).toEqual([]);
  });
});
