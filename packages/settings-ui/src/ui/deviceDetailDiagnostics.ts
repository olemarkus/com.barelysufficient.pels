import type {
  DeviceDiagnosticsSummary,
  DeviceDiagnosticsWindowKey,
  SettingsUiDeviceDiagnosticsPayload,
} from '../../../contracts/src/deviceDiagnosticsTypes';
import { SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH } from '../../../contracts/src/settingsUiApi';
import { deviceDetailDiagnosticsCards, deviceDetailDiagnosticsStatus } from './dom';
import { getApiReadModel } from './homey';
import { logSettingsError } from './logging';

const DIAGNOSTICS_WINDOW_LABELS: Record<DeviceDiagnosticsWindowKey, string> = {
  '1d': '1 day',
  '7d': '7 days',
  '21d': '21 days',
};

let diagnosticsRequestSeq = 0;

const formatHours = (durationMs: number): string => {
  if (durationMs <= 0) return '0m';
  const hours = durationMs / (60 * 60 * 1000);
  if (hours >= 10) return `${hours.toFixed(0)}h`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  const minutes = durationMs / (60 * 1000);
  if (minutes >= 10) return `${minutes.toFixed(0)}m`;
  return `${minutes.toFixed(1)}m`;
};

const formatCycleDuration = (durationMs: number | null): string => {
  if (durationMs === null || !Number.isFinite(durationMs)) return 'No cycles';
  if (durationMs < 60 * 1000) return `${Math.round(durationMs / 1000)}s`;
  if (durationMs < 60 * 60 * 1000) return `${Math.round(durationMs / (60 * 1000))}m`;
  return `${(durationMs / (60 * 60 * 1000)).toFixed(1)}h`;
};

const createDiagnosticsMetric = (label: string, value: string) => {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  row.append(dt, dd);
  return row;
};

const renderDeviceDiagnosticsEmpty = (statusText: string) => {
  if (deviceDetailDiagnosticsStatus) {
    deviceDetailDiagnosticsStatus.textContent = statusText;
  }
  if (deviceDetailDiagnosticsCards) {
    deviceDetailDiagnosticsCards.innerHTML = '';
  }
};

const renderDeviceDiagnosticsSummary = (summary: DeviceDiagnosticsSummary | undefined) => {
  if (!summary) {
    renderDeviceDiagnosticsEmpty('No diagnostics recorded yet.');
    return;
  }
  if (deviceDetailDiagnosticsStatus) {
    deviceDetailDiagnosticsStatus.textContent = `Current penalty level: L${summary.currentPenaltyLevel}.`;
  }
  if (!deviceDetailDiagnosticsCards) return;

  deviceDetailDiagnosticsCards.innerHTML = '';
  (Object.keys(DIAGNOSTICS_WINDOW_LABELS) as DeviceDiagnosticsWindowKey[]).forEach((windowKey) => {
    const windowSummary = summary.windows[windowKey];
    const blockedMs = windowSummary.blockedByHeadroomMs + windowSummary.blockedByCooldownBackoffMs;
    const blockedPercent = windowSummary.unmetDemandMs > 0
      ? Math.round((blockedMs / windowSummary.unmetDemandMs) * 100)
      : null;
    const blockedLabel = windowSummary.unmetDemandMs > 0
      ? `${formatHours(blockedMs)} (${blockedPercent}% of unmet demand)`
      : 'No unmet demand';
    const restoreToSetbackLabel = [
      formatCycleDuration(windowSummary.avgRestoreToSetbackMs),
      formatCycleDuration(windowSummary.minRestoreToSetbackMs),
    ].join(' / ');

    const card = document.createElement('section');
    card.className = 'detail-diagnostics-card';

    const title = document.createElement('h4');
    title.textContent = DIAGNOSTICS_WINDOW_LABELS[windowKey];

    const list = document.createElement('dl');
    list.className = 'detail-diagnostics-list';
    list.append(
      createDiagnosticsMetric('Blocked time', blockedLabel),
      createDiagnosticsMetric('Headroom block', formatHours(windowSummary.blockedByHeadroomMs)),
      createDiagnosticsMetric('Cooldown/backoff', formatHours(windowSummary.blockedByCooldownBackoffMs)),
      createDiagnosticsMetric('Failed activations', `${windowSummary.failedActivationCount}`),
      createDiagnosticsMetric('Avg shed -> restore', formatCycleDuration(windowSummary.avgShedToRestoreMs)),
      createDiagnosticsMetric('Avg / shortest restore -> setback', restoreToSetbackLabel),
      createDiagnosticsMetric(
        'Penalty history',
        `Max L${windowSummary.maxPenaltyLevelSeen} · bumps ${windowSummary.penaltyBumpCount}`,
      ),
    );
    card.append(title, list);
    deviceDetailDiagnosticsCards.appendChild(card);
  });
};

export const showDeviceDetailDiagnosticsLoading = () => {
  renderDeviceDiagnosticsEmpty('Loading diagnostics…');
};

export const resetDeviceDetailDiagnosticsRequests = () => {
  diagnosticsRequestSeq += 1;
};

export const refreshDeviceDetailDiagnostics = async (params: {
  deviceId: string;
  isCurrentDevice: () => boolean;
  showLoading?: boolean;
}) => {
  const requestSeq = diagnosticsRequestSeq + 1;
  diagnosticsRequestSeq = requestSeq;
  if (params.showLoading) {
    showDeviceDetailDiagnosticsLoading();
  }
  try {
    const payload = await getApiReadModel<SettingsUiDeviceDiagnosticsPayload>(SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH);
    if (!params.isCurrentDevice() || diagnosticsRequestSeq !== requestSeq) return;
    renderDeviceDiagnosticsSummary(payload.diagnosticsByDeviceId[params.deviceId]);
  } catch (error) {
    if (!params.isCurrentDevice() || diagnosticsRequestSeq !== requestSeq) return;
    renderDeviceDiagnosticsEmpty('Diagnostics unavailable.');
    await logSettingsError('Failed to load device diagnostics', error, 'device detail');
  }
};
