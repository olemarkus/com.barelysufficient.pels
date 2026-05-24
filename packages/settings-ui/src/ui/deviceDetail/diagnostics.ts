import type {
  DeviceDiagnosticsSummary,
  DeviceDiagnosticsStarvationCountingCause,
  DeviceDiagnosticsStarvationPauseReason,
  DeviceDiagnosticsStarvationSummary,
  DeviceDiagnosticsWindowKey,
  DeviceDiagnosticsWindowSummary,
  SettingsUiDeviceDiagnosticsPayload,
} from '../../../../contracts/src/deviceDiagnosticsTypes.ts';
import { SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH } from '../../../../contracts/src/settingsUiApi.ts';
import {
  deviceDetailDiagnosticsCards,
  deviceDetailDiagnosticsDisclosure,
  deviceDetailDiagnosticsStatus,
} from '../dom.ts';
import { getApiReadModel, getHomeyTimezone } from '../homey.ts';
import { logSettingsError } from '../logging.ts';

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

const formatStarvationDuration = (durationMs: number): string => formatHours(durationMs);

const createEmptyStarvationSummary = (): DeviceDiagnosticsStarvationSummary => ({
  isStarved: false,
  starvedAccumulatedMs: 0,
  starvationEpisodeStartedAt: null,
  starvationLastResumedAt: null,
  intendedNormalTargetC: null,
  currentTemperatureC: null,
  starvationCause: null,
  starvationPauseReason: null,
});

const createEmptyWindowSummary = (): DeviceDiagnosticsWindowSummary => ({
  unmetDemandMs: 0,
  blockedByHeadroomMs: 0,
  blockedByCooldownBackoffMs: 0,
  targetDeficitMs: 0,
  shedCount: 0,
  restoreCount: 0,
  failedActivationCount: 0,
  stableActivationCount: 0,
  penaltyBumpCount: 0,
  maxPenaltyLevelSeen: 0,
  avgShedToRestoreMs: null,
  avgRestoreToSetbackMs: null,
  minRestoreToSetbackMs: null,
  maxRestoreToSetbackMs: null,
});

const getDateTimePart = (partsByType: Record<string, string>, type: string): string => partsByType[type] ?? '00';

const formatStarvationTimestamp = (timestamp: number | null): string => {
  if (timestamp === null || !Number.isFinite(timestamp)) return 'None';

  const partsByType = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: getHomeyTimezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
  );

  return [
    [
      getDateTimePart(partsByType, 'year'),
      getDateTimePart(partsByType, 'month'),
      getDateTimePart(partsByType, 'day'),
    ].join('-'),
    [
      getDateTimePart(partsByType, 'hour'),
      getDateTimePart(partsByType, 'minute'),
      getDateTimePart(partsByType, 'second'),
    ].join(':'),
  ].join(' ');
};

type StarvationReason = DeviceDiagnosticsStarvationCountingCause | DeviceDiagnosticsStarvationPauseReason;

const STARVATION_REASON_LABELS: Record<StarvationReason, string> = {
  capacity: 'Waiting for available power',
  daily_budget: 'Daily budget is limiting service',
  hourly_budget: 'Hourly budget is limiting service',
  shortfall: 'Hard cap may be exceeded',
  swap_pending: 'Waiting for higher-priority device',
  swapped_out: 'Waiting for higher-priority device',
  insufficient_headroom: 'Waiting for available power',
  shedding_active: 'PELS is limiting devices',
  cooldown: 'Waiting before retrying',
  headroom_cooldown: 'Waiting for power reading to stabilise',
  restore_throttled: 'Delaying restart after recent failed attempt',
  activation_backoff: 'Delaying restart after recent failed attempt',
  inactive: 'No active service block',
  keep: 'No active service block',
  restore: 'Resume pending',
  suppression_none: 'No active service block',
  invalid_observation: 'Observation invalid',
  sample_gap: 'Fresh observation missing',
  unknown_suppression_reason: 'Service reason unknown',
};

const formatStarvationReason = (value: StarvationReason | null): string => (
  value ? STARVATION_REASON_LABELS[value] : 'None'
);

const formatStarvationContext = (starvation: DeviceDiagnosticsStarvationSummary): string | null => {
  if (starvation.starvationPauseReason) return formatStarvationReason(starvation.starvationPauseReason);
  if (starvation.starvationCause) return formatStarvationReason(starvation.starvationCause);
  return null;
};

const formatStarvationTemperatureTarget = (starvation: DeviceDiagnosticsStarvationSummary): string => {
  if (starvation.currentTemperatureC === null || starvation.intendedNormalTargetC === null) return 'Unavailable';
  return `${starvation.currentTemperatureC.toFixed(1)}C / ${starvation.intendedNormalTargetC.toFixed(1)}C`;
};

