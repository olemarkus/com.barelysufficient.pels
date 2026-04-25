import type { SteppedLoadProfile } from '../../contracts/src/types.js';
import type { SettingsUiPlanDeviceSnapshot } from '../../contracts/src/settingsUiApi.js';

type SteppedBarDevice = Pick<
  SettingsUiPlanDeviceSnapshot,
  | 'controlModel'
  | 'currentState'
  | 'reportedStepId'
  | 'actualStepId'
  | 'assumedStepId'
  | 'selectedStepId'
  | 'targetStepId'
  | 'desiredStepId'
  | 'measuredPowerKw'
  | 'planningPowerKw'
>;

export type PlanSteppedBarSegment = {
  id: string;
  filled: boolean;
  isActive: boolean;
  isTarget: boolean;
  pulse: boolean;
  planningPowerKw: number;
};

export type PlanSteppedBarView = {
  segments: PlanSteppedBarSegment[];
  activeIndex: number;
  targetIndex: number | null;
  direction: 'up' | 'down' | 'none';
  activeLabel: string;
  targetLabel: string | null;
  measuredKw: number | null;
  expectedKw: number | null;
};

const isOffState = (state: string | undefined): boolean => {
  if (!state) return false;
  const normalized = state.trim().toLowerCase();
  return normalized === 'off' || normalized === 'unknown' || normalized === 'disappeared';
};

const resolveActiveStepId = (device: SteppedBarDevice, profile: SteppedLoadProfile): string | null => {
  // When the device is off, prefer an explicit "off" step in the profile.
  if (isOffState(device.currentState)) {
    const offStep = profile.steps.find((s) => s.id.toLowerCase() === 'off');
    if (offStep) return offStep.id;
  }
  return (
    device.reportedStepId
    ?? device.actualStepId
    ?? device.assumedStepId
    ?? device.selectedStepId
    ?? null
  );
};

const resolveTargetStepId = (device: SteppedBarDevice): string | null => (
  device.targetStepId ?? device.desiredStepId ?? null
);

const findIndex = (profile: SteppedLoadProfile, stepId: string | null): number => (
  stepId ? profile.steps.findIndex((s) => s.id === stepId) : -1
);

type Resolved = {
  activeIndex: number;
  targetIndex: number | null;
  direction: 'up' | 'down' | 'none';
};

const resolveIndices = (
  device: SteppedBarDevice,
  profile: SteppedLoadProfile,
): Resolved => {
  const activeStepId = resolveActiveStepId(device, profile);
  const targetStepId = resolveTargetStepId(device);
  const activeIndex = Math.max(0, findIndex(profile, activeStepId));
  const rawTargetIndex = findIndex(profile, targetStepId);
  const targetIndex = rawTargetIndex >= 0 && rawTargetIndex !== activeIndex ? rawTargetIndex : null;
  const resolveDirection = (): 'up' | 'down' | 'none' => {
    if (targetIndex === null) return 'none';
    return targetIndex > activeIndex ? 'up' : 'down';
  };
  return { activeIndex, targetIndex, direction: resolveDirection() };
};

const resolvePulseIndex = (indices: Resolved): number | null => {
  if (indices.direction === 'up') return indices.targetIndex;
  if (indices.direction === 'down') return indices.activeIndex;
  return null;
};

const buildSegments = (profile: SteppedLoadProfile, indices: Resolved): PlanSteppedBarSegment[] => {
  const { activeIndex, targetIndex } = indices;
  const pulseIdx = resolvePulseIndex(indices);
  return profile.steps.map((step, idx) => ({
    id: step.id,
    filled: idx <= activeIndex,
    isActive: idx === activeIndex,
    isTarget: idx === targetIndex,
    pulse: pulseIdx !== null && idx === pulseIdx,
    planningPowerKw: step.planningPowerW / 1000,
  }));
};

const readMeasuredKw = (device: SteppedBarDevice): number | null => (
  typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)
    ? device.measuredPowerKw
    : null
);

export const resolveSteppedBar = (
  device: SteppedBarDevice,
  profile: SteppedLoadProfile | null,
): PlanSteppedBarView | null => {
  if (device.controlModel !== 'stepped_load') return null;
  if (!profile || profile.steps.length === 0) return null;

  const indices = resolveIndices(device, profile);
  const segments = buildSegments(profile, indices);
  const { activeIndex, targetIndex, direction } = indices;
  const measuredKw = readMeasuredKw(device);
  const activeStep = profile.steps[activeIndex];
  const targetStep = targetIndex !== null ? profile.steps[targetIndex] : null;

  return {
    segments,
    activeIndex,
    targetIndex,
    direction,
    activeLabel: activeStep?.id ?? '',
    targetLabel: targetStep?.id ?? null,
    measuredKw,
    expectedKw: targetStep
      ? targetStep.planningPowerW / 1000
      : (activeStep?.planningPowerW ?? 0) / 1000,
  };
};
