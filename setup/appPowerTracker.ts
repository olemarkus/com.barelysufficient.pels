import type Homey from 'homey';
import { PowerTrackerState } from '../lib/power/tracker';
import {
  createHomeTrackerPersistence,
  type HomeTrackerPersistence,
  type HomeTrackerPersistenceDeps,
} from '../lib/power/homeTrackerPersistence';
import { MAIN_HOME_ID } from '../lib/utils/settingsKeys';
import {
  PowerCalibrationStore,
  persistPowerCalibrationFlush,
  persistPowerCalibrationIfDue,
} from '../lib/device/devicePowerCalibrationStore';
import { emitSettingsUiPowerUpdatedForApp } from './settingsUiAppRuntime';
import { addPerfDuration } from '../lib/utils/perfCounters';
import type { DailyBudgetService } from '../lib/dailyBudget/dailyBudgetService';
import type { DailyBudgetUpdateStateOptions } from '../lib/dailyBudget/dailyBudgetTypes';
import type { SettingsRepository } from './settingsRepository';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import type { PlanService } from '../lib/plan/planService';
import { syncFlowPowerSampleFreshnessClock } from '../lib/power/flowPowerSampleFreshnessClock';

const POWER_CALIBRATION_PRUNE_INITIAL_DELAY_MS = 10 * 1000;
const POWER_CALIBRATION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Cadence of the calibration persist guard — slightly above the store's 60 s
 * persist debounce so a tick landing one debounce after a successful write is
 * not knife-edged out by the few milliseconds the write itself took (which
 * would silently double the effective retry latency).
 */
const POWER_CALIBRATION_PERSIST_GUARD_INTERVAL_MS = 65 * 1000;

/**
 * Dependencies for {@link AppPowerTracker}. The Main home's tracker is a
 * `lib/power` component the app owns (`getTracker`); this wrapper adds the
 * Main-only reactions to a tracker change — the daily budget, the settings
 * UI push, and the per-device calibration store — around that component.
 */
export type AppPowerTrackerDeps = {
  homey: Homey.App['homey'];
  settingsRepository: SettingsRepository;
  timers: TimerRegistry;
  getTracker: () => HomeTrackerPersistence;
  getPowerCalibrationStore: () => PowerCalibrationStore;
  setPowerCalibrationStore: (store: PowerCalibrationStore) => void;
  getDailyBudgetService: () => DailyBudgetService;
  /** Absent until the plan stack is wired: a recovery before that has nothing to rebuild. */
  getPlanService: () => PlanService | undefined;
  error: (...args: unknown[]) => void;
  updateDailyBudgetAndRecordCap: (options?: DailyBudgetUpdateStateOptions) => void;
  persistPowerCalibrationIfDue: (nowMs?: number) => void;
  flushPowerCalibration: (nowMs?: number) => void;
}

export class AppPowerTracker {
  /**
   * The Main home's tracker: the same classified persistence component every
   * meter area runs, on the unsuffixed key (`homeScopedSettingsKey` is the
   * identity for `'main'`) and unbound from any one meter — the Main-meter
   * authority governs which meter its samples come from.
   */
  static createMainTracker(deps: HomeTrackerPersistenceDeps): HomeTrackerPersistence {
    return createHomeTrackerPersistence({
      deps,
      homeId: MAIN_HOME_ID,
      initialState: {},
      meterBinding: { kind: 'unbound' },
      timerKey: (suffix) => suffix,
    });
  }

  constructor(private readonly deps: AppPowerTrackerDeps) {}

  /** Boot: adopt the persisted tracker, or start fenced on a suspect read. */
  hydratePowerTracker(): void {
    this.deps.getTracker().reloadFromSettings();
  }

  /**
   * Runtime reload on a `power_tracker_state` write. The key is rewritten on
   * every persist tick, so this runs continuously; the component suppresses
   * its own-write echoes. The calibration store is NOT reloaded here — doing
   * so would discard the in-memory dirty samples that haven't crossed the
   * persist debounce window yet, stalling calibration convergence. The
   * startup load happens exactly once in `onInit` via `loadPowerCalibrationStore`.
   */
  loadPowerTracker(): void {
    this.deps.getTracker().reloadFromSettings();
    this.deps.getDailyBudgetService().updateState({ refreshObservedStats: false });
  }

  /**
   * The tracker's persistence reopened on a reprobe with a valid tracker in
   * hand, after the bootstrap ran off the fenced state: refresh the daily
   * budget's snapshot, re-sync the Flow feed's planning cadence to the
   * recovered stamp, and re-decide the plan from the recovered reading.
   */
  onPowerTrackerRecovered(): void {
    this.deps.getDailyBudgetService().updateState({ refreshObservedStats: false });
    syncFlowPowerSampleFreshnessClock(this.deps.timers, this.deps.getTracker().getState().lastTimestamp);
    this.deps.getPlanService()?.rebuildPlanFromCache('settings', { detail: 'power_tracker_recovered' })
      .catch((error: unknown) => {
        this.deps.error('plan rebuild after power tracker recovery failed', error);
      });
  }

