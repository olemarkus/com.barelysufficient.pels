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

/**
 * One activity row as a report carries it. The row id, the recording session
 * and the tone (which follows the state) are left out: the section states the
 * sessions once, in `recordingsStartedAtMs`.
 */
export type SupportReportActivityEntry = Omit<
  SettingsUiDeviceActivityEntry, 'id' | 'recordingStartedAtMs' | 'stateTone'
>;

export type SupportReportActivity =
  | {
    state: 'available';
    entries: readonly SupportReportActivityEntry[];
    /**
     * When each recording session behind the window's entries started, oldest
     * first: a new one follows a restart. Entries left out for size may take a
     * session's last row with them.
     */
    recordingsStartedAtMs: readonly number[];
    fromMs: number;
    toMs: number;
    retentionDays: number;
    maxEntries: number;
    maxEntriesPerDevice: number;
    persistence: 'stored' | 'pending';
    /** Entries in the window left out, the oldest first, so a daily report fits its size limit. */
    leftOutForSize: number;
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
    /**
     * The reported device and the devices related to it, such as a charger's
     * selected cars; `all` in a report about the whole app.
     */
    deviceIds: readonly string[] | 'all';
    fromMs: number;
    toMs: number;
    retentionDays: number;
    maxEntriesPerDevice: number;
    /** Kept events left out, the furthest from the incident first, so the report stays within its size. */
    leftOut: number;
  }
  | { state: 'unavailable'; reason: string };

/** One of PELS's own structured log lines, as it was written. */
export type SupportReportLogLine = {
  atMs: number;
  level: 'info' | 'warn' | 'error' | 'fatal';
  entry: { readonly [key: string]: SupportReportValue };
};

/**
 * Lines left out of an hour once they passed the per-hour cap. `key` is what the
 * cap counts: the event, then `|` and the device when the line names one.
 */
export type SupportReportLogOverflow = { hourStartMs: number; key: string; dropped: number };

export type SupportReportLog =
  | {
    state: 'available';
    lines: readonly SupportReportLogLine[];
    overflow: readonly SupportReportLogOverflow[];
    fromMs: number;
    toMs: number;
    /** Kept lines in the window left out, the oldest first, so the report fits its size limit. */
    leftOutForSize: number;
    /**
     * Events whose lines, and per-hour cut counts, the report leaves out
     * because its activity rows record the same facts, such as each command
     * PELS sent; empty when it keeps every line.
     */
    omittedEvents: readonly string[];
  }
  | { state: 'unavailable'; reason: string };

export type SupportReportEvidence = {
  subjectName: string;
  appVersion: string;
  homeyVersion: string;
  activity: SupportReportActivity;
  deviceEvents: SupportReportDeviceEvents;
  log: SupportReportLog;
  sections: readonly SupportReportSection[];
  omissions: readonly string[];
};

/**
 * `owner`: the owner sent it; `daily`: the daily report the owner turned on;
 * `event`: a report on a specific event, which the owner also turned on.
 */
export type SupportReportTrigger = 'owner' | 'daily' | 'event';

/** Immutable snapshot prepared for one submission. */
export type SupportReportDocument = SupportReportEvidence & {
  version: 1;
  id: string;
  capturedAtMs: number;
  request: SupportReportRequest;
  trigger: SupportReportTrigger;
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
