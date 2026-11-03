import type { DeviceControlAdapterSnapshot, SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { PlannedReleaseIntent } from './releaseIntent';
import type { StorageDecidedDevice, StorageReleaseIntent } from './storageDecision';
import type { InverterDecision } from './inverterDecision';
import type { PlannedTargetCommand } from './targetCommand';

/** A selected end state. This is a decision, never a configured shed floor. */
export type PlannedShedTarget =
  | { kind: 'binary_off' }
  | { kind: 'step'; stepId: string | undefined }
  | { kind: 'target_value' };

export type PlannedBinaryCommand = {
  deviceId: string;
  name: string;
  desiredOn: boolean;
  source: 'controlled' | 'uncontrolled';
};
export type PlannedReleaseCommand = PlannedReleaseIntent & { deviceId: string; name: string };
export type PlannedStepTransition = {
  effectiveTransition: 'full_shed_to_off' | 'restore_from_off_at_low' | 'initialize_unknown_step_at_low'
    | 'step_down_while_on' | 'step_up_while_on' | 'steady';
  stepPreparationPurpose: 'prepare_for_off' | 'prepare_for_on' | 'initialize_unknown_step' | null;
  binaryTarget: boolean | null;
  commandStepId: string | undefined;
  plannedDesiredStepId: string | undefined;
  transitionPhase: 'step_preparation' | 'binary_transition' | 'settled';
};
export type PlannedStepDesiredState = { stepId?: string; plannedStepId?: string };

/** The decided step operation. Pending, retry and confirmation state is execution-owned. */
export type PlannedSteppedCommand = {
  id: string;
  name: string;
  steppedLoadProfile: SteppedLoadProfile;
  controlAdapter?: DeviceControlAdapterSnapshot;
  plannedShedTarget?: PlannedShedTarget;
  desired: PlannedStepDesiredState;
  stepDirection: 'any' | 'down_only';
  previousStepId?: string;
  transition: PlannedStepTransition | null;
};

/**
 * The binary axis a stepped command drives: attached only when this cycle's
 * decision moves the on/off handle. Consumers reach it through
 * `isBinaryDrivenIntent` (`lib/executor/executableDesiredState.ts`).
 */
export type PlannedBinaryDrive = { desiredOn: boolean };

/** Axes are attached only when this decision drives them. */
export type PlannedDeviceCommands = {
  id: string;
  name: string;
  commandAuthority: boolean;
  /** Set only by the projection's failure path; the device carries no commands. */
  projectionError?: unknown;
};

/**
 * The axes a decision may attach to `PlannedDeviceCommands`, typed for the
 * producer (`buildExecutableDeviceIntent`) so each attached command is checked.
 * `PlannedDeviceCommands` itself declares none: consumers reach an axis only
 * through its guard, so an unguarded read stays a compile error.
 */
export type PlannedCommandAxes = {
  target?: PlannedTargetCommand;
  binary?: PlannedBinaryCommand;
  release?: PlannedReleaseCommand;
  steppedLoad?: PlannedSteppedCommand;
};
export type PlannedStepBaseline = {
  /** Historical effective state at decision time; never published as live observation. */
  on: boolean | null;
  stepId?: string;
};

/** Qualified operations whose remaining suppression depends on execution-owned command state. */
export type StableExecutionOperation = 'uncontrolled_restore' | 'binary_release' | 'step_change'
  | 'initialize_step' | 'binary_restore';
export type PlannedDeviceExecution = {
  commands: PlannedDeviceCommands;
  stableOperations: StableExecutionOperation[];
  /** Historical fallback used only where the old dispatch lacked a current step observation. */
  stepBaseline?: PlannedStepBaseline;
  /** Distinguishes capacity accounting from an owner's standing off posture. */
  nonCapacityHoldShed: boolean;
};
export type DroppedSteppedShedIntent = {
  deviceId: string;
  deviceName: string;
  selectedStepId: string | null;
  desiredStepId: string | null;
};
/** The execution boundary excludes planner reasons, admission state, UI fields and raw inputs. */
export type ExecutionPlan = {
  devices: PlannedDeviceExecution[];
  hasShedDevices: boolean;
  droppedSteppedSheds: DroppedSteppedShedIntent[];
  storageDevices: StorageDecidedDevice[];
  storageReleases: StorageReleaseIntent[];
  inverterDecisions: InverterDecision[];
};
export const hasPlannedStep = <T extends PlannedDeviceCommands>(
  i: T,
): i is T & { steppedLoad: PlannedSteppedCommand } =>
  'steppedLoad' in i && i.steppedLoad != null;
