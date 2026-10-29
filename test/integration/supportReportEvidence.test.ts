import { describe, expect, it, vi } from 'vitest';
import type { PelsHost } from '../../lib/app/pelsHost';
import { SupportReportEvidenceSource } from '../../lib/diagnostics/supportReportEvidence';
import { createSupportReportReads, type SupportReportApp } from '../../setup/appInit/createSupportReports';
import type { DailyBudgetDayPayload } from '../../packages/contracts/src/dailyBudgetTypes';
import type { SupportReportEvidence, SupportReportRequest } from '../../packages/contracts/src/supportReport';
import { pelsHostDouble } from '../helpers/pelsHostDouble';
import { partialDouble } from '../helpers/partialDouble';
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
import type { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';

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
  homeMembership: membership(homeId),
  deviceManager: partialDouble<NonNullable<PelsHost['deviceManager']>>({
    getSnapshotByDeviceId: vi.fn((id: string) => id === 'heater' ? deviceSnapshot() : undefined),
    getUiPickerDevices: vi.fn(() => []),
  }),
  getDeviceLogUiPayload: vi.fn(() => reportHistoryFixture([reportActivityFixture()])),
  getLatestPlanSnapshotForUi: vi.fn(() => ({ generatedAtMs: now, meta: buildSettingsUiPlanMeta() })),
  getCapacityScalars: vi.fn(() => capacity),
  getSettingsUiManagedDevices: vi.fn(() => []),
  refreshTargetDevicesSnapshot: vi.fn(async () => undefined),
});
// A settings store holding only the given smart tasks, keyed by device id.
const objectiveStore = (tasks: Record<string, unknown> = {}): ObjectiveSettingsStore => ({
  get: (key: string) => tasks[key.replace('deferred_objective.', '')],
  getKeys: () => ['capacity_limit_kw', ...Object.keys(tasks).map((id) => `deferred_objective.${id}`)],
  set: vi.fn(), unset: vi.fn(),
});
const source = (
  app: SupportReportApp, objectives = objectiveStore(),
) => new SupportReportEvidenceSource(createSupportReportReads(app, objectives), {
  manifest: { version: '9.8.7-running-build' }, version: '12.4.1-running-homey',
});
const values = (report: SupportReportEvidence, title: string) => (
  report.sections.find((section) => section.title === title)?.values
);

describe('support report evidence capture', () => {
  it('separates current observations, current plan, and retained incident activity without refreshes', async () => {
    const host = currentHost();
    const decision = buildPlanDevice({
      id: 'heater', currentState: 'on', plannedState: 'keep',
      currentTemperature: 18, currentTarget: 21, plannedTarget: 22,
    });
    host.planService = partialDouble<NonNullable<PelsHost['planService']>>({
      getLatestPlanSnapshot: () => ({ generatedAtMs: now, meta: buildPlanMeta(), devices: [decision], inverterDecisions: [], storageReleases: [] }),
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
    });
    expect(values(report, 'Current limits settings')).toMatchObject({ hardCapKw: 10, gridImportLimitKw: 8 });
    expect(host.refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
    expect(host.getSettingsUiManagedDevices).not.toHaveBeenCalled();
    expect(host.deviceManager.getUiPickerDevices).not.toHaveBeenCalled();
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
      planUpdatedAtMs: now, powerTracker: {}, currentMonthCapacityPeakKw: 3,
      diagnostics: {
        homeId: 'cabin', meterDeviceId: 'cabin-meter', operatingMode: 'Away', dryRunEffective: false,
        lastMeterPowerKw: 2, lastDeviceControlledMs: {}, capacityScalars: { ...capacity, limitKw: 4 },
      },
    } });
    const report = await source(host).capture({
      ...request, subject: { kind: 'device', homeId: 'cabin', deviceId: 'heater' },
    }, now);
    expect(values(report, 'Current home plan')).toMatchObject({ powerKw: 2 });
    expect(values(report, 'Current limits settings')).toMatchObject({ hardCapKw: 4 });
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
    const report = await new SupportReportEvidenceSource(createSupportReportReads(host, objectiveStore()), homey)
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
    latest: partialDouble<NonNullable<RecordedPlan['latest']>>({
      planStatus: 'on_track', energyNeededKWh: 12,
      hours: [
        // Booked at 0 kWh: the task holds this hour without promising energy.
        { startsAtMs: now - 10 * 60_000, plannedKWh: 0 },
        { startsAtMs: now + 2 * hour, plannedKWh: 6 },
        { startsAtMs: now + 3 * hour, plannedKWh: 6 },
      ],
    }),
  });

  it('says when the device has no smart task, which is evidence on its own', async () => {
    const report = await source(currentHost()).capture(request, now);
    expect(values(report, 'Current smart task')).toEqual({ exists: false });
  });

  it('names the task, what it decided and whether it booked this hour', async () => {
    const host = currentHost();
    const getActivePlan = vi.fn((id: string) => (id === 'heater' ? recordedPlan : undefined));
    const app = Object.assign(host, {
      deferredObjectiveActivePlanRecorder: partialDouble<DeferredObjectiveActivePlanRecorder>({ getActivePlan }),
    });
    const report = await source(app, objectiveStore({ heater: evTask })).capture(request, now);
    expect(values(report, 'Current smart task')).toEqual({
      exists: true, kind: 'ev_soc', enabled: true, enforcement: 'soft', deadlineAtMs: now + 8 * hour,
      targetPercent: 80, pending: false, planStatus: 'on_track', energyNeededKWh: 12,
      plannedHours: 2, currentHourBooked: true, currentHourPlannedKWh: 0, nextPlannedHourStartsAtMs: now + 2 * hour,
    });
    // One device's record, never the assembled view of every task.
    expect(getActivePlan).toHaveBeenCalledWith('heater');
  });

  it('marks the section unavailable when the task store cannot say whether a task exists', async () => {
    const flaky: ObjectiveSettingsStore = { get: () => undefined, getKeys: () => [], set: vi.fn(), unset: vi.fn() };
    const report = await source(currentHost(), flaky).capture(request, now);
    expect(values(report, 'Current smart task')).toBeUndefined();
    expect(report.omissions).toContain('Current smart task is unavailable.');
  });
});
