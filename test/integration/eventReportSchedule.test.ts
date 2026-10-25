import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeviceEventStore } from '../../lib/diagnostics/deviceEventStore';
import {
  createEventReportStateStore, EVENT_REPORT_LOOKBACK_MS, EVENT_REPORTS_MAX_PER_DAY, EventReportSchedule,
} from '../../lib/diagnostics/eventReportSchedule';
import type {
  PreparedSupportReport, SupportReportRequest, SupportReportResponse,
} from '../../packages/contracts/src/supportReport';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { partialDouble } from '../helpers/partialDouble';

const NOW = Date.UTC(2026, 9, 25, 10, 0);
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const sent = (state: 'sent' | 'failed' | 'unknown'): SupportReportResponse => ({
  ok: true,
  report: partialDouble<PreparedSupportReport>({
    submission: state === 'sent' ? { state, reference: 'ref' } : { state },
  }),
});

describe('reports on specific events the owner turned on', () => {
  const databases: UserdataDatabase[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const db of databases.splice(0)) db.close();
  });
  const setup = (enabled: unknown, responses: SupportReportResponse[] = []) => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    databases.push(db);
    const values = new Map<string, unknown>([['event_diagnostics_reports', enabled]]);
    const settings: SettingsPort = {
      get: (key) => values.get(key), set: (key, value) => { values.set(key, value); },
      unset: (key) => { values.delete(key); }, getKeys: () => [...values.keys()],
    };
    const events = createDeviceEventStore(db);
    const sendOnEvent = vi.fn(async (_request: SupportReportRequest, _stillWanted: () => boolean) => (
      responses.shift() ?? sent('sent')));
    const state = createEventReportStateStore(db);
    // A new schedule per check is a restart: only the database carries over.
    const schedule = () => new EventReportSchedule(
      settings, state, events, { getHomeIdForDevice: () => 'main' }, { sendOnEvent });
    const unmatched = (atMs: number, chargerId = 'charger-1') => {
      vi.setSystemTime(atMs);
      events.record([chargerId, 'car-1'], {
        component: 'devices', event: 'ev_car_link_unmatched', chargerId, chargerName: 'Elbillader',
        connection: { atMs: atMs - 20 * MINUTE_MS, seen: 'plug_in' }, windowMs: 20 * MINUTE_MS,
        reason: 'no_connected_car', cars: [],
      });
    };
    return { values, events, sendOnEvent, schedule, unmatched };
  };

  it('sends a report about the charger when it could not identify the connected car, once', async () => {
    vi.useFakeTimers({ now: NOW });
    const { sendOnEvent, schedule, unmatched } = setup(true);
    unmatched(NOW - 5 * MINUTE_MS);
    await schedule().check(NOW);
    await schedule().check(NOW + 5 * MINUTE_MS);
    expect(sendOnEvent).toHaveBeenCalledExactlyOnceWith({
      subject: { kind: 'device', homeId: 'main', deviceId: 'charger-1' },
      problem: 'Sent because Elbillader was plugged in and PELS could not identify the connected car '
        + '(no_connected_car). The owner turned on reports on specific events.',
      expected: '',
      occurredAtMs: NOW - 25 * MINUTE_MS,
      historyWindow: 'incident',
    }, expect.any(Function));
  });

  it('sends nothing until the owner turns it on, and nothing for an event outside the lookback', async () => {
    vi.useFakeTimers({ now: NOW });
    const { sendOnEvent, schedule, unmatched, values } = setup(undefined);
    unmatched(NOW - 5 * MINUTE_MS);
    await schedule().check(NOW);
    values.set('event_diagnostics_reports', 'yes');
    await schedule().check(NOW);
    expect(sendOnEvent).not.toHaveBeenCalled();
    values.set('event_diagnostics_reports', true);
    await schedule().check(NOW - 5 * MINUTE_MS + EVENT_REPORT_LOOKBACK_MS + 1);
    expect(sendOnEvent).not.toHaveBeenCalled();
  });

  it('sends one report per charger a day, and tries again when one did not go out', async () => {
    vi.useFakeTimers({ now: NOW });
    const { sendOnEvent, schedule, unmatched } = setup(true, [{ ok: false, code: 'report_busy' }, sent('failed')]);
    unmatched(NOW - 5 * MINUTE_MS);
    await schedule().check(NOW);
    await schedule().check(NOW + 5 * MINUTE_MS);
    await schedule().check(NOW + 10 * MINUTE_MS);
    expect(sendOnEvent).toHaveBeenCalledTimes(3);
    unmatched(NOW + 12 * MINUTE_MS);
    await schedule().check(NOW + 15 * MINUTE_MS);
    expect(sendOnEvent).toHaveBeenCalledTimes(3);
    unmatched(NOW + DAY_MS + 12 * MINUTE_MS);
    await schedule().check(NOW + DAY_MS + 15 * MINUTE_MS);
    expect(sendOnEvent).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['report_busy', 2], ['capture_failed', 2], ['sender_unavailable', 2],
    ['app_store_required', 1], ['report_too_large', 1], ['invalid_subject', 1], ['consent_required', 1],
  ] as const)('after %s, tries again on a later check only when the report could still go out', async (code, calls) => {
    vi.useFakeTimers({ now: NOW });
    const { sendOnEvent, schedule, unmatched } = setup(true, [{ ok: false, code }]);
    unmatched(NOW - 5 * MINUTE_MS);
    await schedule().check(NOW);
    await schedule().check(NOW + 5 * MINUTE_MS);
    expect(sendOnEvent).toHaveBeenCalledTimes(calls);
  });

  it('never sends again after a report whose delivery is uncertain', async () => {
    vi.useFakeTimers({ now: NOW });
    const { sendOnEvent, schedule, unmatched } = setup(true, [sent('unknown')]);
    unmatched(NOW - 5 * MINUTE_MS);
    await schedule().check(NOW);
    await schedule().check(NOW + 5 * MINUTE_MS);
    expect(sendOnEvent).toHaveBeenCalledTimes(1);
  });

  it(`sends at most ${EVENT_REPORTS_MAX_PER_DAY} a day in all`, async () => {
    vi.useFakeTimers({ now: NOW });
    const { sendOnEvent, schedule, unmatched } = setup(true);
    for (let index = 0; index < EVENT_REPORTS_MAX_PER_DAY + 2; index += 1) {
      unmatched(NOW + index * 5 * MINUTE_MS, `charger-${index}`);
      await schedule().check(NOW + index * 5 * MINUTE_MS + MINUTE_MS);
    }
    expect(sendOnEvent).toHaveBeenCalledTimes(EVENT_REPORTS_MAX_PER_DAY);
  });

  it('asks again whether the owner still wants it once the report is prepared', async () => {
    vi.useFakeTimers({ now: NOW });
    const { sendOnEvent, schedule, unmatched, values } = setup(true);
    sendOnEvent.mockImplementationOnce(async (_request, stillWanted) => {
      values.set('event_diagnostics_reports', false);
      return stillWanted() ? sent('sent') : { ok: false, code: 'consent_required' };
    });
    unmatched(NOW - 5 * MINUTE_MS);
    await schedule().check(NOW);
    values.set('event_diagnostics_reports', true);
    await schedule().check(NOW + 5 * MINUTE_MS);
    expect(sendOnEvent).toHaveBeenCalledTimes(1);
  });

  it('ignores an event that does not ask for a report', async () => {
    vi.useFakeTimers({ now: NOW });
    const { events, sendOnEvent, schedule } = setup(true);
    events.record(['charger-1'], { component: 'devices', event: 'ev_car_link_plug_edge', deviceId: 'charger-1' });
    events.record(['charger-1'], { component: 'devices', event: 'ev_car_link_unmatched' });
    await schedule().check(NOW + MINUTE_MS);
    expect(sendOnEvent).not.toHaveBeenCalled();
  });
});
