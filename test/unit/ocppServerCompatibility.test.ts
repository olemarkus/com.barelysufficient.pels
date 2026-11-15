import { describe, expect, it } from 'vitest';
import { DeviceAdapterSessions, getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import type { HubHomeLocation } from '../../lib/device/hubHomeLocation';
import { resolveNativeTargetPowerLadder } from '../../lib/device/nativeSteppedLoadWiring';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { standardDeviceAdapter } from '../../lib/device/standardDeviceAdapter';
import { parseHomeyDevicePayload } from '../../lib/device/transport/homeyDevicePayload';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { partialDouble } from '../helpers/partialDouble';

const AT = '2026-11-15T10:00:00.000Z';
const CAPABILITIES = ['evcharger_charging', 'evcharger_charging_state', 'target_power', 'target_power_mode',
  'measure_current', 'meter_power', 'measure_power', 'measure_voltage'];

/** The app's `charger` as paired: `target_power` from 0 W to `max_current` on `phases`, in 1 A steps. */
const charger = (phases: unknown, maxCurrentA = 16): HomeyDeviceLike => {
  const wattsPerAmp = (phases === '1' ? 1 : 3) * 230;
  return {
    ...HOMEY_DEVICE_FIELDS, id: 'ocpp', name: 'Charger', class: 'evcharger',
    driverId: 'homey:app:com.dnetlabs.ocpp:charger', ownerUri: 'homey:app:com.dnetlabs.ocpp',
    settings: { ocpp_id: 'CP-1', phases, max_current: maxCurrentA, stop_behavior: 'stop', energy_exclude: false },
    capabilities: CAPABILITIES,
    capabilitiesObj: {
      evcharger_charging: { value: true, lastUpdated: AT, setable: true },
      evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: AT },
      target_power: { value: maxCurrentA * wattsPerAmp, lastUpdated: AT, setable: true,
        min: 0, max: maxCurrentA * wattsPerAmp, step: wattsPerAmp },
      target_power_mode: { value: 'homey', lastUpdated: AT, setable: true },
      measure_power: { value: 0, lastUpdated: AT },
    },
  };
};

const ladder = (device: HomeyDeviceLike) => {
  const overlay = getDeviceAdapter(device).overlay(device, device.capabilities, standardDeviceAdapter.observation(device));
  return resolveNativeTargetPowerLadder(overlay.capabilities, overlay.capabilityObj)?.steps
    .map((step) => step.planningPowerW);
};
const sessions = () => new DeviceAdapterSessions(partialDouble<HubHomeLocation>({}));

describe('OCPP Server charger', () => {
  it.each([
    { phases: '1', wattsPerAmp: 230 },
    { phases: '3', wattsPerAmp: 690 },
  ])('starts its native ladder at 6 A on $phases phase(s)', ({ phases, wattsPerAmp }) => {
    expect(ladder(charger(phases))).toEqual([
      0, ...Array.from({ length: 11 }, (_, index) => (index + 6) * wattsPerAmp),
    ]);
    expect(sessions().withholdCapabilities(charger(phases)).capabilities).toEqual(CAPABILITIES);
  });

  it('starts and stops through its own switch after preparing the limit', () => {
    const device = charger('3');
    expect(getDeviceAdapter(device).overlay(device, device.capabilities, standardDeviceAdapter.observation(device))).toMatchObject({
      kind: 'adapted', binaryTarget: { kind: 'canonical' },
      controlAdapter: { kind: 'capability_adapter', activationOrder: 'current_before_start' },
    });
  });

  it.each([undefined, '', '2', 'three', 0])('offers no native ladder with phases %s', (phases) => {
    const device = charger(phases);
    const parsed = sessions().withholdCapabilities(device);
    expect(parsed.capabilities).not.toContain('target_power');
    expect(parsed.capabilities).not.toContain('target_power_mode');
    expect(parsed.capabilitiesObj.target_power).toBeUndefined();
    expect(parsed.capabilities).toContain('evcharger_charging');
    expect(getDeviceAdapter(device).overlay(device, device.capabilities, standardDeviceAdapter.observation(device)).kind)
      .toBe('standard');
  });

  it('resolves a saved continuous range in whole amps from 6 A', () => {
    const device = charger('1');
    expect(getDeviceAdapter(device).configureTargetPower(device, { enabled: true, min: 0, max: 22080, step: 230 }))
      .toMatchObject({ min: 0, max: 16 * 230, step: 230, excludeMin: 0, excludeMax: 6 * 230 });
  });

  it('reads an empty switch as off, dated by the session state', () => {
    const device = charger('3');
    // As Homey's payload carries it, before any session: the boundary parse admits the null.
    const paired = (stateUpdated: string | null): HomeyDeviceLike => {
      const payload = parseHomeyDevicePayload({ ...device, capabilitiesObj: { ...device.capabilitiesObj,
        evcharger_charging: { value: null, lastUpdated: null, setable: true },
        evcharger_charging_state: { value: 'plugged_in', lastUpdated: stateUpdated } } });
      if (!payload) throw new Error('payload dropped');
      return payload;
    };
    const [read] = getDeviceAdapter(device).projectRead(paired(AT));
    expect(read?.capabilitiesObj.evcharger_charging).toEqual({ value: false, lastUpdated: AT, setable: true });
    expect(getDeviceAdapter(device).normalize(partialDouble({}), 'evcharger_charging', null, paired(AT)))
      .toEqual([{ capabilityId: 'evcharger_charging', value: false }]);
    expect(getDeviceAdapter(device).projectRead(paired(null))).toEqual([paired(null)]);
    expect(getDeviceAdapter(device).projectRead(device)).toEqual([device]);
  });

  it('leaves other drivers to the standard reading', () => {
    const other = { ...charger('3'), driverId: 'homey:app:com.dnetlabs.ocpp:other' };
    expect(getDeviceAdapter(other).overlay(other, other.capabilities, standardDeviceAdapter.observation(other)).kind).toBe('standard');
  });
});
