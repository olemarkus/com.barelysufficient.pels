// The transport half of a battery PELS drives through its app's Flow action
// cards: the battery control read (drivable only while every card is
// installed and the owner's Homey API key may run Flow actions), and the
// actuator's storage intents carried out as card runs on the shared key
// owner. The SDK seam is simulated; the key owner's runner is observed, so no
// HTTP leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Homey from 'homey';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { HomeBatteryControlOwner } from '../../lib/battery/batteryControlOwner';
import { BatteryManagedSettings } from '../../lib/battery/batteryControlSettings';
import { PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX } from '../../lib/utils/settingsKeys';

import { createTestDeviceTransport, seedTransportDevices } from '../helpers/deviceTransportHarness';
import {
  buildHuaweiLuna2000Device, buildMarstekConnectorBatteryDevice, buildSigenergyDevices, buildZendureLocalBatteryDevice,
} from '../helpers/homeBatteryMock';
import { mockHomeyInstance, MockDriver, setMockDrivers, type MockDevice } from '../mocks/homey';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import type { HomeyFlowAction } from '../../lib/device/transport/homeyActionAccess';
import { HOMEY_FLOW_API_KEY } from '../../lib/device/transport/homeyActionAccess';
import { CARD_INVENTORY_RETRY_MS } from '../../lib/device/homeBatteryAppActions';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import type { BatteryCommandKeepAlive } from '../../lib/ports/batteryControlOwner';

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

const MARSTEK_CONTROL = { kind: 'app_actions' as const, target: { appUri: MARSTEK_APP, deviceId: 'venus' } };
const SIGENERGY_CONTROL = { kind: 'app_actions' as const, target: { appUri: SIGENERGY_APP, deviceId: 'plant' } };
const ZENDURE_CONTROL = { kind: 'app_actions' as const, target: { appUri: ZENDURE_APP, deviceId: 'zendure' } };
const HUAWEI_CONTROL = { kind: 'app_actions' as const, target: { appUri: HUAWEI_APP, deviceId: 'luna' } };

type Setup = { transport: DeviceTransport; runs: () => Array<[string, HomeyFlowAction]> };

/** How a battery's charge, discharge and 0 W hold are each kept in force, in that order. */
const keepAlives = (transport: DeviceTransport, deviceId: string): BatteryCommandKeepAlive[] => {
  const control = transport.readBatteryControl(deviceId);
  if (control.kind !== 'app_actions') throw new Error(`${deviceId} reads ${control.kind}`);
  return [1000, -1000, 0].map((setpointW) => control.keepAliveFor(setpointW));
};

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

const claimOwner = (transport: DeviceTransport) => {
  const settings = mockHomeyInstance.settings;
  const actuator = createDeviceActuator({
    requestProductionControl: (command) => transport.requestProductionControl(command),
    canTurnOnDevice: (id) => transport.canTurnOnDevice(id),
    requestBinaryControl: (id, desired) => transport.requestBinaryControl(id, desired, async () => {
      throw new Error('Unexpected binary Flow in battery test');
    }),
    requestTemperatureTarget: (id, desired) => transport.requestTemperatureTarget(id, desired),
    resolveTemperatureTarget: (id, desired) => transport.resolveTemperatureTarget(id, desired),
    requestSteppedLoadStep: (command) => transport.requestSteppedLoadStep(command),
    requestStoragePower: (command) => transport.requestStoragePower(command),
    releaseStorageControl: (command) => transport.releaseStorageControl(command),
  });
  const owner = new HomeBatteryControlOwner(
    settings, new BatteryManagedSettings(settings), actuator,
    (id) => transport.readBatteryControl(id), () => true, () => false, () => false,
  );
  return { owner, actuator };
};