  loadPowerCalibrationStore(): void {
    this.deps.setPowerCalibrationStore(this.deps.settingsRepository.loadPowerCalibrationStore());
  }

  persistPowerCalibrationIfDue(nowMs: number): void {
    persistPowerCalibrationIfDue({
      homey: this.deps.homey,
      store: this.deps.getPowerCalibrationStore(),
      nowMs,
    });
  }

  flushPowerCalibration(nowMs: number): void {
    persistPowerCalibrationFlush({
      homey: this.deps.homey,
      store: this.deps.getPowerCalibrationStore(),
      nowMs,
    });
  }

  /**
   * Prune the calibration store on the tracker's cadence so it never grows
   * unbounded across device lifecycles. Flush bypasses the debounce /
   * load-grace gates so the pruned snapshot lands on disk immediately —
   * otherwise a restart inside the persist debounce window would resurrect
   * the pruned device entries from the previous write.
   */
  prunePowerCalibration(): void {
    if (this.deps.getPowerCalibrationStore().prune(Date.now())) {
      this.deps.flushPowerCalibration(Date.now());
    }
  }

  startPowerTrackerPruning(): void {
    this.deps.getTracker().startPruning();
    this.deps.timers.registerTimeout('powerCalibrationPruneInitial', setTimeout(() => {
      this.deps.timers.clear('powerCalibrationPruneInitial');
      this.prunePowerCalibration();
    }, POWER_CALIBRATION_PRUNE_INITIAL_DELAY_MS));
    this.deps.timers.registerInterval('powerCalibrationPruneInterval', setInterval(
      () => this.prunePowerCalibration(),
      POWER_CALIBRATION_PRUNE_INTERVAL_MS,
    ));
    // Persist guard for the calibration store, started here because this class
    // already owns every other calibration persist trigger. Without it,
    // accepted samples can sit memory-only indefinitely: the device snapshot
    // mutation hook marks the store dirty without ever attempting a persist,
    // the per-sample attempt in `savePowerTracker` stops with the meter, and
    // a failed write is only retried by another mutation or shutdown — while
    // PELS is routinely OOM-killed before `onUninit` can flush. The tick is
    // an isDirty() no-op when there is nothing to write.
    this.deps.timers.registerInterval('powerCalibrationPersistGuard', setInterval(
      () => this.deps.persistPowerCalibrationIfDue(Date.now()),
      POWER_CALIBRATION_PERSIST_GUARD_INTERVAL_MS,
    ));
  }

  /** Teardown: flush a pending tracker persist and stop the tracker's timers. */
  stopPowerTracker(): void {
    this.deps.getTracker().stopAndFlush();
  }

  savePowerTracker(nextState: PowerTrackerState): void {
    const tracker = this.deps.getTracker();
    const stateStart = Date.now();
    const previous = tracker.getState();
    tracker.adopt(nextState);
    addPerfDuration('power_sample_state_ms', Date.now() - stateStart);

    // The cap recorder rewrites the tracker it was just handed; the persist
    // for this sample — the forced hour-rollover write included — carries the
    // recorded cap, so it is committed after the recorder, against the state
    // before the sample.
    const budgetStart = Date.now();
    this.deps.updateDailyBudgetAndRecordCap({ nowMs: nextState.lastTimestamp ?? Date.now() });
    addPerfDuration('power_sample_budget_ms', Date.now() - budgetStart);
    tracker.commit(previous);

    const uiStart = Date.now();
    emitSettingsUiPowerUpdatedForApp(
      this.deps.homey,
      this.deps.getTracker().getState(),
      (message, error) => this.deps.error(message, error),
    );
    addPerfDuration('power_sample_ui_ms', Date.now() - uiStart);

    this.deps.persistPowerCalibrationIfDue(nextState.lastTimestamp ?? Date.now());
  }

  replacePowerTrackerForUi(nextState: PowerTrackerState): void {
    const tracker = this.deps.getTracker();
    tracker.adopt(nextState);
    // The cap recorder rewrites the tracker it was just handed; the persisted
    // reset is the state after it ran, not before.
    this.deps.updateDailyBudgetAndRecordCap({
      nowMs: nextState.lastTimestamp ?? Date.now(),
      forcePlanRebuild: true,
      persistReason: 'manual',
    });
    emitSettingsUiPowerUpdatedForApp(
      this.deps.homey,
      tracker.getState(),
      (message, error) => this.deps.error(message, error),
    );
    if (!tracker.replace(tracker.getState())) {
      throw new Error('the power tracker reset could not be persisted');
    }
  }
}
