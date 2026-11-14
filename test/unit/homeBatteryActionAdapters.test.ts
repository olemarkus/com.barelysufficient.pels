// The card mappings of the batteries PELS drives through their app's Flow
// actions: which cards each command and the hand-back run, their arguments,
// sign and units, as read from the vendor packages (each adapter's header).
import { describe, expect, it } from 'vitest';
import { getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import type { HomeBatteryActionBinding, HomeBatteryActions } from '../../lib/device/deviceAdapter';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const device = (id: string, driverId: string, settings: Record<string, unknown> = {}): HomeyDeviceLike => ({ ...HOMEY_DEVICE_FIELDS,
  id, name: id, class: driverId.endsWith(':plant') ? 'other' : 'battery', driverId, settings,
});

const actionBinding = (battery: HomeyDeviceLike): HomeBatteryActionBinding => {
  const binding = getDeviceAdapter(battery).homeBatteryBinding(battery);
  if (binding.kind !== 'app_actions') throw new Error(`${battery.driverId} has no app-action binding`);
  return binding;
};

const resolved = (battery: HomeyDeviceLike, devices: readonly HomeyDeviceLike[]): HomeBatteryActions => {
  const resolution = actionBinding(battery).resolve(battery, devices);
  if (resolution.kind !== 'resolved') throw new Error(`unavailable: ${resolution.reasonCode}`);
  return resolution.actions;
};

describe('Marstek Venus Connector binding', () => {
  const venus = device('venus', 'homey:app:com.niewold.marstek:marstek-venus');

  it('commands passive mode with the app\'s sign, negative charging, for the 300 s it declares', () => {
    const binding = actionBinding(venus);
    expect(binding.appUri).toBe('homey:app:com.niewold.marstek');
    for (const setpointW of [1200, -800, 0]) {
      expect(binding.commandLifetime(setpointW)).toEqual({ kind: 'expires', lifetimeMs: 300_000 });
    }
    const actions = resolved(venus, [venus]);
    expect(actions.range).toEqual({ minW: -2500, maxW: 2500, stepW: 1, excludeMinW: 0, excludeMaxW: 0 });
    expect(actions.command(1200)).toEqual([
      { deviceId: 'venus', actionId: 'marstek_passive_mode', args: { power: -1200, seconds: 300 } },
    ]);
    expect(actions.command(-800)).toEqual([
      { deviceId: 'venus', actionId: 'marstek_passive_mode', args: { power: 800, seconds: 300 } },
    ]);
    const [hold] = actions.command(0);
    expect(Object.is(hold?.args.power, 0)).toBe(true);
  });

  it('hands back to the battery\'s own Auto mode', () => {
    expect(actionBinding(venus).handBack(resolved(venus, [venus]).target, [venus])).toEqual([{ deviceId: 'venus', actionId: 'marstek_auto_mode', args: {} }]);
  });

  it('only watches the cloud and Bluetooth drivers, naming the local driver as the one PELS controls', () => {
    for (const driver of ['marstek-venus-cloud', 'marstek-venus-ble']) {
      const watched = device(driver, `homey:app:com.niewold.marstek:${driver}`);
      expect(getDeviceAdapter(watched).homeBatteryBinding(watched))
        .toEqual({ kind: 'watch_only', reason: 'controlled_through_local_device' });
    }
  });
});

describe('a battery whose driver Homey reports as a local id beside its app', () => {
  const split = (id: string, driverId: string, app: string): HomeyDeviceLike => ({
    ...device(id, driverId), ownerUri: `homey:app:${app}`,
  });

  it('selects the adapter as it does for a qualified driver id', () => {
    expect(actionBinding(split('zendure', 'zendure', 'com.tweakers.zendure')).appUri)
      .toBe('homey:app:com.tweakers.zendure');
    expect(actionBinding(split('venus', 'marstek-venus', 'com.niewold.marstek')).appUri)
      .toBe('homey:app:com.niewold.marstek');
    expect(actionBinding(split('luna', 'luna2000_modbus', 'com.huawei.fusionsolar')).appUri)
      .toBe('homey:app:com.huawei.fusionsolar');
  });

  it('finds the Sigenergy plant beside its battery', () => {
    const battery = split('sigen-battery', 'battery', 'com.sigenergy');
    const plant: HomeyDeviceLike = {
      ...split('sigen-plant', 'plant', 'com.sigenergy'),
      settings: { ratedChargingPower: '8 kW', ratedDischargingPower: '6.25 kW' },
    };
    expect(resolved(battery, [battery, plant]).command(2300)).toEqual([
      { deviceId: 'sigen-plant', actionId: 'force_charge_from_grid', args: { power: 2.3 } },
    ]);
  });

  it('rejects another app using the same local driver name', () => {
    const foreign = split('other', 'zendure', 'com.example.other');
    expect(getDeviceAdapter(foreign).homeBatteryBinding(foreign).kind).toBe('capability');
  });
});

describe('Sigenergy binding', () => {
  const battery = device('sigen-battery', 'homey:app:com.sigenergy:battery');
  const plant = device('sigen-plant', 'homey:app:com.sigenergy:plant', {
    ratedChargingPower: '8 kW', ratedDischargingPower: '6.25 kW',
  });

  it('runs every card on the plant, ranged by its rated powers on the cards\' 0.1 kW grid', () => {
    const actions = resolved(battery, [battery, plant]);
    for (const setpointW of [2300, -1500, 0]) {
      expect(actionBinding(battery).commandLifetime(setpointW)).toEqual({ kind: 'persistent' });
    }
    expect(actions.range).toEqual({ minW: -6200, maxW: 8000, stepW: 100, excludeMinW: 0, excludeMaxW: 0 });
  });

  it('charges with the app\'s force-charge card, in kW', () => {
    expect(resolved(battery, [battery, plant]).command(2300)).toEqual([
      { deviceId: 'sigen-plant', actionId: 'force_charge_from_grid', args: { power: 2.3 } },
    ]);
  });

  it('discharges by capping discharge in kW, then discharging battery first', () => {
    expect(resolved(battery, [battery, plant]).command(-1500)).toEqual([
      { deviceId: 'sigen-plant', actionId: 'set_ess_max_discharge_power', args: { power: 1.5 } },
      { deviceId: 'sigen-plant', actionId: 'set_remote_ems_control_mode', args: { mode: '6' } },
    ]);
  });

  it('holds at 0 W in Standby, and hands back with remote EMS off before clearing both limits', () => {
    const actions = resolved(battery, [battery, plant]);
    expect(actions.command(0)).toEqual([
      { deviceId: 'sigen-plant', actionId: 'set_remote_ems_control_mode', args: { mode: '1' } },
    ]);
    expect(actionBinding(battery).handBack(resolved(battery, [battery, plant]).target, [battery, plant])).toEqual([
      { deviceId: 'sigen-plant', actionId: 'set_remote_ems', args: { state: 'off' } },
      { deviceId: 'sigen-plant', actionId: 'remove_ess_charge_limit', args: {} },
      { deviceId: 'sigen-plant', actionId: 'remove_ess_discharge_limit', args: {} },
    ]);
  });

  it.each([
    { name: 'no plant', devices: [battery], reasonCode: 'plant_not_found' },
    { name: 'two plants', devices: [battery, plant, { ...plant, id: 'plant-2' }], reasonCode: 'plant_ambiguous' },
    { name: 'a second battery on the plant', devices: [battery, plant, { ...battery, id: 'b2' }], reasonCode: 'shared_plant' },
    {
      name: 'a plant whose rated power is not known yet',
      devices: [battery, { ...plant, settings: { ratedChargingPower: '', ratedDischargingPower: '6 kW' } }],
      reasonCode: 'plant_rated_power_unknown',
    },
  ])('is unavailable with $name', ({ devices, reasonCode }) => {
    expect(actionBinding(battery).resolve(battery, devices)).toEqual({ kind: 'unavailable', reasonCode });
  });
});

describe('Zendure local binding', () => {
  const zendure = device('zendure', 'homey:app:com.tweakers.zendure:zendure');

  it('commands set-power with the app\'s sign, positive discharging', () => {
    const binding = actionBinding(zendure);
    expect(binding.appUri).toBe('homey:app:com.tweakers.zendure');
    const actions = resolved(zendure, [zendure]);
    expect(actions.range).toEqual({ minW: -2400, maxW: 2400, stepW: 1, excludeMinW: 0, excludeMaxW: 0 });
    expect(actions.command(1200)).toEqual([{ deviceId: 'zendure', actionId: 'set-power', args: { power: -1200 } }]);
    expect(actions.command(-800)).toEqual([{ deviceId: 'zendure', actionId: 'set-power', args: { power: 800 } }]);
    const [hold] = actions.command(0);
    expect(Object.is(hold?.args.power, 0)).toBe(true);
  });

  it('lets a charge expire, which the app\'s idle poll drops, and holds a discharge and the 0 W hold', () => {
    const binding = actionBinding(zendure);
    expect(binding.commandLifetime(1200)).toEqual({ kind: 'expires', lifetimeMs: 90_000 });
    expect(binding.commandLifetime(1)).toEqual({ kind: 'expires', lifetimeMs: 90_000 });
    // The hold writes smartMode 0, a flash write: never repeated on a timer.
    expect(binding.commandLifetime(0)).toEqual({ kind: 'persistent' });
    expect(binding.commandLifetime(-800)).toEqual({ kind: 'persistent' });
  });

  it('hands back with the app\'s idle, set-power 0, its only control', () => {
    expect(actionBinding(zendure).handBack(resolved(zendure, [zendure]).target, [zendure])).toEqual([
      { deviceId: 'zendure', actionId: 'set-power', args: { power: 0 } },
    ]);
  });

  it('leaves the Zendure cloud app, which reports no battery power, on Homey\'s standard binding', () => {
    const cloud = device('hyper', 'homey:app:com.zendure.flow:hyper-2000');
    expect(getDeviceAdapter(cloud).homeBatteryBinding(cloud).kind).toBe('capability');
  });
});

describe('Huawei LUNA2000 Modbus binding', () => {
  const luna = device('luna', 'homey:app:com.huawei.fusionsolar:luna2000_modbus', {
    max_charge_power: 5000, max_discharge_power: 4550,
  });

  it('ranges by the battery\'s max powers on the cards\' 100 W grid, each run lasting 10 minutes', () => {
    const binding = actionBinding(luna);
    expect(binding.appUri).toBe('homey:app:com.huawei.fusionsolar');
    for (const setpointW of [2300, -1500, 0]) {
      expect(binding.commandLifetime(setpointW)).toEqual({ kind: 'expires', lifetimeMs: 600_000 });
    }
    expect(resolved(luna, [luna]).range).toEqual({ minW: -4500, maxW: 5000, stepW: 100, excludeMinW: 0, excludeMaxW: 0 });
  });

  it('charges, discharges and holds 0 W with forced runs in unsigned W for 10 minutes', () => {
    const actions = resolved(luna, [luna]);
    expect(actions.command(2300)).toEqual([
      { deviceId: 'luna', actionId: 'luna2000_start_force_charge_duration', args: { power: 2300, duration: 10 } },
    ]);
    expect(actions.command(-1500)).toEqual([
      { deviceId: 'luna', actionId: 'luna2000_start_force_discharge_duration', args: { power: 1500, duration: 10 } },
    ]);
    expect(actions.command(0)).toEqual([
      { deviceId: 'luna', actionId: 'luna2000_start_force_charge_duration', args: { power: 0, duration: 10 } },
    ]);
  });

  it('hands back by stopping the forced run', () => {
    expect(actionBinding(luna).handBack(resolved(luna, [luna]).target, [luna])).toEqual([
      { deviceId: 'luna', actionId: 'luna2000_stop_force_charge_discharge', args: {} },
    ]);
  });

  it.each([
    { name: 'no max powers read yet', settings: {} },
    { name: 'charging blocked at 0 W', settings: { max_charge_power: 0, max_discharge_power: 5000 } },
    { name: 'a max power below one step', settings: { max_charge_power: 5000, max_discharge_power: 50 } },
  ])('is unavailable with $name', ({ settings }) => {
    const battery = { ...luna, settings };
    expect(actionBinding(battery).resolve(battery, [battery])).toEqual({ kind: 'unavailable', reasonCode: 'max_power_unknown' });
  });

  it.each(['luna2000_emma_modbus', 'luna2000_openapi_fusionsolar'])('leaves the %s driver on Homey\'s standard binding', (driver) => {
    const other = device('other', `homey:app:com.huawei.fusionsolar:${driver}`);
    expect(getDeviceAdapter(other).homeBatteryBinding(other).kind).toBe('capability');
  });
});

describe('SolaX Modbus binding', () => {
  const battery = device('solax-battery', 'homey:app:com.msd.inverter.solax:solax_modbus_battery');
  const inverter = { ...device('solax-g4', 'homey:app:com.msd.inverter.solax:solax_modbus_g4'), class: 'solarpanel' };

  it('runs Push Power on the inverter the battery follows, for the 300 s timeout it declares', () => {
    const binding = actionBinding(battery);
    expect(binding.appUri).toBe('homey:app:com.msd.inverter.solax');
    for (const setpointW of [3000, -2500, 0]) {
      expect(binding.commandLifetime(setpointW)).toEqual({ kind: 'expires', lifetimeMs: 300_000 });
    }
    const actions = resolved(battery, [battery, inverter]);
    expect(actions.target).toEqual({ appUri: 'homey:app:com.msd.inverter.solax', deviceId: 'solax-g4' });
    expect(actions.range).toEqual({ minW: -30_000, maxW: 30_000, stepW: 1, excludeMinW: 0, excludeMaxW: 0 });
  });

  it('commands with the card\'s sign, positive charging, and holds at 0 W in Push Power', () => {
    const actions = resolved(battery, [battery, inverter]);
    expect(actions.command(3000)).toEqual([{
      deviceId: 'solax-g4', actionId: 'set_remote_control_power_ram_g4', args: { mode: '4', power: 3000, timeout: 300 },
    }]);
    expect(actions.command(-2500)).toEqual([{
      deviceId: 'solax-g4', actionId: 'set_remote_control_power_ram_g4', args: { mode: '4', power: -2500, timeout: 300 },
    }]);
    const [hold] = actions.command(0);
    expect(Object.is(hold?.args.power, 0)).toBe(true);
  });

  it.each([
    ['solax_modbus_g4_pro', 'g4_pro'],
    ['solax_modbus_x1_vast', 'x1_vast'],
    ['solax_modbus_x3_ies', 'x3_ies'],
    ['solax_modbus_x3_ultra', 'ultra'],
  ])('uses the %s inverter\'s own cards', (driverId, suffix) => {
    const other = { ...inverter, driverId: `homey:app:com.msd.inverter.solax:${driverId}` };
    const actions = resolved(battery, [battery, other]);
    expect(actions.command(1000)[0]?.actionId).toBe(`set_remote_control_power_ram_${suffix}`);
    expect(actionBinding(battery).handBack(actions.target, [battery, other])).toEqual([
      { deviceId: 'solax-g4', actionId: `disable_remote_control_ram_${suffix}`, args: {} },
    ]);
  });

  it('hands back by disabling remote control, returning the inverter to its own work mode', () => {
    expect(actionBinding(battery).handBack(resolved(battery, [battery, inverter]).target, [battery, inverter])).toEqual([
      { deviceId: 'solax-g4', actionId: 'disable_remote_control_ram_g4', args: {} },
    ]);
  });

  it('names no listed card for a hand-back whose inverter left the inventory, so the claim stays owed', () => {
    const target = { appUri: 'homey:app:com.msd.inverter.solax', deviceId: 'solax-g4' };
    expect(actionBinding(battery).handBack(target, [battery])).toEqual([
      { deviceId: 'solax-g4', actionId: 'disable_remote_control_ram', args: {} },
    ]);
  });

  it.each([
    { name: 'no inverter', devices: [battery], reasonCode: 'inverter_not_found' },
    { name: 'two inverters', devices: [battery, inverter, { ...inverter, id: 'g4-2' }], reasonCode: 'inverter_ambiguous' },
    { name: 'a second battery', devices: [battery, inverter, { ...battery, id: 'b2' }], reasonCode: 'battery_ambiguous' },
    {
      name: 'a G3 inverter, which has no remote control',
      devices: [battery, { ...inverter, driverId: 'homey:app:com.msd.inverter.solax:solax_modbus_g3' }],
      reasonCode: 'inverter_without_remote_control',
    },
  ])('is unavailable with $name', ({ devices, reasonCode }) => {
    expect(actionBinding(battery).resolve(battery, devices)).toEqual({ kind: 'unavailable', reasonCode });
  });
});
