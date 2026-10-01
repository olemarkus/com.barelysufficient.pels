import Homey from 'homey';
import { describe, expect, it, vi } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { createTestDeviceTransport, onObservedState } from '../helpers/deviceTransportHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { readRuntimeDevice } from '../../lib/planInput/runtimeDeviceRead';
import { readFlowDevices } from '../../lib/device/deviceFlowRead';
import { projectDeviceDescriptor } from '../../lib/device/deviceDescriptorProjection';
import { DeviceConfigurationStore } from '../../lib/device/deviceConfiguration';
import { projectObservedState } from '../../lib/device/observedStateProjection';
import { preserveNewerReportedStepObservation } from '../../lib/device/transport/reportedStepObservation';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { ObservedDeviceStateProjection } from '../../lib/observer/observedDeviceStateProjection';
import { decorateSnapshotWithDeviceControl } from '../../lib/planInput/deviceControlProjection';
import { buildSteppedSettleSnapshot } from '../../lib/observer/steppedSettleSnapshot';
import { syncSteppedCommands } from '../../lib/executor/syncSteppedCommands';
import { resolveSteppedCommandAttempt } from '../../lib/executor/steppedCommandAttempt';
import { steppedStoresForTest } from '../helpers/steppedStores';
import {
  buildTargetPowerReachabilityState, type TargetPowerConfigWithReachability,
} from '../../lib/device/targetPowerReachability';

const savedProfile: SteppedLoadProfile = {
  steps: [
    { id: 'Low', planningPowerW: 1250 },
    { id: 'Medium', planningPowerW: 1750 },
    { id: 'Max', planningPowerW: 3000 },
  ],
};

