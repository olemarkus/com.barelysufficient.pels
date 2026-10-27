import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import type {
  SupportReportEvidence, SupportReportRequest, SupportReportResponse,
} from '../../packages/contracts/src/supportReport';
import { SUPPORT_REPORT_MAX_BYTES, SupportReportService } from '../../lib/diagnostics/supportReportService';
import type { SupportReportDelivery, SupportReportTransport } from '../../lib/diagnostics/homeyReportTransport';
import { reportActivityFixture } from '../helpers/supportReportEvidenceFixtures';

const now = Date.UTC(2026, 9, 23, 12);
const request: SupportReportRequest = {
  subject: { kind: 'device', homeId: 'main', deviceId: 'heater' },
  problem: 'Heater did not resume.', expected: 'Resume when capacity is available.',
  occurredAtMs: now, historyWindow: 'incident',
};
const evidence = (): SupportReportEvidence => ({
  subjectName: 'Hall heater', appVersion: '3.21.0', homeyVersion: '12.3.0',
  activity: { state: 'unavailable', reason: 'No retained history for this home.' },
  deviceEvents: { state: 'unavailable', reason: 'No kept device events.' },
  log: { state: 'available', lines: [], overflow: [], fromMs: now - 60 * 60_000, toMs: now, leftOutForSize: 0, omittedEvents: [] },
  sections: [{ title: 'Current device state', values: { target: 22 } }], omissions: [],
});
const transport = (): SupportReportTransport => ({
  availability: vi.fn(async () => 'available' as const),
  send: vi.fn(async () => ({ state: 'accepted' as const, reference: 'homey-reference' })),
});
const report = (response: SupportReportResponse) => {
  if (!response.ok) throw Error(response.code);
  return response.report;
};

