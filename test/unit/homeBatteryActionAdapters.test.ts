// The card mappings of the batteries PELS drives through their app's Flow
// actions: which cards each command and the hand-back run, their arguments,
// sign and units, as read from the vendor packages (each adapter's header).
import { describe, expect, it } from 'vitest';
import { getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import type { HomeBatteryActionBinding, HomeBatteryActions } from '../../lib/device/deviceAdapter';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const device = (id: string, driverId: string, settings: Record<string, unknown> = {}): HomeyDeviceLike => ({
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
    expect(binding.commandLifetime).toEqual({ kind: 'expires', lifetimeMs: 300_000 });
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
    expect(resolved(venus, [venus]).handBack).toEqual([{ deviceId: 'venus', actionId: 'marstek_auto_mode', args: {} }]);
  });

  it('leaves the cloud driver on Homey\'s standard binding', () => {
    const cloud = device('cloud', 'homey:app:com.niewold.marstek:marstek-venus-cloud');
    expect(getDeviceAdapter(cloud).homeBatteryBinding(cloud).kind).toBe('capability');
  });
});

describe('Sigenergy binding', () => {
  const battery = device('sigen-battery', 'homey:app:com.sigenergy:battery');
  const plant = device('sigen-plant', 'homey:app:com.sigenergy:plant', {
    ratedChargingPower: '8 kW', ratedDischargingPower: '6.25 kW',
  });

  it('runs every card on the plant, ranged by its rated powers on the cards\' 0.1 kW grid', () => {
    const actions = resolved(battery, [battery, plant]);
    expect(actionBinding(battery).commandLifetime).toEqual({ kind: 'persistent' });
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

  it('holds at 0 W in Standby, and hands back with remote EMS off first, then both limits removed', () => {
    const actions = resolved(battery, [battery, plant]);
    expect(actions.command(0)).toEqual([
      { deviceId: 'sigen-plant', actionId: 'set_remote_ems_control_mode', args: { mode: '1' } },
    ]);
    expect(actions.handBack).toEqual([
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
