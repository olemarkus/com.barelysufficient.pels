import { DAILY_DIAGNOSTICS_REPORT } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { readDailyDiagnosticsReportEnabled } from '../../../shared-domain/src/settings/dailyDiagnosticsReport.ts';
import type { MdSwitchElement } from './dom.ts';
import { getSetting, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';

/** Settings → Advanced: the owner's switch for the daily diagnostics report. */
export const initDailyReportSwitch = async (): Promise<void> => {
  const toggle = document.getElementById('advanced-daily-report') as MdSwitchElement | null;
  if (!toggle) return;
  try {
    toggle.selected = readDailyDiagnosticsReportEnabled(await getSetting(DAILY_DIAGNOSTICS_REPORT));
  } catch (error) {
    await logSettingsError('Failed to load the daily report setting', error, 'dailyReport');
  }
  toggle.addEventListener('change', () => {
    const enabled = toggle.selected;
    void setSetting(DAILY_DIAGNOSTICS_REPORT, enabled)
      .then(() => showToast(enabled ? 'Daily report turned on.' : 'Daily report turned off.', 'ok'))
      .catch(async (error: unknown) => {
        toggle.selected = !enabled;
        await logSettingsError('Failed to save the daily report setting', error, 'dailyReport');
        await showToastError(error, 'Could not save the daily report setting.');
      });
  });
};
