/* eslint-disable @typescript-eslint/no-explicit-any -- Homey Flow APIs are untyped */
import { PriceLevel, PRICE_LEVEL_OPTIONS } from '../priceLevels';
import CapacityGuard from '../capacityGuard';
import { TargetDeviceSnapshot } from '../types';
import { registerExpectedPowerCard } from './expectedPower';

type DeviceArg = string | { id?: string; name?: string; data?: { id?: string } };

export interface FlowCardDeps {
  homey: {
    flow: {
      getTriggerCard: (id: string) => {
        registerRunListener: (fn: any) => void;
        registerArgumentAutocompleteListener: (arg: string, fn: any) => void;
      };
      getConditionCard: (id: string) => {
        registerRunListener: (fn: any) => void;
        registerArgumentAutocompleteListener: (arg: string, fn: any) => void;
      };
      getActionCard: (id: string) => {
        registerRunListener: (fn: any) => void;
        registerArgumentAutocompleteListener: (arg: string, fn: any) => void;
      };
    };
    settings: { get: (key: string) => any; set: (key: string, value: any) => void };
  };
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
  log: (...args: any[]) => void;
  logDebug: (...args: any[]) => void;
}

export function registerFlowCards(deps: FlowCardDeps): void {
  const { homey } = deps;

  registerExpectedPowerCard(homey as any, {
    getSnapshot: () => deps.getSnapshot(),
    getDeviceLoadSetting: (deviceId) => deps.getDeviceLoadSetting(deviceId),
    setExpectedOverride: (deviceId, kw) => deps.setExpectedOverride(deviceId, kw),
    refreshSnapshot: () => deps.refreshSnapshot(),
    rebuildPlan: () => deps.rebuildPlan(),
    log: (...args: any[]) => deps.log(...args),
  });

  const operatingModeChangedTrigger = homey.flow.getTriggerCard('operating_mode_changed');
  operatingModeChangedTrigger.registerRunListener(async (args: { mode: string | { id: string; name: string } }, state: { mode?: string }) => {
    const argModeValue = typeof args.mode === 'object' && args.mode !== null ? args.mode.id : args.mode;
    const chosenModeRaw = (argModeValue || '').trim();
    const chosenMode = deps.resolveModeName(chosenModeRaw);
    const stateMode = deps.resolveModeName((state?.mode || '').trim());
    if (!chosenMode || !stateMode) return false;
    return chosenMode.toLowerCase() === stateMode.toLowerCase();
  });
  operatingModeChangedTrigger.registerArgumentAutocompleteListener('mode', async (query: string) => {
    const q = (query || '').toLowerCase();
    return Array.from(deps.getAllModes())
      .filter((m) => !q || m.toLowerCase().includes(q))
      .map((m) => ({ id: m, name: m }));
  });

  const priceLevelChangedTrigger = homey.flow.getTriggerCard('price_level_changed');
  priceLevelChangedTrigger.registerRunListener(async (args: { level: string | { id: string; name: string } }, state: { priceLevel?: PriceLevel }) => {
    const argLevelValue = typeof args.level === 'object' && args.level !== null ? args.level.id : args.level;
    const chosenLevelRaw = (argLevelValue || '').trim().toLowerCase();
    const chosenLevel = (chosenLevelRaw || PriceLevel.UNKNOWN) as PriceLevel;
    const stateLevel = (state?.priceLevel || PriceLevel.UNKNOWN) as PriceLevel;
    return chosenLevel === stateLevel;
  });
  priceLevelChangedTrigger.registerArgumentAutocompleteListener('level', async (query: string) => {
    const q = (query || '').toLowerCase();
    return PRICE_LEVEL_OPTIONS
      .filter((opt) => !q || opt.name.toLowerCase().includes(q))
      .map((opt) => ({ id: opt.id, name: opt.name }));
  });

  const priceLevelIsCond = homey.flow.getConditionCard('price_level_is');
  priceLevelIsCond.registerRunListener(async (args: { level: string | { id: string; name: string } }) => {
    const argLevelValue = typeof args.level === 'object' && args.level !== null ? args.level.id : args.level;
    const chosenLevel = ((argLevelValue || '').trim().toLowerCase() || PriceLevel.UNKNOWN) as PriceLevel;
    const currentLevel = deps.getCurrentPriceLevel();
    return chosenLevel === currentLevel;
  });
  priceLevelIsCond.registerArgumentAutocompleteListener('level', async (query: string) => {
    const q = (query || '').toLowerCase();
    return PRICE_LEVEL_OPTIONS.filter((opt) => !q || opt.name.toLowerCase().includes(q));
  });

  registerHeadroomForDeviceCard(deps);
  registerCapacityAndModeCards(deps);
}

