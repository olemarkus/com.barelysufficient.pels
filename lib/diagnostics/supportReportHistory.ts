import type {
  SettingsUiDeviceActivityEntry,
  SettingsUiDeviceLogPayload,
} from '../../packages/contracts/src/settingsUiApi';
import type {
  SupportReportActivity,
  SupportReportRequest,
} from '../../packages/contracts/src/supportReport';

const HOUR_MS = 60 * 60 * 1000;

// Stored rows may have older or additional fields. The report has its own explicit disclosure surface.
const activityEntry = (entry: SettingsUiDeviceActivityEntry): SettingsUiDeviceActivityEntry => ({
  id: entry.id,
  deviceId: entry.deviceId,
  deviceName: entry.deviceName,
  atMs: entry.atMs,
  recordingStartedAtMs: entry.recordingStartedAtMs,
  stateKind: entry.stateKind,
  stateTone: entry.stateTone,
  stateMsg: entry.stateMsg,
  powerMsg: entry.powerMsg,
  usageMsg: entry.usageMsg,
  statusMsg: entry.statusMsg,
});

/**
 * The history a report covers: an hour or a day before the incident, through
 * capture. Owners report after the fact, and what followed the incident, such
 * as a car reporting its plug-in hours late, is often what explains it.
 */
export const supportReportWindow = (
  request: SupportReportRequest,
  capturedAtMs: number,
): { fromMs: number; toMs: number } => ({
  fromMs: Math.max(0, request.occurredAtMs - (request.historyWindow === 'day' ? 24 : 1) * HOUR_MS),
  toMs: capturedAtMs,
});

/** Select observations in the report window, retaining one preceding state per included device. */
export function selectSupportReportActivity(
  history: SettingsUiDeviceLogPayload,
  request: SupportReportRequest,
  capturedAtMs: number,
): SupportReportActivity {
  const { fromMs, toMs } = supportReportWindow(request, capturedAtMs);
  const deviceId = request.subject.kind === 'device' ? request.subject.deviceId : undefined;
  const candidates = history.entries.filter((entry) => (
    entry.atMs <= toMs && (deviceId === undefined || entry.deviceId === deviceId)
  )).sort((a, b) => b.atMs - a.atMs || b.id.localeCompare(a.id));
  const preceding = new Set<string>();
  const entries = candidates.filter((entry) => {
    if (entry.atMs >= fromMs) return true;
    if (preceding.has(entry.deviceId)) return false;
    preceding.add(entry.deviceId);
    return true;
  }).map(activityEntry);
  return {
    state: 'available', entries, fromMs, toMs,
    retentionDays: history.retentionDays,
    maxEntries: history.maxEntries,
    maxEntriesPerDevice: history.maxEntriesPerDevice,
    persistence: history.persistence,
  };
}
