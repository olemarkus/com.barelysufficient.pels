import type { DeviceOverviewSnapshot } from './deviceOverview.ts';

export type PlanStateKind =
  | 'active'
  | 'idle'
  | 'held'
  | 'resuming'
  | 'manual'
  | 'unavailable'
  | 'unknown';

export type PlanStateTone =
  | 'active'
  | 'idle'
  | 'held'
  | 'resuming'
  | 'neutral'
  | 'warning';

export const PLAN_STATE_LABEL: Record<PlanStateKind, string> = {
  active: 'Running',
  idle: 'Off',
  held: 'Limited',
  resuming: 'Turning on',
  manual: 'Manual',
  unavailable: 'Unavailable',
  unknown: 'Unknown',
};

export const PLAN_STATE_TONE: Record<PlanStateKind, PlanStateTone> = {
  active: 'active',
  idle: 'idle',
  held: 'held',
  resuming: 'resuming',
  manual: 'neutral',
  unavailable: 'warning',
  unknown: 'neutral',
};

const normalize = (value: string | undefined): string => (value ?? '').trim().toLowerCase();

const isOffLike = (value: string | undefined): boolean => {
  const normalized = normalize(value);
  return normalized === 'off' || normalized === 'unknown';
};

const isOnLike = (value: string | undefined): boolean => {
  const normalized = normalize(value);
  if (!normalized) return false;
  return normalized !== 'off'
    && normalized !== 'unknown'
    && normalized !== 'not_applicable'
    && normalized !== 'disappeared';
};

const isSteppedLoad = (device: DeviceOverviewSnapshot): boolean => device.controlModel === 'stepped_load';

const isGray = (device: DeviceOverviewSnapshot): boolean => {
  if (device.available === false) return true;
  if (device.observationStale === true) return true;
  const normalized = normalize(device.currentState);
  return normalized === 'unknown' || normalized === 'disappeared';
};

const hasSteppedRestorePending = (device: DeviceOverviewSnapshot): boolean => (
  isSteppedLoad(device)
  && isOffLike(device.currentState)
  && Boolean(device.selectedStepId && device.desiredStepId && device.selectedStepId !== device.desiredStepId)
);

const isActiveState = (device: DeviceOverviewSnapshot): boolean => (
  device.currentState === 'not_applicable' || isOnLike(device.currentState)
);

export const resolvePlanStateKind = (device: DeviceOverviewSnapshot): PlanStateKind => {
  if (device.controllable === false) return 'manual';
  if (isGray(device)) return device.available === false ? 'unavailable' : 'unknown';
  if (device.plannedState === 'inactive') return 'idle';
  if (device.plannedState === 'shed') return 'held';
  if (device.binaryCommandPending && isOffLike(device.currentState)) return 'resuming';
  if (hasSteppedRestorePending(device)) return 'resuming';
  if (isActiveState(device)) return 'active';
  return 'resuming';
};


export const resolvePlanStateTone = (device: DeviceOverviewSnapshot): PlanStateTone => (
  PLAN_STATE_TONE[resolvePlanStateKind(device)]
);
