import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import type {
  PreparedSupportReport, SupportReportEvidence, SupportReportRequest, SupportReportResponse,
} from '../../packages/contracts/src/supportReport';
import { SUPPORT_REPORT_MAX_BYTES, SupportReportService } from '../../lib/diagnostics/supportReportService';
import type { SupportReportDelivery, SupportReportTransport } from '../../lib/diagnostics/homeyReportTransport';
import {
  decodeReportMessage, incompressibleText, reportActivityFixture,
} from '../helpers/supportReportEvidenceFixtures';

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
const carried = (prepared: PreparedSupportReport) => decodeReportMessage(prepared.message);

describe('manual support reporting', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['owner', 'daily', 'event'] as const)(
    'names the %s report and its description in plain text ahead of the compressed evidence', async (trigger) => {
      const delivery = transport();
      const service = new SupportReportService({ capture: async () => evidence() }, delivery);
      const prepare = {
        owner: () => service.prepare(request),
        daily: () => service.sendDaily(() => true),
        event: () => service.sendOnEvent(request, () => true),
      };
      const prepared = report(await prepare[trigger]());
      const lines = prepared.message.trimEnd().split('\n');
      expect(lines[0]).toBe('PELS PROBLEM REPORT V2');
      expect(lines[1]).toBe(`Type: ${trigger}, ${trigger === 'daily' ? 'app' : 'device'}`);
      expect(lines[2]).toBe(`Description: ${carried(prepared).request.problem}`);
      expect(lines.at(-1)).toBe(`END PELS REPORT ${prepared.document.id}`);
      expect(carried(prepared)).toMatchObject({ trigger, id: prepared.document.id, subjectName: 'Hall heater' });
      expect(carried(prepared).sections).toEqual(evidence().sections);
      if (trigger !== 'daily') {
        expect(prepared.document.request).toEqual(request);
        expect(lines[3]).toBe(`Expected: ${request.expected}`);
      }
    },
  );

  it('reads a description that spans lines back from the data line', async () => {
    const multiLine = { ...request, problem: 'First line.\nEND PELS REPORT not-this-one\nThird line.' };
    const prepared = report(await new SupportReportService({ capture: async () => evidence() }, transport()).prepare(multiLine));
    expect(prepared.message).toContain('Description: First line.\nEND PELS REPORT not-this-one\nThird line.\n');
    expect(carried(prepared).request.problem).toBe(multiLine.problem);
  });

  it('carries a busy home\'s whole day of log without leaving a line out', async () => {
    const live = evidence();
    const lines = Array.from({ length: 2_500 }, (_, index) => ({
      atMs: now - 2_500_000 + index * 1_000, level: 'info' as const,
      entry: {
        event: 'plan_rebuild_completed', rebuildId: `rb_${index}`, totalKw: 4 + (index % 37) / 10,
        softLimitKw: 5 + (index % 11) / 10, hadShedding: index % 2 === 0,
        detail: 'controlled devices, planned shed devices, pending planned shed devices '.repeat(6),
      },
    }));
    live.log = { state: 'available', lines, overflow: [], fromMs: now - 86_400_000, toMs: now, leftOutForSize: 0, omittedEvents: [] };
    const sent = report(await new SupportReportService({ capture: async () => live }, transport()).sendDaily(() => true));
    expect(Buffer.byteLength(JSON.stringify(lines), 'utf8')).toBeGreaterThan(SUPPORT_REPORT_MAX_BYTES * 2);
    expect(Buffer.byteLength(sent.message, 'utf8')).toBeLessThanOrEqual(SUPPORT_REPORT_MAX_BYTES);
    const { log } = carried(sent);
    if (log.state !== 'available') throw new Error('Expected the log');
    expect(log.leftOutForSize).toBe(0);
    expect(log.lines).toHaveLength(2_500);
  });

  it('keeps warnings and errors while ordinary log lines can make room, however old', async () => {
    const live = evidence();
    const lines = Array.from({ length: 2_000 }, (_, index) => ({
      atMs: now - 2_000 + index, level: index % 500 === 0 ? 'error' as const : 'info' as const,
      entry: { event: `line-${index}`, filler: incompressibleText(400) },
    }));
    live.log = { state: 'available', lines, overflow: [], fromMs: now - 3_600_000, toMs: now, leftOutForSize: 0, omittedEvents: [] };
    const prepared = report(await new SupportReportService({ capture: async () => live }, transport()).prepare(request));
    const { log } = carried(prepared);
    if (log.state !== 'available') throw new Error('Expected the log');
    expect(log.leftOutForSize).toBeGreaterThan(0);
    expect(log.lines.filter((line) => line.level === 'error').map((line) => line.entry.event))
      .toEqual(['line-0', 'line-500', 'line-1000', 'line-1500']);
    expect(log.lines[0]?.entry.event).toBe('line-0');
    expect(log.lines.at(-1)?.entry.event).toBe('line-1999');
  });

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
    expect(source.capture).toHaveBeenCalledExactlyOnceWith(request, now, 'owner');
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

  it('checks the encoded size and refuses oversized evidence without silently clipping it', async () => {
    const live = evidence();
    live.sections = [{ title: 'Unicode', values: { text: incompressibleText(SUPPORT_REPORT_MAX_BYTES * 2) } }];
    const delivery = transport();
    const service = new SupportReportService({ capture: async () => live }, delivery);
    expect(await service.prepare(request)).toEqual({ ok: false, code: 'report_too_large' });
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('leaves out the oldest log lines, and says how many, when the log would make it too large', async () => {
    const live = evidence();
    const lines = Array.from({ length: 2_000 }, (_, index) => ({
      atMs: now - 2_000 + index, level: 'info' as const, entry: { event: `line-${index}`, filler: incompressibleText(400) },
    }));
    live.log = { state: 'available', lines, overflow: [], fromMs: now - 3_600_000, toMs: now, leftOutForSize: 0, omittedEvents: [] };
    const service = new SupportReportService({ capture: async () => live }, transport());
    const prepared = report(await service.prepare(request));
    expect(Buffer.byteLength(prepared.message, 'utf8')).toBeLessThanOrEqual(SUPPORT_REPORT_MAX_BYTES);
    const { log } = carried(prepared);
    if (log.state !== 'available') throw new Error('Expected the log');
    const { leftOutForSize } = log;
    expect(leftOutForSize).toBeGreaterThan(0);
    expect(log.lines[0]?.entry.event).toBe(`line-${leftOutForSize}`);
    expect(log.lines.at(-1)?.entry.event).toBe('line-1999');
  });

  it('fits a daily report at every cap by leaving out the oldest log, then the oldest activity', async () => {
    const live = evidence();
    // Every part at its cap on a busy install: a full log and 1,000 activity entries.
    const lines = Array.from({ length: 1_000 }, (_, index) => ({
      atMs: now - 1_000 + index, level: 'info' as const, entry: { event: `line-${index}`, filler: incompressibleText(250) },
    }));
    live.log = { state: 'available', lines, overflow: [], fromMs: now - 86_400_000, toMs: now, leftOutForSize: 0, omittedEvents: [] };
    // Newest first, as the activity history keeps them.
    const entries = Array.from({ length: 1_000 }, (_, index) => reportActivityFixture({
      id: `activity-${index}`, atMs: now - index, deviceId: `device-${index % 30}`,
      statusMsg: incompressibleText(800),
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
    const { log, activity } = carried(sent);
    if (log.state !== 'available' || activity.state !== 'available') {
      throw new Error('Expected the log and the activity');
    }
    expect(log.lines).toEqual([]);
    expect(log.leftOutForSize).toBe(1_000);
    const { leftOutForSize } = activity;
    expect(leftOutForSize).toBeGreaterThan(0);
    expect(activity.entries).toHaveLength(1_000 - leftOutForSize);
    expect(activity.entries[0]?.atMs).toBe(now);
    expect(sent.submission).toEqual({ state: 'sent', reference: 'homey-reference' });
  });

  it('sends the daily report as a report about the whole app over the last day, named as such', async () => {
    const delivery = transport();
    const source = { capture: vi.fn(async () => evidence()) };
    const service = new SupportReportService(source, delivery);
    const sent = report(await service.sendDaily(() => true));
    expect(source.capture).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      subject: { kind: 'app', homeId: 'main' }, historyWindow: 'day', occurredAtMs: now,
    }), now, 'daily');
    expect(carried(sent).trigger).toBe('daily');
    expect(sent.submission).toEqual({ state: 'sent', reference: 'homey-reference' });
    expect(delivery.send).toHaveBeenCalledExactlyOnceWith(sent.message);
  });

  // The capture took the heating section's size out of the log budget, so
  // the log's oldest lines make room for it; it gives way before any activity.
  const logLines = (count: number) => Array.from({ length: count }, (_, index) => ({
    atMs: now - index, level: 'info' as const, entry: { event: 'ordinary-evidence', text: incompressibleText(1_000) },
  }));

  it('keeps a daily report\'s heating observations and leaves the oldest log lines out instead', async () => {
    const live = evidence();
    if (live.log.state !== 'available') throw new Error('Expected the kept log');
    live.log = { ...live.log, lines: logLines(40) };
    live.sections = [
      { title: 'Ordinary evidence', values: { text: incompressibleText(SUPPORT_REPORT_MAX_BYTES - 50_000) } },
      { title: 'Daily heating observations', values: { text: incompressibleText(20_000) } },
    ];
    const sent = report(await new SupportReportService({ capture: async () => live }, transport()).sendDaily(() => true));
    expect(carried(sent).sections.map((section) => section.title))
      .toEqual(['Ordinary evidence', 'Daily heating observations']);
    expect(carried(sent).omissions).toEqual([]);
    const { log } = carried(sent);
    expect(log.state === 'available' && log.leftOutForSize).toBeGreaterThan(0);
    expect(Buffer.byteLength(sent.message, 'utf8')).toBeLessThanOrEqual(SUPPORT_REPORT_MAX_BYTES);
  });

  it('leaves the heating observations out before any activity once no log line can make room', async () => {
    const live = evidence();
    live.activity = {
      state: 'available', fromMs: now - 3_600_000, toMs: now, retentionDays: 7, maxEntries: 1_000,
      maxEntriesPerDevice: 100, persistence: 'stored', leftOutForSize: 0, recordingsStartedAtMs: [],
      entries: [reportActivityFixture({ id: 'activity-0', atMs: now })],
    };
    live.sections = [
      { title: 'Ordinary evidence', values: { text: incompressibleText(SUPPORT_REPORT_MAX_BYTES - 10_000) } },
      { title: 'Daily heating observations', values: { text: incompressibleText(20_000) } },
    ];
    const delivery = transport();
    const sent = report(await new SupportReportService({ capture: async () => live }, delivery).sendDaily(() => true));
    expect(carried(sent).sections.map((section) => section.title)).toEqual(['Ordinary evidence']);
    expect(carried(sent).omissions).toContain('Daily heating observations was left out to fit the report size limit.');
    expect(carried(sent).activity).toEqual(live.activity);
    expect(Buffer.byteLength(sent.message, 'utf8')).toBeLessThanOrEqual(SUPPORT_REPORT_MAX_BYTES);
    expect(delivery.send).toHaveBeenCalledTimes(1);
  });

  it('sends a report on an event as asked, named as such, and trims its activity like the daily one', async () => {
    const live = evidence();
    live.activity = {
      state: 'available', fromMs: now - 3_600_000, toMs: now, retentionDays: 7, maxEntries: 1_000,
      maxEntriesPerDevice: 100, persistence: 'stored', leftOutForSize: 0, recordingsStartedAtMs: [],
      entries: Array.from({ length: 1_000 }, (_, index) => reportActivityFixture({
        id: `activity-${index}`, atMs: now - index, statusMsg: incompressibleText(600),
      })),
    };
    const delivery = transport();
    const source = { capture: vi.fn(async () => live) };
    const service = new SupportReportService(source, delivery);
    const sent = report(await service.sendOnEvent(request, () => true));
    expect(source.capture).toHaveBeenCalledExactlyOnceWith(request, now, 'event');
    expect(carried(sent).trigger).toBe('event');
    const { activity } = carried(sent);
    expect(activity.state === 'available' && activity.leftOutForSize).toBeGreaterThan(0);
    expect(delivery.send).toHaveBeenCalledExactlyOnceWith(sent.message);
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
    expect(carried(report(await service.prepare(request))).trigger).toBe('owner');
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
