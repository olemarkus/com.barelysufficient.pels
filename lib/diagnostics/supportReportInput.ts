import type {
  SupportReportErrorCode, SupportReportRequest, SupportReportSubject,
} from '../../packages/contracts/src/supportReport';
import {
  SUPPORT_REPORT_EXPECTED_MAX_LENGTH, SUPPORT_REPORT_PROBLEM_MAX_LENGTH,
} from '../../packages/shared-domain/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';

export class SupportReportInputError extends Error {
  constructor(public readonly code: SupportReportErrorCode) {
    super(code);
  }
}

const readSubject = (raw: unknown): SupportReportSubject => {
  if (!isUnknownRecord(raw) || typeof raw.homeId !== 'string' || !raw.homeId.trim()
    || raw.homeId.length > 200) throw new SupportReportInputError('invalid_subject');
  if (raw.kind === 'app') return { kind: 'app', homeId: raw.homeId };
  if ((raw.kind === 'device' || raw.kind === 'device_support') && typeof raw.deviceId === 'string'
    && raw.deviceId.trim() && raw.deviceId.length <= 200) {
    return { kind: raw.kind, homeId: raw.homeId, deviceId: raw.deviceId };
  }
  throw new SupportReportInputError('invalid_subject');
};

export const readSupportReportRequest = (raw: unknown, nowMs: number): SupportReportRequest => {
  if (!isUnknownRecord(raw) || typeof raw.problem !== 'string' || !raw.problem.trim()
    || raw.problem.length > SUPPORT_REPORT_PROBLEM_MAX_LENGTH || typeof raw.expected !== 'string'
    || raw.expected.length > SUPPORT_REPORT_EXPECTED_MAX_LENGTH) {
    throw new SupportReportInputError('invalid_description');
  }
  if (typeof raw.occurredAtMs !== 'number' || !Number.isFinite(raw.occurredAtMs)
    || raw.occurredAtMs < 0 || raw.occurredAtMs > nowMs + 60_000) {
    throw new SupportReportInputError('invalid_time');
  }
  if (raw.historyWindow !== 'incident' && raw.historyWindow !== 'day') {
    throw new SupportReportInputError('invalid_window');
  }
  return {
    subject: readSubject(raw.subject), problem: raw.problem.trim(), expected: raw.expected.trim(),
    occurredAtMs: raw.occurredAtMs, historyWindow: raw.historyWindow,
  };
};
