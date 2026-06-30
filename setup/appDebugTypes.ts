import type { DeviceCalibration } from '../packages/contracts/src/powerCalibration';
import type { DevicePlan, StepPowerCalibrationView } from '../lib/plan/planTypes';
import type {
  SteppedLoadProfile,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../packages/contracts/src/types';

export type UnknownRecord = Record<string, unknown>;

export type EnergyApproximationValues = {
  usageOnW: number | null;
  usageOffW: number | null;
  energyW: number | null;
};

export type EnergyInference = {
  inferredExpectedW: number | null;
  inferredSource: string | null;
};

export type EnergyDebugPayload = EnergyApproximationValues & {
  onoff: boolean | null;
} & EnergyInference;

export type DebugSection<T> = {
  available: boolean;
  payload: T | null;
  source?: string;
  error?: string;
};

export type HomeyCapabilitySummary = {
  value?: unknown;
  units?: string;
  lastUpdated?: string;
  setable?: boolean;
  getable?: boolean;
};

export type HomeyDeviceSummary = {
  id: string;
  name: string;
  class?: string;
  driverId?: string;
  available?: boolean;
  ready?: boolean;
  zone?: string;
  lastSeenAt?: string;
  capabilities: string[];
  capabilityValues: Record<string, HomeyCapabilitySummary>;
};

export type PelsTargetSnapshotSummary = {
  id: string;
  name: string;
  deviceType?: string;
  controlModel?: TargetDeviceSnapshot['controlModel'];
  controlCapabilityId?: string;
  controlAdapter?: TargetDeviceSnapshot['controlAdapter'];
  capabilities?: string[];
  steppedLoadProfile?: SteppedLoadProfile;
  suggestedSteppedLoadProfile?: TargetDeviceSnapshot['suggestedSteppedLoadProfile'];
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
  binaryControl?: { on: boolean };
  currentTemperature?: number;
  targets: Array<{ id: string; value?: unknown; unit: string }>;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  reportedStepId?: string;
  controllable?: boolean;
  managed?: boolean;
  available?: boolean;
  lastUpdated?: number;
};

export type PelsPlanDeviceSummary = {
  id: string;
  name: string;
  currentState: string;
  plannedState: string;
  currentTarget: unknown;
  plannedTarget?: number;
  reason?: string;
  controllable?: boolean;
  stepPowerCalibration?: Record<string, StepPowerCalibrationView>;
  pendingTargetCommand?: DevicePlan['devices'][number]['pendingTargetCommand'];
};

export type PelsDeviceDebugState = {
  present: boolean;
  targetSnapshot: PelsTargetSnapshotSummary | null;
  planDevice: PelsPlanDeviceSummary | null;
  powerCalibration?: DeviceCalibration | null;
  observedSources?: PelsObservedSourcesSummary;
  error?: string;
};

export type PelsObservedSourceSummary = {
  observedAt: string;
  path: string;
  state: DeviceStateComparisonSource | null;
  fetchSource?: string;
  capabilityId?: string;
  value?: unknown;
  localEcho?: boolean;
  shouldReconcilePlan?: boolean;
  preservedLocalState?: boolean;
  changes?: Array<{
    capabilityId: string;
    previousValue: string;
    nextValue: string;
  }>;
};

export type PelsObservedSourcesSummary = {
  snapshotRefresh: PelsObservedSourceSummary | null;
  deviceUpdate: PelsObservedSourceSummary | null;
  realtimeCapabilities: Record<string, PelsObservedSourceSummary>;
  localWrites: Record<string, PelsObservedSourceSummary>;
};

export type DeviceDebugDump = {
  homey: {
    summary: DebugSection<HomeyDeviceSummary>;
    settings: DebugSection<unknown>;
    energyApproximation: DebugSection<EnergyDebugPayload>;
    comparison: DebugSection<DeviceStateComparison>;
  };
  pels?: PelsDeviceDebugState;
};

export type DeviceStateComparisonSource = {
  sourceState?: string;
  target?: unknown;
  powerW?: number | null;
  lastSeenAt?: string;
  onoffLastUpdated?: string;
  targetLastUpdated?: string;
  powerLastUpdated?: string;
};

export type DeviceStateComparison = {
  managerDevices: DeviceStateComparisonSource | null;
  pelsSnapshot: DeviceStateComparisonSource | null;
  pelsPlan: {
    currentState: string;
    plannedState: string;
    currentTarget: unknown;
    plannedTarget?: number;
    pendingTargetCommand?: DevicePlan['devices'][number]['pendingTargetCommand'];
  } | null;
};
