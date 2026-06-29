/**
 * `PlanServiceDeps` — the injection contract for `PlanService`. Extracted to its
 * own module so the rebuild-orchestration slice (`planServiceRebuild.ts`) can
 * type its host seam against it without importing the service class, keeping the
 * `planService ↔ planServiceRebuild` edge acyclic. Re-exported from
 * `planService.ts` so existing importers see no change.
 */
import type { SettingsPort, FlowPort, ApiPort } from '../ports/homeyRuntime';
import type { Loggers, StructuredDebugEmitter } from '../logging/logger';
import type { SettingsUiPlanDeviceSnapshot } from '../../packages/contracts/src/settingsUiApi';
import type { DeviceOverviewLogRecorder } from './deviceOverviewLog';
import type { PendingBinaryLiveDevice } from '../observer/pendingBinaryCommands';
import type { buildPelsStatus } from './pelsStatus';
import type { PlanEngine } from './planEngine';
import type { PlanInputDevice } from './planTypes';
import type { DeviceControlModel, EvChargingState } from '../../packages/contracts/src/types';
import type { SnapshotWarmupGate } from './snapshotWarmupGate';

export type PlanServiceDeps = {
  homey: { settings: SettingsPort; flow: FlowPort; api: ApiPort };
  writePelsStatus: (status: ReturnType<typeof buildPelsStatus>['status']) => void;
  planEngine: PlanEngine;
  getPlanDevices: () => PlanInputDevice[];
  // Binary-settle evidence (`binaryControlObservation`) is observer-internal and NOT
  // exposed on `PlanInputDevice`; the settle reads it off the device snapshot directly.
  // PRODUCTION MUST PROVIDE THIS (the raw device snapshot) — when omitted it falls back
  // to `getPlanDevices`, which carries no `binaryControlObservation`, so the settle would
  // never confirm. The fallback exists only so tests that don't exercise the settle can
  // omit it.
  getSettleDevices?: () => PendingBinaryLiveDevice[];
  // EV charging state for the settings-UI read model, sourced from the observer
  // (its canonical owner — `ObservedDeviceState`), not the plan device. The
  // planner no longer carries the raw `evChargingState`.
  getObservedEvChargingState?: (deviceId: string) => EvChargingState | undefined;
  // Producer `deviceType` map for the settings-UI control-mode card selection
  // (the planner no longer carries `controlModel`). Built once per serialize from
  // the raw snapshot; see `SettingsOverviewReadModelDeps.getDeviceTypeById`.
  getDeviceTypeById?: () => Map<string, 'temperature' | 'onoff'>;
  // Producer `controlModel` map for the device-overview transition signature
  // (the planner no longer carries `controlModel`). Built ONCE per
  // `emitOverviewTransitions` pass from the raw, undecorated device snapshot
  // (`deviceManager.getSnapshot()`) — NOT `latestTargetSnapshot` — so capturing
  // it triggers no re-decoration and never re-enters the device manager
  // per-device inside the plan/apply cycle. Restoring the real control model
  // (not just the stepped value) lets the signature distinguish a non-stepped
  // `temperature_target ↔ binary_power` flip; without it both collapse to
  // `null` and a deviceType-only change leaves an open overview card stale.
  getControlModelById?: () => Map<string, DeviceControlModel>;
  getCapacityDryRun: () => boolean;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getCombinedPrices: () => unknown;
  getLastPowerUpdate: () => number | null;
  schedulePostActuationRefresh?: () => void;
  loggers?: Loggers;
  overviewDebugStructured?: StructuredDebugEmitter;
  isOverviewDebugEnabled?: () => boolean;
  // Optional in-memory recorder for the settings-UI device-log view. Captures
  // the SAME overview-transition change boundary the debug log uses, but is
  // NOT gated on the debug topic, so the view has data without the user
  // enabling debug logging first.
  deviceOverviewLogRecorder?: DeviceOverviewLogRecorder;
  isPlanDebugEnabled?: () => boolean;
  deviceDiagnostics?: {
    getOverviewStarvation?: (deviceId: string) => SettingsUiPlanDeviceSnapshot['starvation'] | null;
  };
  // Hold the first plan rebuild until the first device snapshot resolves (or
  // a bounded timeout expires). Without the gate, a price/settings/realtime
  // trigger that arrives between `initDeviceManager` and the first snapshot
  // refresh runs the planner against an empty snapshot and publishes a
  // one-cycle `deferred_objective_unknown reasonCode:objective_missing_device`
  // status, which fires a spurious `waiting → unachievable` flow trigger.
  snapshotWarmupGate?: SnapshotWarmupGate;
};
