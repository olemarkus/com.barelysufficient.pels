import type { SettingsUiPhasePeak } from '../../../contracts/src/settingsUi/power.ts';

const formatDuration = (durationS: number): string => {
  if (durationS < 60) return `${Math.max(1, durationS)} s`;
  return `${Math.round(durationS / 60)} min`;
};

const formatPeakLine = (peak: SettingsUiPhasePeak, timeZone: string): string => {
  const when = new Intl.DateTimeFormat(undefined, {
    timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(peak.startedAtMs));
  const direction = peak.direction === 'export' ? ' export' : '';
  const devices = peak.devices.length > 0 ? ` · ${peak.devices.join(', ')}` : '';
  const magnitude = `${peak.peakKw.toFixed(1)} kW for ${formatDuration(peak.durationS)}`;
  return `${when} · ${peak.phase}${direction} ${magnitude}${devices}`;
};

/** The Usage page's list of phase peaks, newest first; the card hides while there are none. */
export const renderPhasePeaks = (peaks: readonly SettingsUiPhasePeak[] | undefined, timeZone: string): void => {
  const card = document.getElementById('usage-phase-peaks');
  const list = document.getElementById('usage-phase-peaks-list');
  if (!card || !list) return;
  const entries = [...(peaks ?? [])].sort((a, b) => b.startedAtMs - a.startedAtMs);
  card.hidden = entries.length === 0;
  list.replaceChildren(...entries.map((peak) => {
    const item = document.createElement('li');
    item.textContent = formatPeakLine(peak, timeZone);
    return item;
  }));
};
