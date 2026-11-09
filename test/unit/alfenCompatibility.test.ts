import { describe, expect, it } from 'vitest';
import { getDeviceAdapter, getSnapshotAdapter } from '../../lib/device/deviceAdapterRegistry';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { partialDouble } from '../helpers/partialDouble';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const capabilities = ['target_power', 'evcharger_charging', 'measure_current.stationlimit'];
const control = { kind: 'capability_adapter' as const, activationRequired: false, activationEnabled: true };
const sessions = { hasCarStopEvidence: () => false };

function charger(stationPhases: 1 | 3): HomeyDeviceLike {
  return { ...HOMEY_DEVICE_FIELDS,
    id: 'alfen', name: 'Alfen', driverId: 'homey:app:com.alfen:chargepoint', capabilities,
    capabilitiesObj: {
      'measure_voltage.l2': { value: stationPhases === 3 ? 230 : 0 },
      'measure_voltage.l3': { value: stationPhases === 3 ? 230 : 0 },
    },
  };
}

function snapshot(stationPhases: 1 | 3, planningPhases: 1 | 3, minimumA = 6): TransportDeviceSnapshot {
  const stationWatts = stationPhases * 230;
  const planningWatts = planningPhases * 230;
  return partialDouble<TransportDeviceSnapshot>({
    capabilities, controlAdapter: control,
    automaticPowerControl: { mode: 'manual', profile: { steps: [
      { id: 'off', planningPowerW: 0 },
      { id: `${6 * stationWatts}w`, planningPowerW: 6 * stationWatts },
      { id: `${7 * stationWatts}w`, planningPowerW: 7 * stationWatts },
    ] } },
    steppedLoadProfile: { steps: [
      { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
      { id: `${minimumA}a`, planningPowerW: minimumA * planningWatts, planningCurrentA: minimumA },
    ] },
  });
}

describe('Alfen station and car phase conversion', () => {
  it.each([[3, 1], [1, 3]] as const)(
    'resumes the %i-phase station at the same current as a step in the %i-phase car model',
    (stationPhases, planningPhases) => {
      const device = charger(stationPhases);
      const view = snapshot(stationPhases, planningPhases);
      const adapter = getSnapshotAdapter(view);
      const step = view.steppedLoadProfile!.steps[1]!;
      const command = { capabilityId: 'target_power', value: step.planningPowerW };
      expect(adapter).toBe(getDeviceAdapter(device));
      expect(adapter.switchWrite(view, { capabilityId: 'evcharger_charging', value: true }, sessions))
        .toEqual({ kind: 'write', write: adapter.stepCommand(device, step, command), readBackAsWritten: false });
      expect(adapter.stepCommand(device, step, command).value).toBe(6 * stationPhases * 230);
    },
  );

  it.each([1, 3] as const)(
    'uses the physical 6 A switch floor on %i phase(s), independently of a 10 A minimum',
    (stationPhases) => {
      const view = snapshot(stationPhases, stationPhases === 1 ? 3 : 1, 10);
      const adapter = getSnapshotAdapter(view);
      for (const currentA of [0, 5, 6, 8, 10]) {
        const watts = currentA * stationPhases * 230;
        const observedAt = '2026-11-07T08:00:00.000Z';
        const values: DeviceCapabilityMap = {
          ...charger(stationPhases).capabilitiesObj,
          target_power: { value: watts, lastUpdated: observedAt, setable: true },
          evcharger_charging: { value: false, lastUpdated: '2026-11-07T07:00:00.000Z' },
        };
        const overlay = adapter.overlay(charger(stationPhases), capabilities, values);
        const planningWatts = currentA * (stationPhases === 1 ? 3 : 1) * 230;
        const projected = { ...overlay.capabilityObj,
          target_power: { ...overlay.capabilityObj.target_power, value: planningWatts } };
        const full = adapter.finalizeObservation(control, capabilities, projected).evcharger_charging;
        expect(full).toMatchObject({ value: currentA >= 6, lastUpdated: observedAt });
        expect(adapter.observation({ ...charger(stationPhases), capabilitiesObj: values }).evcharger_charging)
          .toMatchObject(full!);
        expect(adapter.normalize(view, 'target_power', watts)).toEqual([
          { capabilityId: 'target_power', value: watts },
          { capabilityId: 'evcharger_charging', value: currentA >= 6 },
        ]);
      }
    },
  );

  it('keeps the app switch when the station limit is not writable', () => {
    const device = charger(3);
    const values = { ...device.capabilitiesObj,
      target_power: { value: 4140, setable: false, lastUpdated: '2026-11-07T08:00:00.000Z' },
      evcharger_charging: { value: false, lastUpdated: '2026-11-07T07:00:00.000Z' },
    };
    const adapter = getDeviceAdapter(device);
    expect(adapter.observation({ ...device, capabilitiesObj: values }).evcharger_charging)
      .toBe(values.evcharger_charging);
    expect(adapter.overlay(device, capabilities, values).capabilityObj.evcharger_charging)
      .toBe(values.evcharger_charging);
  });

  it('withholds the switch when a writable limit has no accepted reading', () => {
    const device = charger(3);
    const values = { ...device.capabilitiesObj,
      target_power: { setable: true },
      evcharger_charging: { value: false, lastUpdated: '2026-11-07T07:00:00.000Z' },
    };
    const adapter = getDeviceAdapter(device);
    expect(adapter.observation({ ...device, capabilitiesObj: values })).not.toHaveProperty('evcharger_charging');
    expect(adapter.overlay(device, capabilities, values).capabilityObj).not.toHaveProperty('evcharger_charging');
  });

  it('keeps an authored native-watt resume in station watts', () => {
    const view = snapshot(3, 1);
    view.steppedLoadProfile = { steps: [
      { id: 'off', planningPowerW: 0 }, { id: '6900w', planningPowerW: 6900 },
    ] };
    expect(getSnapshotAdapter(view).switchWrite(view,
      { capabilityId: 'evcharger_charging', value: true }, sessions)).toMatchObject({
      kind: 'write', write: { capabilityId: 'target_power', value: 6900 },
    });
  });

  it('grants no resume or inferred realtime switch without a physical native ladder', () => {
    const view = snapshot(3, 1);
    delete view.automaticPowerControl;
    const adapter = getSnapshotAdapter(view);
    expect(adapter.switchWrite(view, { capabilityId: 'evcharger_charging', value: true }, sessions))
      .toEqual({ kind: 'none' });
    expect(adapter.normalize(view, 'target_power', 4140)).toEqual([{ capabilityId: 'target_power', value: 4140 }]);
    expect(adapter.switchWrite(view, { capabilityId: 'evcharger_charging', value: false }, sessions))
      .toMatchObject({ kind: 'write', write: { capabilityId: 'target_power', value: 0 } });
  });
});
