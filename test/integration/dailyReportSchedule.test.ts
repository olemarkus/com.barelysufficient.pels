import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDailyReportStateStore, DAILY_REPORT_INTERVAL_MS, DAILY_REPORT_RETRY_MS, DailyReportSchedule,
} from '../../lib/diagnostics/dailyReportSchedule';
import type { PreparedSupportReport, SupportReportResponse } from '../../packages/contracts/src/supportReport';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { partialDouble } from '../helpers/partialDouble';

const NOW = Date.UTC(2026, 9, 25, 3, 0);
const sent = (state: 'sent' | 'failed' | 'unknown'): SupportReportResponse => ({
  ok: true,
  report: partialDouble<PreparedSupportReport>({
    submission: state === 'sent' ? { state, reference: 'ref' } : { state },
  }),
});

describe('the daily diagnostics report the owner turned on', () => {
  const databases: UserdataDatabase[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  const setup = (enabled: unknown, responses: SupportReportResponse[]) => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    databases.push(db);
    const values = new Map<string, unknown>([['daily_diagnostics_report', enabled]]);
    const settings: SettingsPort = {
      get: (key) => values.get(key), set: (key, value) => { values.set(key, value); },
      unset: (key) => { values.delete(key); }, getKeys: () => [...values.keys()],
    };
    const sendDaily = vi.fn(async (_stillWanted: () => boolean) => responses.shift() ?? sent('sent'));
    const state = createDailyReportStateStore(db);
    const schedule = () => new DailyReportSchedule(settings, state, { sendDaily });
    return { values, sendDaily, schedule, state };
  };

  it('sends nothing until the owner turns it on', async () => {
    const { sendDaily, schedule, values } = setup(undefined, []);
    await schedule().check(NOW);
    values.set('daily_diagnostics_report', 'yes');
    await schedule().check(NOW);
    expect(sendDaily).not.toHaveBeenCalled();
  });

  it('sends once a day, and remembers it across a restart', async () => {
    const { sendDaily, schedule } = setup(true, []);
    await schedule().check(NOW);
    await schedule().check(NOW + DAILY_REPORT_INTERVAL_MS - 1);
    expect(sendDaily).toHaveBeenCalledTimes(1);
    await schedule().check(NOW + DAILY_REPORT_INTERVAL_MS);
    expect(sendDaily).toHaveBeenCalledTimes(2);
  });

  it('tries again in a few hours when a report could not go out, but never resends an uncertain one', async () => {
    const failed = setup(true, [sent('failed')]);
    await failed.schedule().check(NOW);
    await failed.schedule().check(NOW + DAILY_REPORT_RETRY_MS);
    expect(failed.sendDaily).toHaveBeenCalledTimes(2);
    const uncertain = setup(true, [sent('unknown')]);
    await uncertain.schedule().check(NOW);
    await uncertain.schedule().check(NOW + DAILY_REPORT_RETRY_MS);
    expect(uncertain.sendDaily).toHaveBeenCalledTimes(1);
  });

  it('checks only daily on an install that cannot send at all', async () => {
    const { sendDaily, schedule } = setup(true, [{ ok: false, code: 'app_store_required' }]);
    await schedule().check(NOW);
    await schedule().check(NOW + DAILY_REPORT_RETRY_MS);
    expect(sendDaily).toHaveBeenCalledTimes(1);
  });

  it('never sends twice after a send that did not finish', async () => {
    const { sendDaily, schedule } = setup(true, []);
    sendDaily.mockImplementationOnce(async () => { throw new Error('the app stopped mid-send'); });
    await schedule().check(NOW);
    await schedule().check(NOW + DAILY_REPORT_RETRY_MS);
    expect(sendDaily).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when it cannot record that a report is going out', async () => {
    const { sendDaily, state } = setup(true, []);
    const failing = { ...state, writeNextAttemptAtMs: () => { throw new Error('disk full'); } };
    const values = new Map<string, unknown>([['daily_diagnostics_report', true]]);
    const settings: SettingsPort = {
      get: (key) => values.get(key), set: vi.fn(), unset: vi.fn(), getKeys: () => [...values.keys()],
    };
    await new DailyReportSchedule(settings, failing, { sendDaily }).check(NOW);
    expect(sendDaily).not.toHaveBeenCalled();
  });

  it('does not wait for a due time written while the clock ran days ahead', async () => {
    const { sendDaily, schedule, state } = setup(true, []);
    state.writeNextAttemptAtMs(NOW + 3 * DAILY_REPORT_INTERVAL_MS);
    await schedule().check(NOW);
    expect(sendDaily).toHaveBeenCalledTimes(1);
    expect(state.readNextAttemptAtMs()).toBe(NOW + DAILY_REPORT_INTERVAL_MS);
  });

  it('asks again whether the owner still wants it once the report is prepared', async () => {
    const { sendDaily, schedule, values } = setup(true, []);
    sendDaily.mockImplementationOnce(async (stillWanted) => {
      values.set('daily_diagnostics_report', false);
      return stillWanted() ? sent('sent') : { ok: false, code: 'consent_required' };
    });
    await schedule().check(NOW);
    expect(sendDaily).toHaveBeenCalledTimes(1);
  });
});
