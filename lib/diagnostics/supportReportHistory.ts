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

/** Select observations around the incident, retaining one preceding state per included device. */
export function selectSupportReportActivity(
  history: SettingsUiDeviceLogPayload,
  request: SupportReportRequest,
  capturedAtMs: number,
): SupportReportActivity {
  const fromMs = Math.max(0, request.occurredAtMs - (request.historyWindow === 'day' ? 24 : 1) * HOUR_MS);
  const toMs = Math.min(capturedAtMs, request.occurredAtMs + (request.historyWindow === 'day' ? 0 : HOUR_MS));
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
