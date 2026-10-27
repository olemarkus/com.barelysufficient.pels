import { describe, expect, it } from 'vitest';
import type { SupportReportRequest } from '../../packages/contracts/src/supportReport';
import { selectSupportReportActivity } from '../../lib/diagnostics/supportReportHistory';
import {
  REPORT_CAPTURE_MS as now, REPORT_HOUR_MS as hour, reportActivityFixture, reportHistoryFixture,
} from '../helpers/supportReportEvidenceFixtures';

const request: SupportReportRequest = {
  subject: { kind: 'device', homeId: 'main', deviceId: 'heater' },
  problem: 'The heater did not resume.', expected: 'Resume when there is capacity.',
  occurredAtMs: now - 2 * hour, historyWindow: 'incident',
};

// A report row carries no id: name each by the fixture it came from.
const fixtureIds = (fixtures: ReturnType<typeof reportActivityFixture>[]) => (
  entry: { deviceId: string; atMs: number },
): string | undefined => fixtures.find((fixture) => (
  fixture.deviceId === entry.deviceId && fixture.atMs === entry.atMs))?.id;

describe('support report incident activity selection', () => {
  it('includes the hour before the incident through capture, and the nearest preceding state', () => {
    const entries = [
      reportActivityFixture({ id: 'older', atMs: now - 5 * hour }),
      reportActivityFixture({ id: 'previous', atMs: now - 4 * hour }),
      reportActivityFixture({ id: 'start', atMs: now - 3 * hour }),
      reportActivityFixture({ id: 'incident', atMs: now - 2 * hour }),
      reportActivityFixture({ id: 'end', atMs: now - hour }),
      reportActivityFixture({ id: 'after', atMs: now - hour + 1 }),
      reportActivityFixture({ id: 'other', deviceId: 'charger', atMs: now - 2 * hour }),
    ];
    const before = structuredClone(entries);
    const result = selectSupportReportActivity(reportHistoryFixture(entries), request, now);
    expect(result).toMatchObject({
      state: 'available', fromMs: now - 3 * hour, toMs: now,
      retentionDays: 7, maxEntries: 1000, maxEntriesPerDevice: 100, persistence: 'stored',
    });
    if (result.state !== 'available') throw new Error('Expected available activity');
    expect(result.entries.map(fixtureIds(entries))).toEqual(['after', 'end', 'incident', 'start', 'previous']);
    expect(entries).toEqual(before);
  });

  it('caps the incident upper bound at capture time and preserves session boundaries', () => {
    const entries = [
      reportActivityFixture({ id: 'before-restart', atMs: now - hour, recordingStartedAtMs: now - 20 * hour }),
      reportActivityFixture({ id: 'after-restart', atMs: now, recordingStartedAtMs: now }),
      reportActivityFixture({ id: 'future', atMs: now + 1 }),
    ];
    const result = selectSupportReportActivity(reportHistoryFixture(entries), { ...request, occurredAtMs: now }, now);
    expect(result).toMatchObject({ state: 'available', fromMs: now - hour, toMs: now });
    if (result.state !== 'available') throw new Error('Expected available activity');
    expect(result.entries.map(fixtureIds(entries))).toEqual(['after-restart', 'before-restart']);
    // The rows leave the session out; the section names each session once, oldest first.
    expect(result.recordingsStartedAtMs).toEqual([now - 20 * hour, now]);
    expect(result.entries[0]).not.toHaveProperty('recordingStartedAtMs');
  });

  it('selects a preceding record for each device in an app report, including removed devices', () => {
    const entries = [
      reportActivityFixture({ id: 'heater-older', atMs: now - 6 * hour }),
      reportActivityFixture({ id: 'heater-previous', atMs: now - 4 * hour }),
      reportActivityFixture({ id: 'heater-window', atMs: now - 2 * hour }),
      reportActivityFixture({ id: 'removed-previous', deviceId: 'removed', deviceName: 'Old heater', atMs: now - 7 * hour }),
      reportActivityFixture({ id: 'charger-previous', deviceId: 'charger', atMs: now - 5 * hour }),
      reportActivityFixture({ id: 'charger-window', deviceId: 'charger', atMs: now - 2 * hour }),
    ];
    const result = selectSupportReportActivity(reportHistoryFixture(entries), {
      ...request, subject: { kind: 'app', homeId: 'main' },
    }, now);
    if (result.state !== 'available') throw new Error('Expected available activity');
    expect(new Set(result.entries.map(fixtureIds(entries)))).toEqual(new Set([
      'heater-previous', 'heater-window', 'charger-previous', 'charger-window', 'removed-previous',
    ]));
    expect(result.entries.find((entry) => entry.deviceId === 'removed')?.deviceName).toBe('Old heater');
  });

  it('selects the prior 24 hours as instants across a local daylight-saving boundary, through capture', () => {
    const incident = Date.parse('2026-10-25T02:30:00+01:00');
    const entries = [
      reportActivityFixture({ id: 'prior', atMs: incident - 24 * hour - 1 }),
      reportActivityFixture({ id: 'start', atMs: incident - 24 * hour }),
      reportActivityFixture({ id: 'first-0230', atMs: Date.parse('2026-10-25T02:30:00+02:00') }),
      reportActivityFixture({ id: 'incident', atMs: incident }),
      reportActivityFixture({ id: 'after', atMs: incident + 1 }),
    ];
    const result = selectSupportReportActivity(reportHistoryFixture(entries), {
      ...request, occurredAtMs: incident, historyWindow: 'day',
    }, incident + hour);
    expect(result).toMatchObject({ state: 'available', fromMs: incident - 24 * hour, toMs: incident + hour });
    if (result.state !== 'available') throw new Error('Expected available activity');
    expect(result.entries.map(fixtureIds(entries))).toEqual(['after', 'incident', 'first-0230', 'start', 'prior']);
  });

  it('retains persistence metadata and projects only disclosed history fields', () => {
    const row = { ...reportActivityFixture(), accessToken: 'history-secret', rawDevice: { password: 'secret' } };
    const history = { ...reportHistoryFixture([row]), persistence: 'pending' as const };
    const result = selectSupportReportActivity(history, request, now);
    expect(result).toMatchObject({ state: 'available', persistence: 'pending' });
    expect(JSON.stringify(result)).not.toMatch(/history-secret|password|rawDevice|accessToken/);
  });

  it('preserves an empty retained window without fabricating historical state', () => {
    expect(selectSupportReportActivity(reportHistoryFixture(), {
      ...request, occurredAtMs: 1, historyWindow: 'day',
    }, now)).toEqual({
      state: 'available', entries: [], recordingsStartedAtMs: [], fromMs: 0, toMs: now,
      retentionDays: 7, maxEntries: 1000, maxEntriesPerDevice: 100, persistence: 'stored', leftOutForSize: 0,
    });
  });
});