function registerHeadroomForDeviceCard(deps: FlowCardDeps): void {
  const hasHeadroomForDeviceCond = deps.homey.flow.getConditionCard('has_headroom_for_device');
  hasHeadroomForDeviceCond.registerRunListener(async (args: { device: DeviceArg; required_kw: number }) => {
    const capacityGuard = deps.getCapacityGuard();
    if (!capacityGuard) return false;
    const deviceIdRaw = typeof args.device === 'object' && args.device !== null
      ? args.device.id || args.device.data?.id
      : args.device;
    const deviceId = (deviceIdRaw || '').trim();
    const requiredKw = Number(args.required_kw);
    if (!deviceId || !Number.isFinite(requiredKw) || requiredKw < 0) return false;

    const headroom = deps.getHeadroom();
    if (headroom === null) return false;

    const snapshot = await deps.getSnapshot();
    const deviceSnap = snapshot.find((d) => d.id === deviceId);
    // Use expectedPowerKw if set and higher than current measurement, otherwise use measurement
    const deviceKw = deviceSnap?.expectedPowerKw !== undefined && deviceSnap.expectedPowerKw > (deviceSnap?.powerKw ?? 0)
      ? deviceSnap.expectedPowerKw
      : (deviceSnap?.powerKw ?? 1);

    // Log headroom condition details
    const softLimit = capacityGuard.getSoftLimit();
    const currentPower = capacityGuard.getLastTotalPower();
    const deviceName = deviceSnap?.name || deviceId;
    const calculatedHeadroomForDevice = headroom + deviceKw;
    const hasHeadroom = calculatedHeadroomForDevice >= requiredKw;
    const expectedPowerKwStr = deviceSnap?.expectedPowerKw !== undefined ? deviceSnap.expectedPowerKw.toFixed(2) : 'unknown';

    deps.logDebug(
      `Headroom check for device "${deviceName}": `
      + `soft limit=${softLimit.toFixed(2)}kW, `
      + `current power=${currentPower?.toFixed(2) ?? 'unknown'}kW, `
      + `device consumption=${deviceKw.toFixed(2)}kW, `
      + `expected power=${expectedPowerKwStr}kW, `
      + `headroom for device=${calculatedHeadroomForDevice.toFixed(2)}kW `
      + `(required=${requiredKw.toFixed(2)}kW) → ${hasHeadroom ? 'PASS' : 'FAIL'}`,
    );

    return hasHeadroom;
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
  reportPowerCard.registerRunListener(async (args: { power: number }) => {
    const power = Number(args.power);
    if (!Number.isFinite(power) || power < 0) {
      throw new Error('Power must be a non-negative number (W).');
    }
    await deps.recordPowerSample(power);
    return true;
  });

  const setLimitCard = deps.homey.flow.getActionCard('set_capacity_limit');
  // eslint-disable-next-line camelcase -- Homey Flow card argument names use snake_case
  setLimitCard.registerRunListener(async (args: { limit_kw: number }) => {
    const capacityGuard = deps.getCapacityGuard();
    if (!capacityGuard) return false;
    const limit = Number(args.limit_kw);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error('Limit must be a positive number (kW).');
    }
    deps.setCapacityLimit(limit);
    return true;
  });

  const setOperatingModeCard = deps.homey.flow.getActionCard('set_capacity_mode');
  setOperatingModeCard.registerRunListener(async (args: { mode: string | { id: string; name: string } }) => {
    // Handle both string (manual input) and object (autocomplete selection) formats
    const modeValue = typeof args.mode === 'object' && args.mode !== null ? args.mode.id : args.mode;
    const raw = (modeValue || '').trim();
    if (!raw) throw new Error('Mode must be provided');
    await deps.handleOperatingModeChange(raw);
    return true;
  });
  setOperatingModeCard.registerArgumentAutocompleteListener('mode', async (query: string) => {
    const q = (query || '').toLowerCase();
    return Array.from(deps.getAllModes())
      .filter((m) => !q || m.toLowerCase().includes(q))
      .map((m) => ({ id: m, name: m }));
  });

  const hasCapacityCond = deps.homey.flow.getConditionCard('has_capacity_for');
  // eslint-disable-next-line camelcase -- Homey Flow card argument names use snake_case
  hasCapacityCond.registerRunListener(async (args: { required_kw: number }) => {
    const headroom = deps.getHeadroom();
    if (headroom === null) return false;
    return headroom >= Number(args.required_kw);
  });

  const isOperatingModeCond = deps.homey.flow.getConditionCard('is_capacity_mode');
  isOperatingModeCond.registerRunListener(async (args: { mode: string | { id: string; name: string } }) => {
    // Handle both string (manual input) and object (autocomplete selection) formats
    const modeValue = typeof args.mode === 'object' && args.mode !== null ? args.mode.id : args.mode;
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
  isOperatingModeCond.registerArgumentAutocompleteListener('mode', async (query: string) => {
    const q = (query || '').toLowerCase();
    return Array.from(deps.getAllModes())
      .filter((m) => !q || m.toLowerCase().includes(q))
      .map((m) => ({ id: m, name: m }));
  });
}
