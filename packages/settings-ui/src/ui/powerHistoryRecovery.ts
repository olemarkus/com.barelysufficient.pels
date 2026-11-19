import type { PowerHistoryRecoveryRead } from '../../../contracts/src/powerHistoryRecovery.ts';
import type { SettingsUiPowerPayload } from '../../../contracts/src/settingsUi/power.ts';
import { SETTINGS_UI_POWER_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { POWER_HISTORY_RECOVERY_REQUEST } from '../../../shared-domain/src/settings/powerHistoryRecovery.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import { getHomeScope, subscribeToHomeScope } from './homeScope.ts';
import { getApiReadModel, invalidateApiCache, setSetting } from './homey.ts';

let busy = false;
let generation = 0;
let statusText = '';
let latestRead: PowerHistoryRecoveryRead = { state: 'idle' };

export const classifyPowerHistoryRecovery = (raw: unknown): PowerHistoryRecoveryRead | null => {
  if (!isUnknownRecord(raw)) return null;
  if (raw.state === 'idle') return { state: 'idle' };
  if (typeof raw.requestId !== 'string') return null;
  if (raw.state === 'running') return { state: 'running', requestId: raw.requestId };
  if (raw.state === 'failed' && typeof raw.message === 'string') {
    return { state: 'failed', requestId: raw.requestId, message: raw.message };
  }
  if (raw.state === 'done' && typeof raw.addedHours === 'number'
    && Number.isSafeInteger(raw.addedHours) && raw.addedHours >= 0) {
    return { state: 'done', requestId: raw.requestId, addedHours: raw.addedHours };
  }
  return null;
};

export const powerHistoryRecoveryText = (read: PowerHistoryRecoveryRead): string => {
  if (read.state === 'idle') return '';
  if (read.state === 'running') return 'Recovering hourly history from Insights…';
  if (read.state === 'failed') return `Hourly history could not be recovered. ${read.message}`;
  return read.addedHours === 0
    ? 'No missing hours could be recovered from the available Insights history.'
    : `Recovered ${read.addedHours} missing ${read.addedHours === 1 ? 'hour' : 'hours'} from Insights. `
      + 'Existing recorded usage was kept.';
};

const onMain = (): boolean => getHomeScope().selectedHomeId === MAIN_HOME_ID;
const current = (run: number): boolean => run === generation && onMain();
const paint = (): void => {
  const section = document.getElementById('power-history-recovery');
  if (section) section.hidden = !onMain();
  const button = document.getElementById('recover-power-history-button');
  if (button) button.toggleAttribute('disabled', !onMain() || busy || latestRead.state === 'running');
  const status = document.getElementById('power-history-recovery-status');
  if (status) status.textContent = statusText;
};
const readFresh = async (): Promise<PowerHistoryRecoveryRead | null> => {
  invalidateApiCache(SETTINGS_UI_POWER_PATH);
  const payload = await getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH);
  return classifyPowerHistoryRecovery(payload?.powerHistoryRecovery);
};
const poll = async (requestId: string, run: number): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!current(run)) return;
    const read = await readFresh();
    if (!current(run)) return;
    if (read && read.state !== 'idle' && read.requestId === requestId) {
      latestRead = read; statusText = powerHistoryRecoveryText(read); paint();
      if (read.state !== 'running') return;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 1000); });
  }
  if (current(run)) {
    statusText = 'PELS has not confirmed the recovery yet. Reopen Advanced to check its progress.';
  }
};

const recoveryRequestId = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const octets = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) => {
    if (index === 6) return ((byte & 0x0f) | 0x40).toString(16);
    const value = index === 8 ? (byte & 0x3f) | 0x80 : byte;
    return value.toString(16).padStart(2, '0');
  });
  return [octets.slice(0, 4), octets.slice(4, 6), octets.slice(6, 8), octets.slice(8, 10), octets.slice(10)]
    .map((group) => group.join('')).join('-');
};

export const recoverPowerHistory = async (): Promise<void> => {
  if (!onMain() || busy || latestRead.state === 'running') return;
  const run = ++generation;
  busy = true; statusText = 'Requesting hourly history recovery…'; paint();
  try {
    const id = recoveryRequestId();
    await setSetting(POWER_HISTORY_RECOVERY_REQUEST, { id });
    await poll(id, run);
  } catch {
    if (current(run)) statusText = 'The recovery could not be confirmed. Reopen Advanced to check its progress.';
  } finally {
    busy = false; paint();
  }
};

export const refreshPowerHistoryRecovery = async (): Promise<void> => {
  if (!onMain() || busy) { paint(); return; }
  const run = ++generation;
  busy = true; paint();
  try {
    const read = await readFresh();
    if (!current(run)) return;
    if (!read) { statusText = 'Hourly history recovery is unavailable right now.'; return; }
    latestRead = read; statusText = powerHistoryRecoveryText(read); paint();
    if (read.state === 'running') await poll(read.requestId, run);
  } catch {
    if (current(run)) statusText = 'Recovery progress could not be read. Reopen Advanced to try again.';
  } finally {
    busy = false; paint();
  }
};

export const initPowerHistoryRecovery = (): void => {
  document.getElementById('recover-power-history-button')?.addEventListener('click', () => {
    void recoverPowerHistory();
  });
  document.addEventListener('pels:tab-shown', (event) => {
    if ((event as CustomEvent<{ tabId?: string }>).detail?.tabId === 'advanced') {
      void refreshPowerHistoryRecovery();
    }
  });
  paint();
};
subscribeToHomeScope(() => {
  generation += 1;
  latestRead = { state: 'idle' }; statusText = ''; paint();
});
