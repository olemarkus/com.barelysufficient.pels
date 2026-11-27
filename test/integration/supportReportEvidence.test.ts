import { describe, expect, it, vi } from 'vitest';
import type { PelsHost } from '../../lib/app/pelsHost';
import { SupportReportEvidenceSource } from '../../lib/diagnostics/supportReportEvidence';
import { createSupportReportReads, type SupportReportApp } from '../../setup/appInit/createSupportReports';
import { APP_MEMORY_REPORT_TITLE, readInstalledAppVersions, type InstalledAppVersions } from '../../lib/diagnostics/supportReportHomeyApps';
import { SUPPORT_REPORT_MAX_HOMEY_DEVICES, type CollectHomeyDeviceInventory } from '../../lib/diagnostics/homeyDeviceSupportSection';
import type { DailyBudgetDayPayload } from '../../packages/contracts/src/dailyBudgetTypes';
import type { SupportReportEvidence, SupportReportRequest } from '../../packages/contracts/src/supportReport';
import { pelsHostDouble } from '../helpers/pelsHostDouble';
import { partialDouble } from '../helpers/partialDouble';
import { deviceDiagnosticConfigurationFixture } from '../helpers/deviceDiagnosticConfigurationFixture';
import {
  REPORT_CAPTURE_MS as now, REPORT_HOUR_MS as hour, reportActivityFixture, reportHistoryFixture,
} from '../helpers/supportReportEvidenceFixtures';
import { transportSnapshotFixture } from '../utils/deviceSnapshotFixture';
import { buildPlanDevice, buildPlanMeta, buildSettingsUiPlanMeta } from '../utils/planTestUtils';
import { createDeviceEventStore } from '../../lib/diagnostics/deviceEventStore';
import {
  DAY_REPORT_OMITTED_LOG_EVENTS, SUPPORT_REPORT_MAX_DEVICE_EVENTS,
} from '../../lib/diagnostics/supportReportEvidence';
import { createLogTailStore } from '../../lib/diagnostics/logTailStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import type { CarLinkDiagnostics } from '../../lib/ports/carLinkDiagnostics';
import type { ObjectiveSettingsStore } from '../../lib/objectives/deferredObjectives/objectiveStore';
import type { SmartTaskCycleRecord } from '../../lib/objectives/deferredObjectives/smartTaskCycleRecord';
import type { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import type {
  DeferredObjectivePlanHistoryRecorder,
} from '../../lib/objectives/deferredObjectives/planHistory';
import type { DeferredObjectivePlanHistoryRecord } from '../../packages/contracts/src/deferredObjectivePlanHistory';
import type { ScheduleEntry, SchedulesSnapshot } from '../../packages/contracts/src/schedules';
import type { HeatingShadowCollector } from '../../lib/diagnostics/heatingShadowCollector';
import type { AppMemoryUsageSampler } from '../../lib/diagnostics/appMemoryFootprint';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { parseHomeyDevicePayload } from '../../lib/device/transport/homeyDevicePayload';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const request: SupportReportRequest = {
  subject: { kind: 'device', homeId: 'main', deviceId: 'heater' },
  problem: 'The heater did not resume.', expected: 'Resume when there is capacity.',
  occurredAtMs: now - hour, historyWindow: 'incident',
};
const capacity = {
  capacityEnabled: true, limitKw: 10, marginKw: 0.5, periodMinutes: 60 as const,
  gridImportLimitKw: 8, dryRun: false,
};
const deviceSnapshot = () => transportSnapshotFixture({
  id: 'heater', name: 'Hall heater now', available: true,
  expectedPowerKw: 1.8, expectedPowerSource: 'default',
  binaryControl: { on: true }, measuredPowerKw: 0.7, measuredPowerObservedAtMs: now - 5_000,
  lastUpdated: now - 5_000,
  targets: [{ id: 'target_temperature', value: 22, unit: '°C' }],
  temperature: { currentTemperature: 19, target: { id: 'target_temperature', value: 22, unit: '°C' } },
});
const membership = (homeId = 'main') => partialDouble<NonNullable<PelsHost['homeMembership']>>({
  isOwnershipReady: () => true, hasPendingOwnershipGeneration: () => false,
  getHomeIdForDevice: () => homeId,
});
const currentHost = (homeId = 'main') => pelsHostDouble({
  readDeviceDiagnosticConfiguration: vi.fn(deviceDiagnosticConfigurationFixture),
  homeMembership: membership(homeId),
  deviceManager: partialDouble<NonNullable<PelsHost['deviceManager']>>({
    getSnapshotByDeviceId: vi.fn((id: string) => id === 'heater' ? deviceSnapshot() : undefined),
    getUiPickerDevices: vi.fn(() => []),
  }),
  getDeviceLogUiPayload: vi.fn(() => reportHistoryFixture([reportActivityFixture()])),
  getLatestPlanSnapshotForUi: vi.fn(() => ({ generatedAtMs: now, meta: buildSettingsUiPlanMeta() })),
  getCapacityScalars: vi.fn(() => capacity),
  getPhaseReadingEvidence: vi.fn(() => ({ reading: { kind: 'none' as const }, meterCapabilityIds: [] })),
  getSettingsUiManagedDevices: vi.fn(() => []),
  refreshTargetDevicesSnapshot: vi.fn(async () => undefined),
});
// A settings store holding only the given smart tasks, keyed by device id.
const objectiveStore = (tasks: Record<string, unknown> = {}): ObjectiveSettingsStore => ({
  get: (key: string) => tasks[key.replace('deferred_objective.', '')],
  getKeys: () => ['capacity_limit_kw', ...Object.keys(tasks).map((id) => `deferred_objective.${id}`)],
  set: vi.fn(), unset: vi.fn(),
});
const fixtureInventory = (read: () => Promise<readonly HomeyDeviceLike[]>): CollectHomeyDeviceInventory => (
  async (collect) => collect((async function* devices() { yield* await read(); })())
);
const noCycle = () => undefined;
type HeatingObservations = Pick<HeatingShadowCollector, 'readDaily'>;
const noHeating: HeatingObservations = { readDaily: () => undefined };
// Homey's reading of the app, as its `/usage` route answers it.
const appUsage = { atMs: now, rssMb: 139.5, pssMb: 84.4, sharedCleanMb: 55.1, swapMb: 0 };
const appMemoryReading = (usage: typeof appUsage | null = appUsage) => partialDouble<AppMemoryUsageSampler>({
  refresh: async () => usage,
  latest: () => usage,
});
const noAppVersions = async (): Promise<InstalledAppVersions> => new Map();
const source = (
  app: SupportReportApp, objectives = objectiveStore(), readCycle: (deviceId: string) => SmartTaskCycleRecord | undefined = noCycle,
  heating: HeatingObservations = noHeating, appMemory = appMemoryReading(), readAppVersions = noAppVersions,
) => new SupportReportEvidenceSource(createSupportReportReads(app, objectives, readCycle, heating, appMemory, readAppVersions), {
  manifest: { version: '9.8.7-running-build' }, version: '12.4.1-running-homey',
});
const values = (report: SupportReportEvidence, title: string) => (
  report.sections.find((section) => section.title === title)?.values
);

describe('configured power source', () => {
  const meter = {
    ...HOMEY_DEVICE_FIELDS, id: 'meter', name: 'Main meter', ownerUri: 'homey:app:com.example.meter',
  };
  const settingsFor = (settings: Record<string, unknown>): ObjectiveSettingsStore => ({
    ...objectiveStore(), get: (key) => settings[key], getKeys: () => Object.keys(settings),
  });
  const energy = { power_source: 'homey_energy', homey_energy_meter_device_id: meter.id };

  it('identifies the selected meter outside the inventory limit with one inventory read', async () => {
    const host = currentHost();
    const devices = Array.from({ length: SUPPORT_REPORT_MAX_HOMEY_DEVICES }, (_, i) => ({
      ...meter, id: `other-${i}`,
    }));
    const readDevices = vi.fn(async () => [...devices, meter]);
    host.deviceManager.readDevicesForDiagnostics = fixtureInventory(readDevices);
    const report = await source(host, settingsFor(energy)).capture(request, now);

    expect(values(report, 'Current power source')).toEqual({
      scope: 'main', selection: 'chosen', source: 'homey_energy',
      meter: { state: 'resolved', deviceId: meter.id, name: meter.name, ownerUri: meter.ownerUri },
    });
    expect(values(report, 'Current Homey devices')).toMatchObject({ leftOut: 1 });
    expect(readDevices).toHaveBeenCalledOnce();
  });

  it('keeps the meter selection when the inventory cannot be read', async () => {
    const host = currentHost();
    host.deviceManager.readDevicesForDiagnostics = fixtureInventory(async () => { throw new Error('inventory unavailable'); });
    const report = await source(host, settingsFor(energy)).capture(request, now);

    expect(values(report, 'Current power source')).toEqual({
      scope: 'main', selection: 'chosen', source: 'homey_energy',
      meter: { state: 'resolved', deviceId: meter.id },
    });
    expect(report.omissions).toContain('Current Homey devices is unavailable.');
  });

  it.each([
    [{ power_source: 'flow', homey_energy_meter_device_id: meter.id }, { selection: 'chosen', source: 'flow' }],
    [{}, { selection: 'unset', source: 'flow' }],
    [{ power_source: null }, { selection: 'unavailable', reason: 'missing_existing_key' }],
    [{ power_source: 'homey_energy' }, { selection: 'chosen', source: 'homey_energy', meter: { state: 'unconfigured' } }],
    [{ ...energy, homey_energy_meter_device_id: null }, {
      selection: 'chosen', source: 'homey_energy', meter: { state: 'unavailable' },
    }],
  ] satisfies Array<[Record<string, unknown>, Record<string, unknown>]>)(
    'reports the power source for %j',
    async (settings, expected) => {
      const report = await source(currentHost(), settingsFor(settings)).capture(request, now);
      expect(values(report, 'Current power source')).toEqual({ scope: 'main', ...expected });
    },
  );
});

describe('app memory', () => {
  // Reports from many homes are compared on memory, so every kind of report
  // carries it, whatever its subject or trigger.
  it('states Homey\'s reading of the app and V8\'s heap in every report', async () => {
    const appRequest: SupportReportRequest = { ...request, subject: { kind: 'app', homeId: 'main' }, historyWindow: 'day' };
    for (const [req, trigger] of [[request, 'owner'], [appRequest, 'daily'], [appRequest, 'event']] as const) {
      const report = await source(currentHost()).capture(req, now, trigger);
      expect(values(report, APP_MEMORY_REPORT_TITLE)).toMatchObject({
        usage: { rssMb: 139.5, pssMb: 84.4, sharedCleanMb: 55.1, swapMb: 0, ageSec: expect.any(Number) },
        faults: { maxRssMb: expect.any(Number), minorFaults: expect.any(Number), majorFaults: expect.any(Number) },
        heap: { heapUsedMb: expect.any(Number), heapTotalMb: expect.any(Number), codeMb: expect.any(Number) },
      });
      expect(report.omissions).not.toContain('Homey\'s reading of the app\'s memory is unavailable.');
    }
  });

  it('keeps V8\'s view and says so when Homey has not answered', async () => {
    const report = await source(currentHost(), objectiveStore(), noCycle, noHeating, appMemoryReading(null))
      .capture(request, now);
    const memory = values(report, APP_MEMORY_REPORT_TITLE);
    expect(memory).toMatchObject({ heap: { heapUsedMb: expect.any(Number) } });
    expect(memory).not.toHaveProperty('usage');
    expect(report.omissions).toContain('Homey\'s reading of the app\'s memory is unavailable.');
  });
});

describe('daily heating observations', () => {
  const appRequest: SupportReportRequest = { ...request, subject: { kind: 'app', homeId: 'main' }, historyWindow: 'day' };

  it('reads the section only for an actual daily Main app report', async () => {
    const section = { title: 'Daily heating observations', values: { schemaVersion: 1, dateKey: '2026-10-22' } };
    const host = currentHost();
    const read = vi.fn(() => section);
    const capture = source(host, objectiveStore(), noCycle, { readDaily: read });
    expect(values(await capture.capture(appRequest, now, 'daily'), section.title)).toEqual(section.values);
    expect(read).toHaveBeenCalledExactlyOnceWith(now);
    read.mockClear();
    for (const trigger of ['owner', 'event'] as const) {
      expect(values(await capture.capture(appRequest, now, trigger), section.title)).toBeUndefined();
    }
    expect(values(await capture.capture(request, now, 'daily'), section.title)).toBeUndefined();
    const cabin = { ...appRequest, subject: { kind: 'app' as const, homeId: 'cabin' } };
    expect(values(await capture.capture(cabin, now, 'daily'), section.title)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('treats an empty passive history as normal and records only failed reads as omissions', async () => {
    const host = currentHost();
    expect((await source(host).capture(appRequest, now, 'daily')).omissions)
      .not.toContain('Daily heating observations is unavailable.');
    const failing = { readDaily: () => { throw new Error('private error'); } };
    const report = await source(host, objectiveStore(), noCycle, failing).capture(appRequest, now, 'daily');
    expect(report.omissions).toContain('Daily heating observations is unavailable.');
    expect(JSON.stringify(report)).not.toContain('private error');
  });
});

describe('meter response times', () => {
  const appRequest: SupportReportRequest = { ...request, subject: { kind: 'app', homeId: 'main' }, historyWindow: 'day' };
  const timing = {
    deviceId: 'heater', deviceName: 'Hall heater', direction: 'on' as const, samples: 5, medianResponseMs: 20_000,
    agreeing: 5, agreedResponseMs: 20_000, trusted: true, noChange: 1, medianResolutionMs: 10_000,
    medianAcceptedAfterMs: 600,
  };
  const withTimings = (readAll: () => (typeof timing)[]): SupportReportApp => {
    const host = currentHost();
    return {
      ...host,
      flowBacked: partialDouble<PelsHost['flowBacked']>({
        powerFigureChecks: host.flowBacked.powerFigureChecks,
        meterResponseTimings: partialDouble<PelsHost['flowBacked']['meterResponseTimings']>({ readAll }),
      }),
    };
  };

  it('lists each device direction in an app report, and states a failed read as an omission', async () => {
    const report = await source(withTimings(() => [timing])).capture(appRequest, now);
    expect(values(report, 'Meter response times')).toEqual({ devices: [timing] });
    const failed = await source(withTimings(() => { throw new Error('private error'); })).capture(appRequest, now);
    expect(failed.omissions).toContain('Meter response times is unavailable.');
    expect(JSON.stringify(failed)).not.toContain('private error');
  });
});

describe('support report evidence capture', () => {
  it('captures owner-resolved charging limits separately from observation steps at the capture time', async () => {
    const host = currentHost();
    const read = vi.fn(() => ({
      kind: 'limited' as const, source: 'confirmed_car' as const,
      selectedLimits: { minA: 16, maxA: 32 }, effectiveLimits: { minA: 16, maxA: 32 },
      plannerSteps: [{ id: '16a', planningPowerW: 6374, planningCurrentA: 16 }],
    }));
    host.deviceManager = partialDouble<NonNullable<PelsHost['deviceManager']>>({
      getSnapshotByDeviceId: () => ({ ...deviceSnapshot(), isEvCharger: true }),
      getEvChargingCurrentDiagnostics: read,
    });
    const report = await source(host).capture(request, now);
    expect(read).toHaveBeenCalledExactlyOnceWith('heater', now);
    expect(values(report, 'Current EV charging range')).toEqual({
      policy: 'limited', source: 'confirmed_car',
      selectedLimits: { minA: 16, maxA: 32 }, effectiveLimits: { minA: 16, maxA: 32 },
      plannerSteps: [{ id: '16a', planningPowerW: 6374, planningCurrentA: 16 }],
    });
  });

  it('omits inapplicable charging ranges and records failed reads without inventing a range', async () => {
    const host = currentHost();
    host.deviceManager = partialDouble<NonNullable<PelsHost['deviceManager']>>({
      getSnapshotByDeviceId: () => ({ ...deviceSnapshot(), isEvCharger: true }),
      getEvChargingCurrentDiagnostics: () => undefined,
    });
    const absent = await source(host).capture(request, now);
    expect(values(absent, 'Current EV charging range')).toBeUndefined();
    expect(absent.omissions).not.toContain('Current EV charging range is unavailable.');
    host.deviceManager.getEvChargingCurrentDiagnostics = () => { throw new Error('private read failure'); };
    const failed = await source(host).capture(request, now);
    expect(failed.omissions).toContain('Current EV charging range is unavailable.');
    expect(JSON.stringify(failed)).not.toContain('private read failure');
  });

  it('separates current observations, current plan, and retained incident activity without refreshes', async () => {
    const host = currentHost();
    const decision = buildPlanDevice({
      id: 'heater', currentState: 'on', plannedState: 'keep',
      priority: 2,
      reason: { code: 'capacity', shortfallKw: 0.6 },
      externalOffHoldActive: true,
      plannedShedTargetKind: 'target_value',
      currentTemperature: 18, currentTarget: 21, plannedTarget: 22,
    });
    host.planService = partialDouble<NonNullable<PelsHost['planService']>>({
      getLatestPlanSnapshot: () => ({ generatedAtMs: now, meta: buildPlanMeta(), devices: [decision], chargingPhaseDecisions: [], inverterDecisions: [], storageReleases: [] }),
    });
    const report = await source(host).capture(request, now);
    expect(report).toMatchObject({
      subjectName: 'Hall heater now', appVersion: '9.8.7-running-build', homeyVersion: '12.4.1-running-homey',
      activity: { state: 'available', entries: [{ atMs: now - hour, deviceName: 'Hall heater', stateKind: 'held' }] },
    });
    expect(values(report, 'Current device observation and configuration')).toMatchObject({
      expectedPowerKw: 1.8, measuredPowerKw: 0.7, measuredPowerObservedAtMs: now - 5_000,
      binaryOn: true, temperatureC: 19, targetTemperatureC: 22,
    });
    expect(values(report, 'Current device plan')).toMatchObject({
      currentState: 'on', plannedState: 'keep', currentTemperatureC: 18, currentTargetC: 21, plannedTargetC: 22,
      priority: 2, reasonDetails: { code: 'capacity', shortfallKw: 0.6 }, externalOffHoldActive: true,
      plannedShedTargetKind: 'target_value', planGeneratedAtMs: now,
    });
    expect(values(report, 'Current PELS device configuration')).toEqual({
      state: 'available', configuration: deviceDiagnosticConfigurationFixture(),
    });
    expect(values(report, 'Current limits settings')).toMatchObject({ hardCapKw: 10, gridImportLimitKw: 8 });
    expect(host.refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
    expect(host.getSettingsUiManagedDevices).not.toHaveBeenCalled();
    expect(host.deviceManager.getUiPickerDevices).not.toHaveBeenCalled();
  });

  it('states for each charger whether it follows solar and what PELS plans per amp beside its draw', async () => {
    const host = currentHost();
    const charger = transportSnapshotFixture({
      id: 'charger', name: 'Laadpaal', available: true, isEvCharger: true, targets: [],
      expectedPowerKw: 1.38, expectedPowerSource: 'default',
      measuredPowerKw: 1.84, measuredPowerObservedAtMs: now - 5_000, lastUpdated: now - 5_000,
      // A one-phase car on a charger PELS plans on three phases.
      chargerPhaseCurrentsA: [8, 0, 0],
      steppedLoadProfile: { steps: [
        { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
        { id: '6a', planningPowerW: 4_140, planningCurrentA: 6 },
        { id: '8a', planningPowerW: 5_520, planningCurrentA: 8 },
      ] },
    });
    host.deviceManager.getSnapshotByDeviceId = vi.fn((id: string) => (id === 'charger' ? charger : undefined));
    const decision = buildPlanDevice({
      id: 'charger', name: 'Laadpaal', isEvCharger: true, surplusTracking: true, reportedStepId: '8a',
    });
    host.planService = partialDouble<NonNullable<PelsHost['planService']>>({
      getLatestPlanSnapshot: () => ({ generatedAtMs: now, meta: buildPlanMeta(), devices: [decision], chargingPhaseDecisions: [], inverterDecisions: [], storageReleases: [] }),
    });
    const report = await source(host).capture({ ...request, subject: { kind: 'app', homeId: 'main' } }, now);
    expect(values(report, 'Current EV chargers')).toEqual({ chargers: [{
      id: 'charger', name: 'Laadpaal', chargeOnSolarSurplus: true, reportedStepId: '8a',
      plannedWattsPerAmp: 690, measuredPowerKw: 1.84, phaseCurrentsA: [8, 0, 0],
    }] });
  });

  it('keeps area configuration separate from an unavailable Main-only plan decision', async () => {
    const host = currentHost('cabin');
    const configuration = deviceDiagnosticConfigurationFixture();
    configuration.modes = { state: 'resolved', homeId: 'cabin', catalogHomeId: 'main', activeMode: 'Night', modes: [] };
    host.readDeviceDiagnosticConfiguration.mockReturnValue(configuration);
    const report = await source(host).capture({ ...request, subject: { kind: 'device', homeId: 'cabin', deviceId: 'heater' } }, now);
    expect(values(report, 'Current PELS device configuration')).toEqual({ state: 'available', configuration });
    expect(values(report, 'Current device plan')).toBeUndefined();
    expect(report.omissions).toContain('Current device plan is available for Main only.');
  });

  it('records a failed device configuration as an omission without leaking the error', async () => {
    const host = currentHost();
    host.readDeviceDiagnosticConfiguration.mockImplementation(() => { throw new Error('private error'); });
    const report = await source(host).capture(request, now);
    expect(values(report, 'Current PELS device configuration')).toBeUndefined();
    expect(report.omissions).toContain('Current PELS device configuration is unavailable.');
    expect(JSON.stringify(report)).not.toContain('private error');
  });

  it('resolves removed devices from retained names and rejects unknown device ids', async () => {
    const host = pelsHostDouble({
      deviceManager: partialDouble<NonNullable<PelsHost['deviceManager']>>({ getSnapshotByDeviceId: () => undefined }),
      getDeviceLogUiPayload: () => reportHistoryFixture([
        reportActivityFixture({ deviceName: 'Old heater', atMs: now - 2 * hour }),
        reportActivityFixture({ deviceName: 'Final heater name', atMs: now - hour }),
      ]),
    });
    const report = await source(host).capture(request, now);
    expect(report.subjectName).toBe('Final heater name');
    expect(report.activity.state).toBe('available');
    expect(report.omissions).toContain('Current device state is unavailable; its name comes from retained activity.');
    expect(values(report, 'Current device observation and configuration')).toBeUndefined();
    await expect(source(host).capture({
      ...request, subject: { kind: 'device', homeId: 'main', deviceId: 'unknown' },
    }, now)).rejects.toMatchObject({ code: 'invalid_subject' });
  });

  it('asks for another try while device transport is not running, and reads it once it is', async () => {
    const host = pelsHostDouble({ getDeviceLogUiPayload: () => reportHistoryFixture() });
    const startingSource = source(host);
    await expect(startingSource.capture(request, now)).rejects.toMatchObject({ code: 'capture_failed' });
    host.deviceManager = partialDouble<NonNullable<PelsHost['deviceManager']>>({
      getSnapshotByDeviceId: () => deviceSnapshot(),
    });
    host.homeMembership = membership();
    const report = await startingSource.capture(request, now);
    expect(report.subjectName).toBe('Hall heater now');
    expect(values(report, 'Current device observation and configuration')).toMatchObject({ measuredPowerKw: 0.7 });
  });

  it('retains the chosen Main incident when a device has moved and omits its other-home state', async () => {
    const host = currentHost('cabin');
    const report = await source(host).capture(request, now);
    expect(report.subjectName).toBe('Hall heater');
    expect(values(report, 'Current device observation and configuration')).toBeUndefined();
    expect(report.omissions).toContain('The device now belongs to another home; its current device details are omitted.');
    host.getDeviceLogUiPayload.mockReturnValue(reportHistoryFixture());
    await expect(source(host).capture(request, now)).rejects.toMatchObject({ code: 'invalid_subject' });
  });

  it('omits current device details while a new ownership generation is pending', async () => {
    const host = currentHost();
    host.homeMembership = partialDouble<NonNullable<PelsHost['homeMembership']>>({
      isOwnershipReady: () => true, hasPendingOwnershipGeneration: () => true,
      getHomeIdForDevice: vi.fn(() => 'main'),
    });
    const report = await source(host).capture(request, now);
    expect(values(report, 'Current device observation and configuration')).toBeUndefined();
    expect(host.homeMembership.getHomeIdForDevice).not.toHaveBeenCalled();
    expect(report.omissions).toContain('Current device home ownership is unavailable; current device details are omitted.');
  });

  it('uses only the selected area runtime and explicitly reports missing area history and budget', async () => {
    const host = currentHost('cabin');
    vi.spyOn(host.homeRuntimeRead, 'readHome').mockReturnValue({ state: 'resolved', reading: {
      homeId: 'cabin', plan: { generatedAtMs: now, meta: buildSettingsUiPlanMeta({ totalKw: 2 }), rescuableDeviceIds: [] },
      planUpdatedAtMs: now, powerTracker: {}, currentMonthCapacityPeak: { state: 'recorded', peakKw: 3, source: 'tracked' },
      diagnostics: {
        homeId: 'cabin', meterDeviceId: 'cabin-meter', operatingMode: 'Away', dryRunEffective: false,
        lastMeterPowerKw: 2, lastDeviceControlledMs: {}, capacityScalars: { ...capacity, limitKw: 4, followMonthPeak: false },
      },
    } });
    const report = await source(host).capture({
      ...request, subject: { kind: 'device', homeId: 'cabin', deviceId: 'heater' },
    }, now);
    expect(values(report, 'Current home plan')).toMatchObject({ powerKw: 2 });
    expect(values(report, 'Current limits settings')).toMatchObject({ hardCapKw: 4 });
    expect(values(report, 'Current power source')).toEqual({
      scope: 'area', source: 'area_meter', meter: { state: 'resolved', deviceId: 'cabin-meter' },
    });
    expect(values(report, 'Current daily budget')).toBeUndefined();
    expect(report.activity).toEqual({ state: 'unavailable', reason: 'Retained device activity is available only for Main.' });
    expect(host.getLatestPlanSnapshotForUi).not.toHaveBeenCalled();
    expect(host.getCapacityScalars).not.toHaveBeenCalled();
    expect(host.getDeviceLogUiPayload).not.toHaveBeenCalled();
    expect(host.homeRuntimeRead.readHome).toHaveBeenCalledExactlyOnceWith('cabin');
  });

  it('keeps unavailable areas scoped and preserves independently readable sections on failures', async () => {
    const host = currentHost();
    const report = await source(host).capture({ ...request, subject: { kind: 'app', homeId: 'cabin' } }, now);
    expect(report.subjectName).toBe('PELS');
    expect(values(report, 'Current home plan')).toBeUndefined();
    expect(values(report, 'Current limits settings')).toBeUndefined();
    expect(values(report, 'Current power source')).toEqual({ scope: 'area', selection: 'unavailable' });
    expect(host.getLatestPlanSnapshotForUi).not.toHaveBeenCalled();
    expect(host.getCapacityScalars).not.toHaveBeenCalled();
    host.getDeviceLogUiPayload.mockImplementation(() => { throw Error('private-history-error'); });
    host.getCapacityScalars.mockImplementation(() => { throw Error('private-settings-error'); });
    const main = await source(host).capture(request, now);
    expect(main.activity).toEqual({ state: 'unavailable', reason: 'Retained device activity could not be read.' });
    expect(values(main, 'Current device observation and configuration')).toMatchObject({ id: 'heater' });
    expect(values(main, 'Current home plan')).toBeDefined();
    expect(main.omissions).toContain('Current limits settings is unavailable.');
    expect(JSON.stringify(main)).not.toMatch(/private-history-error|private-settings-error/);
  });

  it('discloses only the explicit allowlist even if owner objects carry credentials or raw payloads', async () => {
    const host = currentHost();
    const device = {
      ...deviceSnapshot(), password: 'device-secret', data: { key: 'raw-device-secret' },
      targets: [{ id: 'target_temperature', value: 22, unit: '°C', token: 'target-secret' }],
      controlAdapter: {
        kind: 'capability_adapter' as const, activationRequired: true, activationEnabled: true,
        currentControl: 'built_in' as const, token: 'adapter-secret',
      },
    };
    host.deviceManager.getSnapshotByDeviceId = vi.fn(() => device);
    const privateCapacity = { ...capacity, token: 'capacity-secret' };
    host.getCapacityScalars.mockReturnValue(privateCapacity);
    const privateRow = { ...reportActivityFixture(), password: 'row-secret' };
    host.getDeviceLogUiPayload.mockReturnValue(reportHistoryFixture([privateRow]));
    host.readPriceSetup = () => ({ state: 'resolved', setup: {
      source: { scheme: 'norway', basis: { kind: 'chosen' } },
      norway: {
        county: { value: 'private-county', chosen: true }, gridCompany: { kind: 'none' },
        tariffGroup: { value: 'private-tariff', chosen: true },
        pricingModel: { value: 'stromstotte', chosen: true }, priceArea: { value: 'NO1', chosen: true },
      },
    } });
    host.getPriceTimelineForUi = () => ({
      state: 'ready', periods: [{ startsAt: new Date(now).toISOString(), durationMinutes: 60, importPrice: 42, level: 'cheap' }],
      lines: { average: 100, cheapAtOrBelow: 75, expensiveFrom: 125 }, priceUnit: 'øre/kWh', hasExportPrice: false,
    });
    const day = partialDouble<DailyBudgetDayPayload>({
      dateKey: '2026-10-23', timeZone: 'Europe/Oslo', nowUtc: new Date(now).toISOString(),
      budget: { enabled: true, dailyBudgetKWh: 50, priceShapingEnabled: true },
      state: {
        usedNowKWh: 20, allowedNowKWh: 25, remainingKWh: 30, deviationKWh: -5,
        exceeded: false, frozen: false, confidence: 0.8, priceShapingActive: true,
      },
    });
    host.getDailyBudgetUiPayload = () => ({ kind: 'budget', payload: { todayKey: day.dateKey, days: { [day.dateKey]: day } } });
    const settings = { get: vi.fn(), getKeys: vi.fn(), set: vi.fn() };
    const homey = { app: host, manifest: { version: '3.21.0', apiKey: 'manifest-secret' }, version: '12.0.0', settings };
    const report = await new SupportReportEvidenceSource(createSupportReportReads(host, objectiveStore(), noCycle, noHeating, appMemoryReading(), noAppVersions), homey)
      .capture(request, now);
    expect(values(report, 'Current app-wide prices')).toMatchObject({ importPrice: 42, level: 'cheap' });
    expect(values(report, 'Current app-wide price source')).toEqual({ scheme: 'norway', selection: 'chosen' });
    expect(values(report, 'Current daily budget')).toMatchObject({ dailyBudgetKWh: 50, usedKWh: 20 });
    expect(JSON.stringify(report)).not.toMatch(/secret|private-county|private-tariff|password|apiKey|token|rawDevice/);
    expect(settings.get).not.toHaveBeenCalled();
    expect(settings.getKeys).not.toHaveBeenCalled();
    expect(settings.set).not.toHaveBeenCalled();
  });
});

describe('support report car link evidence', () => {
  const chargerRequest: SupportReportRequest = {
    subject: { kind: 'device', homeId: 'main', deviceId: 'charger' },
    problem: 'The car was not linked.', expected: 'Link the car.', occurredAtMs: now - hour, historyWindow: 'incident',
  };
  const chargerSnapshot = () => transportSnapshotFixture({
    id: 'charger', name: 'Elbillader', available: true, isEvCharger: true, deviceClass: 'evcharger',
    expectedPowerKw: 7, expectedPowerSource: 'measured-peak', lastUpdated: now - hour, targets: [],
  });
  const carLink = (): CarLinkDiagnostics => ({
    role: 'charger', selection: 'selected', waitingSinceMs: now - 13 * hour,
    connection: { atMs: now - 13 * hour, seen: 'plug_in' },
    cars: [{
      availability: 'observed', carId: 'car', carName: 'Polestar 3', state: 'plugged_in',
      stateReportedAtMs: now - 30 * 60_000, pastMatches: 3,
    }],
  });
  const chargerHost = (db: UserdataDatabase) => pelsHostDouble({
    homeMembership: membership(),
    deviceManager: partialDouble<NonNullable<PelsHost['deviceManager']>>({
      getSnapshotByDeviceId: (id: string) => id === 'charger' ? chargerSnapshot() : undefined,
      getCarLinkDiagnostics: () => carLink(),
    }),
    getDeviceLogUiPayload: () => reportHistoryFixture(),
    getUserdataDatabase: () => db,
  });

  it('includes the car link and every event kept about the charger and its cars, before the window too', async () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    try {
      const journal = createDeviceEventStore(db);
      vi.useFakeTimers({ now: now - 13 * hour });
      journal.record(['charger'], { component: 'devices', event: 'ev_car_link_plug_edge', role: 'charger' });
      vi.setSystemTime(now - 13 * hour + 20 * 60_000);
      journal.record(['charger'], { component: 'devices', event: 'ev_car_link_unmatched', reason: 'no_connected_car' });
      vi.setSystemTime(now - 30 * 60_000);
      journal.record(['charger', 'car'], { component: 'devices', event: 'ev_car_link_late_car_report', lateByMs: 5 });
      journal.record(['car'], { component: 'devices', event: 'ev_car_link_plug_edge', role: 'car' });
      journal.record(['heater'], { component: 'devices', event: 'unrelated' });
      vi.useRealTimers();
      const report = await source(chargerHost(db)).capture(chargerRequest, now);
      expect(values(report, 'Current car link')).toEqual({
        role: 'charger', selection: 'selected', waitingSinceMs: now - 13 * hour,
        connection: { atMs: now - 13 * hour, seen: 'plug_in' },
        cars: [{
          availability: 'observed', carId: 'car', carName: 'Polestar 3', state: 'plugged_in',
          stateReportedAtMs: now - 30 * 60_000, pastMatches: 3,
        }],
      });
      expect(report.deviceEvents).toMatchObject({ state: 'available', deviceIds: ['charger', 'car'], toMs: now, leftOut: 0 });
      if (report.deviceEvents.state !== 'available') throw new Error('Expected kept device events');
      expect(report.deviceEvents.entries.map((entry) => entry.event)).toEqual([
        'ev_car_link_plug_edge', 'ev_car_link_unmatched', 'ev_car_link_late_car_report', 'ev_car_link_plug_edge',
      ]);
      expect(report.omissions).not.toContain('Current car link is unavailable.');
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it('keeps the kept events nearest the incident and says how many it left out', async () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    try {
      const journal = createDeviceEventStore(db);
      const total = SUPPORT_REPORT_MAX_DEVICE_EVENTS + 40;
      for (let index = 0; index < total; index += 1) {
        vi.useFakeTimers({ now: now - 6 * hour + index * 60_000 });
        journal.record([index % 2 ? 'charger' : 'car'], { component: 'devices', event: `event-${index}` });
      }
      vi.useRealTimers();
      const report = await source(chargerHost(db)).capture({ ...chargerRequest, occurredAtMs: now - 6 * hour }, now);
      if (report.deviceEvents.state !== 'available') throw new Error('Expected kept device events');
      expect(report.deviceEvents.leftOut).toBe(40);
      expect(report.deviceEvents.entries).toHaveLength(SUPPORT_REPORT_MAX_DEVICE_EVENTS);
      expect(report.deviceEvents.entries[0]?.event).toBe('event-0');
      expect(report.deviceEvents.entries.at(-1)?.event).toBe(`event-${SUPPORT_REPORT_MAX_DEVICE_EVENTS - 1}`);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it('leaves out the current car link of a charger that moved to another home', async () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    try {
      const getCarLinkDiagnostics = vi.fn(() => carLink());
      const host = pelsHostDouble({
        homeMembership: membership('cabin'),
        deviceManager: partialDouble<NonNullable<PelsHost['deviceManager']>>({
          getSnapshotByDeviceId: (id: string) => id === 'charger' ? chargerSnapshot() : undefined,
          getCarLinkDiagnostics,
        }),
        getDeviceLogUiPayload: () => reportHistoryFixture([reportActivityFixture({ deviceId: 'charger' })]),
        getUserdataDatabase: () => db,
      });
      const report = await source(host).capture(chargerRequest, now);
      expect(values(report, 'Current car link')).toBeUndefined();
      expect(getCarLinkDiagnostics).not.toHaveBeenCalled();
      expect(report.deviceEvents).toMatchObject({ state: 'available', deviceIds: ['charger'] });
    } finally {
      db.close();
    }
  });

  it('says when kept device events cannot be read, and keeps the rest of the report', async () => {
    const host = currentHost();
    const report = await source(host).capture(request, now);
    expect(report.deviceEvents).toEqual({ state: 'unavailable', reason: 'Kept device events could not be read.' });
    expect(values(report, 'Current device observation and configuration')).toMatchObject({ measuredPowerKw: 0.7 });
  });
});

describe('support report log', () => {
  it('folds identical summaries within each scope and hour after selecting the report window', async () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    try {
      const store = createLogTailStore(db);
      const boundary = now - (now % hour);
      const capturedAt = boundary + 10_000;
      const event = 'periodic_device_health_summary';
      const add = (atMs: number, lineEvent: string, homeId: string, available: number, level = 30) => {
        store.append({ atMs, level, key: lineEvent, line: JSON.stringify({ event: lineEvent, homeId, available }) });
      };
      add(capturedAt - 24 * hour - 1, event, 'main', 3);
      add(capturedAt - 24 * hour, event, 'main', 3);
      add(boundary - 1, event, 'main', 3);
      add(boundary, event, 'main', 3);
      add(boundary + 1, event, 'annex', 3);
      add(boundary + 2, 'overshoot_entered', 'main', 3);
      add(boundary + 3, 'overshoot_entered', 'main', 3);
      add(boundary + 4, event, 'main', 3);
      add(boundary + 5, event, 'main', 2);
      add(boundary + 6, event, 'main', 2, 40);
      add(boundary + 7, event, 'main', 2);
      const host = pelsHostDouble({ ...currentHost(), getUserdataDatabase: () => db });
      const report = await source(host).capture(
        { ...request, historyWindow: 'day', occurredAtMs: capturedAt },
        capturedAt,
      );
      if (report.log.state !== 'available') throw new Error('Expected the log');
      expect(report.log.lines.map(({ atMs, repeated }) => [atMs, repeated])).toEqual([
        [capturedAt - 24 * hour, undefined],
        [boundary - 1, undefined],
        [boundary, { count: 2, lastAtMs: boundary + 4 }],
        [boundary + 1, undefined],
        [boundary + 2, undefined],
        [boundary + 3, undefined],
        [boundary + 5, undefined],
        [boundary + 6, undefined],
        [boundary + 7, undefined],
      ]);
      expect(store.read(boundary, capturedAt, 100_000, []).lines).toHaveLength(8);
    } finally {
      db.close();
    }
  });

  it('leaves the commands its activity records out of a day report about the whole app, and says so', async () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    try {
      const store = createLogTailStore(db);
      const line = (event: string) => ({ atMs: now - hour, level: 30, key: `${event}|heater`,
        line: JSON.stringify({ event, deviceId: 'heater' }) });
      store.append(line('binary_command_applied'));
      store.append(line('overshoot_entered'));
      const host = pelsHostDouble({ ...currentHost(), getUserdataDatabase: () => db });
      const day = await source(host).capture({
        ...request, subject: { kind: 'app', homeId: 'main' }, historyWindow: 'day', occurredAtMs: now,
      }, now);
      expect(day.log).toMatchObject({ state: 'available', omittedEvents: DAY_REPORT_OMITTED_LOG_EVENTS, leftOutForSize: 0 });
      if (day.log.state !== 'available') throw new Error('Expected the log');
      expect(day.log.lines.map((kept) => kept.entry.event)).toEqual(['overshoot_entered']);
      // A report about one device keeps every line: its activity covers only that device.
      const device = await source(host).capture({ ...request, historyWindow: 'day', occurredAtMs: now }, now);
      if (device.log.state !== 'available') throw new Error('Expected the log');
      expect(device.log.omittedEvents).toEqual([]);
      expect(device.log.lines.map((kept) => kept.entry.event)).toEqual(['binary_command_applied', 'overshoot_entered']);
    } finally {
      db.close();
    }
  });
});

describe('support report smart task evidence', () => {
  const evTask = { kind: 'ev_soc', enforcement: 'soft', targetPercent: 80, enabled: true, deadlineAtMs: now + 8 * hour };
  type RecordedPlan = NonNullable<ReturnType<DeferredObjectiveActivePlanRecorder['getActivePlan']>>;
  const recordedPlan = partialDouble<RecordedPlan>({
    deviceId: 'heater', pending: false,
    kwhPerUnitProvenance: partialDouble<NonNullable<RecordedPlan['kwhPerUnitProvenance']>>({
      source: 'learned', acceptedSamples: 7, confidence: 'medium',
    }),
    latest: partialDouble<NonNullable<RecordedPlan['latest']>>({
      planStatus: 'on_track', energyNeededKWh: 12, revisedAtMs: now - hour, reason: 'prices_revised',
      hours: [
        // Booked at 0 kWh: the task holds this hour without promising energy.
        { startsAtMs: now - 10 * 60_000, endsAtMs: now - 10 * 60_000 + hour, plannedKWh: 0 },
        { startsAtMs: now + 2 * hour, endsAtMs: now + 3 * hour, plannedKWh: 6 },
        { startsAtMs: now + 3 * hour, endsAtMs: now + 4 * hour, plannedKWh: 6 },
      ],
    }),
  });

  it('says when the device has no smart task, which is evidence on its own', async () => {
    const report = await source(currentHost()).capture(request, now);
    expect(values(report, 'Current smart task')).toEqual({ exists: false });
  });

  // The controller's view of the hour Michal's charger sat off: no plan could be
  // made, so the start policy kept holding it.
  const cycle: SmartTaskCycleRecord = {
    atMs: now - 20_000, decision: 'inactive', budgetExempt: false, reasonCode: 'objective_progress_stale',
    trajectory: 'unavailable', currentValue: null, energyNeededKWh: null, planningSpeedKw: 1.4,
    kwhPerUnitSource: 'learned', kwhPerUnitAcceptedSamples: 7,
  };

  it('names the task, its plan, and what the controller decided last cycle', async () => {
    const host = currentHost();
    const getActivePlan = vi.fn((id: string) => (id === 'heater' ? recordedPlan : undefined));
    const app = Object.assign(host, {
      deferredObjectiveActivePlanRecorder: partialDouble<DeferredObjectiveActivePlanRecorder>({ getActivePlan }),
    });
    const readCycle = vi.fn((id: string) => (id === 'heater' ? cycle : undefined));
    const report = await source(app, objectiveStore({ heater: evTask }), readCycle).capture(request, now);
    expect(values(report, 'Current smart task')).toEqual({
      exists: true, kind: 'ev_soc', enabled: true, enforcement: 'soft', deadlineAtMs: now + 8 * hour,
      targetPercent: 80, savedPermissions: {}, hourlyBookingColumns: ['hourStartMs', 'plannedKWh'],
      plan: {
        pending: false, learnedRateSource: 'learned', learnedRateSamples: 7, learnedRateConfidence: 'medium',
        planStatus: 'on_track', revisedAtMs: now - hour, revisionReason: 'prices_revised', energyNeededKWh: 12,
        plannedHours: 2, currentHourBooked: true, currentHourPlannedKWh: 0, nextPlannedHourStartsAtMs: now + 2 * hour,
        // The hour booked at 0 kWh stays: it still lets the task start its device.
        hourlyBookings: [[now - hour, 0], [now, 0], [now + 2 * hour, 6], [now + 3 * hour, 6]],
      },
      lastCycle: {
        atMs: now - 20_000, decision: 'inactive', reasonCode: 'objective_progress_stale', trajectory: 'unavailable',
        currentValue: null, energyNeededKWh: null, planningSpeedKw: 1.4,
        kwhPerUnitSource: 'learned', kwhPerUnitAcceptedSamples: 7, budgetExempt: false, permissionsInForce: [],
      },
    });
    // One device's record, never the assembled view of every task.
    expect(getActivePlan).toHaveBeenCalledWith('heater');
  });

  it('reports fractional scheduled duration and a gap between quarter bookings honestly', async () => {
    const plan = { ...recordedPlan, latest: { ...recordedPlan.latest!, energyNeededKWh: 1, hours: [
      { startsAtMs: now, endsAtMs: now + hour / 4, plannedKWh: 0.5 },
      { startsAtMs: now + 3 * hour / 4, endsAtMs: now + hour, plannedKWh: 0.5 },
    ] } };
    const app = Object.assign(currentHost(), {
      deferredObjectiveActivePlanRecorder: partialDouble<DeferredObjectiveActivePlanRecorder>({
        getActivePlan: () => plan,
      }),
    });
    const report = await source(app, objectiveStore({ heater: evTask })).capture(request, now + hour / 2);
    expect(values(report, 'Current smart task')).toMatchObject({ plan: {
      plannedHours: 0.5, currentHourBooked: false, nextPlannedHourStartsAtMs: now + 3 * hour / 4,
    } });
  });

  it('marks the section unavailable when the task store cannot say whether a task exists', async () => {
    const flaky: ObjectiveSettingsStore = {
      get: () => undefined,
      getKeys: () => { throw new Error('settings unavailable'); },
      set: vi.fn(),
      unset: vi.fn(),
    };
    const report = await source(currentHost(), flaky).capture(request, now);
    expect(values(report, 'Current smart task')).toBeUndefined();
    expect(report.omissions).toContain('Current smart task is unavailable.');
  });
});

describe('support report smart task audit', () => {
  const quarter = hour / 4;
  // A charger task that may break the daily budget once it is at risk, made by a weekday schedule.
  const evTask = {
    kind: 'ev_soc', enforcement: 'soft', targetPercent: 80, enabled: true, deadlineAtMs: now + 8 * hour,
    rescue: { exemptFromBudget: 'at_risk' }, scheduleSource: { id: 'weekday-ev', name: 'Weekday car' },
  };
  const cycle: SmartTaskCycleRecord = {
    atMs: now - 20_000, decision: 'planned', budgetExempt: true, reasonCode: 'objective_progress_stale',
    trajectory: 'at_risk', currentValue: 40, energyNeededKWh: 20, planningSpeedKw: 7,
    kwhPerUnitSource: 'learned', kwhPerUnitAcceptedSamples: 4, permissionsInForce: ['exemptFromBudget'],
  };
  const run = (overrides: Partial<DeferredObjectivePlanHistoryRecord> = {}): DeferredObjectivePlanHistoryRecord => ({
    id: 'run-1', deviceId: 'heater', objectiveKind: 'temperature', targetValue: 65,
    startProgressValue: 45, finalProgressValue: 58, deadlineAtMs: now - 2 * hour, startedAtMs: now - 6 * hour,
    finalizedAtMs: now - 2 * hour, initialEnergyNeededKWh: 6, initialEnergyExpectedKWh: 6.0004, deliveredKWh: 3.5, totalCost: 410,
    costDisplay: { unit: 'kr', divisor: 100 }, outcome: 'missed', metAtMs: null, usedDeadlineReserve: true,
    observedIntervals: [], discoveredFrom: 'observation', originalPlan: null, revisionCount: 3,
    finalPlan: {
      hours: [], energyNeededKWh: 2.5, planStatus: 'cannot_meet', revisedAtMs: now - 3 * hour,
      floorShortfallCause: 'time_capacity', planningSpeedKw: 2,
    },
    // Four quarter bookings in one hour and one hour on its own: allocations read by hour.
    hourStartBookings: [
      { atMs: now - 5 * hour, endsAtMs: now - 5 * hour + quarter, bookedKWh: 0.5 },
      { atMs: now - 5 * hour + quarter, endsAtMs: now - 5 * hour + 2 * quarter, bookedKWh: 0.5 },
      { atMs: now - 5 * hour + 2 * quarter, endsAtMs: now - 5 * hour + 3 * quarter, bookedKWh: 0.5 },
      { atMs: now - 5 * hour + 3 * quarter, endsAtMs: now - 4 * hour, bookedKWh: 0.5 },
      { atMs: now - 3 * hour, endsAtMs: now - 2 * hour, bookedKWh: 2 },
    ],
    hourlyContributions: [
      { atMs: now - 5 * hour, endsAtMs: now - 4 * hour, deliveredKWh: 1.5, priceValue: 100, tone: 'cheap' },
      // Delivered in an hour the run had not booked.
      { atMs: now - 4 * hour, endsAtMs: now - 3 * hour, deliveredKWh: 2, priceValue: 130, tone: 'normal' },
    ],
    deliveryExplanation: {
      kind: 'recorded', primary: { kind: 'blocked', cause: 'capacity_limited' }, contributors: ['budget_limited'],
      intervals: [
        { fromMs: now - 3 * hour, toMs: now - 3 * hour + quarter, cause: 'capacity_limited' },
        { fromMs: now - 3 * hour + quarter, toMs: now - 2 * hour, cause: 'capacity_limited' },
      ],
    },
    ...overrides,
  });
  const scheduleEntry = (overrides: Partial<ScheduleEntry['schedule']>): ScheduleEntry => ({
    schedule: {
      id: 'weekday-ev', name: 'Weekday car', enabled: true, at: '22:00',
      repeat: { type: 'weekly', days: [1, 2, 3, 4, 5] }, condition: { type: 'exclude', modes: ['Away'] },
      action: { type: 'task', task: {
        deviceId: 'heater', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00', exemptFromBudget: true,
      } },
      ...overrides,
    },
    modeReferences: [], state: 'on', reason: '', nextAtMs: now + 10 * hour, nextLabel: 'Today 22:00',
    lastResult: 'Created a smart task', lastLabel: 'Yesterday 22:00',
  });
  const schedules: SchedulesSnapshot = {
    timeZone: 'Europe/Oslo', modes: ['Home', 'Away'],
    controls: { modeChangesEnabled: true, disabledTaskDeviceIds: ['boiler'] },
    entries: [
      scheduleEntry({}),
      scheduleEntry({ id: 'night', name: 'Night', action: { type: 'mode', mode: 'Night' } }),
      scheduleEntry({ id: 'boiler-top-up', name: 'Boiler', action: { type: 'task', task: {
        deviceId: 'boiler', kind: 'energy', target: 3, readyByLocalTime: '06:00',
      } } }),
    ],
  };
  const auditedApp = (runs: DeferredObjectivePlanHistoryRecord[]) => Object.assign(currentHost(), {
    readSchedules: () => ({ ok: true as const, data: schedules }),
    deferredObjectiveActivePlanRecorder: partialDouble<DeferredObjectiveActivePlanRecorder>({
      getActivePlan: () => undefined,
    }),
    deferredObjectivePlanHistoryRecorder: partialDouble<DeferredObjectivePlanHistoryRecorder>({
      getHistorySnapshot: () => ({ version: 7, entries: runs }),
      getBudgetOnlyMisses: () => [],
    }),
  });
  const dayRequest: SupportReportRequest = {
    ...request, subject: { kind: 'app', homeId: 'main' }, historyWindow: 'day', occurredAtMs: now,
  };

  it('states what each task asks for, may override, booked and delivered, and the schedules behind it', async () => {
    const old = run({ id: 'old', finalizedAtMs: now - 30 * hour });
    const report = await source(auditedApp([old, run()]), objectiveStore({ heater: evTask }), () => cycle)
      .capture(dayRequest, now);
    expect(values(report, 'Current smart tasks')).toMatchObject({ tasks: [{
      deviceId: 'heater', deviceName: 'Hall heater now', kind: 'ev_soc', targetPercent: 80,
      savedPermissions: { exemptFromBudget: 'at_risk' }, schedule: { id: 'weekday-ev', name: 'Weekday car' },
      plan: 'none', lastCycle: { decision: 'planned', trajectory: 'at_risk', permissionsInForce: ['exemptFromBudget'] },
    }] });
    // Only the run that ended in the day's window.
    expect(values(report, 'Smart task runs')).toEqual({
      fromMs: now - 24 * hour, toMs: now,
      hourColumns: ['hourStartMs', 'bookedKWh', 'deliveredKWh'], blockedColumns: ['fromMs', 'toMs', 'cause'],
      leftOut: 0,
      runs: [{
        deviceId: 'heater', deviceName: 'Hall heater now', kind: 'temperature', target: 65,
        startValue: 45, finalValue: 58, startedAtMs: now - 6 * hour, deadlineAtMs: now - 2 * hour,
        finalizedAtMs: now - 2 * hour, outcome: 'missed', metAtMs: null, neededKWh: 6, deliveredKWh: 3.5,
        cost: { total: 410, unit: 'kr', divisor: 100 }, usedDeadlineReserve: true, budgetOnlyMiss: false,
        revisionCount: 3, finalPlanStatus: 'cannot_meet', floorShortfallCause: 'time_capacity', planningSpeedKw: 2,
        constraint: {
          recorded: true, primary: 'capacity_limited', contributors: ['budget_limited'],
          blocked: [[now - 3 * hour, now - 2 * hour, 'capacity_limited']], blockedLeftOut: 0,
        },
        hours: [[now - 5 * hour, 2, 1.5], [now - 4 * hour, null, 2], [now - 3 * hour, 2, null]],
      }],
    });
    expect(values(report, 'Smart task schedules')).toEqual({
      timeZone: 'Europe/Oslo', pausedDeviceIds: ['boiler'],
      schedules: [
        {
          id: 'weekday-ev', name: 'Weekday car', enabled: true, state: 'on', at: '22:00',
          repeat: { type: 'weekly', days: [1, 2, 3, 4, 5] }, condition: { type: 'exclude', modes: ['Away'] },
          deviceId: 'heater', kind: 'ev_soc', target: 80, readyBy: '07:00', permissions: ['exemptFromBudget'],
          nextAtMs: now + 10 * hour, lastResult: 'Created a smart task', lastDue: 'Yesterday 22:00',
        },
        expect.objectContaining({ id: 'boiler-top-up', deviceId: 'boiler', permissions: [] }),
      ],
    });
  });

  it('states each learned device rate, with or without a smart task', async () => {
    const app = Object.assign(auditedApp([]), {
      powerTracker: {
        objectiveProfiles: {
          heater: {
            updatedAtMs: now, lastSample: { observedAtMs: now, value: 21 }, acceptedSamples: 1, rejectedSamples: 0,
            samples: [{ observedAtMs: now, inputValue: 20.5, kwhPerUnit: 1.4 }],
            rejections: { objective_profile_powerless_sub_interval: { count: 1, discardedEnergyKWh: 0.6 } },
          },
        },
      },
    });
    const report = await source(app, objectiveStore({}), () => undefined).capture(dayRequest, now);
    expect(values(report, 'Learned device rates')).toEqual({
      sampleColumns: ['observedAtMs', 'inputValue', 'kwhPerUnit', 'outdoorTemperatureC', 'progressDirection'],
      devices: [{
        deviceId: 'heater', deviceName: 'Hall heater now', updatedAtMs: now, acceptedSamples: 1, rejectedSamples: 0,
        kwhPerUnit: null,
        rejections: { objective_profile_powerless_sub_interval: { count: 1, discardedEnergyKWh: 0.6 } },
        samples: [[now, 20.5, 1.4, null, 'increasing']],
      }],
    });
  });

  it('shares an interval that crosses an hour over both hours, booked and delivered alike', async () => {
    // A half-hour price period from :45 to :15, booked from a restart at :50.
    const report = await source(auditedApp([run({
      hourStartBookings: [{ atMs: now - 3 * hour - 10 * 60_000, endsAtMs: now - 2 * hour - 45 * 60_000, bookedKWh: 1 }],
      hourlyContributions: [{
        atMs: now - 3 * hour - quarter, endsAtMs: now - 2 * hour - 45 * 60_000, deliveredKWh: 0.8,
        priceValue: 100, tone: 'cheap',
      }],
    })]), objectiveStore()).capture(dayRequest, now);
    expect(values(report, 'Smart task runs')).toMatchObject({ runs: [{
      hours: [[now - 4 * hour, 0.4, 0.4], [now - 3 * hour, 0.6, 0.4]],
    }] });
  });

  it('keeps the newest runs and says how many older ones it left out', async () => {
    const runs = Array.from({ length: 14 }, (_, index) => run({ id: `run-${index}`, finalizedAtMs: now - index * hour }));
    const report = await source(auditedApp(runs), objectiveStore()).capture(dayRequest, now);
    const section = values(report, 'Smart task runs') as { runs: { finalizedAtMs: number }[]; leftOut: number };
    expect(section.runs).toHaveLength(12);
    expect(section.runs[0]?.finalizedAtMs).toBe(now);
    expect(section.leftOut).toBe(2);
  });

  it('narrows a device report to its own runs and schedules', async () => {
    const report = await source(auditedApp([run(), run({ id: 'boiler-run', deviceId: 'boiler' })]),
      objectiveStore({ heater: evTask }), () => cycle).capture(request, now);
    expect(values(report, 'Current smart tasks')).toBeUndefined();
    expect(values(report, 'Smart task runs')).toMatchObject({ runs: [{ deviceId: 'heater' }], leftOut: 0 });
    expect(values(report, 'Smart task schedules')).toMatchObject({
      paused: false, schedules: [{ id: 'weekday-ev' }],
    });
  });

  it('says which smart task evidence it could not read and keeps the rest', async () => {
    const report = await source(currentHost(), objectiveStore({ heater: evTask })).capture(dayRequest, now);
    expect(values(report, 'Current smart tasks')).toMatchObject({ tasks: [{ deviceId: 'heater' }] });
    expect(report.omissions).toEqual(expect.arrayContaining([
      'Smart task runs is unavailable.', 'Smart task schedules is unavailable.',
    ]));
  });
});

describe('device support request evidence', () => {
  const supportRequest: SupportReportRequest = {
    subject: { kind: 'device_support', homeId: 'main', deviceId: 'relay' },
    problem: 'A water heater on a KNX relay.', expected: '', occurredAtMs: now, historyWindow: 'incident',
  };
  const relay = { ...HOMEY_DEVICE_FIELDS,
    id: 'relay', name: 'Water heater relay', class: 'light', ownerUri: 'homey:app:com.knx',
    driverUri: 'homey:app:com.knx', driverId: 'switch', available: true,
    capabilities: ['onoff', 'measure_power'],
    capabilitiesObj: {
      onoff: { id: 'onoff', value: true, setable: true, getable: true, title: 'Turned on' },
      measure_power: { id: 'measure_power', value: 2950, units: 'W', setable: false },
    },
    settings: { energy_value_on: 3000, password: 'secret' },
  };
  const hostWithHomeyDevices = (read: () => Promise<readonly HomeyDeviceLike[]>) => pelsHostDouble({
    homeMembership: membership(),
    deviceManager: partialDouble<NonNullable<PelsHost['deviceManager']>>({
      getSnapshotByDeviceId: vi.fn(() => undefined),
      readDevicesForDiagnostics: fixtureInventory(read),
    }),
    getDeviceLogUiPayload: vi.fn(() => reportHistoryFixture([])),
  });
  const relaySettings = { state: 'available', values: { energy_value_on: { value: 3000, unit: 'W' } } };

  it('uses one Homey read for the settings of an unmanaged device in both report sections', async () => {
    const read = vi.fn(async () => [relay]);
    const host = hostWithHomeyDevices(read);
    const report = await source(host).capture(supportRequest, now);
    expect(read).toHaveBeenCalledOnce();
    expect(report.subjectName).toBe('Water heater relay');
    expect(values(report, 'Homey device')).toEqual({
      id: 'relay', class: 'light', virtualClass: null, ownerUri: 'homey:app:com.knx',
      driverId: 'switch', available: true,
      capabilities: {
        onoff: { value: true, setable: true, getable: true },
        measure_power: { value: 2950, units: 'W', setable: false },
      },
      deviceSettings: relaySettings,
      energy: null,
    });
    expect(values(report, 'Current Homey devices')).toMatchObject({
      devices: [{ id: 'relay', deviceSettings: relaySettings }],
    });
    expect(JSON.stringify(report)).not.toContain('secret');
    // PELS has no snapshot of the device, so no section claims to describe one.
    expect(values(report, 'Current device observation and configuration')).toBeUndefined();
  });

  it('describes a support subject beyond the roster limit', async () => {
    const roster = Array.from({ length: SUPPORT_REPORT_MAX_HOMEY_DEVICES }, (_, index) => (
      { ...relay, id: `device-${index}` }
    ));
    const report = await source(hostWithHomeyDevices(async () => [...roster, relay])).capture(supportRequest, now);
    expect(values(report, 'Homey device')).toMatchObject({ id: relay.id, deviceSettings: relaySettings });
    expect(values(report, 'Current Homey devices')?.leftOut).toBe(1);
  });

  it('treats a partial inventory containing the requested subject as unavailable', async () => {
    const host = hostWithHomeyDevices(async () => []);
    host.deviceManager.readDevicesForDiagnostics = (collect) => collect((async function* devices() {
      yield relay;
      throw new Error('truncated');
    })());
    await expect(source(host).capture(supportRequest, now)).rejects.toMatchObject({ code: 'capture_failed' });
  });

  describe('the device list', () => {
    const appReport: SupportReportRequest = {
      subject: { kind: 'app', homeId: 'main' },
      problem: 'Daily report.', expected: '', occurredAtMs: now, historyWindow: 'day',
    };
    const managedHeater = { ...relay, id: 'heater', name: 'Hall heater', class: 'heater',
      ownerUri: 'homey:app:com.example.heat', driverId: 'homey:app:com.example.heat:pump' };

    it('names the app behind every device, and whether PELS manages it', async () => {
      const host = pelsHostDouble({
        homeMembership: membership(),
        deviceManager: partialDouble<NonNullable<PelsHost['deviceManager']>>({
          getSnapshotByDeviceId: vi.fn((id: string) => id === 'heater' ? deviceSnapshot() : undefined),
          readDevicesForDiagnostics: fixtureInventory(async () => [relay, managedHeater]),
        }),
        getDeviceLogUiPayload: vi.fn(() => reportHistoryFixture([])),
      });
      const report = await source(host).capture(appReport, now);
      expect(values(report, 'Current Homey devices')).toEqual({
        devices: [
          { id: 'relay', name: 'Water heater relay', class: 'light', ownerUri: 'homey:app:com.knx',
            driverId: 'switch', available: true, deviceSettings: relaySettings },
          { id: 'heater', name: 'Hall heater', class: 'heater', ownerUri: 'homey:app:com.example.heat',
            driverId: 'homey:app:com.example.heat:pump', available: true, managed: deviceSnapshot().managed,
            deviceSettings: relaySettings, configuration: { state: 'unavailable' } },
        ],
        leftOut: 0,
      });
      expect(JSON.stringify(values(report, 'Current Homey devices'))).not.toContain('secret');
    });

    it('preserves a charger current and distinguishes absent, unreadable and withheld values', async () => {
      const charger = parseHomeyDevicePayload({
        ...relay, id: 'charger', ownerUri: 'homey:app:com.aminacharging', driverId: 'homey:app:com.aminacharging:amina-s',
        settings: {
          maxCurrent: 16, singlePhase: false, energy_value_off: 0, energy_value_on: null,
          load: '10.0.0.1', ipAddress: '192.0.2.2', accessToken: 'private-token',
          nested: { temperature: 18, ipAddress: '192.0.2.3' },
        },
      });
      if (!charger) throw new Error('invalid charger fixture');
      const devices: HomeyDeviceLike[] = [
        charger,
        { ...relay, id: 'empty', settings: {} },
        { ...relay, id: 'unreadable', settings: {}, settingsUnavailable: true },
        { ...relay, id: 'private', settings: { accessToken: 'private-token' } },
      ];
      const report = await source(hostWithHomeyDevices(async () => devices)).capture(appReport, now);
      const inventory = values(report, 'Current Homey devices');
      expect(inventory).toMatchObject({
        devices: [
          { id: 'charger', deviceSettings: { state: 'available', values: {
            maxCurrent: { value: 16, unit: 'A' }, singlePhase: { value: false },
            energy_value_off: { value: 0, unit: 'W' }, load: { state: 'invalid' },
          } } },
          { id: 'empty', deviceSettings: { state: 'none' } },
          { id: 'unreadable', deviceSettings: { state: 'unavailable' } },
          { id: 'private', deviceSettings: { state: 'available', values: {} } },
        ],
      });
      expect(JSON.stringify(inventory)).not.toMatch(/private-token|ipAddress|10\.0\.0\.1|192\.0\.2|nested|energy_value_on/);
    });

    it('captures installed app versions and reported battery firmware without unrelated metadata', async () => {
      const sigenergy = {
        ...relay, id: 'battery', ownerUri: 'homey:app:com.sigenergy', driverId: 'homey:app:com.sigenergy:battery',
        capabilities: ['firmware'], capabilitiesObj: { firmware: { value: 'V100R001C00SPC117' } },
        settings: { firmware: 'V100R001C00SPC115', privateSetting: 'secret' },
      };
      const zinvolt = {
        ...relay, id: 'zinvolt', ownerUri: 'homey:app:com.zinvolt', driverId: 'homey:app:com.zinvolt:power',
        settings: { firmware_inverter: '1.2.3', firmware_ems: '- (2×)', firmware_batteries: '3'.repeat(257) },
      };
      const runtime = {
        manifest: { id: 'com.barelysufficient.pels' },
        api: { getLocalUrl: async () => 'http://127.0.0.1:1234', getOwnerApiToken: async () => 'test-token' },
      };
      const body = {
        'com.sigenergy': { id: 'com.sigenergy', version: '0.9.0', settings: { privateSetting: 'secret' } },
        'com.zinvolt': { id: 'com.zinvolt', version: '1.2.1' },
        'com.unrelated': { id: 'com.unrelated', version: '1.2.3' },
        'com.knx': { id: 'com.knx', version: 'not a version' },
      };
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        partialDouble<Awaited<ReturnType<typeof globalThis.fetch>>>({
          ok: true, status: 200, text: async () => JSON.stringify(body),
        }),
      );
      try {
        const host = hostWithHomeyDevices(async () => [sigenergy, zinvolt, {
          ...sigenergy, id: 'battery-fallback', capabilities: [],
        }, relay]);
        const report = await source(host, undefined, undefined, undefined, undefined, () => readInstalledAppVersions(runtime))
          .capture(appReport, now);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(fetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:1234/api/manager/apps/app/');
        expect(values(report, 'Installed Homey app versions')).toEqual({ apps: [
          { ownerUri: 'homey:app:com.sigenergy', version: '0.9.0' },
          { ownerUri: 'homey:app:com.zinvolt', version: '1.2.1' },
        ] });
        expect(values(report, 'Current Homey devices')).toMatchObject({ devices: [
          { firmwareVersions: { battery: 'V100R001C00SPC117' } },
          { firmwareVersions: { inverter: '1.2.3' } },
          { firmwareVersions: { battery: 'V100R001C00SPC115' } },
          { id: relay.id },
        ] });
        expect(JSON.stringify(report)).not.toMatch(/secret|com\.unrelated|firmware_ems|batteryModules/);
      } finally {
        fetch.mockRestore();
      }
    });

    it('keeps device inventory when installed app versions are unavailable', async () => {
      const unavailable = async (): Promise<InstalledAppVersions> => { throw new Error('private app list error'); };
      const report = await source(
        hostWithHomeyDevices(async () => [relay]), undefined, undefined, undefined, undefined, unavailable,
      ).capture(appReport, now);
      expect(values(report, 'Current Homey devices')).toMatchObject({ devices: [{ id: relay.id }] });
      expect(values(report, 'Installed Homey app versions')).toBeUndefined();
      expect(report.omissions).toContain('Installed Homey app versions is unavailable.');
      expect(JSON.stringify(report)).not.toContain('private app list error');
    });

    it('states how many devices it left out past its limit', async () => {
      const devices = Array.from({ length: SUPPORT_REPORT_MAX_HOMEY_DEVICES + 2 }, (_, index) => (
        { ...relay, id: `device-${index}` }
      ));
      const report = await source(hostWithHomeyDevices(async () => devices)).capture(appReport, now);
      const list = values(report, 'Current Homey devices') as { devices: unknown[]; leftOut: number };
      expect(list.devices).toHaveLength(SUPPORT_REPORT_MAX_HOMEY_DEVICES);
      expect(list.leftOut).toBe(2);
    });

    it('captures daily configuration only for retained managed devices in this home, isolating failures', async () => {
      const devices = Array.from({ length: SUPPORT_REPORT_MAX_HOMEY_DEVICES + 2 }, (_, index) => (
        { ...managedHeater, id: `device-${index}` }
      ));
      const readConfiguration = vi.fn((id: string) => {
        if (id === 'device-3') throw new Error('private settings error');
        return deviceDiagnosticConfigurationFixture();
      });
      const host = pelsHostDouble({
        homeMembership: { ...membership(), getHomeIdForDevice: (id: string) => id === 'device-1' ? 'cabin' : 'main' },
        readDeviceDiagnosticConfiguration: readConfiguration,
        deviceManager: partialDouble<NonNullable<PelsHost['deviceManager']>>({
          getSnapshotByDeviceId: (id) => ({ ...deviceSnapshot(), id, managed: id !== 'device-2' }),
          readDevicesForDiagnostics: fixtureInventory(async () => devices),
        }),
      });
      const report = await source(host).capture(appReport, now, 'daily');
      const list = values(report, 'Current Homey devices') as { devices: Array<{ configuration?: unknown }>; leftOut: number };
      expect(list.devices[0].configuration).toEqual({ state: 'available', configuration: deviceDiagnosticConfigurationFixture() });
      expect(list.devices[1].configuration).toBeUndefined();
      expect(list.devices[2].configuration).toBeUndefined();
      expect(list.devices[3].configuration).toEqual({ state: 'unavailable' });
      expect(readConfiguration).toHaveBeenCalledTimes(SUPPORT_REPORT_MAX_HOMEY_DEVICES - 2);
      expect(readConfiguration).not.toHaveBeenCalledWith('device-500');
      expect(list.leftOut).toBe(2);
      expect(JSON.stringify(report)).not.toContain('private settings error');
    });

    it('does not expose another home configuration while ownership is pending', async () => {
      const readConfiguration = vi.fn(deviceDiagnosticConfigurationFixture);
      const host = pelsHostDouble({
        homeMembership: { ...membership(), hasPendingOwnershipGeneration: () => true },
        readDeviceDiagnosticConfiguration: readConfiguration,
        deviceManager: partialDouble<NonNullable<PelsHost['deviceManager']>>({
          getSnapshotByDeviceId: () => deviceSnapshot(), readDevicesForDiagnostics: fixtureInventory(async () => [managedHeater]),
        }),
      });
      const report = await source(host).capture(appReport, now, 'daily');
      expect(values(report, 'Current Homey devices')).toMatchObject({
        devices: [{ configuration: { state: 'unavailable' } }],
      });
      expect(readConfiguration).not.toHaveBeenCalled();
    });

    it('still captures the report when Homey cannot list its devices, and says so', async () => {
      const report = await source(hostWithHomeyDevices(async () => { throw new Error('Homey busy'); }))
        .capture(appReport, now);
      expect(values(report, 'Current Homey devices')).toBeUndefined();
      expect(report.omissions).toContain('Current Homey devices is unavailable.');
    });
  });

  it('asks for another try when Homey cannot be read, and rejects a device Homey no longer has', async () => {
    await expect(source(hostWithHomeyDevices(async () => { throw new Error('Homey busy'); }))
      .capture(supportRequest, now)).rejects.toMatchObject({ code: 'capture_failed' });
    await expect(source(hostWithHomeyDevices(async () => []))
      .capture(supportRequest, now)).rejects.toMatchObject({ code: 'invalid_subject' });
  });
});
