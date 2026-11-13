import type { DevicePlan } from '../plan/planTypes';
import { isTemperaturePlanDevice } from '../plan/planTemperatureDevice';
import { formatDeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { MAIN_HOME_ID } from '../home/homeConfig';
import type { HomeMembershipPort } from '../home/membership';

export type DeviceDebugPlanSummary = {
  id: string;
  name: string;
  currentState: string;
  plannedState: string;
  currentTarget: unknown;
  plannedTarget?: number;
  reason?: string;
  reasonDetails: DevicePlan['devices'][number]['reason'];
  /** Effective rank in the committed plan, not the capture-time configuration rank. */
  priority: number;
  plannedShedTargetKind?: DevicePlan['devices'][number]['plannedShedTargetKind'];
  externalOffHoldActive?: boolean;
  startPolicyHoldActive?: true;
  controllable?: boolean;
  pendingTargetCommand?: DevicePlan['devices'][number]['pendingTargetCommand'];
};

const compactPelsPlanDevice = (
  device: DevicePlan['devices'][number] | null,
): DeviceDebugPlanSummary | null => {
  if (!device) return null;
  return {
    id: device.id,
    name: device.name,
    currentState: device.currentState,
    plannedState: device.plannedState,
    currentTarget: isTemperaturePlanDevice(device) ? device.currentTarget : null,
    plannedTarget: isTemperaturePlanDevice(device) ? device.plannedTarget : undefined,
    reason: formatDeviceReason(device.reason),
    reasonDetails: device.reason,
    priority: device.priority,
    plannedShedTargetKind: device.plannedShedTargetKind,
    externalOffHoldActive: device.externalOffHoldActive,
    startPolicyHoldActive: device.startPolicyHoldActive,
    controllable: device.control.commandAuthority,
    pendingTargetCommand: device.pendingTargetCommand,
  };
};

/** The Main-only decision, with its own timestamp and an explicit scope omission for area devices. */
export function captureDeviceDebugPlan(
  plan: DevicePlan | null | undefined,
  membership: Pick<HomeMembershipPort,
    'isOwnershipReady' | 'hasPendingOwnershipGeneration' | 'getHomeIdForDevice'> | undefined,
  deviceId: string,
): { planDevice: DeviceDebugPlanSummary | null; planGeneratedAtMs?: number; planOmission?: string } {
  try {
    if (membership && (!membership.isOwnershipReady() || membership.hasPendingOwnershipGeneration())) {
      return { planDevice: null, planOmission: 'Current device plan ownership is unavailable.' };
    }
    if ((membership?.getHomeIdForDevice(deviceId) ?? MAIN_HOME_ID) !== MAIN_HOME_ID) {
      return { planDevice: null, planOmission: 'Current device plan is available for Main only.' };
    }
  } catch {
    return { planDevice: null, planOmission: 'Current device plan ownership is unavailable.' };
  }
  const planDevice = compactPelsPlanDevice(plan?.devices.find((entry) => entry.id === deviceId) ?? null);
  return { planDevice, ...(planDevice ? { planGeneratedAtMs: plan?.generatedAtMs } : {}) };
}
