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
import type {
  AssociatedCarSnapshot,
  BinaryControlObservation,
  TargetDeviceSnapshot,
} from '../../../packages/contracts/src/types';
import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { LiveDevicePowerWatts } from '../managerEnergy';
import type { DeviceFetchResult } from './managerFetch';
import type { HomePowerSampleWithIdentity } from './resolvedHomeMeterDispatch';
import type { ZoneTreeCache } from './zoneTreeCache';
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
  ResolvedTransportPowerState,
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
 * The EV car-to-charger link probe (`lib/device/evCarLinkProducer.ts`). Unlike
 * the battery/solar role producers it takes an explicit `nowMs`: its whole job
 * is timing coincident plug edges, so the clock is an input rather than an
 * ambient read.
 */
export type TransportEvCarLinkProducer = {
  observe: (
    devices: readonly HomeyDeviceLike[],
    options: { fullRefresh: boolean; nowMs: number },
  ) => void;
  noteDeviceUpdate: (device: HomeyDeviceLike, nowMs: number) => void;
  noteCapabilityUpdate: (deviceId: string, capabilityId: string, value: unknown, nowMs: number) => void;
  tick: (nowMs: number) => void;
  getObservedCarDeviceIds: () => string[];
  getAssociatedCarForCharger: (chargerId: string) => AssociatedCarSnapshot | undefined;
};

export type SnapshotRefreshOptions = {
  includeLivePower?: boolean;
  targetedRefresh?: boolean;
  mainMeterSelection?: MainMeterSelection;
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
  /** Session-sticky identity used to stabilize Automatic cumulative selection. */
  readonly automaticHomeMeterState: { preferredDeviceId: string | null };

  /** The read-only observation producers, built together in `observationProducers.ts`. */
  readonly observationProducers: {
    readonly battery: TransportRoleProducer;
    readonly solar: TransportSolarRoleProducer;
    readonly evCarLink: TransportEvCarLinkProducer;
  };

  nextObservationCursor(deviceId: string, nowMs?: number): ObservationCursor;
  dispatchObservedStateChanged(event: ObservedDeviceStateEvent): void;
  dispatchObservedControlStateChanged(event: PlanRealtimeUpdateEvent): void;
  emitObservedControlStateChangedEvent(event: PlanRealtimeUpdateEvent): void;
  shouldTrackRealtimeDevice(deviceId: string): boolean;

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
  dispatchObservedStateForDevice(deviceId: string, capabilityId?: string): void;
  refreshSnapshot(options?: SnapshotRefreshOptions): Promise<HomePowerSampleWithIdentity | null>;

  // --- Snapshot-refresh pipeline collaborators (snapshotRefresh.ts) ---
  // Parse-binding inputs (stable references built once in the constructor).
  readonly providers: DeviceTransportParseProviders;
  readonly powerState: ResolvedTransportPowerState;
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
  // Zone-tree cache + fetch-generation guard, owned by the leaf. Only a
  // SUCCESSFUL fetch that is still the latest generation commits — a failed
  // fetch resolves `null` in the pipeline and leaves the cached tree untouched
  // (abandon-grace); a superseded fetch drops its result (`zoneTreeCache.ts`).
  readonly zoneTreeCache: ZoneTreeCache;
  // Fires after a SUCCESSFUL generation-guarded zone-tree commit (the leaf's
  // set-after-construction `onZoneTreeCommitted` callback; no-op while no
  // consumer is subscribed). The refresh pipeline invokes it CONTAINED — a
  // subscriber throw must never reject the detached zone-fetch chain.
  notifyZoneTreeCommitted(): void;
  // Fires after a realtime device.update commits a snapshot entry whose
  // `zoneId` differs from the previous entry (device moved zones, or first
  // appeared, via the realtime path). Same set-after-construction seam shape
  // as `notifyZoneTreeCommitted`; consumer: multi-home membership recompute —
  // without it a realtime zone move would stay unjoined until the next full
  // refresh (up to the periodic-refresh interval).
  notifyDeviceZoneChanged(): void;
  getTrackedDevicesById(): Map<string, HomeyDeviceLike>;
  // Fetch seams routed through the leaf's instance methods so a test spy on
  // `DeviceTransport.fetchDevicesForSnapshot` is honored.
  fetchDevicesForSnapshot(): Promise<DeviceFetchResult>;
  fetchDevicesByKnownIds(): Promise<DeviceFetchResult>;
  // Commit-side seams owned by the leaf (snapshot index + event bridge + live feed).
  setSnapshot(snapshot: TransportDeviceSnapshot[]): void;
  dispatchObservedStateRefresh(snapshot: TargetDeviceSnapshot[]): void;
  updateLiveFeedTrackedDevices(deviceIds: string[]): void;
};
