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
import type { HomeId } from '../../packages/contracts/src/settingsKeys';

type PlanServicePlanEngine = Pick<
  PlanEngine,
  | 'state'
  | 'buildDevicePlanSnapshot'
  | 'computeDynamicSoftLimit'
  | 'computeShortfallThreshold'
  | 'handleShortfall'
  | 'handleShortfallCleared'
  | 'applyPlanActions'
  | 'shouldApplyStablePlanActions'
  | 'syncPendingTargetCommands'
  | 'syncPendingBinaryCommands'
  | 'prunePendingTargetCommands'
  | 'decoratePlanWithPendingTargetCommands'
  | 'hasPendingTargetCommands'
  | 'hasPendingBinaryCommands'
  | 'applySheddingToDevice'
  | 'evaluateHeadroomForDevice'
  | 'syncHeadroomCardState'
  | 'syncHeadroomUsageObservation'
>;

/**
 * Injection contract owned by `PlanService` and shared with the rebuild
 * orchestration slice to keep their dependency edge acyclic. Setup callers
 * must provide the stable owning home and live service dependencies.
 *
 * Every queued operation establishes `homeId` in AsyncLocalStorage so
 * descendant planner/executor logs inherit it; see `notes/logging/README.md`.
 * Re-exported from `planService.ts` so existing importers retain one seam.
 */
export type PlanServiceDeps = {
  /**
   * Stable owner of this plan-operation queue. Every caller must supply it so
   * queued descendant logs can inherit `homeId` through AsyncLocalStorage.
   */
  homeId: HomeId;
  homey: { settings: SettingsPort; flow: FlowPort; api: ApiPort };
  writePelsStatus: (status: ReturnType<typeof buildPelsStatus>['status']) => void;
  planEngine: PlanServicePlanEngine;
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
  // Observation staleness for the settings-UI gray-state label AND the idle
  // classifier's "unresponsive" detection, sourced from the observer (its
  // canonical owner — `ObservedDeviceState` freshness), not the plan device. The
  // plan no longer carries `observationStale`: the plan trusts producer-resolved
  // `currentOn`/`currentState`, and staleness reporting belongs to the observer.
  getObservationStale?: (deviceId: string) => boolean;
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
  /**
   * When set, the effective (membership-gated) dry-run this bundle actuates on,
   * written into `pels_status` as `dryRunEffective` so the per-home Limits card
   * shows honest posture (R7b: persisted-live but no committed zone tree still
   * reads Simulating). Sub-homes only — the main home omits it so its persisted
   * `pels_status` blob stays byte-identical.
   */
  getStatusEffectiveDryRun?: () => boolean;
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
  // Whether this service drives the shared settings-UI realtime `plan_updated`
  // channel. The settings UI reads ONE `plan_updated` stream (the main home's
  // plan); a sub-home capacity bundle (R7b) must NOT clobber it with its own
  // partitioned plan payload, so it binds `false`. Omitted/undefined = the
  // pre-R7b behavior (main always emits), preserving single-home byte-identity.
  emitsUiRealtime?: boolean;
  // Hold the first plan rebuild until the first device snapshot resolves (or
  // a bounded timeout expires). Without the gate, a price/settings/realtime
  // trigger that arrives between `initDeviceManager` and the first snapshot
  // refresh runs the planner against an empty snapshot and publishes a
  // one-cycle `deferred_objective_unknown reasonCode:objective_missing_device`
  // status, which fires a spurious `waiting → unachievable` flow trigger.
  snapshotWarmupGate?: SnapshotWarmupGate;
};
