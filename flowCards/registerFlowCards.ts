import { PriceLevel, PRICE_LEVEL_OPTIONS, PriceLevelOption } from '../lib/price/priceLevels';
import CapacityGuard from '../lib/core/capacityGuard';
import { FlowHomeyLike, TargetDeviceSnapshot } from '../lib/utils/types';
import { registerExpectedPowerCard } from './expectedPower';
import { CAPACITY_LIMIT_KW } from '../lib/utils/settingsKeys';

type DeviceArg = string | { id?: string; name?: string; data?: { id?: string } };

export type FlowCardDeps = {
  homey: FlowHomeyLike;
  resolveModeName: (mode: string) => string;
  getAllModes: () => Set<string>;
  getCurrentOperatingMode: () => string;
  handleOperatingModeChange: (rawMode: string) => Promise<void>;
  getCurrentPriceLevel: () => PriceLevel;
  recordPowerSample: (powerW: number) => Promise<void>;
  getCapacityGuard: () => CapacityGuard | undefined;
  getHeadroom: () => number | null;
  setCapacityLimit: (kw: number) => void;
  getSnapshot: () => Promise<TargetDeviceSnapshot[]>;
  refreshSnapshot: () => Promise<void>;
  getDeviceLoadSetting: (deviceId: string) => Promise<number | null>;
  setExpectedOverride: (deviceId: string, kw: number) => void;
  rebuildPlan: () => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};

export function registerFlowCards(deps: FlowCardDeps): void {
  const { homey } = deps;

  registerExpectedPowerCard(homey, {
    getSnapshot: () => deps.getSnapshot(),
    getDeviceLoadSetting: (deviceId) => deps.getDeviceLoadSetting(deviceId),
    setExpectedOverride: (deviceId, kw) => deps.setExpectedOverride(deviceId, kw),
    refreshSnapshot: () => deps.refreshSnapshot(),
    rebuildPlan: () => deps.rebuildPlan(),
    log: (...args: unknown[]) => deps.log(...args),
  });

  const operatingModeChangedTrigger = homey.flow.getTriggerCard('operating_mode_changed');
  operatingModeChangedTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { mode?: string | { id?: string; name?: string } } | null;
    const statePayload = state as { mode?: string } | null;
    const argModeValue = typeof payload?.mode === 'object' && payload?.mode !== null ? payload.mode.id : payload?.mode;
    const chosenModeRaw = (argModeValue || '').trim();
    const chosenMode = deps.resolveModeName(chosenModeRaw);
    const stateMode = deps.resolveModeName((statePayload?.mode || '').trim());
    if (!chosenMode || !stateMode) return false;
    return chosenMode.toLowerCase() === stateMode.toLowerCase();
  });
  operatingModeChangedTrigger.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));

  const priceLevelChangedTrigger = homey.flow.getTriggerCard('price_level_changed');
  priceLevelChangedTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { level?: string | { id?: string; name?: string } } | null;
    const statePayload = state as { priceLevel?: PriceLevel } | null;
    const argLevelValue = typeof payload?.level === 'object' && payload?.level !== null ? payload.level.id : payload?.level;
    const chosenLevelRaw = (argLevelValue || '').trim().toLowerCase();
    const chosenLevel = (chosenLevelRaw || PriceLevel.UNKNOWN) as PriceLevel;
    const stateLevel = (statePayload?.priceLevel || PriceLevel.UNKNOWN) as PriceLevel;
    return chosenLevel === stateLevel;
  });
  priceLevelChangedTrigger.registerArgumentAutocompleteListener('level', async (query: string) => (
    getPriceLevelOptions(query)
  ));

  const priceLevelIsCond = homey.flow.getConditionCard('price_level_is');
  priceLevelIsCond.registerRunListener(async (args: unknown) => {
    const payload = args as { level?: string | { id?: string; name?: string } } | null;
    const argLevelValue = typeof payload?.level === 'object' && payload?.level !== null ? payload.level.id : payload?.level;
    const chosenLevel = ((argLevelValue || '').trim().toLowerCase() || PriceLevel.UNKNOWN) as PriceLevel;
    const currentLevel = deps.getCurrentPriceLevel();
    return chosenLevel === currentLevel;
  });
  priceLevelIsCond.registerArgumentAutocompleteListener('level', async (query: string) => (
    getPriceLevelOptions(query)
  ));

  registerHeadroomForDeviceCard(deps);
  registerCapacityAndModeCards(deps);
}

