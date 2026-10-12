import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import type {
  PriceSettingChoice,
  PriceSetupRead,
  ResolvedPriceScheme,
} from '../../packages/contracts/src/settingsUiApi';
import { NORWAY_SETTING_KEYS, readNorwaySchemeSettings } from './priceServiceNorway';

const isUsableString = (value: unknown): boolean => typeof value === 'string' && value !== '';

const isNorwayPriceModel = (value: unknown): boolean => value === 'stromstotte' || value === 'norgespris';

const readResolvedPriceSetup = (settings: SettingsPort, source: ResolvedPriceScheme): PriceSetupRead => {
  const keys = readSettingsKeyList(settings);
  if (keys.status !== 'resolved') return { state: 'unavailable' };
  // One read per key, so a value and its chosen flag describe the same read.
  const raw = new Map<string, unknown>(Object.values(NORWAY_SETTING_KEYS).map((key) => [key, settings.get(key)]));
  // A key that is listed but reads back nothing is a missed read. Reporting it
  // would turn the owner's value into PELS's default, or their grid company
  // into none, on the strength of a hiccup.
  if ([...raw].some(([key, value]) => keys.keys.includes(key) && (value === undefined || value === null))) {
    return { state: 'unavailable' };
  }
  const choice = <T>(key: string, value: T, usedAsStored: (stored: unknown) => boolean): PriceSettingChoice<T> => ({
    value,
    chosen: keys.keys.includes(key) && usedAsStored(raw.get(key)),
  });
  const norway = readNorwaySchemeSettings({ getRaw: (key) => raw.get(key) });
  return {
    state: 'resolved',
    setup: {
      source,
      norway: {
        county: choice(NORWAY_SETTING_KEYS.county, norway.countyCode, isUsableString),
        gridCompany: norway.organizationNumber === null
          ? { kind: 'none' }
          : { kind: 'chosen', organizationNumber: norway.organizationNumber },
        tariffGroup: choice(NORWAY_SETTING_KEYS.tariffGroup, norway.tariffGroup, isUsableString),
        pricingModel: choice(NORWAY_SETTING_KEYS.pricingModel, norway.norwayPriceModel, isNorwayPriceModel),
        priceArea: choice(NORWAY_SETTING_KEYS.priceArea, norway.priceArea, isUsableString),
      },
    },
  };
};

/**
 * Which prices PELS is running on, and which of them the owner chose.
 *
 * Values come from the same read the combined-series build uses
 * (`readNorwaySchemeSettings`), so the settings UI can say what PELS uses
 * without keeping defaults of its own. A setting counts as chosen when its key
 * was written and holds a value that read uses as stored; a key that was never
 * written, or holds something the read replaces with its default, is PELS's
 * assumption. Only the key list tells a never-written key from a missed read,
 * so an unanswered key list, or a listed key that reads back nothing, makes the
 * whole read unavailable.
 */
export const readPriceSetup = (settings: SettingsPort, source: ResolvedPriceScheme): PriceSetupRead => {
  try {
    return readResolvedPriceSetup(settings, source);
  } catch {
    return { state: 'unavailable' };
  }
};
