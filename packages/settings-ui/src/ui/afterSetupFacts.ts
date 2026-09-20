import type { AfterSetupDevice, AfterSetupFacts } from './afterSetupRecommendations.ts';
import { hasLoadedDeferredObjectiveSettings } from './deferredObjectiveSettings.ts';
import { supportsPowerDevice, supportsTemperatureControlDevice } from './deviceUtils.ts';
import { getSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { confirmSettingAbsence } from './settingAbsence.ts';
import { readSetupPath } from './setupPathFacts.ts';
import { state, type PriceOptimizationConfig } from './state.ts';

/**
 * Gathers what the after-setup suggestions are judged from. Everything here is
 * either already in `state` or one settings key, and each fact is `unknown`
 * until it has actually been read — see the model's header for why an unread
 * setting must never pass for a feature nobody turned on.
 */

const PRICE_OPTIMIZATION_SETTINGS = 'price_optimization_settings';

type PriceSettingsRecord = Record<string, PriceOptimizationConfig>;

// `null` until the confirmed read lands; stays `null` if it failed.
let persistedPriceSettings: PriceSettingsRecord | null = null;

const isRecord = (value: unknown): value is PriceSettingsRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * Price and solar-surplus opt-ins live in one per-device map. An absent map is
 * the normal state of a home that uses neither, which is exactly when these
 * suggestions matter, so absence is confirmed rather than assumed.
 */
export const loadAfterSetupFacts = async (): Promise<void> => {
  try {
    const first = await getSetting(PRICE_OPTIMIZATION_SETTINGS);
    const confirmed = await confirmSettingAbsence(PRICE_OPTIMIZATION_SETTINGS, first, isRecord);
    // Unreadable stays `null`: nothing is claimed about Price or solar.
    if (confirmed.state === 'unavailable') return;
    persistedPriceSettings = confirmed.state === 'present' ? confirmed.value : {};
  } catch (error) {
    await logSettingsError('Failed to read price settings for suggestions', error, 'setup recommendations');
  }
};

const resolveDevices = (priceSettings: PriceSettingsRecord): AfterSetupDevice[] => (
  state.latestDevices
    .filter((device) => state.managedMap[device.id] === true)
    .map((device) => {
      // A temperature target PELS is ALLOWED to command. A thermostat whose
      // temperature control the owner turned off still has the capability, but
      // Price cannot move it and it cannot take a heating task, so it makes
      // neither suggestion relevant.
      const temperature = supportsTemperatureControlDevice(device);
      // `state` carries this session's own toggles, so it wins over the read.
      const price = state.priceOptimizationSettings[device.id] ?? priceSettings[device.id];
      return {
        temperature,
        limitable: supportsPowerDevice(device) && state.controllableMap[device.id] === true,
        taskCapable: temperature || device.deviceClass === 'evcharger',
        priceEnabled: price?.enabled === true,
        usesSolarSurplus: price?.surplusWilling === true,
      };
    })
);

export const readAfterSetupFacts = (): AfterSetupFacts => {
  const setup = readSetupPath();
  const devicesKnown = state.devicesLoaded && persistedPriceSettings !== null;
  return {
    setupComplete: setup.state === 'resolved' && setup.path === null,
    devices: devicesKnown && persistedPriceSettings !== null
      ? { state: 'known', value: resolveDevices(persistedPriceSettings) }
      : { state: 'unknown' },
    solarSurplusAvailable: state.surplusPoolReachable
      && (state.hasManagedSolarDevice || state.hasExhibitedExport),
    smartTaskConfigured: hasLoadedDeferredObjectiveSettings()
      ? {
        state: 'known',
        value: Object.keys(state.deferredObjectiveSettings?.objectivesByDeviceId ?? {}).length > 0,
      }
      : { state: 'unknown' },
  };
};
