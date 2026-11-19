/**
 * The Flow scan behind built-in device control, and what PELS does with its
 * answer (notes/native-wiring/README.md).
 *
 * A scan reads the owner's Homey Flows (`detectNativeWiringConflicts`) and
 * decides which Hoiax or Easee devices native wiring
 * auto-enables, which of them a Flow conflicts with, and the Flow list the
 * charging-current routes (Tesla, Zaptec, Futurehome) are held back by
 * (`ChargingCurrentControl.acceptFlowFacts`). The same scan finds the Flow
 * cards that admit saved manual stepped-load profiles. An accepted change
 * re-projects the device snapshot and rebuilds the plan. A failure restores
 * the previous decisions, so the next scan is not taken as "no change"
 * and retries.
 *
 * Every scan runs through one `FlowConflictRefreshCoordinator`: background
 * scans are dropped while one is pending, and an explicit check or the
 * settings page's charging-current read queues behind it, so no two applies
 * overlap and a rollback restores what was in effect before its own scan.
 *
 * The auto-enable decisions are in memory only, recomputed by the first scan
 * after a boot; an owner's explicit entry in `native_ev_wiring_devices`
 * always takes precedence over them. The conflicts are kept across a restart
 * (`NativeFlowConflictState`).
 */
import type { DeviceDescriptorRead, PendingSteppedLoad } from '../../packages/contracts/src/types';
import type { ChargingCurrentRead } from '../../packages/contracts/src/chargingControl';
import type { PlanRebuildOutcome } from '../planContract/planActuationResult';
import type { AcceptedFlowConflictSlice, NativeFlowConflicts } from '../flowApi/acceptedFlowConflictStore';
import {
  FlowConflictRefreshCoordinator,
  type FlowConflictRefreshResult,
} from '../flowApi/flowConflictRefreshCoordinator';
import type { FlowReadResult } from '../flowApi/readUserFlows';
import type { SteppedLoadFlowCards, UserFlowFacts } from '../flowApi/userFlows';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import type { ShutdownLatch } from '../utils/shutdownLatch';
import { resolveNativeWiringEnabled } from './builtInControlFlowGate';
import type { ChargingCurrentControl } from './chargingCurrentControl';
import type { DeviceControlSettings } from './deviceControlSettings';
import { NativeFlowConflictState } from './nativeFlowConflictState';
import { detectNativeWiringConflicts, type NativeWiringConflictDetection } from './nativeWiringConflictProbe';
import { getRawFromHomeyApi } from './transport/managerHomeyApi';

const DETECTION_MAX_ATTEMPTS = 3;
const DETECTION_RETRY_DELAY_MS = 2000;

const logger = getLogger('flow_conflict');

/** How an accepted change takes effect: the snapshot is re-projected, then the plan rebuilt. */
export type FlowConflictPlanRuntime = {
  awaitSnapshotWarmup(): Promise<void>;
  refreshSnapshot(): Promise<unknown>;
  rebuildPlan(): Promise<Pick<PlanRebuildOutcome, 'failed'>>;
};

// Stable canonical strings, so an apply can tell "no change" regardless of key order.
function decisionKey(decisions: Readonly<Record<string, boolean>>): string {
  return Object.keys(decisions).filter((id) => decisions[id] === true).sort().join('|');
}

