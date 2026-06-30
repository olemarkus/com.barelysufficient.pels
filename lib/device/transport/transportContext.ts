/**
 * Shared runtime context handed to the homey-free transport collaborator
 * modules (`realtimeCapabilityHandling`, `binarySettleEvidence`, `deviceWrites`,
 * `deviceUpdateHandling`). The `DeviceTransport` leaf builds exactly one of these
 * in its constructor (state references + bound callbacks) and threads it into the
 * extracted free functions, so the functions mutate the SAME shared snapshot /
 * evidence maps the class owns — object identity is preserved.
 *
 * This module is NOT in the Homey-SDK-leaf allowlist, so it must stay homey-free:
 * it must never reference the `homey` SDK package (no value or type usage), and no
 * `Homey.*` types. `HomeyDeviceLike` (from `lib/utils/types`) is a homey-free
 * structural mirror, so it is allowed here.
 */
import type { BinaryControlObservation, TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { BinarySettleState } from '../../observer/binarySettle';
import type { LiveDevicePowerWatts } from '../managerEnergy';
import type { DeviceFetchResult } from './managerFetch';
import type { PowerEstimateState } from '../devicePowerEstimate';
import type { DeviceMeasuredPowerResolver } from '../measuredPowerResolver';
import type { DeviceTransportObservationState } from './managerObservation';
import type { RecentLocalCapabilityWrites } from './managerRealtimeSupport';
import type { DeviceTransportParseProviders } from './managerParseDevice';
import type { TargetedMissState } from './targetedSnapshotMerge';
import type {
  ObservationCursor,
  ObservedDeviceStateEvent,
  PlanRealtimeUpdateEvent,
} from './managerRealtimeHandlers';
import type {
  BinarySettleDepsForTransport,
  DeviceTransportBinarySettleOps,
  SteppedLoadFlowTriggerCard,
  TransportObservedStateDispatcher,
} from './transportTypes';

/**
 * Producer-ish surfaces the device-update path notes new role members on before
 * the first full refresh. Structural so this module does not import the producer
 * classes (which would pull device-peer dependencies in).
 */
export type TransportRoleProducer = {
  observe: (devices: readonly HomeyDeviceLike[], options: { fullRefresh: boolean }) => void;
  noteBatteryDevice: (device: HomeyDeviceLike) => void;
};

export type TransportSolarRoleProducer = {
  observe: (devices: readonly HomeyDeviceLike[], options: { fullRefresh: boolean }) => void;
  noteSolarDevice: (device: HomeyDeviceLike) => void;
};

/**
 * The shared state + callback surface the extracted transport collaborators use.
 * Members typed as getters resolve fields the leaf reassigns (`latestSnapshot`,
 * `latestSnapshotById`); plain map/object members are stable references mutated
 * in place. Callbacks delegate to methods that stay on the leaf (the
 * EventEmitter bridge, the per-device cursor, the parse pipeline).
 */
export type TransportContext = {
  /** Identity key for the native stepped-load adapter WeakMap (the leaf instance). */
  readonly owner: object;
  readonly logger: Logger;
  readonly debugStructured: StructuredDebugEmitter | undefined;
  readonly onSnapshotMutated: ((snapshot: TargetDeviceSnapshot, nowMs: number) => void) | undefined;

  /** Reassigned by `setSnapshot` — read through the getter so it stays current. */
  readonly latestSnapshot: TransportDeviceSnapshot[];
  /** Reassigned by `syncLatestSnapshotIndex` — read through the getter. */
  readonly latestSnapshotById: Map<string, TransportDeviceSnapshot>;
  readonly latestBinarySettleEvidenceByDeviceId: Map<string, BinaryControlObservation>;
  readonly observationState: DeviceTransportObservationState;
  readonly recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  readonly recentRealtimeCapabilityEventLogByKey: Map<string, number>;
  readonly binarySettleState: BinarySettleState;
  readonly binarySettleOps: DeviceTransportBinarySettleOps;

  readonly batteryStateProducer: TransportRoleProducer;
  readonly solarProductionProducer: TransportSolarRoleProducer;

  nextObservationCursor(deviceId: string, nowMs?: number): ObservationCursor;
  dispatchObservedStateChanged(event: ObservedDeviceStateEvent): void;
  dispatchPlanReconcile(event: PlanRealtimeUpdateEvent): void;
  emitPlanReconcileEvent(event: PlanRealtimeUpdateEvent): void;
  consultPendingPredicate(deviceId: string, capabilityId: string): boolean;
  shouldTrackRealtimeDevice(deviceId: string): boolean;
  getBinarySettleDeps(): BinarySettleDepsForTransport;

  applyDeviceDriverOverride(device: HomeyDeviceLike): HomeyDeviceLike;
  parseDevice(
    device: HomeyDeviceLike,
    now: number,
    livePowerWByDeviceId: LiveDevicePowerWatts,
  ): TargetDeviceSnapshot | null;
  syncTrackedNativeSteppedLoadAdapters(): void;
  setTrackedDevice(deviceId: string, device: HomeyDeviceLike): void;
  deleteTrackedDevice(deviceId: string): void;

  // Write-seam collaborators.
  readonly getFlowTriggerCard: ((cardId: string) => SteppedLoadFlowTriggerCard | undefined) | undefined;
  isSdkReady(): boolean;
  updateLocalSnapshot(deviceId: string, updates: { on: boolean }): void;
  dispatchObservedStateForDevice(deviceId: string, capabilityId?: string): void;
  refreshSnapshot(
    options?: { includeLivePower?: boolean; targetedRefresh?: boolean },
  ): Promise<{ powerW: number; generationW?: number } | null>;

  // --- Snapshot-refresh pipeline collaborators (snapshotRefresh.ts) ---
  // Parse-binding inputs (stable references built once in the constructor).
  readonly providers: DeviceTransportParseProviders;
  readonly powerState: Required<PowerEstimateState>;
  readonly measuredPowerResolver: DeviceMeasuredPowerResolver;
  readonly observedStateDispatcher: TransportObservedStateDispatcher | undefined;
  // Per-device targeted-miss grace state — stable Map, mutated in place.
  readonly targetedMissByDeviceId: Map<string, TargetedMissState>;
  // Mutable scalars the leaf reassigns; threaded via accessor pairs so the
  // refresh pipeline mutates the SAME backing fields.
  getEmptySnapshotGrace(): { firstSeenMs: number; reads: number } | null;
  setEmptySnapshotGrace(value: { firstSeenMs: number; reads: number } | null): void;
  getLastSnapshotRefreshMetricsKey(): string | null;
  setLastSnapshotRefreshMetricsKey(value: string | null): void;
  getLatestRawDevices(): HomeyDeviceLike[];
  setLatestRawDevices(devices: HomeyDeviceLike[]): void;
  getTrackedDevicesById(): Map<string, HomeyDeviceLike>;
  // Fetch seams routed through the leaf's instance methods so a test spy on
  // `DeviceTransport.fetchDevicesForSnapshot` is honored.
  fetchDevicesForSnapshot(): Promise<DeviceFetchResult>;
  fetchDevicesByKnownIds(): Promise<DeviceFetchResult>;
  // Commit-side seams owned by the leaf (snapshot index + event bridge + live feed).
  setSnapshot(snapshot: TargetDeviceSnapshot[]): void;
  dispatchObservedStateRefresh(snapshot: TargetDeviceSnapshot[]): void;
  updateLiveFeedTrackedDevices(deviceIds: string[]): void;
};
