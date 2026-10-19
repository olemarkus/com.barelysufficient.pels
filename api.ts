import { getBudgetDailyHistoryFromHomey, getBudgetDecisionHistoryFromHomey } from './lib/weather/budgetDiagnosticsApi';
import type Homey from 'homey';
import type { DailyBudgetModelPreviewResponse, DailyBudgetUiRead } from './lib/dailyBudget/dailyBudgetTypes';
import { readObservedStateOfCharge } from './lib/observer/observedDeviceStateProjection';
import { readPelsHost } from './lib/app/pelsHost';
import type { HomeyDeviceLike } from './lib/utils/types';
import { normalizeError } from './lib/utils/errorUtils';
import { ApiRequestError } from './lib/utils/apiRequestError';
import { hasPowerCapability } from './lib/device/transport/managerParse';
import { readCarAssociationCandidatesFromHomey } from './lib/device/settingsUiDeviceReads';
import { readHubMarket } from './lib/home/hubMarket';
import { createHomeyWebApiGet } from './setup/homeyWebApi';
import {
  getHomeyDevicesForDebugFromApp,
  getHomeyEnergyMetersFromApp,
  logHomeyDeviceForDebugFromApp,
} from './setup/appDebugHelpers';
import type {
  SettingsUiCarAssociationConfirmation,
  HomeyEnergyMeterEntry,
  PriceSetupSuggestion,
  SettingsUiHubMarketRead,
  SettingsUiRecommendationCarsRead,
} from './packages/contracts/src/settingsUiApi';
import {
  buildSettingsUiBootstrap,
  getSettingsUiDeferredObjectivePlanHistoryPayload,
  getSettingsUiDeferredObjectiveSettingsPayload,
  getSettingsUiDeviceDiagnosticsPayload,
  getSettingsUiWeatherAdvisorReadout,
  getSettingsUiDeviceLogPayload,
  getSettingsUiDevicesPayload,
  getSettingsUiPlanPayload,
  getSettingsUiPowerPayload,
  getSettingsUiPricesPayload,
  logSettingsUiMessage,
  applySettingsUiDailyBudgetModel,
  getSettingsUiDailyBudget,
  previewSettingsUiDailyBudgetModel,
  refreshSettingsUiDevices,
  refreshSettingsUiGridTariff,
  refreshSettingsUiPrices,
  resetSettingsUiPowerStats,
} from './setup/settingsUiApi';
import {
  getSettingsUiHomesPayload,
  saveSettingsUiHomesConfig,
} from './setup/settingsUiHomesApi';
import {
  createSettingsUiStarvationRescue,
  getSettingsUiStarvationRescueDevices,
  previewSettingsUiStarvationRescue,
} from './setup/settingsUiStarvationRescueApi';
import {
  cancelSettingsUiSmartTask,
  createSettingsUiSmartTask,
  getSettingsUiSmartTaskDevices,
  previewSettingsUiNewSmartTask,
  previewSettingsUiSmartTask,
  updateSettingsUiSmartTask,
} from './setup/settingsUiSmartTaskApi';
import { refreshSettingsUiFlowConflicts } from './setup/settingsUiFlowConflictApi';

type ApiContext = {
  homey: Homey.App['homey'];
};

const hasDeviceId = (device: HomeyDeviceLike): device is HomeyDeviceLike & { id: string } => (
  typeof device.id === 'string'
);

// Wrap an async API handler so any thrown error is logged through the runtime's
// structured pino logger before the rejection propagates to the Homey API
// transport. Without this, handler exceptions become opaque "Network request
// failed" responses on the client and never reach `/tmp/pels`, leaving the
// failure undiagnosable.
//
// During app restart `homey.app` (or its structured logger) may not be wired
// yet; fall back to `console.error` so the cause still lands in the app's
// stderr log instead of disappearing because no logger was reachable.
const withApiLogging = <Ctx extends ApiContext, R>(
  name: string,
  handler: (ctx: Ctx) => Promise<R> | R,
) => async (ctx: Ctx): Promise<R> => {
  try {
    return await handler(ctx);
  } catch (error) {
    const logger = readPelsHost(ctx.homey)?.getApiStructuredLogger();
    if (!logger) {
      console.error(`api ${name} failed`, error);
    } else if (error instanceof ApiRequestError) {
      // The caller's input was malformed: reject it without reporting a PELS failure.
      logger.warn({ event: 'api_request_rejected', handler: name, reason: error.message });
    } else {
      logger.error({ event: 'api_handler_failed', handler: name, err: normalizeError(error) });
    }
    throw error;
  }
};

const STARTING = 'PELS is starting. Try again shortly.';

