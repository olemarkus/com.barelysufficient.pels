import { describe, expect, it, vi } from 'vitest';
import type { PelsHost } from '../../lib/app/pelsHost';
import { SupportReportEvidenceSource } from '../../lib/diagnostics/supportReportEvidence';
import { createSupportReportReads } from '../../setup/appInit/createSupportReports';
import type { DailyBudgetDayPayload } from '../../packages/contracts/src/dailyBudgetTypes';
import type { SupportReportEvidence, SupportReportRequest } from '../../packages/contracts/src/supportReport';
import { pelsHostDouble } from '../helpers/pelsHostDouble';
import { partialDouble } from '../helpers/partialDouble';
import {
  REPORT_CAPTURE_MS as now, REPORT_HOUR_MS as hour, reportActivityFixture, reportHistoryFixture,
} from '../helpers/supportReportEvidenceFixtures';
import { transportSnapshotFixture } from '../utils/deviceSnapshotFixture';
import { buildPlanDevice, buildPlanMeta, buildSettingsUiPlanMeta } from '../utils/planTestUtils';

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
const source = (app: PelsHost) => new SupportReportEvidenceSource(createSupportReportReads(app), {
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
      getLatestPlanSnapshot: () => ({ generatedAtMs: now, meta: buildPlanMeta(), devices: [decision], storageReleases: [] }),
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
    const report = await new SupportReportEvidenceSource(createSupportReportReads(host), homey).capture(request, now);
    expect(values(report, 'Current app-wide prices')).toMatchObject({ importPrice: 42, level: 'cheap' });
    expect(values(report, 'Current app-wide price source')).toEqual({ scheme: 'norway', selection: 'chosen' });
    expect(values(report, 'Current daily budget')).toMatchObject({ dailyBudgetKWh: 50, usedKWh: 20 });
    expect(JSON.stringify(report)).not.toMatch(/secret|private-county|private-tariff|password|apiKey|token|rawDevice/);
    expect(settings.get).not.toHaveBeenCalled();
    expect(settings.getKeys).not.toHaveBeenCalled();
    expect(settings.set).not.toHaveBeenCalled();
  });
});
