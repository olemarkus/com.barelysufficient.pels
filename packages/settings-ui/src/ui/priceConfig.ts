import './materialWeb.ts';
import {
  callApi,
  getApiReadModel,
  invalidateApiCache,
  primeApiCache,
  setSetting,
} from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { logSettingsError } from './logging.ts';
import { state, defaultPriceOptimizationConfig, type SettingsUiDeviceView } from './state.ts';
import { supportsTemperatureDevice } from './deviceUtils.ts';
import { resolveManagedState, resolveHomeExhibitsSolar } from './state.ts';
import { gridCompanies } from './gridCompanies.ts';
import { readPriceSchemeInForce, savePriceScheme } from './priceSettingsPersistence.ts';
import { createNorwayPriceHandlers } from './norwayPriceHandlers.ts';
import { getPricesReadModel } from './prices.ts';
import {
  resolveNorwayChoices,
  resolvePriceSetupStatus,
  resolvePriceSourceAssumption,
} from './priceSetupStatus.ts';
import {
  applyExportSchemeChangePlan,
  createExportPriceHandlers,
  createExportSourceHandler,
  type ExportPriceStatePatch,
  recoverFromSchemeChangeFailure,
  resolveExportSchemeChangePlan,
} from './exportPriceSettings.ts';
import {
  readPriceConfigSettings,
  validateAndSavePriceSettings as saveValidatedPriceSettings,
  writePriceOptimizationSettings,
} from './priceConfigSettingsIo.ts';
import {
  POWERHOUR_DEVICE_ID, PRICE_OPTIMIZATION_ENABLED, PV_FORECAST_SOURCE,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import {
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  SETTINGS_UI_REFRESH_PRICES_PATH,
  type SettingsUiPowerPayload,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { buildFlowStatus, buildHomeyStatus, buildPowerhourStatus } from './priceConfigStatus.ts';
import { resolveLiveSummarySignals } from './livePriceSignals.ts';
import {
  renderElectricityPricesView,
  type ElectricityPricesHandlers,
  type ElectricityPricesViewProps,
} from './views/ElectricityPricesView.tsx';
import {
  renderPriceAwareDevicesView,
  type PriceAwareDevicesHandlers,
  type PriceAwareDevicesViewProps,
} from './views/PriceAwareDevicesView.tsx';
import type {
  PriceConfigState,
  PriceOptDevice,
  GridCompanyOption,
  PriceScheme,
  PvForecastSourceSetting,
} from './priceConfigTypes.ts';
import { liveStatusOrNull } from './powerStatusRead.ts';
import { resolvePvForecastSourceUiStatus } from '../../../shared-domain/src/solar/pvForecastSourceStatus.ts';
import { EXPORT_PRICE_SOURCE_DEFAULT } from '../../../shared-domain/src/settings/exportPriceSource.ts';
import { refreshAfterSetupRecommendations } from './recommendations.ts';

let configState: PriceConfigState = {
  optimizationEnabled: true,
  thresholdPercent: 25,
  minDiffOre: 0,
  priceScheme: 'norway',
  norwayPriceModel: 'stromstotte',
  priceArea: 'NO1',
  providerSurcharge: 0,
  countyCode: '03',
  organizationNumber: '',
  tariffGroup: 'Husholdning',
  flowStatus: null,
  homeyStatus: null,
  powerhourStatus: null,
  powerhourDeviceId: null,
  currentPriceLevel: null,
  liveSummary: { lastFetchedShort: null, exportText: null },
  exportPriceEnabled: false,
  exportPriceSource: EXPORT_PRICE_SOURCE_DEFAULT,
  exportSpotFactor: 0,
  exportFixed: 0,
  pvForecastSource: 'auto',
  pvForecastStatus: { kind: 'unknown' },
  priceSetup: { state: 'unavailable' },
  priceSetupStatus: { state: 'unavailable' },
};

let electricityPricesSurface: HTMLElement | null = null;
let priceAwareDevicesSurface: HTMLElement | null = null;
let settingsLoaded = false;

const getGridCompanyOptions = (countyCode: string): GridCompanyOption[] => (
  gridCompanies
    .filter((c) => c.countyCodes.includes(countyCode))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ name: c.name, organizationNumber: c.organizationNumber }))
);