describe('manual support reporting', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends the frozen preview even after live state and returned preview objects change', async () => {
    const live = evidence();
    const delivery = transport();
    const source = { capture: vi.fn(async () => live) };
    const service = new SupportReportService(source, delivery);
    const preview = report(await service.prepare(request));
    const message = preview.message;
    live.subjectName = 'Renamed later';
    preview.document.subjectName = 'Changed by caller';
    preview.message = 'Changed by caller';
    expect(delivery.send).not.toHaveBeenCalled();
    const result = report(await service.send(preview.document.id, { consent: true }));
    expect(delivery.send).toHaveBeenCalledExactlyOnceWith(message);
    expect(source.capture).toHaveBeenCalledTimes(1);
    expect(result.document.subjectName).toBe('Hall heater');
    expect(result.submission).toEqual({ state: 'sent', reference: 'homey-reference' });
    expect(message).toContain(`END PELS REPORT ${preview.document.id}`);
  });

  it('requires explicit consent and rejects malformed input without capturing evidence', async () => {
    const source = { capture: vi.fn(async () => evidence()) };
    const delivery = transport();
    const service = new SupportReportService(source, delivery);
    for (const raw of [null, {}, { ...request, problem: '' }, { ...request, problem: 'x'.repeat(1501) }]) {
      expect(await service.prepare(raw)).toEqual({ ok: false, code: 'invalid_description' });
    }
    expect(await service.prepare({ ...request, occurredAtMs: NaN })).toEqual({ ok: false, code: 'invalid_time' });
    expect(await service.prepare({ ...request, occurredAtMs: now + 61_000 }))
      .toEqual({ ok: false, code: 'invalid_time' });
    expect(await service.prepare({ ...request, subject: { kind: 'app' } }))
      .toEqual({ ok: false, code: 'invalid_subject' });
    expect(source.capture).not.toHaveBeenCalled();
    const preview = report(await service.prepare(request));
    expect(await service.send(preview.document.id, {})).toEqual({ ok: false, code: 'consent_required' });
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('checks UTF-8 bytes and refuses oversized evidence without silently clipping it', async () => {
    const live = evidence();
    live.sections = [{ title: 'Unicode', values: { text: 'ø'.repeat(SUPPORT_REPORT_MAX_BYTES / 2) } }];
    const delivery = transport();
    const service = new SupportReportService({ capture: async () => live }, delivery);
    expect(await service.prepare(request)).toEqual({ ok: false, code: 'report_too_large' });
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('leaves out the oldest log lines, and says how many, when the log would make it too large', async () => {
    const live = evidence();
    const lines = Array.from({ length: 2_000 }, (_, index) => ({
      atMs: now - 2_000 + index, level: 'info' as const, entry: { event: `line-${index}`, filler: 'x'.repeat(400) },
    }));
    live.log = { state: 'available', lines, overflow: [], fromMs: now - 3_600_000, toMs: now, leftOutForSize: 0, omittedEvents: [] };
    const service = new SupportReportService({ capture: async () => live }, transport());
    const prepared = report(await service.prepare(request));
    expect(Buffer.byteLength(prepared.message, 'utf8')).toBeLessThanOrEqual(SUPPORT_REPORT_MAX_BYTES);
    if (prepared.document.log.state !== 'available') throw new Error('Expected the log');
    const { leftOutForSize } = prepared.document.log;
    expect(leftOutForSize).toBeGreaterThan(0);
    expect(prepared.document.log.lines[0]?.entry.event).toBe(`line-${leftOutForSize}`);
    expect(prepared.document.log.lines.at(-1)?.entry.event).toBe('line-1999');
  });

  it('fits a daily report at every cap by leaving out the oldest log, then the oldest activity', async () => {
    const live = evidence();
    // Every part at its cap on a busy install: a full log and 1,000 activity entries.
    const lines = Array.from({ length: 1_000 }, (_, index) => ({
      atMs: now - 1_000 + index, level: 'info' as const, entry: { event: `line-${index}`, filler: 'x'.repeat(250) },
    }));
    live.log = { state: 'available', lines, overflow: [], fromMs: now - 86_400_000, toMs: now, leftOutForSize: 0, omittedEvents: [] };
    // Newest first, as the activity history keeps them.
    const entries = Array.from({ length: 1_000 }, (_, index) => reportActivityFixture({
      id: `activity-${index}`, atMs: now - index, deviceId: `device-${index % 30}`,
      statusMsg: 'Kept at its limited temperature while the hour is near its limit. '.repeat(6),
    }));
    live.activity = {
      state: 'available', entries, fromMs: now - 86_400_000, toMs: now, retentionDays: 7, maxEntries: 1_000,
      maxEntriesPerDevice: 100, persistence: 'stored', leftOutForSize: 0, recordingsStartedAtMs: [],
    };
    const delivery = transport();
    const service = new SupportReportService({ capture: async () => live }, delivery);
    expect(await service.prepare({ ...request, subject: { kind: 'app', homeId: 'main' }, historyWindow: 'day' }))
      .toEqual({ ok: false, code: 'report_too_large' });
    const sent = report(await service.sendDaily(() => true));
    expect(Buffer.byteLength(sent.message, 'utf8')).toBeLessThanOrEqual(SUPPORT_REPORT_MAX_BYTES);
    if (sent.document.log.state !== 'available' || sent.document.activity.state !== 'available') {
      throw new Error('Expected the log and the activity');
    }
    expect(sent.document.log.lines).toEqual([]);
    expect(sent.document.log.leftOutForSize).toBe(1_000);
    const { leftOutForSize } = sent.document.activity;
    expect(leftOutForSize).toBeGreaterThan(0);
    expect(sent.document.activity.entries).toHaveLength(1_000 - leftOutForSize);
    expect(sent.document.activity.entries[0]?.atMs).toBe(now);
    expect(sent.submission).toEqual({ state: 'sent', reference: 'homey-reference' });
  });

  it('sends the daily report as a report about the whole app over the last day, named as such', async () => {
    const delivery = transport();
    const source = { capture: vi.fn(async () => evidence()) };
    const service = new SupportReportService(source, delivery);
    const sent = report(await service.sendDaily(() => true));
    expect(source.capture).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      subject: { kind: 'app', homeId: 'main' }, historyWindow: 'day', occurredAtMs: now,
    }), now);
    expect(sent.document.trigger).toBe('daily');
    expect(sent.submission).toEqual({ state: 'sent', reference: 'homey-reference' });
    expect(delivery.send).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"trigger":"daily"'));
  });

  it('sends a report on an event as asked, named as such, and trims its activity like the daily one', async () => {
    const live = evidence();
    live.activity = {
      state: 'available', fromMs: now - 3_600_000, toMs: now, retentionDays: 7, maxEntries: 1_000,
      maxEntriesPerDevice: 100, persistence: 'stored', leftOutForSize: 0, recordingsStartedAtMs: [],
      entries: Array.from({ length: 1_000 }, (_, index) => reportActivityFixture({
        id: `activity-${index}`, atMs: now - index, statusMsg: 'Waiting for a car to be identified. '.repeat(12),
      })),
    };
    const delivery = transport();
    const source = { capture: vi.fn(async () => live) };
    const service = new SupportReportService(source, delivery);
    const sent = report(await service.sendOnEvent(request, () => true));
    expect(source.capture).toHaveBeenCalledExactlyOnceWith(request, now);
    expect(sent.document.trigger).toBe('event');
    expect(sent.document.activity.state === 'available' && sent.document.activity.leftOutForSize).toBeGreaterThan(0);
    expect(delivery.send).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"trigger":"event"'));
  });

  it('lets a report Homey refused be sent again at once', async () => {
    const delivery = transport();
    vi.mocked(delivery.send).mockResolvedValueOnce({ state: 'rejected' });
    const service = new SupportReportService({ capture: async () => evidence() }, delivery);
    const refused = report(await service.prepare(request));
    expect(report(await service.send(refused.document.id, { consent: true })).submission).toEqual({ state: 'failed' });
    const again = report(await service.prepare(request));
    expect(report(await service.send(again.document.id, { consent: true })).submission.state).toBe('sent');
    const third = report(await service.prepare(request));
    expect(await service.send(third.document.id, { consent: true })).toEqual({ ok: false, code: 'report_busy' });
  });

  it('sends no daily report the owner turned off while it was prepared, and captures none it cannot send', async () => {
    const delivery = transport();
    const source = { capture: vi.fn(async () => evidence()) };
    const service = new SupportReportService(source, delivery);
    expect(await service.sendDaily(() => false)).toEqual({ ok: false, code: 'consent_required' });
    expect(delivery.send).not.toHaveBeenCalled();
    vi.mocked(delivery.availability).mockResolvedValue('app_store_required');
    source.capture.mockClear();
    expect(await service.sendDaily(() => true)).toEqual({ ok: false, code: 'app_store_required' });
    expect(source.capture).not.toHaveBeenCalled();
  });

  it('marks a report the owner sent as theirs', async () => {
    const service = new SupportReportService({ capture: async () => evidence() }, transport());
    expect(report(await service.prepare(request)).document.trigger).toBe('owner');
  });

  it('expires drafts and bounds retained previews while allowing repeated edits', async () => {
    const service = new SupportReportService({ capture: async () => evidence() }, transport());
    const first = report(await service.prepare(request));
    for (let i = 0; i < 4; i += 1) report(await service.prepare(request));
    expect(service.get(first.document.id)).toEqual({ ok: false, code: 'report_expired' });
    const latest = report(await service.prepare(request));
    vi.advanceTimersByTime(15 * 60_000);
    expect(await service.send(latest.document.id, { consent: true })).toEqual({ ok: false, code: 'report_expired' });
  });

  it('rechecks installation origin and keeps a local preview available for copying', async () => {
    const delivery = transport();
    const service = new SupportReportService({ capture: async () => evidence() }, delivery);
    const preview = report(await service.prepare(request));
    vi.mocked(delivery.availability).mockResolvedValue('app_store_required');
    expect(await service.send(preview.document.id, { consent: true })).toEqual({ ok: false, code: 'app_store_required' });
    expect(report(service.get(preview.document.id)).message).toBe(preview.message);
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('serializes concurrent sends and returns the original outcome on repeat requests', async () => {
    let finish!: (result: SupportReportDelivery) => void;
    const delivery = transport();
    vi.mocked(delivery.send).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const service = new SupportReportService({ capture: async () => evidence() }, delivery);
    const first = report(await service.prepare(request));
    const second = report(await service.prepare(request));
    const sending = service.send(first.document.id, { consent: true });
    expect(report(await service.send(first.document.id, { consent: true })).submission.state).toBe('sending');
    expect(await service.send(second.document.id, { consent: true })).toEqual({ ok: false, code: 'report_busy' });
    await Promise.resolve();
    finish({ state: 'accepted', reference: 'receipt' });
    await sending;
    expect(report(await service.send(first.document.id, { consent: true })).submission.state).toBe('sent');
    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(await service.send(second.document.id, { consent: true })).toEqual({ ok: false, code: 'report_busy' });
    vi.advanceTimersByTime(60_000);
    vi.mocked(delivery.send).mockResolvedValue({ state: 'accepted', reference: '' });
    expect(report(await service.send(second.document.id, { consent: true })).submission.state).toBe('sent');
  });

  it.each(['unknown', 'rejected'] as const)('never automatically retries a %s submission', async (state) => {
    const delivery = transport();
    vi.mocked(delivery.send).mockResolvedValue({ state });
    const service = new SupportReportService({ capture: async () => evidence() }, delivery);
    const preview = report(await service.prepare(request));
    const result = report(await service.send(preview.document.id, { consent: true }));
    expect(result.submission.state).toBe(state === 'rejected' ? 'failed' : 'unknown');
    await service.send(preview.document.id, { consent: true });
    expect(delivery.send).toHaveBeenCalledTimes(1);
  });
});
