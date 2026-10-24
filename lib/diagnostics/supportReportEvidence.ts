import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import type { DailyBudgetUiRead } from '../../packages/contracts/src/dailyBudgetTypes';
import type { PriceTimelineRead } from '../../packages/contracts/src/priceTimeline';
import type {
  PriceSetupRead, SettingsUiDeviceActivityEntry, SettingsUiDeviceLogPayload, SettingsUiPlanSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import type {
  SupportReportEvidence, SupportReportRequest, SupportReportSection, SupportReportSubject,
} from '../../packages/contracts/src/supportReport';
import { MAIN_HOME_ID } from '../home/homeConfig';
import type { HomeRuntimeReadPort, HomeRuntimeReading } from '../home/homeRuntimeRead';
import type { HomeMembershipPort } from '../home/membership';
import type { DevicePlan } from '../plan/planTypes';
import { selectSupportReportActivity } from './supportReportHistory';
import { SupportReportInputError } from './supportReportInput';
import {
  reportCapacitySettings, reportDailyBudget, reportDeviceDecision, reportDevicePresentation,
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
    const sectionReads = [
      ...readDeviceSections(host, request.subject, subject.currentDevice, plan),
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
      sections: sectionReads.flatMap((read) => read.state === 'available' ? [read.section] : []),
      omissions: [
        ...subject.omissions,
        ...sectionReads.flatMap((read) => read.state === 'unavailable' ? [read.reason] : []),
      ],
    };
  }
}