function chargingAccess(homey: ApiContext['homey']) {
  const transport = readPelsHost(homey)?.deviceManager;
  if (!transport) throw new Error(STARTING);
  return transport.chargingAccess;
}

export = {
  ui_car_association_confirm: withApiLogging('ui_car_association_confirm', (
    { homey, body }: ApiContext & { body?: unknown },
  ): SettingsUiCarAssociationConfirmation => {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !('chargerId' in body) || typeof body.chargerId !== 'string' || !body.chargerId.trim()
      || !('carId' in body) || typeof body.carId !== 'string' || !body.carId.trim()) {
      throw new ApiRequestError('Choose a charger and a car.');
    }
    const transport = readPelsHost(homey)?.deviceManager;
    if (!transport) throw new Error(STARTING);
    transport.confirmCarAssociation(body.chargerId, body.carId);
    const charge = readObservedStateOfCharge(transport.getSnapshotByDeviceId(body.chargerId));
    return {
      carConfirmation: transport.getCarConfirmation(body.chargerId),
      associatedCar: transport.getAssociatedCar(body.chargerId),
      ...(charge.kind === 'observed' ? { stateOfCharge: charge.value } : {}),
    };
  }),
  ui_car_association_clear: withApiLogging('ui_car_association_clear', (
    { homey, body }: ApiContext & { body?: unknown },
  ): SettingsUiCarAssociationConfirmation => {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !('chargerId' in body) || typeof body.chargerId !== 'string' || !body.chargerId.trim()) {
      throw new ApiRequestError('Choose a charger.');
    }
    const transport = readPelsHost(homey)?.deviceManager;
    if (!transport) throw new Error(STARTING);
    transport.clearCarConfirmation(body.chargerId);
    const charge = readObservedStateOfCharge(transport.getSnapshotByDeviceId(body.chargerId));
    return {
      carConfirmation: transport.getCarConfirmation(body.chargerId),
      associatedCar: transport.getAssociatedCar(body.chargerId),
      ...(charge.kind === 'observed' ? { stateOfCharge: charge.value } : {}),
    };
  }),
  ui_charging_current: withApiLogging('ui_charging_current', ({ homey }: ApiContext) => {
    const host = readPelsHost(homey);
    // A read can apply a route change, which rebuilds the plan.
    if (!host?.deviceManager || !host.planService) throw new Error(STARTING);
    return host.readChargingCurrentForUi();
  }),
  ui_charging_current_save: withApiLogging('ui_charging_current_save', async (
    { homey, params, body }: ApiContext & { params: { deviceId: string }; body?: unknown },
  ) => {
    const host = readPelsHost(homey);
    const transport = host?.deviceManager;
    if (!host || !transport) throw new Error(STARTING);
    await transport.chargingCurrentControl.save(params.deviceId, body);
    try {
      await host.refreshTargetDevicesSnapshot();
    } catch (error) {
      // The owner has committed the route and already gates commands and Flow
      // reports. A projection failure must not report that this save failed.
      host.getApiStructuredLogger()?.warn({
        event: 'charging_control_snapshot_refresh_failed', deviceId: params.deviceId, err: normalizeError(error),
      });
    }
  }),
  ui_charging_access: withApiLogging('ui_charging_access', ({ homey }: ApiContext) => (
    chargingAccess(homey).status()
  )),
  ui_charging_access_check: withApiLogging('ui_charging_access_check', ({ homey }: ApiContext) => (
    chargingAccess(homey).check()
  )),
  ui_charging_access_save: withApiLogging('ui_charging_access_save', (
    { homey, body }: ApiContext & { body?: unknown },
  ) => chargingAccess(homey).save(body)),
  ui_charging_access_remove: withApiLogging('ui_charging_access_remove', ({ homey }: ApiContext) => (
    chargingAccess(homey).remove()
  )),
  ui_bootstrap: withApiLogging('ui_bootstrap', ({ homey }: ApiContext) => (
    buildSettingsUiBootstrap({ homey })
  )),
  // The three `?homeId=`-aware reads. The app-API transport hands every handler
  // `{ query, params, body }` alongside `homey` (the same seam `body` already
  // arrives on for ui_homes_save); `setup/settingsUiHomeScope.ts` owns the
  // complete classification of the raw bag, so this layer only forwards it.
  ui_devices: withApiLogging('ui_devices', ({ homey, query }: ApiContext & { query?: unknown }) => (
    getSettingsUiDevicesPayload({ homey, query })
  )),
  ui_plan: withApiLogging('ui_plan', ({ homey, query }: ApiContext & { query?: unknown }) => (
    getSettingsUiPlanPayload({ homey, query })
  )),
  ui_homes: withApiLogging('ui_homes', ({ homey }: ApiContext) => (
    getSettingsUiHomesPayload({ homey })
  )),
  ui_homes_save: withApiLogging('ui_homes_save', ({ homey, body }: ApiContext & { body?: unknown }) => (
    saveSettingsUiHomesConfig({ homey, body })
  )),
  ui_power: withApiLogging('ui_power', ({ homey, query }: ApiContext & { query?: unknown }) => (
    getSettingsUiPowerPayload({ homey, query })
  )),
  ui_prices: withApiLogging('ui_prices', ({ homey }: ApiContext) => (
    getSettingsUiPricesPayload({ homey })
  )),
  ui_device_diagnostics: withApiLogging('ui_device_diagnostics', ({ homey }: ApiContext) => (
    getSettingsUiDeviceDiagnosticsPayload({ homey })
  )),
  ui_device_log: withApiLogging('ui_device_log', ({ homey }: ApiContext) => (
    getSettingsUiDeviceLogPayload({ homey })
  )),
  ui_deferred_objective_history: withApiLogging('ui_deferred_objective_history', ({ homey }: ApiContext) => (
    getSettingsUiDeferredObjectivePlanHistoryPayload({ homey })
  )),
  ui_deferred_objective_settings: withApiLogging('ui_deferred_objective_settings', ({ homey }: ApiContext) => (
    getSettingsUiDeferredObjectiveSettingsPayload({ homey })
  )),
  diagnostics_budget_days: withApiLogging(
    'diagnostics_budget_days',
    ({ homey, query }: ApiContext & { query?: unknown }) => getBudgetDailyHistoryFromHomey(homey, query),
  ),
  diagnostics_budget_decisions: withApiLogging(
    'diagnostics_budget_decisions',
    ({ homey, query }: ApiContext & { query?: unknown }) => getBudgetDecisionHistoryFromHomey(homey, query),
  ),
  get_daily_budget: withApiLogging('get_daily_budget', ({ homey }: ApiContext): DailyBudgetUiRead => (
    getSettingsUiDailyBudget({ homey })
  )),
  ui_weather_advisor_readout: withApiLogging('ui_weather_advisor_readout', ({ homey }: ApiContext) => (
    getSettingsUiWeatherAdvisorReadout({ homey })
  )),
  ui_preview_daily_budget_model: withApiLogging(
    'ui_preview_daily_budget_model',
    ({ homey, body }: ApiContext & { body?: unknown }): DailyBudgetModelPreviewResponse => (
      previewSettingsUiDailyBudgetModel({ homey, body })
    ),
  ),
  ui_apply_daily_budget_model: withApiLogging(
    'ui_apply_daily_budget_model',
    ({ homey, body }: ApiContext & { body?: unknown }): DailyBudgetUiRead => (
      applySettingsUiDailyBudgetModel({ homey, body })
    ),
  ),
  homey_devices: withApiLogging('homey_devices', async (
    { homey }: ApiContext,
  ): Promise<Array<{
    id: string;
    name: string;
    class?: string;
    hasTemperature: boolean;
    hasPower: boolean;
  }>> => {
    const host = readPelsHost(homey);
    if (!host) return [];
    const devices = await getHomeyDevicesForDebugFromApp(host);
    return devices
      .filter(hasDeviceId)
      .map((device) => {
        const deviceClass = typeof device.class === 'string' ? device.class : undefined;
        return {
          id: device.id,
          name: device.name,
          class: deviceClass,
          // Whether the device exposes a bare measure_temperature capability —
          // lets the Weather insight pickers filter to temperature devices.
          // Array.isArray-guarded (matching the runtime's other capability checks)
          // since `device` crosses the SDK boundary and types aren't guaranteed.
          hasTemperature: Array.isArray(device.capabilities)
            && device.capabilities.includes('measure_temperature'),
          // Whether the runtime considers the device power-capable
          // (measure_power or meter_power — same predicate as managerParse) —
          // lets the whole-home meter picker filter to power-reporting devices.
          hasPower: Array.isArray(device.capabilities)
            && hasPowerCapability(device.capabilities.filter((cap): cap is string => typeof cap === 'string')),
        };
      });
  }),
  ui_recommendation_cars: withApiLogging('ui_recommendation_cars', (
    { homey }: ApiContext,
  ): SettingsUiRecommendationCarsRead => readCarAssociationCandidatesFromHomey(homey)),
  // Where the hub is, from Homey's location-derived `country`. `lib/home` owns the
  // read and resolves every failure to `unavailable`, so this never throws and
  // never blocks the settings UI: it asks once, after its first paint.
  ui_hub_market: withApiLogging('ui_hub_market', (): Promise<SettingsUiHubMarketRead> => (
    readHubMarket(createHomeyWebApiGet())
  )),
  // The Norway price settings for the hub's location. Asked only when the owner
  // opens Electricity prices with a setting still missing: the lookup sends the
  // hub's coordinates to NVE and Kartverket. Never throws: no app answers `none`.
  ui_price_setup_suggestion: withApiLogging('ui_price_setup_suggestion', async (
    { homey }: ApiContext,
  ): Promise<PriceSetupSuggestion> => {
    const host = readPelsHost(homey);
    return host
      ? host.suggestPriceSetup()
      : { gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'none' } };
  }),
  // Backs both whole-home meter pickers: the meters the Homey Energy live report
  // actually exposes (the same seam a selection is read against), so every pick
  // is guaranteed readable — unlike a capability/class filter over the device list.
  // An unreadable report rejects instead of answering empty, so the pickers can
  // trust an empty list as "this home has no meters".
  homey_energy_meters: withApiLogging('homey_energy_meters', async (
    { homey }: ApiContext,
  ): Promise<HomeyEnergyMeterEntry[]> => {
    const host = readPelsHost(homey);
    if (!host) throw new Error('PELS app not available');
    return getHomeyEnergyMetersFromApp(host);
  }),
  ui_refresh_devices: withApiLogging('ui_refresh_devices', ({ homey }: ApiContext) => (
    refreshSettingsUiDevices({ homey })
  )),
  ui_refresh_flow_conflicts: withApiLogging('ui_refresh_flow_conflicts', ({ homey }: ApiContext) => (
    refreshSettingsUiFlowConflicts({ homey })
  )),
  ui_refresh_prices: withApiLogging('ui_refresh_prices', ({ homey }: ApiContext) => (
    refreshSettingsUiPrices({ homey })
  )),
  ui_refresh_grid_tariff: withApiLogging('ui_refresh_grid_tariff', ({ homey }: ApiContext) => (
    refreshSettingsUiGridTariff({ homey })
  )),
  settings_ui_log: withApiLogging('settings_ui_log', ({ homey, body }: ApiContext & { body?: unknown }) => (
    logSettingsUiMessage({ homey, body })
  )),
  ui_reset_power_stats: withApiLogging('ui_reset_power_stats', ({ homey }: ApiContext) => (
    resetSettingsUiPowerStats({ homey })
  )),
  ui_starvation_rescue_devices: withApiLogging('ui_starvation_rescue_devices', ({ homey }: ApiContext) => (
    getSettingsUiStarvationRescueDevices({ homey })
  )),
  ui_starvation_rescue_preview: withApiLogging(
    'ui_starvation_rescue_preview',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      previewSettingsUiStarvationRescue({ homey, body })
    ),
  ),
  ui_starvation_rescue_create: withApiLogging(
    'ui_starvation_rescue_create',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      createSettingsUiStarvationRescue({ homey, body })
    ),
  ),
  ui_smart_task_preview: withApiLogging(
    'ui_smart_task_preview',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      previewSettingsUiSmartTask({ homey, body })
    ),
  ),
  ui_smart_task_devices: withApiLogging('ui_smart_task_devices', ({ homey }: ApiContext) => (
    getSettingsUiSmartTaskDevices({ homey })
  )),
  ui_smart_task_create: withApiLogging(
    'ui_smart_task_create',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      createSettingsUiSmartTask({ homey, body })
    ),
  ),
  ui_smart_task_create_preview: withApiLogging(
    'ui_smart_task_create_preview',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      previewSettingsUiNewSmartTask({ homey, body })
    ),
  ),
  ui_smart_task_update: withApiLogging(
    'ui_smart_task_update',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      updateSettingsUiSmartTask({ homey, body })
    ),
  ),
  ui_smart_task_cancel: withApiLogging(
    'ui_smart_task_cancel',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      cancelSettingsUiSmartTask({ homey, body })
    ),
  ),
  log_homey_device: withApiLogging('log_homey_device', async (
    { homey, body }: ApiContext & { body?: { id?: string } },
  ): Promise<{ ok: boolean; error?: string }> => {
    const host = readPelsHost(homey);
    if (!host) {
      return { ok: false, error: 'LOGGING_NOT_AVAILABLE' };
    }
    const deviceId = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!deviceId) {
      host.error('Homey device log API called without valid device id');
      return { ok: false, error: 'INVALID_DEVICE_ID' };
    }
    const ok = await logHomeyDeviceForDebugFromApp(host, deviceId);
    if (!ok) {
      return { ok: false, error: 'DEVICE_NOT_FOUND' };
    }
    return { ok: true };
  }),
};