const buildPriceOptDevices = (devices: SettingsUiDeviceView[]): PriceOptDevice[] => (
  devices
    .filter((d) => {
      const cfg = state.priceOptimizationSettings[d.id];
      return resolveManagedState(d.id)
        && cfg?.enabled === true
        && supportsTemperatureDevice(d);
    })
    .map((d) => {
      const cfg = state.priceOptimizationSettings[d.id] || { ...defaultPriceOptimizationConfig };
      return { id: d.id, name: d.name, cheapDelta: cfg.cheapDelta, expensiveDelta: cfg.expensiveDelta };
    })
);

const renderElectricityPrices = () => {
  if (!electricityPricesSurface) return;
  const props: ElectricityPricesViewProps = {
    config: configState,
    handlers: electricityPricesHandlers,
    gridCompanyOptions: getGridCompanyOptions(configState.countyCode),
    sourceAssumption: resolvePriceSourceAssumption(configState.priceSetup, configState.priceScheme),
    norwayChoices: resolveNorwayChoices(configState.priceSetup),
    // Prosumer gate: any home that exhibits solar — a managed solar device OR
    // material exhibited grid export (a meter-only / string-inverter home) — OR
    // an already-enabled export config, so an enabled user is never stranded
    // behind the gate. Source-blind: both power sources report signed net, so a
    // flow home exhibits export on the same evidence as a Homey Energy one.
    //
    // NOT in lockstep with the surplus-toggle gate any more: that one asks the
    // narrower "can the surplus POOL open" question (`surplusPoolReachable`),
    // while a fixed feed-in amount needs no pool at all.
    showExportSection: resolveHomeExhibitsSolar() || configState.exportPriceEnabled,
    // Same solar gate as the export section, plus two escape hatches: a user
    // who already pinned a non-default source is never stranded, and a home
    // whose panels only Homey Energy knows about (no production feed reaches
    // PELS, so resolveHomeExhibitsSolar is false) still gets the section the
    // moment Homey serves a forecast.
    showSolarForecastSection: resolveHomeExhibitsSolar()
      || configState.pvForecastSource !== 'auto'
      || (configState.pvForecastStatus.kind === 'selected'
        && configState.pvForecastStatus.homeyForecastAvailable),
  };
  renderElectricityPricesView(electricityPricesSurface, props);
};

const renderPriceAwareDevices = () => {
  if (!priceAwareDevicesSurface) return;
  const props: PriceAwareDevicesViewProps = {
    priceSetupStatus: configState.priceSetupStatus,
    optimizationEnabled: configState.optimizationEnabled,
    devices: buildPriceOptDevices(state.latestDevices),
    handlers: priceAwareDevicesHandlers,
  };
  renderPriceAwareDevicesView(priceAwareDevicesSurface, props);
};

const renderAll = () => {
  renderElectricityPrices();
  renderPriceAwareDevices();
};

const validateAndSavePriceSettings = async () => {
  await saveValidatedPriceSettings(configState);
};

const handleOptimizationToggle = async (enabled: boolean) => {
  configState = { ...configState, optimizationEnabled: enabled };
  renderAll();
  try {
    await setSetting(PRICE_OPTIMIZATION_ENABLED, enabled);
    invalidateApiCache(SETTINGS_UI_PRICES_PATH);
    await refreshAfterSetupRecommendations();
    await showToast(enabled ? 'Price optimization enabled.' : 'Price optimization disabled.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to update price optimization', error, 'priceConfig');
    await showToastError(error, 'Failed to update price optimization setting.');
  }
};

const handlePvForecastSourceChange = async (source: PvForecastSourceSetting) => {
  const previous = configState.pvForecastSource;
  configState = { ...configState, pvForecastSource: source };
  renderAll();
  try {
    await setSetting(PV_FORECAST_SOURCE, source);
    // The runtime re-selects (and, for homey/auto, re-probes) on the settings
    // write. The prices read model is cache-first, so DROP the cached payload
    // before re-reading or the sub-line would repaint from the pre-flip
    // provenance (the settings router also invalidates on the echoed event;
    // doing it here keeps the repaint deterministic, not race-dependent).
    invalidateApiCache(SETTINGS_UI_PRICES_PATH);
    await refreshStatusInfo();
    renderAll();
    await showToast('Solar forecast source saved.', 'ok');
  } catch (error) {
    // Only roll back if THIS request's selection is still the one on screen.
    // Two quick changes race: if the earlier write fails after the later one
    // started, an unconditional rollback would restore the value captured
    // before the first request and leave the selector showing a source neither
    // the store nor the runtime holds. Same rule as the scheme change below.
    if (configState.pvForecastSource === source) {
      configState = { ...configState, pvForecastSource: previous };
      renderAll();
    }
    await logSettingsError('Failed to save solar forecast source', error, 'priceConfig');
    await showToastError(error, 'Failed to save the solar forecast source.');
  }
};

