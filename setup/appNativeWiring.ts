import { detectNativeWiringConflicts, type NativeWiringConflictDetection } from './flowConflictProbe';
import type { DeviceDescriptorRead } from '../packages/contracts/src/types';
import type { UserFlowFacts } from '../lib/flowApi/userFlows';
import type { NativeFlowConflicts } from '../lib/flowApi/acceptedFlowConflictStore';
import type { AcceptedFlowConflictSlice } from '../lib/flowApi/acceptedFlowConflictStore';
import { NativeFlowConflictState } from '../lib/device/nativeFlowConflictState';
import { getRawFromHomeyApi } from '../lib/device/transport/managerHomeyApi';
import { normalizeError } from '../lib/utils/errorUtils';
import { resolveNativeWiringEnabled } from '../lib/device/builtInControlFlowGate';
import type { Logger as PinoLogger } from '../lib/logging/logger';
import type { SnapshotWarmupGate } from '../lib/plan/snapshotWarmupGate';
import type { ShutdownLatch } from '../lib/utils/shutdownLatch';
import type { PlanService } from '../lib/plan/planService';
import {
  FlowConflictRefreshCoordinator,
  type FlowConflictRefreshResult,
} from '../lib/flowApi/flowConflictRefreshCoordinator';

const NATIVE_WIRING_DETECTION_MAX_ATTEMPTS = 3;
const NATIVE_WIRING_DETECTION_RETRY_DELAY_MS = 2000;

type FlowConflictMap = NativeFlowConflicts;

// Stable canonical strings for the native-wiring auto-decision + flow-conflict
// maps, so the apply path can detect "no change" regardless of key ordering.
function nativeWiringDecisionKey(decisions: Record<string, boolean>): string {
  return Object.keys(decisions).filter((id) => decisions[id] === true).sort().join('|');
}

function flowConflictKey(conflicts: FlowConflictMap): string {
  return Object.keys(conflicts)
    .sort()
    .map((id) => {
      const conflict = conflicts[id];
      const caps = [...(conflict?.conflictingCapabilities ?? [])].sort().join(',');
      // Include the named Flow so renaming the conflicting Flow re-renders the
      // banner even when the conflicting capability set is unchanged.
      return `${id}:${caps}:${conflict?.flowName ?? ''}`;
    })
    .join('|');
}

/**
 * Dependencies for {@link AppNativeWiring}. The auto-decision and conflict maps
 * stay on `PelsApp` (read by `initDeviceManager` and poked by tests), so they
 * flow in via getters/setters. `delayMs`/`refreshTargetDevicesSnapshot` route
 * back through the app instance so test spies/replacements intercept them.
 */
export type AppNativeWiringDeps = {
  /** The app's teardown signal: once stopped, the probe drops every side effect. */
  shutdown: ShutdownLatch;
  getAutoNativeWiringDecisions: () => Record<string, boolean>;
  setAutoNativeWiringDecisions: (decisions: Record<string, boolean>) => void;
  /** Where the accepted native-wiring conflicts are kept across a restart. */
  nativeFlowConflictStore: AcceptedFlowConflictSlice<NativeFlowConflicts>;
  getNativeEvWiringDevices: () => Record<string, boolean>;
  /**
   * Hands an accepted Flow list to the charging-current owner
   * (`ChargingCurrentControl.acceptFlowFacts`); answers whether it changed a
   * Tesla, Zaptec or Futurehome current route.
   */
  acceptChargingFlowFacts: (facts: UserFlowFacts) => boolean;
  /** Restores the Flow list accepted before the last one, when applying it failed. */
  revertChargingFlowFacts: () => void;
  getStructuredLogger: (component: string) => PinoLogger | undefined;
  /**
   * Descriptors, not the transport: the conflict probe declares
   * `getDescriptors: () => readonly DeviceDescriptorRead[]`
   * (`setup/flowConflictProbe.ts`) and this was handing it the raw snapshot — a
   * surface it declared and did not have. This module needs nothing else from
   * the transport.
   */
  getDeviceDescriptors: () => DeviceDescriptorRead[];
  getSnapshotWarmupGate: () => SnapshotWarmupGate | undefined;
  getPlanService: () => PlanService | undefined;
  refreshTargetDevicesSnapshot: () => Promise<unknown>;
  delayMs: (ms: number) => Promise<void>;
  applyNativeWiringAutoDecisions: () => Promise<void>;
}

