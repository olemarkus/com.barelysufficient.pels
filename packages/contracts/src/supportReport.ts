import type { SettingsUiDeviceActivityEntry } from './settingsUiApi.js';

export type SupportReportSubject =
  | { kind: 'app'; homeId: string }
  | { kind: 'device'; homeId: string; deviceId: string };

/** User-authored incident description. Time is an instant, independent of the browser's timezone. */
export type SupportReportRequest = {
  subject: SupportReportSubject;
  problem: string;
  expected: string;
  occurredAtMs: number;
  historyWindow: 'incident' | 'day';
};

export type SupportReportValue = string | number | boolean | null
  | readonly SupportReportValue[] | { readonly [key: string]: SupportReportValue };

/** Explicitly selected diagnostic sections; never a raw Homey/settings object. */
export type SupportReportSection = {
  title: string;
  values: { readonly [key: string]: SupportReportValue };
};

export type SupportReportActivity =
  | {
    state: 'available';
    entries: readonly SettingsUiDeviceActivityEntry[];
    fromMs: number;
    toMs: number;
    retentionDays: number;
    maxEntries: number;
    maxEntriesPerDevice: number;
    persistence: 'stored' | 'pending';
  }
  | { state: 'unavailable'; reason: string };

export type SupportReportEvidence = {
  subjectName: string;
  appVersion: string;
  homeyVersion: string;
  activity: SupportReportActivity;
  sections: readonly SupportReportSection[];
  omissions: readonly string[];
};

/** Immutable snapshot prepared for one explicit user submission. */
export type SupportReportDocument = SupportReportEvidence & {
  version: 1;
  id: string;
  capturedAtMs: number;
  request: SupportReportRequest;
};

export type SupportReportAvailability = 'available' | 'app_store_required' | 'unavailable';
export type SupportReportSubmission =
  | { state: 'draft' }
  | { state: 'sending' }
  | { state: 'sent'; reference: string }
  | { state: 'failed'; reason: string }
  | { state: 'unknown' };

export type PreparedSupportReport = {
  document: SupportReportDocument;
  message: string;
  bytes: number;
  expiresAtMs: number;
  availability: SupportReportAvailability;
  submission: SupportReportSubmission;
};

export type SupportReportErrorCode = 'invalid_description' | 'invalid_time' | 'invalid_subject'
  | 'invalid_window' | 'report_expired' | 'report_too_large' | 'report_busy'
  | 'consent_required' | 'app_store_required' | 'sender_unavailable' | 'capture_failed';

export type SupportReportResponse =
  | { ok: true; report: PreparedSupportReport }
  | { ok: false; code: SupportReportErrorCode };