function conflictKey(conflicts: NativeFlowConflicts): string {
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

export class BuiltInControlFlowConflicts {
  private readonly conflicts: NativeFlowConflictState;
  private readonly coordinator = new FlowConflictRefreshCoordinator();
  private autoDecisions: Readonly<Record<string, boolean>> = {};
  private steppedLoadCards: SteppedLoadFlowCards | undefined;
  private steppedSetupProjectionPending = false;
  private steppedUpdateScanQueued = false;

  constructor(
    private readonly shutdown: ShutdownLatch,
    store: AcceptedFlowConflictSlice<NativeFlowConflicts>,
    private readonly ownerChoices: DeviceControlSettings,
    private readonly getDeviceDescriptors: () => readonly DeviceDescriptorRead[],
    private readonly getChargingCurrentControl: () => ChargingCurrentControl,
    private readonly planRuntime: FlowConflictPlanRuntime,
    private readonly steppedLoadCardsStore: AcceptedFlowConflictSlice<SteppedLoadFlowCards | undefined>,
  ) {
    this.conflicts = new NativeFlowConflictState(store);
  }

  /** Runs when the userdata database opens, before the transport's first parse. */
  restoreSaved(): void {
    this.conflicts.restoreSaved();
    try {
      this.steppedLoadCards = this.steppedLoadCardsStore.read();
    } catch (error) {
      logger.warn({ event: 'stepped_load_flow_cards_restore_failed', err: normalizeError(error) });
    }
  }

  steppedLoadFlowSetup(deviceId: string): PendingSteppedLoad['reason'] | 'ready' {
    if (this.steppedLoadCards === undefined) return 'unverified';
    switch (this.steppedLoadCards[deviceId]) {
      case 'both': return 'ready';
      case 'target': return 'missing_report';
      case 'report': return 'missing_trigger';
      default: return 'missing_both';
    }
  }

  /** The owner's explicit choice, else the auto-enable decision, held back while a Flow conflicts. */
  resolveNativeWiringEnabled(deviceId: string): boolean {
    return resolveNativeWiringEnabled(
      deviceId, this.ownerChoices.nativeEvWiringDevices, this.autoDecisions, this.conflicts.all,
    );
  }

  /** The native-write capabilities a user Flow drives on this device, for the device-detail notice. */
  getFlowConflict(deviceId: string): NativeFlowConflicts[string] | undefined {
    return this.conflicts.get(deviceId);
  }

  /** The startup scan and the periodic re-query: best-effort, and never blocks startup. */
  runBackgroundScan(): void {
    if (this.shutdown.isStopped()) return;
    void this.applyBackgroundScan().catch((error: unknown) => {
      // The next scan re-reads the Flows, so a failed apply self-heals. Not
      // logged once tearing down, where it would hit a closing worker rpc.
      if (this.shutdown.isStopped()) return;
      logger.error({ event: 'flow_conflict_detection_failed', err: normalizeError(error) });
    });
  }

  /** A saved Flow may complete setup while another scan is already running. */
  runSteppedLoadCardUpdateScan(): void {
    if (this.shutdown.isStopped() || this.steppedUpdateScanQueued) return;
    this.steppedUpdateScanQueued = true;
    void this.coordinator.requestExplicit(() => {
      this.steppedUpdateScanQueued = false;
      return this.scanAndApply();
    }).catch((error: unknown) => {
      if (!this.shutdown.isStopped()) {
        logger.warn({ event: 'stepped_load_flow_card_update_scan_failed', err: normalizeError(error) });
      }
    });
  }

  applyBackgroundScan(): Promise<void> {
    return this.coordinator.requestBackground(() => this.scanAndApply());
  }

  /** The owner's "Check again": queued behind older work, so it reads the Flows as they are now. */
  refreshForUi(): Promise<FlowConflictRefreshResult> {
    return this.coordinator.requestExplicit(() => this.scanAndApply());
  }

  /**
   * The settings page's charging-current read. Its Flow list is read and
   * applied as one queued operation, after any scan before it, so it is the
   * freshest PELS has and an older list never lands over a newer scan's. The
   * page then reports the route in effect; a failed apply has been rolled
   * back, and the page reports that route instead.
   */
  async readChargingCurrent(): Promise<ChargingCurrentRead[]> {
    const charging = this.getChargingCurrentControl();
    let flows: FlowReadResult = { status: 'unknown', reason: 'not read' };
    try {
      await this.coordinator.requestExplicit(async () => {
        flows = await charging.readFlows();
        if (this.shutdown.isStopped() || flows.status !== 'ok') return { state: 'unavailable' };
        await this.apply(this.autoDecisions, this.conflicts.all, flows.facts);
        return { state: 'resolved', flowFacts: flows.facts };
      });
    } catch (error) {
      if (!this.shutdown.isStopped()) {
        logger.warn({ event: 'charging_flow_list_apply_failed', err: normalizeError(error) });
      }
    }
    return charging.describe(flows);
  }

  delayMs(ms: number): Promise<void> {
    // A detection retry can be pending when the app tears down; resolve at once
    // so the fire-and-forget scan settles promptly instead of holding a timer.
    if (this.shutdown.isStopped()) return Promise.resolve();
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  private async scanAndApply(): Promise<FlowConflictRefreshResult> {
    // The warm-up gate releases on its own timeout bound, so this never hangs
    // startup; detection then runs against a populated snapshot.
    await this.planRuntime.awaitSnapshotWarmup();
    const detection = await this.detectWithSnapshotRetry();
    // The read can resolve after teardown began; never refresh the snapshot or
    // rebuild the plan against a half-torn-down app.
    if (this.shutdown.isStopped() || detection.status !== 'ok') return { state: 'unavailable' };

    const decisions = Object.fromEntries(detection.autoEnableDeviceIds.map((deviceId) => [deviceId, true]));
    const conflicts: NativeFlowConflicts = Object.fromEntries(
      detection.conflicts.map(({ deviceId, ...conflict }) => [deviceId, conflict]),
    );
    await this.apply(decisions, conflicts, detection.flowFacts);
    return { state: 'resolved', flowFacts: detection.flowFacts };
  }

  // Retries while the device snapshot is still empty. The warm-up gate can
  // release via its timeout bound with the snapshot not yet populated; taking
  // that empty result as final would leave conflict-free Hoiax devices
  // native-off until the next restart. A populated snapshot with no candidates
  // is final.
  //
  // An empty snapshot that survives every retry resolves to `unknown`, never an
  // empty `ok`: on a periodic re-query a transient empty snapshot would
  // otherwise clear existing auto decisions until the next tick. With genuinely
  // zero devices there is nothing to auto-enable, so nothing is lost.
  private async detectWithSnapshotRetry(): Promise<NativeWiringConflictDetection> {
    for (let attempt = 1; attempt <= DETECTION_MAX_ATTEMPTS; attempt += 1) {
      if (this.shutdown.isStopped()) return { status: 'unknown' };
      const descriptors = this.getDeviceDescriptors();
      if (descriptors.length > 0) {
        return detectNativeWiringConflicts(getRawFromHomeyApi, descriptors, {
          // The outcome line can arrive after teardown; drop it then.
          info: (obj) => { if (!this.shutdown.isStopped()) logger.info(obj); },
        });
      }
      if (attempt < DETECTION_MAX_ATTEMPTS) await this.delayMs(DETECTION_RETRY_DELAY_MS);
    }
    return { status: 'unknown' };
  }

  private async apply(
    decisions: Readonly<Record<string, boolean>>,
    conflicts: NativeFlowConflicts,
    flowFacts: UserFlowFacts,
  ): Promise<void> {
    const charging = this.getChargingCurrentControl();
    const previousFlowWrites = charging.acceptedFlowWrites;
    const chargingRoutesChanged = charging.acceptFlowFacts(flowFacts);
    const nextSteppedLoadCards = flowFacts.steppedLoadCards;
    const previousSteppedLoadCards = this.steppedLoadCards;
    const steppedSetupChanged = this.getDeviceDescriptors().some(({ id }) => (
      this.ownerChoices.getDeviceControlProfile(id) !== undefined
      && (previousSteppedLoadCards === undefined || previousSteppedLoadCards[id] !== nextSteppedLoadCards[id])
    ));
    this.steppedLoadCards = nextSteppedLoadCards;
    // A readable inventory can revoke authority before the snapshot or plan
    // catches up. Save it independently of the reversible native-route apply.
    this.saveSteppedLoadCards(nextSteppedLoadCards);
    this.steppedSetupProjectionPending ||= steppedSetupChanged;
    if (
      !this.steppedSetupProjectionPending
      && !chargingRoutesChanged
      && decisionKey(this.autoDecisions) === decisionKey(decisions)
      && conflictKey(this.conflicts.all) === conflictKey(conflicts)
    ) {
      // Saved even unchanged: the store writes nothing for it, and a save that
      // failed earlier is healed.
      this.conflicts.accept(conflicts);
      return;
    }

    const previousDecisions = this.autoDecisions;
    const previousConflicts = this.conflicts.all;
    this.autoDecisions = decisions;
    this.conflicts.accept(conflicts);
    let projected = false;
    try {
      await this.planRuntime.refreshSnapshot();
      projected = true;
      // A rebuild reports its failure instead of throwing; roll back on it too.
      const rebuild = await this.planRuntime.rebuildPlan();
      if (rebuild.failed) throw new Error('Plan rebuild failed after a Flow-conflict change');
      this.steppedSetupProjectionPending = false;
    } catch (error) {
      this.autoDecisions = previousDecisions;
      this.conflicts.accept(previousConflicts);
      charging.restoreFlowWrites(previousFlowWrites);
      // A rebuild that failed after the snapshot took the new routes leaves it
      // projecting them; project the restored ones, or the planner and the
      // commands would disagree about who sets the device until the next refresh.
      if (projected && !this.shutdown.isStopped()) await this.reprojectAfterRollback();
      throw error;
    }
  }

  private saveSteppedLoadCards(cards: SteppedLoadFlowCards): void {
    try {
      this.steppedLoadCardsStore.write(cards);
    } catch (error) {
      logger.warn({ event: 'stepped_load_flow_cards_save_failed', err: normalizeError(error) });
    }
  }

  private async reprojectAfterRollback(): Promise<void> {
    try {
      await this.planRuntime.refreshSnapshot();
    } catch (error) {
      if (this.shutdown.isStopped()) return;
      logger.error({ event: 'flow_conflict_rollback_refresh_failed', err: normalizeError(error) });
    }
  }
}
