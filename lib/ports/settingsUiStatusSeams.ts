/**
 * Narrow structural ports exposed by the running app to settings-UI payload
 * producers. The SDK types `homey.app` as its base App, so the transport edge
 * must establish which application-owned methods are actually present before
 * setup delegates to them.
 */

import type {
  HomeyPriceFormulaUiStatus,
  PowerhourSourceUiStatus,
  PvForecastSourceUiStatus,
  SettingsUiPriceSourcePayloads,
  SettingsUiHardCapConfigurationRead,
} from '../../packages/contracts/src/settingsUiApi';
import type { PriceOptimizationSetupRead } from '../../packages/contracts/src/priceOptimizationSettings';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';

type PvForecastSourceSeam = { getPvForecastSourceUiStatus: () => PvForecastSourceUiStatus };

type HomeyPriceFormulaSeam = { getHomeyPriceFormulaUiStatus: () => HomeyPriceFormulaUiStatus };

type PowerhourSourceSeam = { getPowerhourSourceUiStatus: () => PowerhourSourceUiStatus };

type PriceSourcePayloadsSeam = { getPriceSourcePayloadsForUi: () => SettingsUiPriceSourcePayloads };

type CombinedPricesSeam = { getCombinedPricesForUi: () => unknown };

type HardCapConfigurationSeam = { readHardCapConfiguration: () => SettingsUiHardCapConfigurationRead };

type PriceOptimizationSetupSeam = { readPriceOptimizationSetup: () => PriceOptimizationSetupRead };

type CapacityPeakSeam = { getCurrentMonthCapacityPeakKw: () => number | null };

type CapacityScalarsSeam = { getCapacityScalars: () => CapacityScalarSettings };

export const hasPvForecastSourceSeam = (app: unknown): app is PvForecastSourceSeam => (
  typeof app === 'object'
  && app !== null
  && 'getPvForecastSourceUiStatus' in app
  && typeof app.getPvForecastSourceUiStatus === 'function'
);

export const hasHomeyPriceFormulaSeam = (app: unknown): app is HomeyPriceFormulaSeam => (
  typeof app === 'object'
  && app !== null
  && 'getHomeyPriceFormulaUiStatus' in app
  && typeof app.getHomeyPriceFormulaUiStatus === 'function'
);

export const hasPowerhourSourceSeam = (app: unknown): app is PowerhourSourceSeam => (
  typeof app === 'object'
  && app !== null
  && 'getPowerhourSourceUiStatus' in app
  && typeof app.getPowerhourSourceUiStatus === 'function'
);

/**
 * What the settings UI is told before the price coordinator is wired, or when
 * the app does not carry the seam: nothing stored.
 */
export const NO_PRICE_SOURCE_PAYLOADS: SettingsUiPriceSourcePayloads = {
  flowToday: null,
  flowTomorrow: null,
  homeyCurrency: null,
  homeyToday: null,
  homeyTomorrow: null,
  powerhourCurrency: null,
  powerhourToday: null,
  powerhourTomorrow: null,
};

export const hasPriceSourcePayloadsSeam = (app: unknown): app is PriceSourcePayloadsSeam => (
  typeof app === 'object'
  && app !== null
  && 'getPriceSourcePayloadsForUi' in app
  && typeof app.getPriceSourcePayloadsForUi === 'function'
);

export const hasCombinedPricesSeam = (app: unknown): app is CombinedPricesSeam => (
  typeof app === 'object'
  && app !== null
  && 'getCombinedPricesForUi' in app
  && typeof app.getCombinedPricesForUi === 'function'
);

export const hasHardCapConfigurationSeam = (app: unknown): app is HardCapConfigurationSeam => (
  typeof app === 'object'
  && app !== null
  && 'readHardCapConfiguration' in app
  && typeof app.readHardCapConfiguration === 'function'
);

export const hasPriceOptimizationSetupSeam = (app: unknown): app is PriceOptimizationSetupSeam => (
  typeof app === 'object'
  && app !== null
  && 'readPriceOptimizationSetup' in app
  && typeof app.readPriceOptimizationSetup === 'function'
);

export const hasCapacityPeakSeam = (app: unknown): app is CapacityPeakSeam => (
  typeof app === 'object'
  && app !== null
  && 'getCurrentMonthCapacityPeakKw' in app
  && typeof app.getCurrentMonthCapacityPeakKw === 'function'
);

export const hasCapacityScalarsSeam = (app: unknown): app is CapacityScalarsSeam => (
  typeof app === 'object'
  && app !== null
  && 'getCapacityScalars' in app
  && typeof app.getCapacityScalars === 'function'
);
