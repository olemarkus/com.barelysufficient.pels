import { describe, expect, it } from 'vitest';
import { getCapabilityAdapter, getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import { plainDeviceAdapter } from '../../lib/device/standardDeviceAdapter';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const control = { kind: 'capability_adapter', activationRequired: false,
  activationAvailable: true, activationEnabled: true } as const;
const stamp = '2026-11-06T08:00:00.000Z';
const later = '2026-11-06T08:05:00.000Z';

const device = (driverId: string, capabilitiesObj: DeviceCapabilityMap, settings = {}): HomeyDeviceLike => ({
  id: 'charger', name: 'Charger', class: 'evcharger', driverId, settings,
  capabilities: Object.keys(capabilitiesObj), capabilitiesObj,
});

describe('Alfen official app (com.alfen)', () => {
  const values = (l2: number): DeviceCapabilityMap => ({
    target_power: { value: 4140, min: 0, max: 22080, step: 230, excludeMin: 0, excludeMax: 1380, setable: true },
    'measure_voltage.l2': { value: l2 },
    evcharger_charging: { value: false, lastUpdated: stamp },
  });

  it.each([[230, 690], [0, 230]])('rebuilds the ladder in the station\'s phase watts (L2 %i V)', (volts, step) => {
    const charger = device('homey:app:com.alfen:chargepoint', values(volts));
    const overlay = getDeviceAdapter(charger).overlay(charger, charger.capabilities!, values(volts));
    expect(overlay.capabilityObj.target_power).toMatchObject({
      step, min: 0, excludeMin: 0, excludeMax: 6 * step, max: Math.min(Math.floor(22080 / step) * step, 32 * step),
    });
  });

  it('reads the raw limit before projection and withholds the switch when that limit is unreadable', () => {
    const charger = device('homey:app:com.alfen:chargepoint', values(230));
    const adapter = getDeviceAdapter(charger);
    const raw = { ...values(230), target_power: { ...values(230).target_power, value: 4140, lastUpdated: later } };
    const overlay = adapter.overlay(charger, charger.capabilities!, raw);
    const read = adapter.finalizeObservation(control, charger.capabilities!, overlay.capabilityObj);
    expect(read.evcharger_charging).toMatchObject({ value: true, lastUpdated: later });
    const unreadable = { ...raw, target_power: { ...raw.target_power, value: null } };
    expect(adapter.overlay(charger, charger.capabilities!, unreadable).capabilityObj.evcharger_charging)
      .toBeUndefined();
  });

  it('leaves other drivers alone', () => {
    expect(getDeviceAdapter(device('homey:app:com.peblar:home', values(230)))).toBe(plainDeviceAdapter);
  });
});

describe.each([
  {
    app: 'Alfen Pro-line (Alfen.ProlineSingle)', driverId: 'homey:app:Alfen.ProlineSingle:alfen-ace',
    current: 'max_current', phases: (count: 1 | 3) => ({ charge_phases: { value: String(count) } }),
  },
  {
    app: 'Peblar (com.KyleMichiels.Peblar)', driverId: 'homey:app:com.KyleMichiels.Peblar:peblar_charger',
    current: 'peblar_charge_limit',
    phases: (count: 1 | 3) => ({ peblar_force_1_phase: { value: false },
      peblar_voltage_l2: { value: count === 3 ? 230 : 0 }, peblar_voltage_l3: { value: count === 3 ? 231 : 0 } }),
  },
])('$app', ({ driverId, current, phases }) => {
  const values = (count: 1 | 3, amps: unknown): DeviceCapabilityMap => ({
    [current]: { value: amps, min: 1, max: 16, setable: true, lastUpdated: later },
    evcharger_charging: { value: false, lastUpdated: stamp },
    ...phases(count),
  });

  it.each([1, 3] as const)('reports %i phase(s) and builds 6-16 A levels in its watts', (count) => {
    const charger = device(driverId, values(count, 10));
    const adapter = getDeviceAdapter(charger);
    expect(adapter.phaseReport(charger)).toEqual({
      kind: 'reported', preset: count === 1 ? 'ev_charger_1_phase' : 'ev_charger_3_phase',
    });
    const profile = adapter.nativeCurrentControls[0]!.automaticProfile(charger, values(count, 10));
    expect(profile?.steps.map((step) => step.planningPowerW))
      .toEqual([0, ...Array.from({ length: 11 }, (_, index) => (index + 6) * count * 230)]);
    expect(adapter.nativeCurrentControls[0]!.stepObservations(profile!, values(count, 5))).toEqual(['off']);
    expect(adapter.nativeCurrentControls[0]!.stepObservations(profile!, values(count, 10))).toEqual(['10a']);
  });

  it('reads the switch from the current, and leaves the app\'s switch when the current is unreadable', () => {
    const charger = device(driverId, values(3, 10));
    const adapter = getDeviceAdapter(charger);
    expect(adapter.finalizeObservation(control, charger.capabilities!, values(3, 6)).evcharger_charging)
      .toMatchObject({ value: true, lastUpdated: later });
    expect(adapter.finalizeObservation(control, charger.capabilities!, values(3, 5)).evcharger_charging)
      .toMatchObject({ value: false, lastUpdated: later });
    const unreadable = values(3, 'n/a');
    expect(adapter.finalizeObservation(control, charger.capabilities!, unreadable)).toBe(unreadable);
  });

  it('owns its current capability by itself, as a native write set is looked up', () => {
    expect(getCapabilityAdapter([current]).nativeCurrentControls[0]?.capabilityId).toBe(current);
  });
});

describe('Zappi (net.biseth.myenergi)', () => {
  it('reads the switch from the charge mode, not from whether a car draws', () => {
    const values: DeviceCapabilityMap = {
      onoff: { value: true, setable: true, lastUpdated: later },
      evcharger_charging: { value: false, lastUpdated: stamp },
      zappi_boost_mode: { value: 'Stop' },
    };
    const charger = device('homey:app:net.biseth.myenergi:zappi', values);
    const overlay = getDeviceAdapter(charger).overlay(charger, charger.capabilities!, values);
    expect(overlay.kind).toBe('adapted');
    expect(overlay.capabilityObj.evcharger_charging).toMatchObject({ value: true, lastUpdated: later });
  });
});

describe('Wallbox (nl.xseth.wallbox)', () => {
  const values = (status: string): DeviceCapabilityMap => ({
    status: { value: status, lastUpdated: later },
    evcharger_charging: { value: false, lastUpdated: stamp },
    measure_current: { value: 16, lastUpdated: later },
    locked: { value: false },
  });

  it.each([['Charging', true], ['Waiting', true], ['Paused', false], ['Locked', false]] as const)(
    'reads %s as switch %s, and the configured current as the charger\'s current', (status, on) => {
      const charger = device('homey:app:nl.xseth.wallbox:wallbox', values(status));
      const overlay = getDeviceAdapter(charger).overlay(charger, charger.capabilities!, values(status));
      expect(overlay.capabilityObj.evcharger_charging).toMatchObject({ value: on, lastUpdated: later });
      expect(overlay.capabilityObj.available_installation_current).toMatchObject({ value: 16, lastUpdated: later });
    },
  );

  it('sets the current through its app card, scoped to this charger', () => {
    const charger = device('homey:app:nl.xseth.wallbox:wallbox', values('Charging'));
    const [binding] = getDeviceAdapter(charger).currentBindings(charger);
    expect(binding).toMatchObject({ appUri: 'homey:app:nl.xseth.wallbox', actionId: 'change_ampere',
      scope: { kind: 'charger' }, current: { kind: 'action_only' } });
    expect(binding!.currentArguments(10)).toEqual({ ampere: 10 });
  });
});
