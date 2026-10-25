import {
  DAILY_DIAGNOSTICS_REPORT, EVENT_DIAGNOSTICS_REPORTS,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import { readDailyDiagnosticsReportEnabled } from '../../../shared-domain/src/settings/dailyDiagnosticsReport.ts';
import { readEventDiagnosticsReportsEnabled } from '../../../shared-domain/src/settings/eventDiagnosticsReports.ts';
import type { MdSwitchElement } from './dom.ts';
import { getSetting, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';

/** One of the owner's switches for reports nobody presses Send for (Settings → Advanced). */
type DiagnosticsReportSwitch = {
  elementId: string;
  settingKey: string;
  readEnabled: (raw: unknown) => boolean;
  /** What the toast calls it. */
  name: string;
};

export const DIAGNOSTICS_REPORT_SWITCHES: readonly DiagnosticsReportSwitch[] = [
  {
    elementId: 'advanced-daily-report', settingKey: DAILY_DIAGNOSTICS_REPORT,
    readEnabled: readDailyDiagnosticsReportEnabled, name: 'Daily report',
  },
  {
    elementId: 'advanced-event-reports', settingKey: EVENT_DIAGNOSTICS_REPORTS,
    readEnabled: readEventDiagnosticsReportsEnabled, name: 'Reports on specific events',
  },
];

const findSwitch = (entry: DiagnosticsReportSwitch): MdSwitchElement | null => (
  document.getElementById(entry.elementId) as MdSwitchElement | null
);

/**
 * Shows the stored value. The switch is the owner's consent, so it stays
 * disabled until the value has loaded: a switch showing off while reports go
 * out, or a change made before the load and then overwritten, must not happen.
 */
export const loadDiagnosticsReportSwitch = async (entry: DiagnosticsReportSwitch): Promise<void> => {
  const toggle = findSwitch(entry);
  if (!toggle) return;
  try {
    toggle.selected = entry.readEnabled(await getSetting(entry.settingKey));
    toggle.disabled = false;
  } catch (error) {
    toggle.disabled = true;
    await logSettingsError(`Failed to load the ${entry.settingKey} setting`, error, 'diagnosticsReports');
  }
};

const initSwitch = async (entry: DiagnosticsReportSwitch): Promise<void> => {
  const toggle = findSwitch(entry);
  if (!toggle) return;
  toggle.disabled = true;
  await loadDiagnosticsReportSwitch(entry);
  toggle.addEventListener('change', () => {
    const enabled = toggle.selected;
    void setSetting(entry.settingKey, enabled)
      .then(() => showToast(`${entry.name} turned ${enabled ? 'on' : 'off'}.`, 'ok'))
      .catch(async (error: unknown) => {
        toggle.selected = !enabled;
        await logSettingsError(`Failed to save the ${entry.settingKey} setting`, error, 'diagnosticsReports');
        await showToastError(error, `Could not save the ${entry.name.toLowerCase()} setting.`);
      });
  });
};

/** Settings → Advanced: the owner's switches for the daily report and reports on specific events. */
export const initDiagnosticsReportSwitches = async (): Promise<void> => {
  await Promise.all(DIAGNOSTICS_REPORT_SWITCHES.map(initSwitch));
};
