import { resolveManagedState, state } from '../state.ts';
import { isLastResortConfigured, readLastResortSetup } from '../devicePowerSetup.ts';
import { usesLastResortControls } from './controlState.ts';
import { supportsPowerLimiting } from './temperaturePolicy.ts';
import { supportsTemperatureDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { evLowersChargingLevelFirst, resolveDeviceDetailKind } from '../deviceKind.ts';

/**
 * The one-line summaries in the headers of the device page's Price response and
 * Power limiting cards. Both cards are closed when the page opens, so the page
 * reads as a summary of what PELS does with the device, and each opens to
 * change it. A card the owner opens stays open until the page closes.
 */
const DISCLOSURE_IDS = ['device-detail-delta-disclosure', 'device-detail-shedding-disclosure'] as const;

const degrees = (value: number): string => `${Number(Math.abs(value).toFixed(1))}°`;

/** `On · +2.5° cheap, −2° expensive`, `On`, or `Off`. */
export const resolvePriceResponseSummary = (device: SettingsUiDeviceDetailItem): string => {
  const config = state.priceOptimizationSettings[device.id];
  if (config?.enabled !== true) return 'Off';
  if (!supportsTemperatureDevice(device)) return 'On';
  const parts = [
    config.cheapDelta !== 0 ? `+${degrees(config.cheapDelta)} cheap` : null,
    config.expensiveDelta !== 0 ? `−${degrees(config.expensiveDelta)} expensive` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `On · ${parts.join(', ')}` : 'On';
};

const limitingAction = (device: SettingsUiDeviceDetailItem): string => {
  if (resolveDeviceDetailKind(device) === 'ev_charger') {
    return evLowersChargingLevelFirst(device) ? 'lowers the charging level' : 'pauses charging';
  }
  const behavior = state.shedBehaviors[device.id];
  if (behavior?.action === 'set_temperature') return `lowers to ${degrees(behavior.temperature)}`;
  if (behavior?.action === 'set_step') return 'steps down';
  return 'turns off';
};

/** The effective limiting setup, including a saved last-resort relay. */
export const resolvePowerLimitingSummary = (device: SettingsUiDeviceDetailItem): string => {
  const managed = resolveManagedState(device.id);
  if (isLastResortConfigured(device.id)) {
    if (readLastResortSetup(device.id)?.maximumW === undefined) return 'Last resort · check setup';
    return managed ? 'On · last resort' : 'Last resort · requires management';
  }
  if (usesLastResortControls(device)) return 'Off · no device power reading';
  return managed && supportsPowerLimiting(device) && state.controllableMap[device.id] === true
    ? `On · ${limitingAction(device)} when limiting`
    : 'Off';
};

const setText = (id: string, text: string): void => {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
};

export const renderDeviceDetailSectionSummaries = (device: SettingsUiDeviceDetailItem): void => {
  setText('device-detail-delta-summary', resolvePriceResponseSummary(device));
  setText('device-detail-shedding-summary', resolvePowerLimitingSummary(device));
};

/** Close both cards for the next device page; one opened meanwhile stays open until then. */
export const resetDeviceDetailSectionDisclosures = (): void => {
  for (const id of DISCLOSURE_IDS) {
    const disclosure = document.getElementById(id) as HTMLDetailsElement | null;
    if (disclosure?.open) disclosure.open = false;
  }
};
