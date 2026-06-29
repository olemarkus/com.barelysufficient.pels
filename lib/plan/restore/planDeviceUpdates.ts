import type { DevicePlanDevice } from '../planTypes';
import { withSteppedDiscriminant } from '../planTypes';
import { isOffSteppedRestoreCandidate } from './devices';
import {
  getSteppedLoadLowestStep,
  getSteppedLoadOffStep,
} from '../../utils/deviceControlProfiles';
import { isSteppedLoadDevice } from '../planSteppedLoad';

export function setRestorePlanDevice(
  deviceMap: Map<string, DevicePlanDevice>,
  id: string,
  updates: Partial<DevicePlanDevice>,
): void {
  const current = deviceMap.get(id);
  if (!current) return;
  // Spreading two unions decouples the `controlModel`/`steppedLoadProfile`
  // discriminant; re-tie it as a single variant-shaped pair (updates win when
  // they carry it) so the merged device stays assignable to one union member.
  const next: DevicePlanDevice = withSteppedDiscriminant({ ...current, ...updates });
  deviceMap.set(id, next);
}

export function buildOffSteppedRestoreShedUpdate(dev: DevicePlanDevice): Partial<DevicePlanDevice> {
  const offStepId = isSteppedLoadDevice(dev)
    ? (getSteppedLoadOffStep(dev.steppedLoadProfile) ?? getSteppedLoadLowestStep(dev.steppedLoadProfile))?.id
    : dev.selectedStepId;
  return {
    plannedState: 'shed',
    desiredStepId: offStepId,
    targetStepId: offStepId,
    shedAction: dev.shedAction ?? (dev.controlCapabilityId === undefined ? 'set_step' : 'turn_off'),
  };
}

export function buildOffSteppedRestoreHoldUpdate(
  dev: DevicePlanDevice,
  reason: DevicePlanDevice['reason'],
): Partial<DevicePlanDevice> {
  return {
    ...buildOffSteppedRestoreShedUpdate(dev),
    reason,
  };
}

export function resolveRejectedSteppedSwapUpdate(dev: DevicePlanDevice): Partial<DevicePlanDevice> {
  return isOffSteppedRestoreCandidate(dev)
    ? buildOffSteppedRestoreShedUpdate(dev)
    : { plannedState: 'keep' };
}