function registerHeadroomForDeviceCard(deps: FlowCardDeps): void {
  const hasHeadroomForDeviceCond = deps.homey.flow.getConditionCard('has_headroom_for_device');
  hasHeadroomForDeviceCond.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: DeviceArg; required_kw?: number } | null;
    return checkHeadroomForDevice({
      device: payload?.device as DeviceArg,
      required_kw: Number(payload?.required_kw),
    }, deps);
  });
  hasHeadroomForDeviceCond.registerArgumentAutocompleteListener('device', async (query: string) => {
    const q = (query || '').toLowerCase();
    const snapshot = await deps.getSnapshot();
    const devices = snapshot
      .filter((d) => d.controllable !== false && (!d.loadKw || d.loadKw <= 0))
      .map((d) => ({ id: d.id, name: d.name || d.id }));
    return devices
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

function registerCapacityAndModeCards(deps: FlowCardDeps): void {
  const reportPowerCard = deps.homey.flow.getActionCard('report_power_usage');
  reportPowerCard.registerRunListener(async (args: unknown) => {
    const payload = args as { power?: number } | null;
    const power = Number(payload?.power);
    if (!Number.isFinite(power) || power < 0) {
      throw new Error('Power must be a non-negative number (W).');
    }
    await deps.recordPowerSample(power);
    return true;
  });

  const setLimitCard = deps.homey.flow.getActionCard('set_capacity_limit');
  setLimitCard.registerRunListener(async (args: unknown) => {
    const capacityGuard = deps.getCapacityGuard();
    if (!capacityGuard) return false;
    const payload = args as { limit_kw?: number } | null;
    const limit = Number(payload?.limit_kw);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error('Limit must be a positive number (kW).');
    }
    const previous = deps.homey.settings.get(CAPACITY_LIMIT_KW);
    deps.homey.settings.set(CAPACITY_LIMIT_KW, limit);
    deps.setCapacityLimit(limit);
    const previousText = typeof previous === 'number' ? `${previous} kW` : 'unset';
    deps.log(`Flow: capacity limit set to ${limit} kW (was ${previousText})`);
    return true;
  });

  const setOperatingModeCard = deps.homey.flow.getActionCard('set_capacity_mode');
  setOperatingModeCard.registerRunListener(async (args: unknown) => {
    const payload = args as { mode?: string | { id?: string; name?: string } } | null;
    const modeValue = typeof payload?.mode === 'object' && payload?.mode !== null ? payload.mode.id : payload?.mode;
    const raw = (modeValue || '').trim();
    if (!raw) throw new Error('Mode must be provided');
    await deps.handleOperatingModeChange(raw);
    return true;
  });
  setOperatingModeCard.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));

  const hasCapacityCond = deps.homey.flow.getConditionCard('has_capacity_for');
  hasCapacityCond.registerRunListener(async (args: unknown) => {
    const payload = args as { required_kw?: number } | null;
    const headroom = deps.getHeadroom();
    if (headroom === null) return false;
    return headroom >= Number(payload?.required_kw);
  });

  const isOperatingModeCond = deps.homey.flow.getConditionCard('is_capacity_mode');
  isOperatingModeCond.registerRunListener(async (args: unknown) => {
    const payload = args as { mode?: string | { id?: string; name?: string } } | null;
    const modeValue = typeof payload?.mode === 'object' && payload?.mode !== null ? payload.mode.id : payload?.mode;
    const chosenModeRaw = (modeValue || '').trim();
    const chosenMode = deps.resolveModeName(chosenModeRaw);
    if (!chosenMode) return false;
    const activeMode = deps.getCurrentOperatingMode();
    const matches = activeMode.toLowerCase() === chosenMode.toLowerCase();
    if (!matches && chosenModeRaw !== chosenMode) {
      deps.logDebug(`Mode condition checked using alias '${chosenModeRaw}' -> '${chosenMode}', but active mode is '${activeMode}'`);
    }
    return matches;
  });
  isOperatingModeCond.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));
}

