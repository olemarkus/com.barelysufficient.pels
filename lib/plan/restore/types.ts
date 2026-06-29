import type { Logger as PinoLogger, StructuredDebugEmitter } from '../../logging/logger';
import type { DevicePlanDevice } from '../planTypes';
import type { SwapStateSnapshot } from '../swap';
import type { DeviceDiagnosticsRecorder } from '../../diagnostics/deviceDiagnosticsService';
import type { PowerTrackerState } from '../../power/tracker';

export type RestoreDeps = {
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  };
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  deviceNameById?: ReadonlyMap<string, string>;
  logDebug: (...args: unknown[]) => void;
};

export type RestorePlanState = SwapStateSnapshot;

export type RestoreBatchState = {
  enabled: boolean;
  maxDevices: number;
  maxNeedKw: number;
  admittedCount: number;
  admittedNeedKw: number;
};

export type RestoreLoopState = {
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
};

export type RestorePlanResult = {
  planDevices: DevicePlanDevice[];
  stateUpdates: RestorePlanState;
  restoredThisCycle: Set<string>;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  inCooldown: boolean;
  inRestoreCooldown: boolean;
  activeOvershoot: boolean;
  restoreCooldownSeconds: number;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs: number | null;
  shedCooldownTotalSec: number | null;
  restoreCooldownRemainingSec: number | null;
  restoreCooldownStartedAtMs: number | null;
  restoreCooldownTotalSec: number | null;
  inShedWindow: boolean;
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
};