export class AppNativeWiring {
  /** The accepted native-wiring conflicts; seeded when the userdata database opens. */
  readonly flowConflicts: NativeFlowConflictState;
  private readonly flowConflictRefreshCoordinator = new FlowConflictRefreshCoordinator();

  constructor(private readonly deps: AppNativeWiringDeps) {
    this.flowConflicts = new NativeFlowConflictState(deps.nativeFlowConflictStore);
  }

  runNativeWiringDetectionBestEffort(): void {
    if (this.deps.shutdown.isStopped()) return;
    void this.deps.applyNativeWiringAutoDecisions()
      .catch((error) => {
        // Best-effort: a failed detection/refresh never blocks startup, and
        // the next normal plan cycle re-reads the provider so any applied
        // decision self-heals. Log so prod audits can see the miss — unless we
        // are tearing down, where logging would hit a closing worker rpc.
        if (this.deps.shutdown.isStopped()) return;
        this.deps.getStructuredLogger('flow_conflict')?.error({
          event: 'flow_conflict_detection_failed',
          err: normalizeError(error),
        });
      });
  }

  // Run detection, retrying while the device snapshot is still empty. The
  // warm-up gate can release via its timeout bound (slow/failed first refresh)
  // with the snapshot not yet populated; treating that empty result as a final
  // "no candidates" would leave conflict-free Hoiax devices native-off until
  // the next restart. A populated snapshot with no candidates is final.
  //
  // An empty snapshot that survives every retry resolves to `unknown`, never an
  // empty `ok` verdict: on a periodic re-query a transient empty snapshot (a
  // refresh/SDK hiccup) would otherwise clear existing auto decisions and turn
  // native control off until the next tick. `unknown` makes it a no-op that
  // keeps prior decisions — and with genuinely zero devices there is nothing to
  // auto-enable, so we lose nothing by not emitting an empty `ok`.
  async detectNativeWiringConflictsWithSnapshotRetry(): Promise<NativeWiringConflictDetection> {
    for (let attempt = 1; attempt <= NATIVE_WIRING_DETECTION_MAX_ATTEMPTS; attempt += 1) {
      if (this.deps.shutdown.isStopped()) return { status: 'unknown' };
      const descriptors = this.deps.getDeviceDescriptors();
      const lastAttempt = attempt === NATIVE_WIRING_DETECTION_MAX_ATTEMPTS;
      if (descriptors.length === 0) {
        if (!lastAttempt) {
          await this.deps.delayMs(NATIVE_WIRING_DETECTION_RETRY_DELAY_MS);
          continue;
        }
        return { status: 'unknown' };
      }
      return detectNativeWiringConflicts({
        get: (path) => getRawFromHomeyApi(path),
        getDescriptors: () => descriptors,
        // Guarded sink: the flow read can resolve after teardown, so drop the
        // outcome line once uninitializing rather than log into a closing rpc.
        structuredLog: {
          info: (obj) => {
            if (this.deps.shutdown.isStopped()) return;
            this.deps.getStructuredLogger('flow_conflict')?.info(obj);
          },
        },
      });
    }
    return { status: 'unknown' };
  }

