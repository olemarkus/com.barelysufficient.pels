import { detectNativeWiringConflicts, type NativeWiringConflictDetection } from './flowConflictProbe';
import { getRawFromHomeyApi } from '../lib/device/transport/managerHomeyApi';
import { normalizeError } from '../lib/utils/errorUtils';
import type { Logger as PinoLogger } from '../lib/logging/logger';
import type { DeviceTransport } from '../lib/device/deviceTransport';
import type { SnapshotWarmupGate } from '../lib/plan/snapshotWarmupGate';
import type { PlanService } from '../lib/plan/planService';

const NATIVE_WIRING_DETECTION_MAX_ATTEMPTS = 3;
const NATIVE_WIRING_DETECTION_RETRY_DELAY_MS = 2000;

type FlowConflictMap = Record<string, { conflictingCapabilities: readonly string[]; flowName?: string }>;

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
  getNativeWiringUninitializing: () => boolean;
  getAutoNativeWiringDecisions: () => Record<string, boolean>;
  setAutoNativeWiringDecisions: (decisions: Record<string, boolean>) => void;
  getFlowConflictsByDevice: () => FlowConflictMap;
  setFlowConflictsByDevice: (conflicts: FlowConflictMap) => void;
  getNativeEvWiringDevices: () => Record<string, boolean>;
  getStructuredLogger: (component: string) => PinoLogger | undefined;
  getDeviceManager: () => DeviceTransport | undefined;
  getSnapshotWarmupGate: () => SnapshotWarmupGate | undefined;
  getPlanService: () => PlanService | undefined;
  refreshTargetDevicesSnapshot: () => Promise<unknown>;
  delayMs: (ms: number) => Promise<void>;
  applyNativeWiringAutoDecisions: () => Promise<void>;
}

export class AppNativeWiring {
  private nativeWiringDecisionInFlight = false;

  constructor(private readonly deps: AppNativeWiringDeps) {}

  runNativeWiringDetectionBestEffort(): void {
    if (this.deps.getNativeWiringUninitializing()) return;
    void this.deps.applyNativeWiringAutoDecisions()
      .catch((error) => {
        // Best-effort: a failed detection/refresh never blocks startup, and
        // the next normal plan cycle re-reads the provider so any applied
        // decision self-heals. Log so prod audits can see the miss — unless we
        // are tearing down, where logging would hit a closing worker rpc.
        if (this.deps.getNativeWiringUninitializing()) return;
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
      if (this.deps.getNativeWiringUninitializing()) return { status: 'unknown' };
      const snapshot = this.deps.getDeviceManager()?.getSnapshot() ?? [];
      const lastAttempt = attempt === NATIVE_WIRING_DETECTION_MAX_ATTEMPTS;
      if (snapshot.length === 0) {
        if (!lastAttempt) {
          await this.deps.delayMs(NATIVE_WIRING_DETECTION_RETRY_DELAY_MS);
          continue;
        }
        return { status: 'unknown' };
      }
      return detectNativeWiringConflicts({
        get: (path) => getRawFromHomeyApi(path),
        getSnapshot: () => snapshot,
        // Guarded sink: the flow read can resolve after teardown, so drop the
        // outcome line once uninitializing rather than log into a closing rpc.
        structuredLog: {
          info: (obj) => {
            if (this.deps.getNativeWiringUninitializing()) return;
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
    if (this.deps.getNativeWiringUninitializing()) return Promise.resolve();
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  // Explicit user choice (true or false in `nativeEvWiringDevices`) always wins;
  // for devices the user has never touched, fall back to the conflict-gated
  // auto-enable decision. See notes/native-wiring/.
  resolveNativeWiringEnabled(deviceId: string): boolean {
    const nativeEvWiringDevices = this.deps.getNativeEvWiringDevices();
    if (Object.prototype.hasOwnProperty.call(nativeEvWiringDevices, deviceId)) {
      return nativeEvWiringDevices[deviceId] === true;
    }
    return this.deps.getAutoNativeWiringDecisions()[deviceId] === true;
  }

  // Guarded entry point: startup runs this once and a periodic timer re-runs it
  // (see startPostStartupBackgroundTasks). The in-flight flag keeps overlapping
  // runs — startup vs a periodic tick, or two ticks — from racing.
  async applyNativeWiringAutoDecisions(): Promise<void> {
    if (this.nativeWiringDecisionInFlight) return;
    this.nativeWiringDecisionInFlight = true;
    try {
      await this.runNativeWiringDecision();
    } finally {
      this.nativeWiringDecisionInFlight = false;
    }
  }

  private async runNativeWiringDecision(): Promise<void> {
    // Wait for the snapshot warm-up gate so detection runs against a populated
    // snapshot rather than the initial empty array — the bootstrap refresh is
    // deferred in production. The gate also releases on its own timeout bound,
    // so this can never hang startup, and the call stays fire-and-forget.
    await this.deps.getSnapshotWarmupGate()?.wait();
    const detection = await this.detectNativeWiringConflictsWithSnapshotRetry();
    // The read above can resolve after teardown began; never refresh the
    // snapshot or rebuild the plan against a half-torn-down app.
    if (this.deps.getNativeWiringUninitializing() || detection.status !== 'ok') return;

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
    if (
      nativeWiringDecisionKey(this.deps.getAutoNativeWiringDecisions()) === nativeWiringDecisionKey(nextDecisions)
      && flowConflictKey(this.deps.getFlowConflictsByDevice()) === flowConflictKey(nextConflicts)
    ) {
      return;
    }

    const previousDecisions = this.deps.getAutoNativeWiringDecisions();
    const previousConflicts = this.deps.getFlowConflictsByDevice();
    this.deps.setAutoNativeWiringDecisions(nextDecisions);
    this.deps.setFlowConflictsByDevice(nextConflicts);
    try {
      // Re-parse the snapshot (the native-wiring + conflict providers now
      // report the new state) and rebuild the plan so both the decision and
      // the surfaced conflict take effect — mirrors the native-wiring
      // settings-change handler.
      await this.deps.refreshTargetDevicesSnapshot();
      await this.deps.getPlanService()?.rebuildPlanFromCache('native_wiring_auto_decision');
    } catch (error) {
      // Keep the apply atomic: if the refresh/rebuild fails, roll both maps
      // back so a later re-query re-attempts cleanly rather than being
      // short-circuited by the no-change guard above.
      this.deps.setAutoNativeWiringDecisions(previousDecisions);
      this.deps.setFlowConflictsByDevice(previousConflicts);
      throw error;
    }
  }
}
