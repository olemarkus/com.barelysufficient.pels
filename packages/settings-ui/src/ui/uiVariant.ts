export type SettingsUiVariant = 'legacy' | 'redesign';

export const OVERVIEW_REDESIGN_PREFERENCE_STORAGE_KEY = 'pels.settingsUi.overviewRedesignEnabled';

const OVERVIEW_REDESIGN_ENABLED_CLASS = 'overview-redesign-enabled';

let currentSettingsUiVariant: SettingsUiVariant = 'legacy';

const getStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const syncSettingsUiVariant = () => {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.dataset.uiVariant = currentSettingsUiVariant;
  document.body.classList.toggle(
    OVERVIEW_REDESIGN_ENABLED_CLASS,
    currentSettingsUiVariant === 'redesign',
  );
};

export const getCurrentSettingsUiVariant = (): SettingsUiVariant => currentSettingsUiVariant;

export const getStoredOverviewRedesignPreference = (): boolean => (
  getStorage()?.getItem(OVERVIEW_REDESIGN_PREFERENCE_STORAGE_KEY) === 'true'
);

export const setStoredOverviewRedesignPreference = (enabled: boolean): void => {
  getStorage()?.setItem(OVERVIEW_REDESIGN_PREFERENCE_STORAGE_KEY, enabled ? 'true' : 'false');
};

export const resolveSettingsUiVariant = (
  canToggleOverviewRedesign: boolean,
  prefersOverviewRedesign = getStoredOverviewRedesignPreference(),
): SettingsUiVariant => (
  canToggleOverviewRedesign && prefersOverviewRedesign ? 'redesign' : 'legacy'
);

export const applySettingsUiVariant = (variant: SettingsUiVariant): void => {
  currentSettingsUiVariant = variant;
  syncSettingsUiVariant();
};

export const applyStoredOverviewRedesignPreference = (
  canToggleOverviewRedesign: boolean,
): SettingsUiVariant => {
  const variant = resolveSettingsUiVariant(canToggleOverviewRedesign);
  applySettingsUiVariant(variant);
  return variant;
};

syncSettingsUiVariant();