const formatCurrentStarvationStatus = (params: {
  isStarved: boolean;
  starvedMs: number;
}): string => {
  const duration = formatStarvationDuration(params.starvedMs);
  if (params.isStarved) {
    return params.starvedMs > 0 ? `Starved for ${duration}` : 'Starved';
  }
  return 'Not starved';
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
  const starvation = summary.starvation ?? createEmptyStarvationSummary();
  const starvationStatus = formatCurrentStarvationStatus({
    isStarved: starvation.isStarved,
    starvedMs: starvation.starvedAccumulatedMs,
  });
  const starvationContext = formatStarvationContext(starvation);
  if (deviceDetailDiagnosticsStatus) {
    deviceDetailDiagnosticsStatus.textContent = [
      `Current penalty level: L${summary.currentPenaltyLevel}.`,
      `Status: ${starvationStatus}${starvationContext ? ` - ${starvationContext}` : ''}.`,
    ].join(' ');
  }
  if (!deviceDetailDiagnosticsCards) return;

  deviceDetailDiagnosticsCards.innerHTML = '';
  (Object.keys(DIAGNOSTICS_WINDOW_LABELS) as DeviceDiagnosticsWindowKey[]).forEach((windowKey) => {
    const windowSummary = summary.windows[windowKey] ?? createEmptyWindowSummary();
    const restoreToSetbackLabel = [
      formatCycleDuration(windowSummary.avgRestoreToSetbackMs),
      formatCycleDuration(windowSummary.minRestoreToSetbackMs),
    ].join(' / ');

    const card = document.createElement('section');
    card.className = 'pels-surface-card detail-diagnostics-card';

    const title = document.createElement('h4');
    title.textContent = DIAGNOSTICS_WINDOW_LABELS[windowKey];

    const list = document.createElement('dl');
    list.className = 'detail-diagnostics-list';
    list.append(
      createDiagnosticsMetric('Time not served', formatHours(windowSummary.unmetDemandMs)),
      createDiagnosticsMetric('Time away from target', formatHours(windowSummary.targetDeficitMs)),
      createDiagnosticsMetric('Available power wait', formatHours(windowSummary.blockedByHeadroomMs)),
      createDiagnosticsMetric('Retry wait', formatHours(windowSummary.blockedByCooldownBackoffMs)),
      createDiagnosticsMetric('Failed activations', `${windowSummary.failedActivationCount}`),
      createDiagnosticsMetric('Avg limit -> resume', formatCycleDuration(windowSummary.avgShedToRestoreMs)),
      createDiagnosticsMetric('Avg / shortest resume -> limited', restoreToSetbackLabel),
      createDiagnosticsMetric(
        'Penalty history',
        `Max L${windowSummary.maxPenaltyLevelSeen} · bumps ${windowSummary.penaltyBumpCount}`,
      ),
    );
    card.append(title, list);
    deviceDetailDiagnosticsCards.appendChild(card);
  });

  const starvationCard = document.createElement('section');
  starvationCard.className = 'pels-surface-card detail-diagnostics-card';

  const starvationTitle = document.createElement('h4');
  starvationTitle.textContent = 'Starvation details';

  const starvationList = document.createElement('dl');
  starvationList.className = 'detail-diagnostics-list';
  starvationList.append(
    createDiagnosticsMetric('State', starvationStatus),
    createDiagnosticsMetric('Starved time', formatStarvationDuration(starvation.starvedAccumulatedMs)),
    createDiagnosticsMetric('Temperature / target', formatStarvationTemperatureTarget(starvation)),
    createDiagnosticsMetric(
      'Current reason',
      starvation.starvationCause
        ? formatStarvationReason(starvation.starvationCause)
        : formatStarvationReason(starvation.starvationPauseReason),
    ),
    createDiagnosticsMetric('Started', formatStarvationTimestamp(starvation.starvationEpisodeStartedAt)),
    createDiagnosticsMetric('Resumed', formatStarvationTimestamp(starvation.starvationLastResumedAt)),
  );
  starvationCard.append(starvationTitle, starvationList);
  deviceDetailDiagnosticsCards.appendChild(starvationCard);
};

export const showDeviceDetailDiagnosticsLoading = () => {
  renderDeviceDiagnosticsEmpty('Loading diagnostics…');
};

export const resetDeviceDetailDiagnosticsView = () => {
  if (deviceDetailDiagnosticsDisclosure) {
    deviceDetailDiagnosticsDisclosure.open = false;
  }
  renderDeviceDiagnosticsEmpty('');
};

export const isDeviceDetailDiagnosticsExpanded = () => deviceDetailDiagnosticsDisclosure?.open === true;

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
