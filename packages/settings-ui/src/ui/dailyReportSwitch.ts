import { DAILY_DIAGNOSTICS_REPORT } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { readDailyDiagnosticsReportEnabled } from '../../../shared-domain/src/settings/dailyDiagnosticsReport.ts';
import type { MdSwitchElement } from './dom.ts';
import { getSetting, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';

const findSwitch = (): MdSwitchElement | null => (
  document.getElementById('advanced-daily-report') as MdSwitchElement | null
);

/**
 * Shows the stored value. The switch is the owner's consent, so it stays
 * disabled until the value has loaded: a switch showing off while reports go
 * out, or a change made before the load and then overwritten, must not happen.
 */
export const loadDailyReportSwitch = async (): Promise<void> => {
  const toggle = findSwitch();
  if (!toggle) return;
  try {
    toggle.selected = readDailyDiagnosticsReportEnabled(await getSetting(DAILY_DIAGNOSTICS_REPORT));
    toggle.disabled = false;
  } catch (error) {
    toggle.disabled = true;
    await logSettingsError('Failed to load the daily report setting', error, 'dailyReport');
  }
};

/** Settings → Advanced: the owner's switch for the daily diagnostics report. */
export const initDailyReportSwitch = async (): Promise<void> => {
  const toggle = findSwitch();
  if (!toggle) return;
  toggle.disabled = true;
  await loadDailyReportSwitch();
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