  delayMs(ms: number): Promise<void> {
    // A detection retry can be pending when the app tears down; resolve at once
    // so the fire-and-forget probe settles promptly instead of holding a timer.
    if (this.deps.shutdown.isStopped()) return Promise.resolve();
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  /** The native-write capabilities a user Flow drives on this device, for the device-detail banner. */
  getFlowConflict(deviceId: string): FlowConflictMap[string] | undefined {
    return this.flowConflicts.get(deviceId);
  }

  resolveNativeWiringEnabled(deviceId: string): boolean {
    return resolveNativeWiringEnabled(
      deviceId,
      this.deps.getNativeEvWiringDevices(),
      this.deps.getAutoNativeWiringDecisions(),
      this.flowConflicts.all,
    );
  }

  // Startup runs this once and a periodic timer re-runs it (see
  // startPostStartupBackgroundTasks). The flow-domain coordinator drops
  // overlapping best-effort requests without keeping mutable state in setup.
  async applyNativeWiringAutoDecisions(): Promise<void> {
    await this.flowConflictRefreshCoordinator.requestBackground(
      () => this.runNativeWiringDecision(),
    );
  }

  refreshFlowConflictsForUi(): Promise<FlowConflictRefreshResult> {
    return this.flowConflictRefreshCoordinator.requestExplicit(
      () => this.runNativeWiringDecision(),
    );
  }

  private async runNativeWiringDecision(): Promise<FlowConflictRefreshResult> {
    // Wait for the snapshot warm-up gate so detection runs against a populated
    // snapshot rather than the initial empty array — the bootstrap refresh is
    // deferred in production. The gate also releases on its own timeout bound,
    // so this can never hang startup, and the call stays fire-and-forget.
    await this.deps.getSnapshotWarmupGate()?.wait();
    const detection = await this.detectNativeWiringConflictsWithSnapshotRetry();
    // The read above can resolve after teardown began; never refresh the
    // snapshot or rebuild the plan against a half-torn-down app.
    if (this.deps.shutdown.isStopped() || detection.status !== 'ok') {
      return { state: 'unavailable' };
    }

    const nextDecisions: Record<string, boolean> = {};
    for (const deviceId of detection.autoEnableDeviceIds) {
      nextDecisions[deviceId] = true;
    }
    const nextConflicts: FlowConflictMap = {};
    for (const conflict of detection.conflicts) {
      nextConflicts[conflict.deviceId] = conflict.flowName === undefined
        ? { conflictingCapabilities: conflict.conflictingCapabilities }
        : { conflictingCapabilities: conflict.conflictingCapabilities, flowName: conflict.flowName };
    }
    const chargingRoutesChanged = this.deps.acceptChargingFlowFacts(detection.flowFacts);
    if (
      !chargingRoutesChanged
      && nativeWiringDecisionKey(this.deps.getAutoNativeWiringDecisions()) === nativeWiringDecisionKey(nextDecisions)
      && flowConflictKey(this.flowConflicts.all) === flowConflictKey(nextConflicts)
    ) {
      // Saved even unchanged: the store writes nothing for it, and a save that
      // failed earlier is healed.
      this.flowConflicts.accept(nextConflicts);
      return { state: 'resolved', flowFacts: detection.flowFacts };
    }

    const previousDecisions = this.deps.getAutoNativeWiringDecisions();
    const previousConflicts = this.flowConflicts.all;
    this.deps.setAutoNativeWiringDecisions(nextDecisions);
    this.flowConflicts.accept(nextConflicts);
    try {
      // Re-parse the snapshot (the native-wiring + conflict providers now
      // report the new state) and rebuild the plan so both the decision and
      // the surfaced conflict take effect — mirrors the native-wiring
      // settings-change handler.
      await this.deps.refreshTargetDevicesSnapshot();
      // A rebuild reports its failure instead of throwing; roll back on it too,
      // so the next scan is not taken as "no change" and retries.
      const rebuild = await this.deps.getPlanService()?.rebuildPlanFromCache('native_wiring_auto_decision');
      if (rebuild?.failed) throw new Error('Plan rebuild failed after a Flow-conflict change');
    } catch (error) {
      // Keep the apply atomic: if the refresh/rebuild fails, roll both maps
      // and the charging Flow list back so a later re-query re-attempts cleanly
      // rather than being short-circuited by the no-change guard above. A
      // rebuild that fails after a successful refresh leaves the snapshot on the
      // new routes until the next refresh re-projects it; the retry restores
      // agreement.
      this.deps.setAutoNativeWiringDecisions(previousDecisions);
      this.flowConflicts.accept(previousConflicts);
      this.deps.revertChargingFlowFacts();
      throw error;
    }
    return { state: 'resolved', flowFacts: detection.flowFacts };
  }
}