describe('home battery app actions', () => {
  beforeEach(() => {
    setMockDrivers({});
    mockHomeyInstance.settings.set(HOMEY_FLOW_API_KEY, 'saved-key');
    mockHomeyInstance.settings.unset(`${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}sigen`);
    mockHomeyInstance.settings.unset(`${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}venus`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a Marstek with its cards and a saved key as drivable, its command kept alive', async () => {
    const { transport } = await setup([buildMarstekConnectorBatteryDevice({ id: 'venus' })], MARSTEK_CARDS);

    expect(transport.readBatteryControl('venus')).toEqual({
      kind: 'app_actions',
      target: MARSTEK_CONTROL.target,
      range: { minW: -2500, maxW: 2500, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
      keepAliveFor: expect.any(Function),
    });
    // A third of the app's 300 s passive countdown, whatever the command.
    const resend = { kind: 'resend', everyMs: 100_000 };
    expect(keepAlives(transport, 'venus')).toEqual([resend, resend, resend]);
  });

  it('commands and hands back a Marstek through its app cards, in the app\'s sign', async () => {
    const { transport, runs } = await setup([buildMarstekConnectorBatteryDevice({ id: 'venus' })], MARSTEK_CARDS);

    await expect(transport.requestStoragePower({ kind: 'storage_power', control: MARSTEK_CONTROL, deviceId: 'venus', setpointW: 1500.4 }))
      .resolves.toEqual({ kind: 'written', setpointW: 1500 });
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'venus', handBack: 'app_actions', target: MARSTEK_CONTROL.target });

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
    await expect(transport.requestStoragePower({ kind: 'storage_power', control: MARSTEK_CONTROL, deviceId: 'venus', setpointW: 500 }))
      .rejects.toThrow();
    expect(runs()).toEqual([]);
  });

  it('keeps hand-back retryable after the saved key is denied permission', async () => {
    const { transport, runs } = await setup([buildMarstekConnectorBatteryDevice({ id: 'venus' })], MARSTEK_CARDS);
    await transport.requestStoragePower({ kind: 'storage_power', control: MARSTEK_CONTROL, deviceId: 'venus', setpointW: 500 });
    vi.spyOn(transport.chargingAccess, 'status').mockReturnValue({ configured: true, state: 'permission_denied' });
    expect(transport.readBatteryControl('venus')).toEqual({ kind: 'hand_back_only' });
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'venus', handBack: 'app_actions', target: MARSTEK_CONTROL.target });
    expect(runs().at(-1)?.[1].cardId).toBe(`${MARSTEK_APP}:marstek_auto_mode`);
  });

  it('rechecks denied access on device observations before admitting a normal command', async () => {
    const battery = buildMarstekConnectorBatteryDevice({ id: 'venus' });
    const { transport, runs } = await setup([battery], MARSTEK_CARDS);
    const status = vi.spyOn(transport.chargingAccess, 'status')
      .mockReturnValue({ configured: true, state: 'permission_denied' });
    let finish!: () => void;
    const check = vi.spyOn(transport.chargingAccess, 'check').mockImplementation(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      const ready = { configured: true, state: 'ready' as const };
      status.mockReturnValue(ready);
      return ready;
    });
    const { owner } = claimOwner(transport);
    transport.batteryAppActions.observeDevices([battery.toHomeyApiDevice() as HomeyDeviceLike], 1000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(owner.admitClaim('venus')).toEqual({ status: 'refused', reason: 'not_drivable' });
    expect(runs()).toEqual([]);

    const pending = transport.chargingAccess.retryDeniedAccess(1000);
    finish();
    await pending;
    expect(transport.readBatteryControl('venus').kind).toBe('app_actions');
    expect(owner.admitClaim('venus')).toEqual({ status: 'admitted' });
    expect(runs()).toEqual([]);
  });

  it('fails closed on a missing card: the battery is observe-only and no card runs', async () => {
    const { transport, runs } = await setup(
      [buildMarstekConnectorBatteryDevice({ id: 'venus' })], [`${MARSTEK_APP}:marstek_passive_mode`],
    );

    expect(transport.readBatteryControl('venus')).toEqual({ kind: 'observe_only' });
    await expect(transport.requestStoragePower({ kind: 'storage_power', control: MARSTEK_CONTROL, deviceId: 'venus', setpointW: 500 }))
      .rejects.toThrow('unavailable');
    await expect(transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'venus', handBack: 'app_actions', target: MARSTEK_CONTROL.target }))
      .rejects.toThrow('unavailable');
    expect(runs()).toEqual([]);
  });

  it('still hands back a battery whose command card is missing, and claims it no more', async () => {
    const { transport, runs } = await setup(
      [buildMarstekConnectorBatteryDevice({ id: 'venus' })], [`${MARSTEK_APP}:marstek_auto_mode`],
    );

    expect(transport.readBatteryControl('venus')).toEqual({ kind: 'hand_back_only' });
    await expect(transport.requestStoragePower({ kind: 'storage_power', control: MARSTEK_CONTROL, deviceId: 'venus', setpointW: 500 }))
      .rejects.toThrow('action_card_missing:marstek_passive_mode');
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'venus', handBack: 'app_actions', target: MARSTEK_CONTROL.target });

    expect(runs()).toEqual([
      ['venus', { ownerUri: MARSTEK_APP, cardId: `${MARSTEK_APP}:marstek_auto_mode`, args: { device: { id: 'venus' } } }],
    ]);
  });

  it('reads the card inventory again a minute after a read that lacked a bound battery\'s card', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const cards = [`${MARSTEK_APP}:marstek_auto_mode`];
      const battery = buildMarstekConnectorBatteryDevice({ id: 'venus' });
      const { transport } = await setup([battery], cards);
      const inventoryReads = () => vi.mocked(mockHomeyInstance.api.get).mock.calls
        .filter(([path]) => path === 'manager/flow/flowcardaction').length;
      expect(transport.readBatteryControl('venus')).toEqual({ kind: 'hand_back_only' });
      const readsBefore = inventoryReads();
      const raw = [battery.toHomeyApiDevice() as HomeyDeviceLike];

      transport.batteryAppActions.observeDevices(raw, Date.now() + CARD_INVENTORY_RETRY_MS - 1);
      expect(inventoryReads()).toBe(readsBefore);
      // The app finished starting: its passive-mode card is installed now.
      cards.push(`${MARSTEK_APP}:marstek_passive_mode`);
      transport.batteryAppActions.observeDevices(raw, Date.now() + CARD_INVENTORY_RETRY_MS);
      await vi.waitFor(() => expect(transport.readBatteryControl('venus')).toMatchObject({ kind: 'app_actions' }));
      expect(inventoryReads()).toBe(readsBefore + 1);
    } finally {
      vi.useRealTimers();
    }
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

    await expect(transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'venus', handBack: 'claim_capability', restoreClaimValue: 'x' }))
      .rejects.toThrow('does not match');
    expect(runs()).toEqual([]);
  });

  it('drives a Sigenergy battery through its plant\'s cards, in kW, as an ordered sequence', async () => {
    const { battery, plant } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'plant' });
    const { transport, runs } = await setup([battery, plant], SIGENERGY_CARDS);

    expect(transport.readBatteryControl('sigen')).toEqual({
      kind: 'app_actions',
      target: SIGENERGY_CONTROL.target,
      range: { minW: -5000, maxW: 5000, stepW: 100, excludeMinW: 0, excludeMaxW: 0 },
      keepAliveFor: expect.any(Function),
    });
    expect(keepAlives(transport, 'sigen')).toEqual([{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }]);
    await expect(transport.requestStoragePower({ kind: 'storage_power', control: SIGENERGY_CONTROL, deviceId: 'sigen', setpointW: -1234 }))
      .resolves.toEqual({ kind: 'written', setpointW: -1200 });
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'sigen', handBack: 'app_actions', target: SIGENERGY_CONTROL.target });

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

  it.each(['ratings', 'shared', 'ambiguous', 'missing', 'replacement'])('hands back the original Sigenergy plant after %s resolution degrades', async (failure) => {
    const { battery, plant } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'plant' });
    const { transport, runs } = await setup([battery, plant], SIGENERGY_CARDS);
    await transport.requestStoragePower({ kind: 'storage_power', control: SIGENERGY_CONTROL, deviceId: 'sigen', setpointW: -1000 });
    const batteryRaw = battery.toHomeyApiDevice() as HomeyDeviceLike;
    const plantRaw = plant.toHomeyApiDevice() as HomeyDeviceLike;
    const devices = [batteryRaw, plantRaw];
    if (failure === 'ratings') plantRaw.settings = {};
    if (failure === 'shared') devices.push({ ...batteryRaw, id: 'second-battery' });
    if (failure === 'ambiguous') devices.push({ ...plantRaw, id: 'second-plant' });
    if (failure === 'missing') devices.pop();
    if (failure === 'replacement') devices[1] = { ...plantRaw, id: 'replacement-plant' };
    await seedTransportDevices(transport, devices);

    await expect(transport.requestStoragePower({ kind: 'storage_power', control: SIGENERGY_CONTROL, deviceId: 'sigen', setpointW: 1000 }))
      .rejects.toThrow();
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'sigen', handBack: 'app_actions', target: SIGENERGY_CONTROL.target });
    expect(runs().at(-3)).toEqual(['sigen', {
      ownerUri: SIGENERGY_APP, cardId: `${SIGENERGY_APP}:set_remote_ems`,
      args: { device: { id: 'plant' }, state: 'off' },
    }]);
  });

  it.each([null, undefined, 'unreadable', 42])('retains the last card inventory after a malformed envelope: %s', async (raw) => {
    const { transport, runs } = await setup([buildMarstekConnectorBatteryDevice({ id: 'venus' })], MARSTEK_CARDS);
    await transport.requestStoragePower({ kind: 'storage_power', control: MARSTEK_CONTROL, deviceId: 'venus', setpointW: 500 });
    vi.mocked(mockHomeyInstance.api.get).mockResolvedValueOnce(raw);
    await transport.batteryAppActions.refreshCards();
    expect(transport.readBatteryControl('venus').kind).toBe('app_actions');
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'venus', handBack: 'app_actions', target: MARSTEK_CONTROL.target });
    expect(runs().at(-1)?.[1].cardId).toBe(`${MARSTEK_APP}:marstek_auto_mode`);
  });

  it('hands back the recorded Sigenergy plant after a full owner and transport restart with only a replacement plant', async () => {
    const { battery, plant } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'plant' });
    const first = await setup([battery, plant], SIGENERGY_CARDS);
    const { owner, actuator } = claimOwner(first.transport);
    await owner.dispatchSetpoint('sigen', async (control) => {
      expect(mockHomeyInstance.settings.get(`${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}sigen`))
        .toMatchObject({ target: SIGENERGY_CONTROL.target });
      const result = await actuator.apply({ kind: 'storage_power', deviceId: 'sigen', setpointW: -1000, control });
      return result.requested && result.kind === 'storage_power' ? result.requestedSetpointW : 'skipped';
    });
    vi.restoreAllMocks();
    const replacement = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'replacement' });
    const restarted = await setup([replacement.battery, replacement.plant], SIGENERGY_CARDS);
    const recovered = claimOwner(restarted.transport).owner;
    recovered.onSnapshotCommitted({ entries: [], ignoredReadIds: ['sigen'] });
    await vi.waitFor(() => expect(restarted.runs()).toHaveLength(3));
    expect(restarted.runs()[0]?.[1]).toEqual({
      ownerUri: SIGENERGY_APP, cardId: `${SIGENERGY_APP}:set_remote_ems`,
      args: { device: { id: 'plant' }, state: 'off' },
    });
    await vi.waitFor(() => expect(mockHomeyInstance.settings.get(`${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}sigen`)).toBeNull());
  });

  it.each(['unknown vendor rating', 'missing cleanup card'])('turns remote EMS off and retains cleanup for retry after %s', async (failure) => {
    const { battery, plant } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'plant' });
    const cards = [...SIGENERGY_CARDS];
    const { transport, runs } = await setup([battery, plant], cards);
    const { owner, actuator } = claimOwner(transport);
    const key = `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}sigen`;
    await owner.dispatchSetpoint('sigen', async (control) => {
      const result = await actuator.apply({ kind: 'storage_power', deviceId: 'sigen', setpointW: -1000, control });
      return result.requested && result.kind === 'storage_power' ? result.requestedSetpointW : 'skipped';
    });
    const plantRaw = plant.toHomeyApiDevice() as HomeyDeviceLike;
    await seedTransportDevices(transport, [battery.toHomeyApiDevice() as HomeyDeviceLike, { ...plantRaw, settings: {} }]);
    if (failure === 'missing cleanup card') {
      cards.splice(cards.indexOf(`${SIGENERGY_APP}:remove_ess_charge_limit`), 1);
      await transport.batteryAppActions.refreshCards();
    } else {
      vi.mocked(transport.chargingAccess.runAction).mockImplementation(async (_id, action) => {
        if (action.cardId.endsWith(':remove_ess_charge_limit')) throw new Error('Rated charging power not known yet');
      });
    }
    expect(transport.readBatteryControl('sigen')).toEqual({ kind: 'hand_back_only' });
    await expect(owner.releaseClaim('sigen', 'idle')).resolves.toBe('not_released');
    expect(runs()[2]?.[1]).toEqual({
      ownerUri: SIGENERGY_APP, cardId: `${SIGENERGY_APP}:set_remote_ems`,
      args: { device: { id: 'plant' }, state: 'off' },
    });
    expect(mockHomeyInstance.settings.get(key)).toMatchObject({ target: SIGENERGY_CONTROL.target });

    cards.splice(0, cards.length, ...SIGENERGY_CARDS);
    await transport.batteryAppActions.refreshCards();
    vi.mocked(transport.chargingAccess.runAction).mockResolvedValue(undefined);
    const removeKey = vi.fn();
    await expect(owner.handBackBeforeHomeyApiKeyRemoval(removeKey)).resolves.toBe('removed');
    expect(runs().slice(-3).map(([, action]) => action.cardId)).toEqual([
      `${SIGENERGY_APP}:set_remote_ems`, `${SIGENERGY_APP}:remove_ess_charge_limit`,
      `${SIGENERGY_APP}:remove_ess_discharge_limit`,
    ]);
    expect(mockHomeyInstance.settings.get(key)).toBeNull();
    expect(removeKey).toHaveBeenCalledTimes(1);
  });

  it('retains a legacy companion claim without guessing the plant from the current inventory', async () => {
    const { battery, plant } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'replacement' });
    const { transport, runs } = await setup([battery, plant], SIGENERGY_CARDS);
    const key = `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}sigen`;
    mockHomeyInstance.settings.set(key, { handBack: 'app_actions', claimedAtMs: 1 });
    const { owner } = claimOwner(transport);
    const removeKey = vi.fn();
    await expect(owner.handBackBeforeHomeyApiKeyRemoval(removeKey)).resolves.toBe('battery_held');
    expect(runs()).toEqual([]);
    expect(removeKey).not.toHaveBeenCalled();
    expect(mockHomeyInstance.settings.get(key)).toEqual({ handBack: 'app_actions', claimedAtMs: 1 });
  });

  it('hands back a legacy self-target claim through the adapter explicit legacy resolution', async () => {
    const { transport, runs } = await setup([buildMarstekConnectorBatteryDevice({ id: 'venus' })], MARSTEK_CARDS);
    const key = `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}venus`;
    mockHomeyInstance.settings.set(key, { handBack: 'app_actions', claimedAtMs: 1 });
    const { owner } = claimOwner(transport);
    owner.onSnapshotCommitted({ entries: [], ignoredReadIds: ['venus'] });
    await vi.waitFor(() => expect(mockHomeyInstance.settings.get(key)).toBeNull());
    expect(runs()[0]?.[1].cardId).toBe(`${MARSTEK_APP}:marstek_auto_mode`);
  });

  it('stops a sequence at the step that failed', async () => {
    const { battery, plant } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'plant' });
    const { transport, runs } = await setup([battery, plant], SIGENERGY_CARDS);
    vi.mocked(transport.chargingAccess.runAction).mockRejectedValueOnce(new Error('plant offline'));

    await expect(transport.requestStoragePower({ kind: 'storage_power', control: SIGENERGY_CONTROL, deviceId: 'sigen', setpointW: -1000 }))
      .rejects.toThrow('plant offline');
    expect(runs().map(([, action]) => action.cardId)).toEqual([`${SIGENERGY_APP}:set_ess_max_discharge_power`]);
  });

  it('waits to resolve a Sigenergy hand-back while its plant is not in Homey', async () => {
    const { battery } = buildSigenergyDevices({ batteryId: 'sigen', plantId: 'plant' });
    const { transport } = await setup([battery], SIGENERGY_CARDS);

    expect(transport.readBatteryControl('sigen')).toEqual({ kind: 'unobserved' });
  });
  it('drives a local Zendure through set-power in the app\'s sign, keeping only a charge alive', async () => {
    const { transport, runs } = await setup([buildZendureLocalBatteryDevice({ id: 'zendure' })], [`${ZENDURE_APP}:set-power`]);

    expect(transport.readBatteryControl('zendure')).toEqual({
      kind: 'app_actions',
      target: ZENDURE_CONTROL.target,
      range: { minW: -2400, maxW: 2400, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
      keepAliveFor: expect.any(Function),
    });
    // The app's idle poll drops a charge; a discharge and the 0 W hold stand until the next command.
    expect(keepAlives(transport, 'zendure')).toEqual([
      { kind: 'resend', everyMs: 30_000 }, { kind: 'none' }, { kind: 'none' },
    ]);
    await expect(transport.requestStoragePower({ kind: 'storage_power', control: ZENDURE_CONTROL, deviceId: 'zendure', setpointW: 900 }))
      .resolves.toEqual({ kind: 'written', setpointW: 900 });
    await expect(transport.requestStoragePower({ kind: 'storage_power', control: ZENDURE_CONTROL, deviceId: 'zendure', setpointW: -3000 }))
      .resolves.toEqual({ kind: 'written', setpointW: -2400 });
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'zendure', handBack: 'app_actions', target: ZENDURE_CONTROL.target });

    const setPower = (power: number): [string, HomeyFlowAction] => [
      'zendure', { ownerUri: ZENDURE_APP, cardId: `${ZENDURE_APP}:set-power`, args: { device: { id: 'zendure' }, power } },
    ];
    expect(runs()).toEqual([setPower(-900), setPower(2400), setPower(0)]);
  });

  it('drives a LUNA2000 through forced runs kept alive at a third of their 10 minutes, and stops them to hand back', async () => {
    const battery = buildHuaweiLuna2000Device({ id: 'luna', maxChargePowerW: 5000, maxDischargePowerW: 4000 });
    const { transport, runs } = await setup([battery], HUAWEI_CARDS);

    expect(transport.readBatteryControl('luna')).toEqual({
      kind: 'app_actions',
      target: HUAWEI_CONTROL.target,
      range: { minW: -4000, maxW: 5000, stepW: 100, excludeMinW: 0, excludeMaxW: 0 },
      keepAliveFor: expect.any(Function),
    });
    const resend = { kind: 'resend', everyMs: 200_000 };
    expect(keepAlives(transport, 'luna')).toEqual([resend, resend, resend]);
    await expect(transport.requestStoragePower({ kind: 'storage_power', control: HUAWEI_CONTROL, deviceId: 'luna', setpointW: -1234 }))
      .resolves.toEqual({ kind: 'written', setpointW: -1200 });
    await expect(transport.requestStoragePower({ kind: 'storage_power', control: HUAWEI_CONTROL, deviceId: 'luna', setpointW: 0 }))
      .resolves.toEqual({ kind: 'written', setpointW: 0 });
    await transport.releaseStorageControl({ kind: 'storage_release', deviceId: 'luna', handBack: 'app_actions', target: HUAWEI_CONTROL.target });

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
    expect(unread.transport.readBatteryControl('luna')).toEqual({ kind: 'hand_back_only' });
    vi.restoreAllMocks();

    const noStop = await setup([buildHuaweiLuna2000Device({ id: 'luna' })], HUAWEI_CARDS.slice(0, 2));
    expect(noStop.transport.readBatteryControl('luna')).toEqual({ kind: 'observe_only' });
    await expect(noStop.transport.requestStoragePower({ kind: 'storage_power', control: HUAWEI_CONTROL, deviceId: 'luna', setpointW: 500 }))
      .rejects.toThrow('unavailable');
    expect(noStop.runs()).toEqual([]);
  });
});
