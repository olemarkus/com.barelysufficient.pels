import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gzipSupportReportJson } from '../../lib/diagnostics/supportReportEncoding';
import type {
  SupportReportDocument, SupportReportLog, SupportReportValue,
} from '../../packages/contracts/src/supportReport';
import { REPORT_CAPTURE_MS, reportActivityFixture } from '../helpers/supportReportEvidenceFixtures';

const logs: SupportReportLog[] = [
  {
    state: 'available',
    fromMs: 0,
    toMs: REPORT_CAPTURE_MS,
    leftOutForSize: 1,
    lines: [
      { atMs: 10, level: 'info', entry: { note: '温度🌡'.repeat(12_000) } },
      ...Array.from({ length: 300 }, (_, i) => ({
        atMs: 20 + i, level: 'warn' as const, entry: { index: i, note: 'Lone surrogate \ud800' },
      })),
    ],
    omittedEvents: [],
    overflow: [{ hourStartMs: 0, key: 'temperature', dropped: 2 }],
  },
  { state: 'unavailable', reason: 'No retained log.' },
];

describe('support report encoding', () => {
  it.each(logs)('preserves UTF-8 JSON and gzip bytes with a $state log', async (log) => {
    const document: SupportReportDocument = {
      trigger: 'owner',
      request: {
        subject: { kind: 'app', homeId: 'main' },
        problem: 'Først\n再度',
        expected: '🌡',
        occurredAtMs: REPORT_CAPTURE_MS,
        historyWindow: 'day',
      },
      version: 1,
      id: 'report',
      capturedAtMs: REPORT_CAPTURE_MS,
      subjectName: 'PELS',
      appVersion: '1.0',
      homeyVersion: '1.0',
      activity: {
        state: 'available', entries: [reportActivityFixture()], recordingsStartedAtMs: [10],
        fromMs: 0, toMs: REPORT_CAPTURE_MS, retentionDays: 7, maxEntries: 1000, maxEntriesPerDevice: 100,
        persistence: 'stored', leftOutForSize: 0,
      },
      deviceEvents: {
        state: 'available',
        entries: [{ id: 'event', event: 'temperature', atMs: 42, deviceIds: ['heater'], details: { value: 12 } }],
        deviceIds: 'all', fromMs: 0, toMs: REPORT_CAPTURE_MS, retentionDays: 7, maxEntriesPerDevice: 100, leftOut: 0,
      },
      log,
      sections: [{
        title: 'Temperatur',
        values: {
          name: 'Snow ❄ and lone surrogate \udfff',
          devices: new Array<SupportReportValue>(1),
        },
      }],
      omissions: [],
    };

    const expected = Buffer.from(JSON.stringify(document));
    const { buffer, jsonBytes } = await gzipSupportReportJson(document);

    expect(gunzipSync(buffer).equals(expected)).toBe(true);
    expect(buffer.equals(gzipSync(expected))).toBe(true);
    expect(jsonBytes).toBe(expected.length);
  });
});