const heater = (): HomeyDeviceLike => ({
  id: 'heater',
  name: 'Connected 300',
  class: 'heater',
  driverId: 'homey:app:com.myuplink:hoiax',
  capabilities: ['measure_power', 'onoff', 'max_power_3000'],
  capabilitiesObj: {
    measure_power: { value: 1671, lastUpdated: '2026-09-30T08:00:00.000Z' },
    onoff: { value: true, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
    max_power_3000: { value: '2', setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
  },
  available: true,
  ready: true,
});

const logger: Logger = {
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: getLogger('devices'),
};

const transportForHeater = (nativeEnabled: boolean) => createTestDeviceTransport(
  mockHomeyInstance as unknown as Homey.App,
  logger,
  {
    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
    getDeviceControlProfile: () => savedProfile,
    getNativeEvWiringEnabled: () => nativeEnabled,
  },
);

describe('device owner control resolution', () => {
  it('uses the current descriptor ladder for Flow reads while an older observed profile remains', () => {
    const oldTransport = transportForHeater(false);
    const [previous] = oldTransport.parseDeviceListForTests([heater()]);
    const transport = transportForHeater(true);
    const [current] = transport.parseDeviceListForTests([heater()]);
    const [flow] = readFlowDevices([projectDeviceDescriptor(current)], () => projectObservedState(previous));
    const { store } = steppedStoresForTest();
    const decorated = decorateSnapshotWithDeviceControl(flow, store, false, false);

    expect(decorated.steppedLoadProfile).toEqual(current.steppedLoadProfile);
    expect(decorated.steppedLoadProfile).not.toEqual(savedProfile);
  });

  it('removes an observed Flow ladder after its owner disables stepped control', () => {
    const transport = transportForHeater(true);
    const [previous] = transport.parseDeviceListForTests([heater()]);
    const unconfiguredTransport = createTestDeviceTransport(
      mockHomeyInstance as unknown as Homey.App, logger,
      { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }) },
    );
    const [current] = unconfiguredTransport.parseDeviceListForTests([heater()]);
    const [flow] = readFlowDevices([projectDeviceDescriptor(current)], () => projectObservedState(previous));
    const { store } = steppedStoresForTest();
    const decorated = decorateSnapshotWithDeviceControl(flow, store, false, false);

    expect(decorated.controlModel).toBe(current.controlModel);
    expect(decorated).not.toHaveProperty('steppedLoadProfile');
  });

  it.each(['same preset', 'new phase count'] as const)(
    'retains confirmed EV capacity when merging newer telemetry under %s', (change) => {
      const baseConfig = { preset: 'ev_charger_1_phase' as const, max: 7360 };
      let config: TargetPowerConfigWithReachability = { ...baseConfig, reachability: buildTargetPowerReachabilityState({
        config: baseConfig, maxReachedPowerW: 6440,
      }) };
      const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger, {
        getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
        getDeviceTargetPowerConfig: () => config,
      });
      const device: HomeyDeviceLike = {
        id: 'charger', name: 'Native charger', class: 'evcharger',
        capabilities: ['measure_power', 'onoff', 'target_power', 'evcharger_charging_state'],
        capabilitiesObj: {
          measure_power: { value: 1380, lastUpdated: '2026-09-30T08:00:00.000Z' },
          onoff: { value: true, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
          target_power: { value: 1380, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
          evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: '2026-09-30T08:00:00.000Z' },
        },
        available: true, ready: true,
      };
      transport.setSnapshotForTests(transport.parseDeviceListForTests([device]));
      transport.injectCapabilityUpdateForTest('charger', 'target_power', 1380);
      const previous = transport.getSnapshotByDeviceId('charger')!;
      const nextDevice = { ...device, capabilitiesObj: { ...device.capabilitiesObj } };
      if (change === 'new phase count') {
        config = { preset: 'ev_charger_3_phase', max: 22080 };
        config = { ...config, reachability: buildTargetPowerReachabilityState({
          config, maxReachedPowerW: 19320,
        }) };
        nextDevice.capabilitiesObj.target_power = {
          value: 4140, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z',
        };
      }
      const next = transport.parseDeviceListForTests([nextDevice])[0];
      const acceptedBeforeMerge = projectObservedState(next);

      preserveNewerReportedStepObservation(previous, next);

      if (change === 'same preset') {
        expect(next.reportedStepId).toBe('6a');
        expect(next.reportedStepObservedAtMs).toBe(previous.reportedStepObservedAtMs);
        expect(next.steppedLoadProfile?.steps.at(-1)?.id).toBe('28a');
        expect(next.steppedLoadProfile?.steps.at(-1)?.planningPowerW).toBe(6440);
      } else {
        expect(projectObservedState(next)).toEqual(acceptedBeforeMerge);
        expect(next.reportedStepPowerW).toBe(4140);
      }
    },
  );

  it('preserves the native step event timestamp across unrelated power updates', () => {
    const transport = transportForHeater(true);
    transport.setSnapshotForTests(transport.parseDeviceListForTests([heater()]));
    const observer = new ObservedDeviceStateProjection();
    onObservedState(transport, (event) => observer.applyDelta(event));
    const nowMs = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    try {
      transport.injectCapabilityUpdateForTest('heater', 'max_power_3000', '2');
      clock.mockReturnValue(nowMs + 2000);
      transport.injectCapabilityUpdateForTest('heater', 'measure_power', 1600);

      expect(observer.getObservedState('heater')).toMatchObject({
        reportedStepId: 'medium', reportedStepObservedAtMs: nowMs,
      });
      const runtime = readRuntimeDevice(
        transport.deviceConfigurationStore.get('heater'), observer.getObservedState('heater'),
      );
      expect(buildSteppedSettleSnapshot([runtime!])[0]?.steppedCommandConfirmation).toEqual({
        state: 'observed', observedStepId: 'medium', observedAtMs: nowMs,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('confirms native feedback through Observer and runtime composition without reviving retries', () => {
    const transport = transportForHeater(true);
    transport.setSnapshotForTests(transport.parseDeviceListForTests([heater()]));
    const observer = new ObservedDeviceStateProjection();
    onObservedState(transport, (event) => observer.applyDelta(event));
    const { store } = steppedStoresForTest();
    const nowMs = Date.now();
    store.markDesiredStepIssued({ deviceId: 'heater', desiredStepId: 'medium', issuedAtMs: nowMs - 1000 });

    transport.injectCapabilityUpdateForTest('heater', 'max_power_3000', '2');
    const runtime = readRuntimeDevice(transport.deviceConfigurationStore.get('heater'), observer.getObservedState('heater'));
    expect(runtime).toBeDefined();
    const projected = decorateSnapshotWithDeviceControl(runtime!, store, false, false);
    expect(projected).toMatchObject({ reportedStepId: 'medium', selectedStepId: 'medium' });
    expect(projected).not.toHaveProperty('suggestedSteppedLoadProfile');
    const devices = buildSteppedSettleSnapshot([projected]);
    expect(devices[0]?.steppedCommandConfirmation).toMatchObject({ state: 'observed', observedStepId: 'medium' });
    syncSteppedCommands({ store, devices, nowMs });
    syncSteppedCommands({ store, devices, nowMs: nowMs + 30 * 60 * 1000 });

    const desired = store.getDesired('heater');
    expect(desired).toMatchObject({ stepId: 'medium', status: 'success', pending: false, retryCount: 0 });
    expect(resolveSteppedCommandAttempt({ requestedStepId: 'medium', lastDesiredStepId: desired?.stepId,
      steppedLoadProfile: projected.steppedLoadProfile!, stepCommandPending: desired?.pending,
      stepCommandStatus: desired?.status, nextStepCommandRetryAtMs: desired?.nextRetryAtMs,
      nowMs: nowMs + 30 * 60 * 1000 })).toBeNull();
  });

  it('publishes the active native ladder with its matching observation through the runtime configuration seam', () => {
    const transport = transportForHeater(true);
    const [snapshot] = transport.parseDeviceListForTests([heater()]);
    const configurations = new DeviceConfigurationStore();
    configurations.set(snapshot);
    const configuration = configurations.get('heater');
    const observed = projectObservedState(snapshot);

    expect(configuration?.controlModel).toBe('stepped_load');
    expect(configuration).toMatchObject({
      steppedLoadProfile: { steps: expect.arrayContaining([{ id: 'medium', planningPowerW: 1750 }]) },
    });
    expect(observed.reportedStepId).toBe('medium');
    expect(configuration).not.toHaveProperty('suggestedSteppedLoadProfile');
    expect(configuration).not.toHaveProperty('profiles');
    expect(configuration).not.toHaveProperty('nativeWriteCapabilities');
  });

  it('uses the saved Flow ladder only when native control is disabled', () => {
    const transport = transportForHeater(false);
    const parsed = transport.parseDeviceListForTests([heater()]);
    transport.setSnapshotForTests(parsed);

    expect(transport.deviceConfigurationStore.get('heater')).toMatchObject({
      controlModel: 'stepped_load', steppedLoadProfile: savedProfile,
    });
    expect(transport.reportSteppedLoadActualStep('heater', 'Medium')).toMatchObject({
      kind: 'accepted',
      profile: savedProfile,
      observation: { deviceId: 'heater', stepId: 'Medium', planningPowerW: 1750 },
    });
    expect(transport.reportSteppedLoadActualStep('heater', 'medium')).toEqual({ kind: 'invalid' });
    expect(parsed[0].reportedStepId).toBe('Medium');
  });

  it('rejects Flow reports while native authority is active without changing accepted evidence', () => {
    const transport = transportForHeater(true);
    const parsed = transport.parseDeviceListForTests([heater()]);
    transport.setSnapshotForTests(parsed);
    const previous = projectObservedState(parsed[0]);

    expect(transport.reportSteppedLoadActualStep('heater', 'Medium', 1750)).toEqual({ kind: 'native_control' });
    expect(projectObservedState(parsed[0])).toEqual(previous);
  });

  it('leaves accepted Flow evidence and configuration untouched for malformed and stale reports', () => {
    const transport = transportForHeater(false);
    const parsed = transport.parseDeviceListForTests([heater()]);
    transport.setSnapshotForTests(parsed);
    expect(transport.reportSteppedLoadActualStep('heater', 'Medium')).toMatchObject({ kind: 'accepted' });
    const previous = projectObservedState(parsed[0]);
    const previousConfiguration = transport.deviceConfigurationStore.get('heater');

    expect(transport.reportSteppedLoadActualStep('heater', 'Medium', Number.NaN)).toEqual({ kind: 'invalid' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      expect(transport.reportSteppedLoadActualStep('heater', 'Low', 1250)).toEqual({ kind: 'unchanged' });
    } finally {
      clock.mockRestore();
    }
    expect(projectObservedState(parsed[0])).toEqual(previous);
    expect(transport.deviceConfigurationStore.get('heater')).toBe(previousConfiguration);
  });

  it('does not carry a Flow observation into a newly enabled native configuration', () => {
    const flowTransport = transportForHeater(false);
    const [previous] = flowTransport.parseDeviceListForTests([heater()]);
    flowTransport.setSnapshotForTests([previous]);
    flowTransport.reportSteppedLoadActualStep('heater', 'Low');
    const nativeTransport = transportForHeater(true);
    const [next] = nativeTransport.parseDeviceListForTests([heater()]);

    preserveNewerReportedStepObservation(previous, next);

    expect(next.reportedStepId).toBe('medium');
    expect(next.steppedLoadProfile?.steps.map((step) => step.id)).toEqual(['off', 'low', 'medium', 'max']);
  });

  it.each([
    ['inside the ladder', '16a', 3_600],
    ['just below the lowest rung', '6a', 1_320],
  ])('keeps a Flow EV report %s as its rung across a refresh', (_case, stepId, reportedW) => {
    // Cars draw a little under nominal, so the report card resolves such a
    // reading to the rung above it. A refresh re-parses the charger without
    // that report and must carry the admitted rung forward, not drop it.
    const baseConfig = { enabled: true, preset: 'ev_charger_1_phase' as const, max: 7_360 };
    const config: TargetPowerConfigWithReachability = { ...baseConfig, reachability: buildTargetPowerReachabilityState({
      config: baseConfig, maxReachedPowerW: 5_520,
    }) };
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger, {
      getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
      getDeviceTargetPowerConfig: () => config,
    });
    const charger: HomeyDeviceLike = {
      id: 'charger', name: 'Flow charger', class: 'evcharger',
      capabilities: ['measure_power', 'evcharger_charging', 'evcharger_charging_state'],
      capabilitiesObj: {
        measure_power: { value: reportedW, lastUpdated: '2026-09-30T08:00:00.000Z' },
        evcharger_charging: { value: true, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
        evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: '2026-09-30T08:00:00.000Z' },
      },
      available: true, ready: true,
    };
    const [previous] = transport.parseDeviceListForTests([charger]);
    transport.setSnapshotForTests([previous]);
    const ladder = previous.steppedLoadProfile;
    expect(transport.reportSteppedLoadActualStep('charger', stepId, reportedW)).toMatchObject({ kind: 'accepted' });
    const [next] = transport.parseDeviceListForTests([charger]);

    preserveNewerReportedStepObservation(previous, next);

    expect(next).toMatchObject({ reportedStepId: stepId, reportedStepPowerW: reportedW });
    expect(next.steppedLoadProfile).toEqual(ladder);
  });

  it('keeps a Flow EV report admitted just under an earlier off-grid step across a refresh', () => {
    // An exact off-grid reading puts its own step on the ladder; the next
    // reading a little under it is admitted as that step, and a refresh, whose
    // fresh ladder lacks the off-grid step, must still carry it forward.
    const baseConfig = { enabled: true, preset: 'ev_charger_1_phase' as const, max: 7_360 };
    const config: TargetPowerConfigWithReachability = { ...baseConfig, reachability: buildTargetPowerReachabilityState({
      config: baseConfig, maxReachedPowerW: 5_520,
    }) };
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger, {
      getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
      getDeviceTargetPowerConfig: () => config,
    });
    const charger: HomeyDeviceLike = {
      id: 'charger', name: 'Flow charger', class: 'evcharger',
      capabilities: ['measure_power', 'evcharger_charging', 'evcharger_charging_state'],
      capabilitiesObj: {
        measure_power: { value: 3_520, lastUpdated: '2026-09-30T08:00:00.000Z' },
        evcharger_charging: { value: true, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
        evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: '2026-09-30T08:00:00.000Z' },
      },
      available: true, ready: true,
    };
    const [first] = transport.parseDeviceListForTests([charger]);
    transport.setSnapshotForTests([first]);
    expect(transport.reportSteppedLoadActualStep('charger', '15.304a', 3_520)).toMatchObject({ kind: 'accepted' });
    const [second] = transport.parseDeviceListForTests([charger]);
    preserveNewerReportedStepObservation(first, second);
    expect(second.reportedStepId).toBe('15.304a');
    transport.setSnapshotForTests([second]);
    expect(transport.reportSteppedLoadActualStep('charger', '15.304a', 3_515)).toMatchObject({ kind: 'accepted' });
    const [third] = transport.parseDeviceListForTests([charger]);

    preserveNewerReportedStepObservation(second, third);

    expect(third).toMatchObject({ reportedStepId: '15.304a', reportedStepPowerW: 3_515 });
    expect(third.steppedLoadProfile?.steps.map((step) => step.id)).toContain('15.304a');
  });

  it('does not retain a step removed by a Flow profile edit', () => {
    const transport = transportForHeater(false);
    const [previous] = transport.parseDeviceListForTests([heater()]);
    transport.setSnapshotForTests([previous]);
    transport.reportSteppedLoadActualStep('heater', 'Medium');
    const next = {
      ...transport.parseDeviceListForTests([heater()])[0],
      steppedLoadProfile: { steps: [{ id: 'Low', planningPowerW: 1250 }] },
    };

    preserveNewerReportedStepObservation(previous, next);

    expect(next.reportedStepId).toBeUndefined();
    expect(next.reportedStepPowerW).toBeUndefined();
  });

  it('removes an observed ladder when the accepted configuration no longer has stepped control', () => {
    const transport = createTestDeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }) },
    );
    const [snapshot] = transport.parseDeviceListForTests([heater()]);
    transport.setSnapshotForTests([snapshot]);
    const oldTransport = transportForHeater(true);
    const [oldNative] = oldTransport.parseDeviceListForTests([heater()]);

    const runtime = readRuntimeDevice(transport.deviceConfigurationStore.get('heater'), projectObservedState(oldNative));

    expect(runtime?.controlModel).toBe('binary_power');
    expect(runtime).not.toHaveProperty('steppedLoadProfile');
  });

  it('keeps configuration and observations unchanged when a whole-device SDK update is malformed', () => {
    const transport = transportForHeater(true);
    const [snapshot] = transport.parseDeviceListForTests([heater()]);
    transport.setSnapshotForTests([snapshot]);
    const configuration = transport.deviceConfigurationStore.get('heater');
    const previous = projectObservedState(snapshot);

    transport.injectDeviceUpdateForTest({ ...heater(), capabilitiesObj: { onoff: { value: true } } });

    expect(transport.deviceConfigurationStore.get('heater')).toBe(configuration);
    expect(projectObservedState(snapshot)).toEqual(previous);
  });

  it('keeps Easee native feedback authoritative over an alternate installation-current source', () => {
    const transport = createTestDeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {
        getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
        getDeviceTargetPowerConfig: () => ({ preset: 'ev_charger_1_phase', max: 7360 }),
        getNativeEvWiringEnabled: () => true,
      },
    );
    const device: HomeyDeviceLike = {
      id: 'easee', name: 'Easee', class: 'evcharger', driverId: 'homey:app:no.easee:charger',
      capabilities: ['onoff', 'measure_power', 'target_charger_current', 'available_installation_current',
        'evcharger_charging', 'evcharger_charging_state'],
      capabilitiesObj: {
        onoff: { value: true, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
        measure_power: { value: 3600, lastUpdated: '2026-09-30T08:00:00.000Z' },
        target_charger_current: { value: 16, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
        available_installation_current: { value: 32, lastUpdated: '2026-09-30T08:00:00.000Z' },
        evcharger_charging: { value: true, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
        evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: '2026-09-30T08:00:00.000Z' },
      },
      available: true, ready: true,
    };
    const [snapshot] = transport.parseDeviceListForTests([device]);
    transport.setSnapshotForTests([snapshot]);
    const configuration = transport.deviceConfigurationStore.get('easee');

    transport.injectCapabilityUpdateForTest('easee', 'available_installation_current', 32);

    expect(snapshot.reportedStepId).toBe('16a');
    expect(transport.deviceConfigurationStore.get('easee')).toBe(configuration);
    transport.injectCapabilityUpdateForTest('easee', 'target_charger_current', 3);
    expect(snapshot.reportedStepId).toBe('off');
    expect(snapshot.reportedStepPowerW).toBe(0);
  });

  it('admits exact EV feedback through the owner and publishes the extended confirmed ladder before notifications', () => {
    const notifiedProfiles: SteppedLoadProfile[] = [];
    const transport = createTestDeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      logger,
      {
        getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
        getDeviceTargetPowerConfig: () => ({ preset: 'ev_charger_1_phase', max: 7360 }),
      },
      undefined,
      { onSnapshotMutated: (snapshot) => {
        const configuration = transport.deviceConfigurationStore.get(snapshot.id);
        if (configuration?.controlModel === 'stepped_load') notifiedProfiles.push(configuration.steppedLoadProfile);
      } },
    );
    const device: HomeyDeviceLike = {
      id: 'charger', name: 'Flow charger', class: 'evcharger',
      capabilities: ['measure_power', 'onoff', 'evcharger_charging_state'],
      capabilitiesObj: {
        measure_power: { value: 1380, lastUpdated: '2026-09-30T08:00:00.000Z' },
        onoff: { value: true, setable: true, lastUpdated: '2026-09-30T08:00:00.000Z' },
        evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: '2026-09-30T08:00:00.000Z' },
      },
      available: true, ready: true,
    };
    transport.setSnapshotForTests(transport.parseDeviceListForTests([device]));

    const result = transport.reportSteppedLoadActualStep('charger', '25a', 5750);

    expect(result).toMatchObject({ kind: 'accepted', observation: { stepId: '25a', planningPowerW: 5750 } });
    expect(notifiedProfiles.at(-1)).toMatchObject({
      steps: expect.arrayContaining([
        { id: '24a', planningPowerW: 5520, planningCurrentA: 24 },
        { id: '25a', planningPowerW: 5750, planningCurrentA: 25 },
      ]),
    });
    expect(transport.reportSteppedLoadActualStep('charger', '25a', 5980)).toEqual({ kind: 'invalid' });
    expect(transport.reportSteppedLoadActualStep('charger', '33a')).toEqual({ kind: 'invalid' });
  });
});