function getModeOptions(deps: FlowCardDeps, query: string): Array<{ id: string; name: string }> {
  const q = (query || '').toLowerCase();
  return Array.from(deps.getAllModes())
    .filter((m) => !q || m.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((m) => ({ id: m, name: m }));
}

function getPriceLevelOptions(query: string): Array<{ id: string; name: string }> {
  const q = (query || '').toLowerCase();
  return PRICE_LEVEL_OPTIONS
    .filter((opt: PriceLevelOption) => !q || opt.name.toLowerCase().includes(q))
    .map((opt: PriceLevelOption) => ({ id: opt.id, name: opt.name }));
}

function getDeviceIdFromArg(arg: DeviceArg): string {
  const deviceIdRaw = typeof arg === 'object' && arg !== null
    ? arg.id || arg.data?.id
    : arg;
  return (deviceIdRaw || '').trim();
}

async function checkHeadroomForDevice(
  args: { device: DeviceArg; required_kw: number },
  deps: FlowCardDeps,
): Promise<boolean> {
  const capacityGuard = deps.getCapacityGuard();
  if (!capacityGuard) return false;
  const deviceId = getDeviceIdFromArg(args.device);
  const requiredKw = Number(args.required_kw);
  if (!deviceId || !Number.isFinite(requiredKw) || requiredKw < 0) return false;

  const headroom = deps.getHeadroom();
  if (headroom === null) return false;

  const snapshot = await deps.getSnapshot();
  const deviceSnap = snapshot.find((d) => d.id === deviceId);
  const deviceKw = deviceSnap?.measuredPowerKw ?? deviceSnap?.powerKw ?? 0;

  const calculatedHeadroomForDevice = headroom + deviceKw;
  const hasHeadroom = calculatedHeadroomForDevice >= requiredKw;
  logHeadroomCheck({
    deps,
    capacityGuard,
    deviceSnap,
    deviceId,
    deviceKw,
    headroom,
    requiredKw,
    hasHeadroom,
  });

  return hasHeadroom;
}

function logHeadroomCheck(params: {
  deps: FlowCardDeps;
  capacityGuard: CapacityGuard;
  deviceSnap: TargetDeviceSnapshot | undefined;
  deviceId: string;
  deviceKw: number;
  headroom: number;
  requiredKw: number;
  hasHeadroom: boolean;
}): void {
  const {
    deps,
    capacityGuard,
    deviceSnap,
    deviceId,
    deviceKw,
    headroom,
    requiredKw,
    hasHeadroom,
  } = params;
  const softLimit = capacityGuard.getSoftLimit();
  const currentPower = capacityGuard.getLastTotalPower();
  const deviceName = deviceSnap?.name || deviceId;
  const expectedPowerKwStr = deviceSnap?.expectedPowerKw !== undefined ? deviceSnap.expectedPowerKw.toFixed(2) : 'unknown';
  const sourceStr = deviceSnap?.expectedPowerSource ? ` (${deviceSnap.expectedPowerSource})` : '';

  deps.logDebug(
    `Headroom check for device "${deviceName}": `
    + `soft limit=${softLimit.toFixed(2)}kW, `
    + `current power=${currentPower?.toFixed(2) ?? 'unknown'}kW, `
    + `device consumption=${deviceKw.toFixed(2)}kW, `
    + `expected power=${expectedPowerKwStr}kW${sourceStr}, `
    + `headroom for device=${(headroom + deviceKw).toFixed(2)}kW `
    + `(required=${requiredKw.toFixed(2)}kW) → ${hasHeadroom ? 'PASS' : 'FAIL'}`,
  );
}
