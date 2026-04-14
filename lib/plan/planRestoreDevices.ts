import { getSteppedLoadHighestStep } from '../utils/deviceControlProfiles';
import type { DevicePlanDevice } from './planTypes';
import { sortByPriorityAsc, sortByPriorityDesc } from './planSort';
import { isSteppedLoadDevice } from './planSteppedLoad';

function isLiveEligibleDevice(device: DevicePlanDevice): boolean {
  return device.controllable !== false
    && device.observationStale !== true
    && device.plannedState !== 'shed';
}

export function getOffDevices(planDevices: DevicePlanDevice[]): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((device) => (
      !isSteppedLoadDevice(device)
      && isLiveEligibleDevice(device)
      && device.currentState === 'off'
    ));
  return sortByPriorityAsc(filtered);
}

export function getSteppedRestoreCandidates(planDevices: DevicePlanDevice[]): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((device) => (
      isSteppedLoadDevice(device)
      && isLiveEligibleDevice(device)
      && device.selectedStepId !== undefined
      && device.steppedLoadProfile?.model === 'stepped_load'
      && device.selectedStepId !== getSteppedLoadHighestStep(device.steppedLoadProfile)?.id
    ));
  return sortByPriorityAsc(filtered);
}

export function getOnDevices(
  planDevices: DevicePlanDevice[],
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  },
): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((device) => !isSteppedLoadDevice(device) && isLiveEligibleDevice(device))
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
  return 'charger power unknown; configure expected power or let PELS observe a charging peak';
}

export function getInactiveReason(dev: DevicePlanDevice): string | null {
  const evStateBlock = getEvRestoreStateBlockReason(dev);
  if (evStateBlock) return `inactive (${evStateBlock})`;

  const evPowerBlock = getEvUnknownPowerBlockReason(dev);
  if (evPowerBlock) return `inactive (${evPowerBlock})`;

  return null;
}

export function markOffDevicesStayOff(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  timing: {
    activeOvershoot: boolean;
    inCooldown: boolean;
    inStartupStabilization: boolean;
    restoreCooldownSeconds: number;
    shedCooldownRemainingSec: number | null;
    startupStabilizationRemainingSec: number | null;
  };
  logDebug: (...args: unknown[]) => void;
  setDevice: (id: string, updates: Partial<DevicePlanDevice>) => void;
  reasonOverride?: (dev: DevicePlanDevice) => string;
}): void {
  const {
    deviceMap,
    timing,
    setDevice,
    reasonOverride,
  } = params;
  const offDevices = Array.from(deviceMap.values())
    .filter((device) => isLiveEligibleDevice(device) && device.currentState === 'off');
  for (const dev of offDevices) {
    const inactiveReason = getInactiveReason(dev);
    if (inactiveReason) {
      setDevice(dev.id, { plannedState: 'inactive', reason: inactiveReason });
      continue;
    }
    const defaultReason = dev.reason || 'shed due to capacity';
    const nextReason = reasonOverride ? reasonOverride(dev) : resolveOffDeviceReason(timing, defaultReason);
    setDevice(dev.id, { plannedState: 'shed', reason: nextReason });
  }
}

function canSwapOutDevice(
  dev: DevicePlanDevice,
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null },
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
    inStartupStabilization: boolean;
    restoreCooldownSeconds: number;
    shedCooldownRemainingSec: number | null;
    startupStabilizationRemainingSec: number | null;
  },
  defaultReason: string,
): string {
  if (timing.inStartupStabilization) return 'startup stabilization';
  if (timing.activeOvershoot) return defaultReason;
  if (timing.inCooldown) {
    const seconds = timing.shedCooldownRemainingSec ?? 0;
    return `cooldown (shedding, ${seconds}s remaining)`;
  }
  return `cooldown (restore, ${timing.restoreCooldownSeconds}s remaining)`;
}
