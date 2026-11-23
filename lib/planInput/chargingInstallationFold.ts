import { getDebugEmitter } from '../logging/logger';
import {
  getSteppedLoadLowestActiveStep, isSteppedLoadOffStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import type { PlanInputSnapshotDevice } from './runtimeDeviceRead';
import type { PlanInputProjectionSource } from './planInputDeviceTypes';
import type { PlanInputDeviceBase } from '../../packages/planner-types/src/planInputDevice';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

const emitPlanInputDebug = getDebugEmitter('plan_input', 'plan');

/**
 * Resolve the capacity lever alongside the unmodified member input. Smart tasks
 * see the member observations before the capacity cycle consumes this cluster.
 */
export function foldChargingInstallations<T extends PlanInputSnapshotDevice>(
  devices: readonly T[],
  source: Pick<PlanInputProjectionSource, 'readChargingInstallationLevelW'>,
): (T & Pick<PlanInputDeviceBase, 'chargingInstallationLoad'>)[] {
  const byId = new Map(devices.map((device) => [device.id, device]));
  return devices.map((device) => {
    const installation = device.controlAdapter?.chargingInstallation;
    if (installation?.role !== 'main') return device;
    const members = installation.memberIds.flatMap((id) => {
      const member = byId.get(id);
      return member ? [member] : [];
    });
    const levelW = source.readChargingInstallationLevelW(device.id);
    const profile = device.controlModel === 'stepped_load' ? device.steppedLoadProfile : undefined;
    const step = profile && levelW !== undefined ? stepAtLevel(profile, levelW) : null;
    const metered = members.filter((member) => member.measuredPowerKw !== undefined);
    const totalKw = metered.reduce((sum, member) => sum + (member.measuredPowerKw ?? 0), 0);
    const running = members.some((member) => member.binaryControl?.on === true);
    emitPlanInputDebug({
      event: 'charging_installation_planned', installationId: installation.id, mainId: device.id,
      totalKw, levelW: levelW ?? null, stepId: step?.id ?? null,
      members: members.map((member) => ({
        id: member.id, drawKw: member.measuredPowerKw ?? null, on: member.binaryControl?.on ?? null,
      })),
    });
    return {
      ...device,
      chargingInstallationLoad: {
        ...(metered.length ? { currentDrawKw: totalKw } : {}),
        ...(step && levelW !== undefined ? { level: { stepId: step.id, watts: levelW } } : {}),
        running,
      },
    };
  });
}

function stepAtLevel(profile: SteppedLoadProfile, levelW: number): SteppedLoadProfile['steps'][number] | null {
  if (levelW <= 0) return profile.steps.find((step) => isSteppedLoadOffStep(profile, step.id)) ?? null;
  const active = profile.steps.filter((step) => !isSteppedLoadOffStep(profile, step.id));
  const atOrBelow = active.filter((step) => step.planningPowerW <= levelW);
  if (atOrBelow.length === 0) return getSteppedLoadLowestActiveStep(profile);
  return atOrBelow.reduce((best, step) => (step.planningPowerW > best.planningPowerW ? step : best));
}
