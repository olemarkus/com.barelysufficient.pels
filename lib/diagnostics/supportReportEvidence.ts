import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import type { DailyBudgetUiRead } from '../../packages/contracts/src/dailyBudgetTypes';
import type { PriceTimelineRead } from '../../packages/contracts/src/priceTimeline';
import type {
  PriceSetupRead, SettingsUiDeviceActivityEntry, SettingsUiDeviceLogPayload, SettingsUiPlanSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import type {
  SupportReportDeviceEvent, SupportReportDeviceEvents, SupportReportEvidence, SupportReportLog,
  SupportReportRequest, SupportReportSection, SupportReportSubject,
} from '../../packages/contracts/src/supportReport';
import type { CarLinkDiagnostics } from '../ports/carLinkDiagnostics';
import { DEVICE_EVENT_MAX_ENTRIES_PER_DEVICE, DEVICE_EVENT_RETENTION_DAYS } from './deviceEventStore';
import { MAIN_HOME_ID } from '../home/homeConfig';
import type { HomeRuntimeReadPort, HomeRuntimeReading } from '../home/homeRuntimeRead';
import type { HomeMembershipPort } from '../home/membership';
import type { DevicePlan } from '../plan/planTypes';
import { selectSupportReportActivity, supportReportWindow } from './supportReportHistory';
import { SupportReportInputError } from './supportReportInput';
import {
  reportCapacitySettings, reportCarLink, reportDailyBudget, reportDeviceDecision, reportDevicePresentation,
  reportDeviceSnapshot, reportHomePlan,
  type SupportReportDeviceSnapshot,
} from './supportReportProjection';

/** Metadata from the running Homey installation. */
export type SupportReportHomey = {
  readonly manifest: { readonly version: string };
  readonly version: string;
};

/**
 * The owner reads a report captures, made at capture time. A read whose owner is
 * not running yet throws; capture records that read as unavailable.
 */
export type SupportReportReads = {
  /** `undefined` when device transport does not hold the device. */
  getDeviceSnapshot(deviceId: string): SupportReportDeviceSnapshot | undefined;
  getHomeMembership(): Pick<HomeMembershipPort,
    'isOwnershipReady' | 'hasPendingOwnershipGeneration' | 'getHomeIdForDevice'>;
  /** Main's latest plan decisions; `null` before the first plan. */
  getLatestDevicePlan(): DevicePlan | null;
  readHome: HomeRuntimeReadPort['readHome'];
  getDeviceLogUiPayload(): SettingsUiDeviceLogPayload;
  getLatestPlanSnapshotForUi(): SettingsUiPlanSnapshot | null;
  getCapacityScalars(): CapacityScalarSettings;
  getDailyBudgetUiPayload(): DailyBudgetUiRead;
  readPriceSetup(): PriceSetupRead;
  getPriceTimelineForUi(): PriceTimelineRead;
  /** `undefined` for a device that is neither a charger nor a car the car link knows. */
  getCarLinkDiagnostics(deviceId: string): CarLinkDiagnostics | undefined;
  /** Kept device events about any of `deviceIds` in the window, oldest first; every device without ids. */
  readDeviceEvents(deviceIds: readonly string[] | 'all', fromMs: number, toMs: number): SupportReportDeviceEvent[];
  /** PELS's kept log lines in the window (`logTailStore.ts`). */
  readLogTail(fromMs: number, toMs: number, maxBytes: number): Pick<KeptLog, 'lines' | 'overflow'> & {
    /** Kept lines in the window older than the newest that fit `maxBytes`. */
    leftOut: number;
  };
};

type ReportSubject = {
  name: string;
  currentDevice: SupportReportDeviceSnapshot | null;
  omissions: readonly string[];
};

type SectionRead = { state: 'available'; section: SupportReportSection }
  | { state: 'unavailable'; reason: string };

const readOptional = <T>(read: () => T): T | undefined => {
  try { return read(); } catch { return undefined; }
};

const readSection = (title: string, read: () => SupportReportSection | null): SectionRead => {
  const section = readOptional(read);
  return section ? { state: 'available', section } : { state: 'unavailable', reason: `${title} is unavailable.` };
};

const resolveSubject = (
  host: SupportReportReads,
  subject: SupportReportSubject,
  history: SettingsUiDeviceLogPayload | undefined,
  capturedAtMs: number,
): ReportSubject => {
  if (subject.kind === 'app') return { name: 'PELS', currentDevice: null, omissions: [] };
  const recorded = history?.entries.filter((entry) => (
    entry.deviceId === subject.deviceId && entry.atMs <= capturedAtMs
  )).reduce<SettingsUiDeviceActivityEntry | undefined>((latest, entry) => (
    !latest || entry.atMs > latest.atMs ? entry : latest
  ), undefined);
  let device: SupportReportDeviceSnapshot | undefined;
  try {
    device = host.getDeviceSnapshot(subject.deviceId);
  } catch {
    // A failed read is not evidence that the device is unknown; ask for another try.
    if (!recorded) throw new SupportReportInputError('capture_failed');
  }
  if (!device) {
    if (!recorded) throw new SupportReportInputError('invalid_subject');
    return {
      name: recorded.deviceName, currentDevice: null,
      omissions: ['Current device state is unavailable; its name comes from retained activity.'],
    };
  }
  const homeId = readOptional(() => {
    const membership = host.getHomeMembership();
    return membership.isOwnershipReady() && !membership.hasPendingOwnershipGeneration()
      ? membership.getHomeIdForDevice(device.id) : null;
  });
  if (!homeId) {
    return {
      name: device.name, currentDevice: null,
      omissions: ['Current device home ownership is unavailable; current device details are omitted.'],
    };
  }
  if (homeId !== subject.homeId) {
    if (!recorded) throw new SupportReportInputError('invalid_subject');
    return {
      name: recorded.deviceName, currentDevice: null,
      omissions: ['The device now belongs to another home; its current device details are omitted.'],
    };
  }
  return { name: device.name, currentDevice: device, omissions: [] };
};

const readArea = (host: SupportReportReads, homeId: string): HomeRuntimeReading | null => {
  if (homeId === MAIN_HOME_ID) return null;
  const result = readOptional(() => host.readHome(homeId));
  return result?.state === 'resolved' ? result.reading : null;
};

const readHomeSections = (
  host: SupportReportReads,
  homeId: string,
  plan: SettingsUiPlanSnapshot | null | undefined,
  area: HomeRuntimeReading | null,
): SectionRead[] => [
  readSection('Current home plan', () => plan ? reportHomePlan(plan) : null),
  readSection('Current limits settings', () => {
    const settings = homeId === MAIN_HOME_ID ? host.getCapacityScalars() : area?.diagnostics.capacityScalars;
    return settings ? reportCapacitySettings(settings) : null;
  }),
  readSection('Current daily budget', () => {
    // The current budget owner publishes Main only. Never substitute it for an area's budget.
    if (homeId !== MAIN_HOME_ID) return null;
    const read = host.getDailyBudgetUiPayload();
    if (read.kind !== 'budget') return null;
    const day = read.payload.days[read.payload.todayKey];
    return day ? reportDailyBudget(day) : null;
  }),
];

const readPriceSections = (host: SupportReportReads, capturedAtMs: number): SectionRead[] => [
  readSection('Current app-wide price source', () => {
    const read = host.readPriceSetup();
    return read.state === 'resolved' ? {
      title: 'Current app-wide price source',
      values: { scheme: read.setup.source.scheme, selection: read.setup.source.basis.kind },
    } : null;
  }),
  readSection('Current app-wide prices', () => {
    const read = host.getPriceTimelineForUi();
    if (read.state !== 'ready') return null;
    const period = read.periods.find((candidate) => {
      const startMs = Date.parse(candidate.startsAt);
      return startMs <= capturedAtMs && capturedAtMs < startMs + candidate.durationMinutes * 60_000;
    });
    return {
      title: 'Current app-wide prices',
      values: {
        unit: read.priceUnit,
        average: read.lines.average, cheapAtOrBelow: read.lines.cheapAtOrBelow,
        expensiveFrom: read.lines.expensiveFrom,
        ...(period ? {
          periodStartsAt: period.startsAt, periodDurationMinutes: period.durationMinutes,
          importPrice: period.importPrice, level: period.level,
          ...(period.exportPrice === undefined ? {} : { exportPrice: period.exportPrice }),
        } : {}),
      },
    };
  }),
];

const readDeviceSections = (
  host: SupportReportReads,
  subject: SupportReportSubject,
  device: SupportReportDeviceSnapshot | null,
  plan: SettingsUiPlanSnapshot | null | undefined,
): SectionRead[] => {
  if (!device || subject.kind !== 'device') return [];
  return [
    readSection('Current device observation and configuration', () => reportDeviceSnapshot(device)),
    readSection('Current device status', () => {
      const presentation = plan?.devices?.find((entry) => entry.id === device.id);
      return presentation ? reportDevicePresentation(presentation) : null;
    }),
    readSection('Current device plan', () => {
      if (subject.homeId !== MAIN_HOME_ID) return null;
      const decision = host.getLatestDevicePlan()?.devices.find((entry) => entry.id === device.id);
      return decision ? reportDeviceDecision(decision) : null;
    }),
  ];
};

type KeptLog = Extract<SupportReportLog, { state: 'available' }>;

type CarLinkRead = { state: 'read'; link: CarLinkDiagnostics | undefined } | { state: 'failed' };

const readCarLink = (host: SupportReportReads, subject: SupportReportSubject): CarLinkRead => {
  if (subject.kind !== 'device') return { state: 'read', link: undefined };
  try {
    return { state: 'read', link: host.getCarLinkDiagnostics(subject.deviceId) };
  } catch {
    return { state: 'failed' };
  }
};

/** The devices whose events explain the subject's: the cars that may pair with a charger, a car's chargers. */
const relatedDeviceIds = (deviceId: string, link: CarLinkDiagnostics | undefined): string[] => {
  if (!link) return [deviceId];
  const related = link.role === 'charger' ? link.cars.map((car) => car.carId) : link.chargerIds;
  return [...new Set([deviceId, ...related])];
};

/**
 * At most this many kept events in one report, about 150 KiB. Each device keeps
 * up to 200, and a charger with several cars could otherwise outgrow the report.
 */
export const SUPPORT_REPORT_MAX_DEVICE_EVENTS = 300;

/** The events nearest the incident, in their original order. */
const nearestToIncident = (
  entries: readonly SupportReportDeviceEvent[],
  occurredAtMs: number,
): readonly SupportReportDeviceEvent[] => {
  if (entries.length <= SUPPORT_REPORT_MAX_DEVICE_EVENTS) return entries;
  const kept = new Set(entries.map((entry, index) => ({ index, distance: Math.abs(entry.atMs - occurredAtMs) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, SUPPORT_REPORT_MAX_DEVICE_EVENTS)
    .map((entry) => entry.index));
  return entries.filter((_, index) => kept.has(index));
};

/**
 * A device report reads every event kept about the device and the devices
 * related to it, whatever the report window: a missed car link is explained by
 * a plug-in and a timeout that may lie hours before the reported time. A
 * report about the whole app, such as the daily report, reads every device's
 * events in its window.
 */
const readDeviceEvents = (
  host: SupportReportReads,
  request: SupportReportRequest,
  carLink: CarLinkRead,
  capturedAtMs: number,
): SupportReportDeviceEvents => {
  const { subject } = request;
  const deviceIds = subject.kind === 'device'
    ? relatedDeviceIds(subject.deviceId, carLink.state === 'read' ? carLink.link : undefined) : 'all';
  // A report about the whole app keeps to its window; a device report reads everything kept.
  const fromMs = deviceIds === 'all'
    ? supportReportWindow(request, capturedAtMs).fromMs
    : Math.max(0, capturedAtMs - DEVICE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const toMs = capturedAtMs;
  const read = readOptional(() => host.readDeviceEvents(deviceIds, fromMs, toMs));
  if (!read) return { state: 'unavailable', reason: 'Kept device events could not be read.' };
  const entries = nearestToIncident(read, request.occurredAtMs);
  return {
    state: 'available', entries, deviceIds, fromMs, toMs, leftOut: read.length - entries.length,
    retentionDays: DEVICE_EVENT_RETENTION_DAYS, maxEntriesPerDevice: DEVICE_EVENT_MAX_ENTRIES_PER_DEVICE,
  };
};

/**
 * The most kept log one report reads, newest first: about half the report's
 * size limit, so a day of log is never built in memory only to be cut down.
 */
export const SUPPORT_REPORT_LOG_BUDGET_BYTES = 256 * 1024;

const readLog = (host: SupportReportReads, request: SupportReportRequest, capturedAtMs: number): SupportReportLog => {
  const { fromMs, toMs } = supportReportWindow(request, capturedAtMs);
  const read = readOptional(() => host.readLogTail(fromMs, toMs, SUPPORT_REPORT_LOG_BUDGET_BYTES));
  return read ? {
    state: 'available', lines: read.lines, overflow: read.overflow, fromMs, toMs, leftOutForSize: read.leftOut,
  } : { state: 'unavailable', reason: 'The kept log could not be read.' };
};

const readCarLinkSection = (carLink: CarLinkRead): SectionRead[] => {
  if (carLink.state === 'failed') return [{ state: 'unavailable', reason: 'Current car link is unavailable.' }];
  return carLink.link ? [{ state: 'available', section: reportCarLink(carLink.link) }] : [];
};

/** Captures existing owner readouts without refreshing devices, planning, or actuating. */
export class SupportReportEvidenceSource {
  constructor(private readonly host: SupportReportReads, private readonly homey: SupportReportHomey) {}

  async capture(request: SupportReportRequest, capturedAtMs: number): Promise<SupportReportEvidence> {
    const { host } = this;
    const history = request.subject.homeId === MAIN_HOME_ID
      ? readOptional(() => host.getDeviceLogUiPayload()) : undefined;
    const subject = resolveSubject(host, request.subject, history, capturedAtMs);
    const area = readArea(host, request.subject.homeId);
    const plan = request.subject.homeId === MAIN_HOME_ID
      ? readOptional(() => host.getLatestPlanSnapshotForUi()) : area?.plan;
    // Like the other current device details, only for a device still in the reported home.
    const carLink: CarLinkRead = subject.currentDevice
      ? readCarLink(host, request.subject) : { state: 'read', link: undefined };
    const sectionReads = [
      ...readDeviceSections(host, request.subject, subject.currentDevice, plan),
      ...readCarLinkSection(carLink),
      ...readHomeSections(host, request.subject.homeId, plan, area),
      ...readPriceSections(host, capturedAtMs),
    ];
    return {
      subjectName: subject.name,
      appVersion: this.homey.manifest.version,
      homeyVersion: this.homey.version,
      activity: history ? selectSupportReportActivity(history, request, capturedAtMs) : {
        state: 'unavailable',
        reason: request.subject.homeId === MAIN_HOME_ID
          ? 'Retained device activity could not be read.' : 'Retained device activity is available only for Main.',
      },
      deviceEvents: readDeviceEvents(host, request, carLink, capturedAtMs),
      log: readLog(host, request, capturedAtMs),
      sections: sectionReads.flatMap((read) => read.state === 'available' ? [read.section] : []),
      omissions: [
        ...subject.omissions,
        ...sectionReads.flatMap((read) => read.state === 'unavailable' ? [read.reason] : []),
      ],
    };
  }
}
