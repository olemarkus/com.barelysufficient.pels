import type { SettingsUiPowerPayload } from '../../../contracts/src/settingsUi/power.ts';
import type { NorwayCapacityChoiceRequest } from '../../../shared-domain/src/settings/norwayCapacityChoice.ts';
import {
  NORWAY_CAPACITY_CHOICE_REQUEST, readNorwayCapacityChoiceRequest,
} from '../../../shared-domain/src/settings/norwayCapacityChoice.ts';
import {
  MAIN_HOME_ID, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CAPACITY_PERIOD_MINUTES, CAPACITY_ENABLED, PRICE_SCHEME,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import { SETTINGS_UI_POWER_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { getApiReadModel, invalidateApiCache, setSetting } from './homey.ts';
import { getHomeScope, subscribeToHomeScope } from './homeScope.ts';
import { state } from './state.ts';
import { classifyNorwayMonthlyCapacity } from './norwayMonthlyCapacityRead.ts';
import { renderMonthlyCapacityUsage } from './views/NorwayMonthlyCapacity.tsx';
import { renderMonthlyCapacityLimits } from './views/NorwayMonthlyCapacityLimits.tsx';
import type { NorwayCapacityChoiceState } from '../../../contracts/src/norwayMonthlyCapacity.ts';

let payload: SettingsUiPowerPayload | null = null;
let busy = false;
let message = '';
let readError = false;
let generation = 0;
let refreshOwed = false;

const classifyChoice = (value: unknown): NorwayCapacityChoiceState => {
  if (typeof value !== 'object' || value === null || !('state' in value) || value.state !== 'active') {
    return { state: 'normal' };
  }
  const choice = value as Record<string, unknown>;
  const request = readNorwayCapacityChoiceRequest({ id: 'read', action: 'apply', offer: choice.offer });
  return request?.action === 'apply' && typeof choice.normalLimitKw === 'number'
    && Number.isFinite(choice.normalLimitKw) && choice.normalLimitKw > 0
    ? { state: 'active', offer: request.offer, normalLimitKw: choice.normalLimitKw } : { state: 'normal' };
};
const paint = (): void => {
  const onMain = getHomeScope().selectedHomeId === MAIN_HOME_ID;
  const read = onMain
    ? classifyNorwayMonthlyCapacity(payload?.norwayMonthlyCapacity) : { state: 'hidden' } as const;
  const actions = {
    choice: onMain ? classifyChoice(payload?.norwayMonthlyCapacityChoice) : { state: 'normal' } as const,
    busy, message,
    onApply: () => { void sendMonthlyCapacityAction('apply'); },
    onCancel: () => { void sendMonthlyCapacityAction('cancel'); },
  };
  renderMonthlyCapacityLimits({ read, ...actions });
  renderMonthlyCapacityUsage(read, actions);
};
const acceptPayload = (next: SettingsUiPowerPayload): void => {
  payload = next;
  if (readError) { message = ''; readError = false; }
};
const readFresh = async (): Promise<SettingsUiPowerPayload> => {
  invalidateApiCache(SETTINGS_UI_POWER_PATH);
  return getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH);
};
export const refreshMonthlyCapacityLimits = async (): Promise<void> => {
  if (busy) { if (payload === null) refreshOwed = true; paint(); return; }
  const run = ++generation;
  if (getHomeScope().selectedHomeId !== MAIN_HOME_ID) return;
  try {
    const next = await readFresh();
    if (run !== generation || busy) return;
    acceptPayload(next); paint();
  } catch {
    if (run !== generation) return;
    readError = true;
    message = 'Monthly capacity could not be read. Reopen Limits & safety to try again.'; paint();
  }
};

/** Stamp the Usage read before its await, so an action or fresh settings read can supersede it. */
export const captureMonthlyCapacityRead = (): number => generation;
export const updateMonthlyCapacityUsage = (next: SettingsUiPowerPayload, stamp = generation): void => {
  if (busy || stamp !== generation) return;
  if (getHomeScope().selectedHomeId === MAIN_HOME_ID) acceptPayload(next);
  else payload = null;
  paint();
};

const monthlyRequestId = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const octets = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) => {
    if (index === 6) return ((byte & 0x0f) | 0x40).toString(16).padStart(2, '0');
    const value = index === 8 ? (byte & 0x3f) | 0x80 : byte;
    return value.toString(16).padStart(2, '0');
  });
  return [octets.slice(0, 4), octets.slice(4, 6), octets.slice(6, 8), octets.slice(8, 10), octets.slice(10)]
    .map((group) => group.join('')).join('-');
};

