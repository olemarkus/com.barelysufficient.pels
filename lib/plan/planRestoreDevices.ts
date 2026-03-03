import type { DevicePlanDevice } from './planTypes';
import { sortByPriorityAsc, sortByPriorityDesc } from './planSort';

export function getOffDevices(planDevices: DevicePlanDevice[]): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((device) => device.controllable !== false && device.currentState === 'off' && device.plannedState !== 'shed');
  return sortByPriorityAsc(filtered);
}

export function getOnDevices(
  planDevices: DevicePlanDevice[],
  getShedBehavior: (deviceId: string) => { action: 'turn_off' | 'set_temperature'; temperature: number | null },
): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((device) => device.controllable !== false && device.plannedState !== 'shed')
    .filter((device) => device.currentState === 'on' || device.currentState === 'not_applicable')
    .filter((device) => canSwapOutDevice(device, getShedBehavior(device.id)));
  return sortByPriorityDesc(filtered);
}

export function getEvRestoreStateBlockReason(dev: DevicePlanDevice): string | null {
  if (dev.controlCapabilityId !== 'evcharger_charging') return null;
  if (dev.evChargingState === undefined) return 'charger state unknown';

  switch (dev.evChargingState) {
    case 'plugged_in':
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return null;
    case 'plugged_out':
      return 'charger is unplugged';
    case 'plugged_in_discharging':
      return 'charger is discharging';
    default:
      return `unknown charging state '${dev.evChargingState}'`;
  }
}

export function getEvUnknownPowerBlockReason(dev: DevicePlanDevice): string | null {
  if (dev.controlCapabilityId !== 'evcharger_charging') return null;
  if (dev.expectedPowerSource !== 'default') return null;
  return 'restore blocked (charger power unknown; configure expected power or let PELS observe a charging peak)';
}

export function markOffDevicesStayOff(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  timing: {
    activeOvershoot: boolean;
    inCooldown: boolean;
    restoreCooldownSeconds: number;
    shedCooldownRemainingSec: number | null;
  };
  logDebug: (...args: unknown[]) => void;
  setDevice: (id: string, updates: Partial<DevicePlanDevice>) => void;
  reasonOverride?: (dev: DevicePlanDevice) => string;
}): void {
  const {
    deviceMap,
    timing,
    logDebug,
    setDevice,
    reasonOverride,
  } = params;
  const offDevices = Array.from(deviceMap.values())
    .filter((device) => device.controllable !== false && device.currentState === 'off' && device.plannedState !== 'shed');
  for (const dev of offDevices) {
    const defaultReason = dev.reason || 'shed due to capacity';
    const nextReason = reasonOverride ? reasonOverride(dev) : resolveOffDeviceReason(timing, defaultReason);
    setDevice(dev.id, { plannedState: 'shed', reason: nextReason });
    logDebug(`Plan: skipping restore of ${dev.name} (p${dev.priority ?? 100}, ~${(dev.powerKw ?? 1).toFixed(2)}kW) - ${nextReason}`);
  }
}

function canSwapOutDevice(
  dev: DevicePlanDevice,
  behavior: { action: 'turn_off' | 'set_temperature'; temperature: number | null },
): boolean {
  if (behavior.action !== 'set_temperature' || behavior.temperature === null) return true;
  let currentTarget: number | null = null;
  if (typeof dev.currentTarget === 'number') {
    currentTarget = dev.currentTarget;
  } else if (typeof dev.plannedTarget === 'number') {
    currentTarget = dev.plannedTarget;
  }
  if (currentTarget === null) return true;
  return currentTarget > behavior.temperature;
}

function resolveOffDeviceReason(
  timing: {
    activeOvershoot: boolean;
    inCooldown: boolean;
    restoreCooldownSeconds: number;
    shedCooldownRemainingSec: number | null;
  },
  defaultReason: string,
): string {
  if (timing.activeOvershoot) return defaultReason;
  if (timing.inCooldown) {
    const seconds = timing.shedCooldownRemainingSec ?? 0;
    return `cooldown (shedding, ${seconds}s remaining)`;
  }
  return `cooldown (restore, ${timing.restoreCooldownSeconds}s remaining)`;
}
