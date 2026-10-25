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

/**
 * Something PELS observed or decided about a device, as its structured-log
 * event recorded it, such as a car link it waited for and gave up on.
 */
export type SupportReportDeviceEvent = {
  id: string;
  atMs: number;
  /** Every device the event is about. */
  deviceIds: readonly string[];
  event: string;
  details: { readonly [key: string]: SupportReportValue };
};

export type SupportReportDeviceEvents =
  | {
    state: 'available';
    entries: readonly SupportReportDeviceEvent[];
    /** The reported device and the devices related to it, such as a charger's selected cars. */
    deviceIds: readonly string[];
    fromMs: number;
    toMs: number;
    retentionDays: number;
    maxEntriesPerDevice: number;
    /** Kept events left out, the furthest from the incident first, so the report stays within its size. */
    leftOut: number;
  }
  | { state: 'unavailable'; reason: string };

export type SupportReportEvidence = {
  subjectName: string;
  appVersion: string;
  homeyVersion: string;
  activity: SupportReportActivity;
  deviceEvents: SupportReportDeviceEvents;
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
  | { state: 'failed' }
  | { state: 'unknown' };

export type PreparedSupportReport = {
  document: SupportReportDocument;
  message: string;
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