const actionStillCurrent = (run: number): boolean => (
  run === generation && getHomeScope().selectedHomeId === MAIN_HOME_ID
);

const pollMonthlyCapacityAction = async (id: string, run: number): Promise<string | undefined> => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (!actionStillCurrent(run)) return undefined;
    const next = await readFresh();
    if (!actionStillCurrent(run)) return undefined;
    acceptPayload(next);
    const outcome = next.norwayMonthlyCapacityOutcome;
    if (outcome && outcome.state !== 'idle' && outcome.requestId === id && typeof outcome.message === 'string') {
      return outcome.message;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
  }
  return actionStillCurrent(run)
    ? 'PELS has not confirmed this change yet. Reopen Limits & safety to check the limit in use.' : undefined;
};

export const sendMonthlyCapacityAction = async (action: 'apply' | 'cancel'): Promise<void> => {
  if (busy || getHomeScope().selectedHomeId !== MAIN_HOME_ID) return;
  const read = classifyNorwayMonthlyCapacity(payload?.norwayMonthlyCapacity);
  const run = ++generation;
  busy = true; message = ''; readError = false; paint();
  try {
    const id = monthlyRequestId();
    let request: NorwayCapacityChoiceRequest = { id, action: 'cancel' };
    if (action === 'apply') {
      if (read.state !== 'ready' || read.advice.state !== 'suggestion' || !read.advice.actionable) return;
      request = { id, action: 'apply', offer: { monthKey: read.monthKey, tariffIdentity: read.tariffIdentity,
        limitKw: read.advice.limitKw, revision: read.advice.version } };
    }
    await setSetting(NORWAY_CAPACITY_CHOICE_REQUEST, request);
    const result = await pollMonthlyCapacityAction(id, run);
    if (result !== undefined && actionStillCurrent(run)) {
      message = result;
      generation += 1;
    }
  } catch {
    if (actionStillCurrent(run)) {
      message = 'The monthly limit change could not be confirmed. Reopen Limits & safety to check it.';
    }
  } finally {
    busy = false; paint();
    if (refreshOwed) { refreshOwed = false; void refreshMonthlyCapacityLimits(); }
  }
};

subscribeToHomeScope(() => {
  payload = null; message = ''; readError = false;
  generation += 1;
  paint();
  if (['limits', 'usage'].includes(state.activePanel)) void refreshMonthlyCapacityLimits();
});

export const notifyMonthlyCapacitySettingChanged = (key: string): void => {
  if (!['limits', 'usage'].includes(state.activePanel) || getHomeScope().selectedHomeId !== MAIN_HOME_ID) return;
  // The matching outcome is read by the in-flight action's own poll. A
  // refresh here would invalidate that poll before it can acknowledge success.
  if (key === 'norway_capacity_choice_state' && busy) return;
  if ([CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CAPACITY_PERIOD_MINUTES, CAPACITY_ENABLED, PRICE_SCHEME,
    'nettleie_orgnr', 'nettleie_tariffgruppe', 'norway_capacity_choice_state'].includes(key)) {
    if (busy) { generation += 1; refreshOwed = true; return; }
    void refreshMonthlyCapacityLimits();
  }
};