/**
 * Which Power by the Hour device prices this home.
 *
 * Optimistic like the forecast-source selector, and rolled back the same way —
 * only when this request's choice is still the one on screen, so two quick
 * changes cannot leave the field showing a device neither the store nor the
 * runtime holds. The runtime re-reads the app on the settings write, so the
 * cached prices payload is dropped before re-reading the status.
 */
const handlePowerhourDeviceChange = async (deviceId: string) => {
  const previous = configState.powerhourDeviceId;
  const next = deviceId || null;
  configState = { ...configState, powerhourDeviceId: next };
  renderAll();
  try {
    await setSetting(POWERHOUR_DEVICE_ID, deviceId);
    invalidateApiCache(SETTINGS_UI_PRICES_PATH);
    await refreshStatusInfo();
    renderAll();
    await showToast('Price device saved.', 'ok');
  } catch (error) {
    if (configState.powerhourDeviceId === next) {
      configState = { ...configState, powerhourDeviceId: previous };
      renderAll();
    }
    await logSettingsError('Failed to save the Power by the Hour device', error, 'priceConfig');
    await showToastError(error, 'Failed to save the price device.');
  }
};

const handleSchemeChange = async (scheme: PriceScheme) => {
  // Crossing the Norway unit boundary in either direction changes what an
  // enabled export config means — a fixed amount can't cross it (export turns
  // off) and a spot-linked share has no spot on flow/homey (share normalizes
  // to 0). See exportPriceSettings.ts for the full rationale.
  // Only the scheme is patched optimistically; export state mutates strictly
  // AFTER its follow-up write lands, so a failed save never shows a state the
  // store does not hold.
  const shownScheme = configState.priceScheme;
  configState = { ...configState, priceScheme: scheme };
  renderAll();
  // The plan resolves against the source in force, not the optimistic UI one:
  // the stored fixed amount's unit follows the source active when it was
  // entered, and after a failed save the two can diverge. Without that source
  // nothing is written, and the page goes back to the one it showed.
  let previousScheme: PriceScheme;
  try {
    previousScheme = await readPriceSchemeInForce();
  } catch (error) {
    if (configState.priceScheme === scheme) configState = { ...configState, priceScheme: shownScheme };
    renderAll();
    await logSettingsError('Failed to read the price source in force', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
    return;
  }
  // The scheme save and the export follow-up cannot be atomic. Track whether
  // the scheme write landed (`schemePersisted`); on any failure
  // `recoverFromSchemeChangeFailure` decides how to reconcile the store +
  // optimistic UI (roll back a landed scheme, revert a never-persisted one, and
  // never clobber a newer selection or the export config).
  let schemePersisted = false;
  try {
    // Keeping the source in force changes no unit, so it leaves the export price alone.
    const exportPlan = previousScheme === scheme ? 'none' : resolveExportSchemeChangePlan(
      previousScheme, scheme, configState.exportPriceEnabled, configState.exportSpotFactor, configState.exportFixed,
    );
    await validateAndSavePriceSettings();
    await savePriceScheme(scheme);
    schemePersisted = true;
    invalidateApiCache(SETTINGS_UI_PRICES_PATH);
    // Export follow-up write runs only after the scheme save itself landed —
    // if it failed, the store never changed scheme and disabling/zeroing
    // would silently degrade a live export config.
    const { patch, toast } = await applyExportSchemeChangePlan(exportPlan);
    configState = { ...configState, ...patch };
    await refreshStatusInfo();
    renderAll();
    await showToast(toast, 'ok');
  } catch (error) {
    // A failed change: reconcile the store + optimistic UI (the helper guards a
    // newer selection and never wipes the export config).
    const rolled = await recoverFromSchemeChangeFailure({
      scheme, currentScheme: configState.priceScheme, previousScheme, schemePersisted,
    });
    if (rolled) configState = { ...configState, priceScheme: previousScheme };
    // Repaint so the view reflects the stored export config (and any rollback).
    renderAll();
    await logSettingsError('Failed to save price scheme', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

const handleProviderSurchargeChange = async (val: number) => {
  configState = { ...configState, providerSurcharge: val };
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save provider surcharge', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

const handleThresholdChange = async (val: number) => {
  configState = { ...configState, thresholdPercent: val };
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save price threshold', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

const handleMinDiffChange = async (val: number) => {
  configState = { ...configState, minDiffOre: val };
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save min diff', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

// Export-section handlers live in exportPriceSettings.ts; config state and the
// surface repaint stay owned here via the context callbacks.
const exportPriceHandlersContext = {
  getState: () => configState,
  patchState: (patch: ExportPriceStatePatch) => { configState = { ...configState, ...patch }; },
  rerender: () => renderElectricityPrices(),
};

const exportPriceHandlers = createExportPriceHandlers(exportPriceHandlersContext);

const norwayPriceHandlers = createNorwayPriceHandlers({
  getState: () => configState,
  patchState: (patch) => { configState = { ...configState, ...patch }; },
  rerender: () => renderAll(),
  refreshStatus: async () => {
    await refreshStatusInfo();
    renderAll();
  },
});
const exportSourceHandler = createExportSourceHandler(exportPriceHandlersContext);

const handleDeviceCheapDeltaChange = async (deviceId: string, val: number) => {
  const existing = state.priceOptimizationSettings[deviceId] || { ...defaultPriceOptimizationConfig };
  const previousCheapDelta = existing.cheapDelta;
  const previousPriceConfigured = existing.priceConfigured;
  state.priceOptimizationSettings[deviceId] = { ...existing, cheapDelta: val, priceConfigured: true };
  renderPriceAwareDevices();
  try {
    await writePriceOptimizationSettings();
  } catch (error) {
    // Roll back only this device's `cheapDelta`, and only if a later
    // successful save has not already overwritten it. Replacing the whole
    // map (the earlier approach) clobbered newer persisted edits from
    // overlapping handlers.
    const current = state.priceOptimizationSettings[deviceId];
    if (current && current.cheapDelta === val && current.priceConfigured) {
      state.priceOptimizationSettings[deviceId] = {
        ...current,
        cheapDelta: previousCheapDelta,
        priceConfigured: previousPriceConfigured,
      };
      renderPriceAwareDevices();
    }
    await logSettingsError('Failed to save cheap delta', error, 'priceConfig');
    await showToastError(error, 'Failed to save price optimization setting.');
  }
};

const handleDeviceExpensiveDeltaChange = async (deviceId: string, val: number) => {
  const existing = state.priceOptimizationSettings[deviceId] || { ...defaultPriceOptimizationConfig };
  const previousExpensiveDelta = existing.expensiveDelta;
  const previousPriceConfigured = existing.priceConfigured;
  state.priceOptimizationSettings[deviceId] = { ...existing, expensiveDelta: val, priceConfigured: true };
  renderPriceAwareDevices();
  try {
    await writePriceOptimizationSettings();
  } catch (error) {
    // Same field-level rollback rationale as `cheapDelta` above.
    const current = state.priceOptimizationSettings[deviceId];
    if (current && current.expensiveDelta === val && current.priceConfigured) {
      state.priceOptimizationSettings[deviceId] = {
        ...current,
        expensiveDelta: previousExpensiveDelta,
        priceConfigured: previousPriceConfigured,
      };
      renderPriceAwareDevices();
    }
    await logSettingsError('Failed to save expensive delta', error, 'priceConfig');
    await showToastError(error, 'Failed to save price optimization setting.');
  }
};

const handleRefreshPrices = async () => {
  try {
    const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_PRICES_PATH, {});
    primeApiCache(SETTINGS_UI_PRICES_PATH, response);
    await refreshStatusInfo();
    renderAll();
  } catch (error) {
    await logSettingsError('Failed to refresh prices', error, 'priceConfig');
    await showToastError(error, 'Failed to refresh spot prices. If this keeps happening, send a diagnostics report.');
  }
};

const handleRefreshGridTariff = async () => {
  try {
    const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
    primeApiCache(SETTINGS_UI_PRICES_PATH, response ?? null);
    await showToast('Grid tariffs refreshed.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to refresh grid tariff', error, 'priceConfig');
    await showToastError(error, 'Failed to refresh grid tariffs. If this keeps happening, send a diagnostics report.');
  }
};

const electricityPricesHandlers: ElectricityPricesHandlers = {
  onSchemeChange: handleSchemeChange,
  onPowerhourDeviceChange: handlePowerhourDeviceChange,
  onKeepSource: () => handleSchemeChange(configState.priceScheme),
  onNorwayModelChange: norwayPriceHandlers.onNorwayModelChange,
  onPriceAreaChange: norwayPriceHandlers.onPriceAreaChange,
  onProviderSurchargeChange: handleProviderSurchargeChange,
  onThresholdChange: handleThresholdChange,
  onMinDiffChange: handleMinDiffChange,
  onCountyChange: norwayPriceHandlers.onCountyChange,
  onOrganizationChange: norwayPriceHandlers.onOrganizationChange,
  onTariffGroupChange: norwayPriceHandlers.onTariffGroupChange,
  onRefreshPrices: handleRefreshPrices,
  onRefreshGridTariff: handleRefreshGridTariff,
  onPvForecastSourceChange: handlePvForecastSourceChange,
  onExportEnabledChange: exportPriceHandlers.onEnabledChange,
  onExportSourceChange: exportSourceHandler,
  onExportSpotFactorChange: exportPriceHandlers.onSpotFactorChange,
  onExportFixedChange: exportPriceHandlers.onFixedChange,
};

const priceAwareDevicesHandlers: PriceAwareDevicesHandlers = {
  onOptimizationToggle: handleOptimizationToggle,
  onDeviceCheapDeltaChange: handleDeviceCheapDeltaChange,
  onDeviceExpensiveDeltaChange: handleDeviceExpensiveDeltaChange,
};

const refreshStatusInfo = async () => {
  try {
    const [payload, powerPayload] = await Promise.all([
      getPricesReadModel(),
      getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH),
    ]);
    // A read that cannot say which settings the owner chose keeps the last one
    // that could, rather than showing every setting as chosen.
    const priceSetup = payload.priceSetup.state === 'resolved' ? payload.priceSetup : configState.priceSetup;
    configState = {
      ...configState,
      priceSetup,
      priceSetupStatus: resolvePriceSetupStatus({ ...payload, priceSetup }),
      flowStatus: configState.priceScheme === 'flow' ? buildFlowStatus(payload) : null,
      homeyStatus: configState.priceScheme === 'homey' ? buildHomeyStatus(payload) : null,
      powerhourStatus: configState.priceScheme === 'powerhour' ? buildPowerhourStatus(payload) : null,
      // Same `priceLevel` field the budget hero reads, so the tier chip never
      // disagrees across surfaces.
      currentPriceLevel: liveStatusOrNull(powerPayload?.status)?.priceLevel ?? null,
      liveSummary: resolveLiveSummarySignals(payload.combinedPrices, Date.now()),
      // Shape-guarded at the seam: the prices read model crosses the Homey API
      // bridge as a cast, so this nested object is untrusted until the adapter
      // discriminates it (root AGENTS.md § "Clean and trusted interfaces").
      // Inward of here the view reads it directly and never re-checks.
      pvForecastStatus: resolvePvForecastSourceUiStatus(payload.pvForecastSource),
    };
  } catch (error) {
    await logSettingsError('Failed to refresh price status', error, 'priceConfig');
  }
};

let settingsLoadGeneration = 0;

const loadPriceConfigSettings = async () => {
  // Read FIRST, then merge. Spreading `configState` inside the same literal as
  // the `await` would snapshot it before the 12 settings round trips and revert
  // anything `refreshStatusInfo` wrote meanwhile (both run concurrently off a
  // `price_scheme` change), leaving the "Right now" card stale for the session.
  // Only the newest read merges: one key change after another (a new county,
  // then the cleared grid company) starts overlapping reads, and an older one
  // finishing last would put the old values back.
  settingsLoadGeneration += 1;
  const generation = settingsLoadGeneration;
  const patch = await readPriceConfigSettings();
  if (generation !== settingsLoadGeneration) return;
  configState = { ...configState, ...patch };
  settingsLoaded = true;
};

const ensureLoaded = async () => {
  if (!settingsLoaded) await loadPriceConfigSettings();
};

export const updatePriceConfigDevices = (devices: SettingsUiDeviceView[]) => {
  state.latestDevices = devices;
  renderPriceAwareDevices();
  // The devices payload also carries the home-level managed-solar flag that
  // gates the export-price section, so the prices view must repaint too.
  renderElectricityPrices();
};

export const refreshPriceConfigView = async () => {
  await refreshStatusInfo();
  renderAll();
};

export const reloadPriceConfigSettings = async () => {
  await loadPriceConfigSettings();
  // Which settings the owner chose, and so whether prices are set up, comes
  // with the status read.
  await refreshStatusInfo();
  renderAll();
};

export const initElectricityPricesView = async (surface: HTMLElement) => {
  electricityPricesSurface = surface;
  await ensureLoaded();
  await refreshStatusInfo();
  // Both price pages: Price-aware devices shows whether prices are set up,
  // which arrives with this status read.
  renderAll();
};

export const initPriceAwareDevicesView = async (surface: HTMLElement) => {
  priceAwareDevicesSurface = surface;
  await ensureLoaded();
  renderPriceAwareDevices();
};
