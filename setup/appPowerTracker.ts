import type Homey from 'homey';
import { PowerTrackerState } from '../lib/power/tracker';
import {
  persistPowerTrackerStateForApp,
  prunePowerTrackerHistoryForApp,
  type PowerTrackerPersistReason,
} from '../lib/power/sampleIngest';
import {
  PowerCalibrationStore,
  persistPowerCalibrationFlush,
  persistPowerCalibrationIfDue,
} from '../lib/device/devicePowerCalibrationStore';
import { emitSettingsUiPowerUpdatedForApp } from './settingsUiAppRuntime';
import { addPerfDuration, incPerfCounter } from '../lib/utils/perfCounters';
import { getHourBucketKey } from '../lib/utils/dateUtils';
import { VOLATILE_WRITE_THROTTLE_MS } from '../lib/utils/timingConstants';
import type { DailyBudgetService } from '../lib/dailyBudget/dailyBudgetService';
import type { DailyBudgetUpdateStateOptions } from '../lib/dailyBudget/dailyBudgetTypes';
import type { SettingsRepository } from './settingsRepository';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import type { StructuredDebugEmitter } from '../lib/logging/logger';
import { type DebugLoggingTopic } from '../packages/shared-domain/src/utils/debugLogging';

const POWER_TRACKER_PRUNE_INITIAL_DELAY_MS = 10 * 1000;
const POWER_TRACKER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const POWER_TRACKER_PERSIST_DELAY_MS = VOLATILE_WRITE_THROTTLE_MS;

const shouldForcePersistPowerTracker = (
  previousState: PowerTrackerState,
  nextState: PowerTrackerState,
): boolean => {
  const previousTimestamp = previousState.lastTimestamp;
  const nextTimestamp = nextState.lastTimestamp;
  if (
    typeof previousTimestamp !== 'number'
    || typeof nextTimestamp !== 'number'
    || !Number.isFinite(previousTimestamp)
    || !Number.isFinite(nextTimestamp)
  ) {
    return false;
  }
  return getHourBucketKey(previousTimestamp) !== getHourBucketKey(nextTimestamp);
};

/**
 * Dependencies for {@link AppPowerTracker}. State the rest of the app also
 * reads (`powerTracker`, `powerCalibrationStore`) stays on `PelsApp` and is
 * accessed through these getters/setters; cluster-internal calls that have a
 * thin `PelsApp` stub (`persistPowerTrackerState`, `prunePowerTrackerHistory`,
 * …) route back through the app so test spies/mocks intercept them.
 */
export type AppPowerTrackerDeps = {
  homey: Homey.App['homey'];
  settingsRepository: SettingsRepository;
  timers: TimerRegistry;
  getPowerTracker: () => PowerTrackerState;
  setPowerTracker: (state: PowerTrackerState) => void;
  getPowerCalibrationStore: () => PowerCalibrationStore;
  setPowerCalibrationStore: (store: PowerCalibrationStore) => void;
  getDailyBudgetService: () => DailyBudgetService;
  getStructuredDebugEmitter: (component: string, topic: DebugLoggingTopic) => StructuredDebugEmitter;
  getTimeZone: () => string;
  error: (...args: unknown[]) => void;
  updateDailyBudgetAndRecordCap: (options?: DailyBudgetUpdateStateOptions) => void;
  persistPowerTrackerState: (reason?: PowerTrackerPersistReason) => void;
  persistPowerCalibrationIfDue: (nowMs?: number) => void;
  flushPowerCalibration: (nowMs?: number) => void;
  prunePowerTrackerHistory: () => void;
}

export class AppPowerTracker {
  constructor(private readonly deps: AppPowerTrackerDeps) {}

  loadPowerTracker(options: { skipDailyBudgetUpdate?: boolean } = {}): void {
    // `power_tracker_state` is rewritten every persist tick, so the global
    // settings listener re-runs `loadPowerTracker` continuously at runtime.
    // The calibration store is NOT reloaded here — doing so would discard the
    // in-memory dirty samples that haven't crossed the persist debounce
    // window yet, stalling calibration convergence. The startup load happens
    // exactly once in `onInit` via `loadPowerCalibrationStore`.
    const stored = this.deps.settingsRepository.loadPowerTrackerState();
    if (stored) this.deps.setPowerTracker(stored);
    if (options.skipDailyBudgetUpdate !== true) {
      this.deps.getDailyBudgetService().updateState({ refreshObservedStats: false });
    }
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

  persistPowerTrackerState(reason: PowerTrackerPersistReason): void {
    this.deps.timers.clear('powerTrackerSave');
    persistPowerTrackerStateForApp({
      homey: this.deps.homey,
      powerTracker: this.deps.getPowerTracker(),
      reason,
      error: (msg, err) => this.deps.error(msg, err),
    });
  }

  prunePowerTrackerHistory(): void {
    this.deps.setPowerTracker(prunePowerTrackerHistoryForApp({
      powerTracker: this.deps.getPowerTracker(),
      debugStructured: this.deps.getStructuredDebugEmitter('perf', 'perf'),
      error: (msg, err) => this.deps.error(msg, err),
      // Pass Homey timezone so dailyTotals are keyed by the local calendar day
      // (matches the UI's bucket-derived keys; see TODO `power-tracker-tz-fix`).
      timeZone: this.deps.getTimeZone(),
    }));
    this.deps.persistPowerTrackerState('prune');
    // Piggyback on the power-tracker prune tick so the calibration store
    // never grows unbounded across device lifecycles. Flush bypasses the
    // debounce / load-grace gates so the pruned snapshot lands on disk
    // immediately — otherwise a restart inside the persist debounce window
    // would resurrect the pruned device entries from the previous write.
    if (this.deps.getPowerCalibrationStore().prune(Date.now())) {
      this.deps.flushPowerCalibration(Date.now());
    }
  }

  startPowerTrackerPruning(): void {
    this.deps.timers.registerTimeout('powerTrackerPruneInitial', setTimeout(() => {
      this.deps.timers.clear('powerTrackerPruneInitial');
      this.deps.prunePowerTrackerHistory();
    }, POWER_TRACKER_PRUNE_INITIAL_DELAY_MS));
    this.deps.timers.registerInterval('powerTrackerPruneInterval', setInterval(
      () => this.deps.prunePowerTrackerHistory(),
      POWER_TRACKER_PRUNE_INTERVAL_MS,
    ));
  }

  savePowerTracker(nextState: PowerTrackerState): void {
    const stateStart = Date.now();
    const previousState = this.deps.getPowerTracker();
    this.deps.setPowerTracker(nextState);
    const forcePersist = shouldForcePersistPowerTracker(previousState, nextState);
    addPerfDuration('power_sample_state_ms', Date.now() - stateStart);

    const budgetStart = Date.now();
    this.deps.updateDailyBudgetAndRecordCap({ nowMs: nextState.lastTimestamp ?? Date.now() });
    addPerfDuration('power_sample_budget_ms', Date.now() - budgetStart);

    if (forcePersist) {
      incPerfCounter('settings_set.power_tracker_state_forced_hour_rollover_total');
      this.deps.persistPowerTrackerState('hour_rollover');
    } else if (!this.deps.timers.has('powerTrackerSave')) {
      incPerfCounter('settings_set.power_tracker_state_scheduled_total');
      this.deps.timers.registerTimeout(
        'powerTrackerSave',
        setTimeout(() => this.deps.persistPowerTrackerState('scheduled'), POWER_TRACKER_PERSIST_DELAY_MS),
      );
    } else {
      incPerfCounter('settings_set.power_tracker_state_skipped_pending_total');
    }

    const uiStart = Date.now();
    emitSettingsUiPowerUpdatedForApp(
      this.deps.homey,
      this.deps.getPowerTracker(),
      (message, error) => this.deps.error(message, error),
    );
    addPerfDuration('power_sample_ui_ms', Date.now() - uiStart);

    this.deps.persistPowerCalibrationIfDue(nextState.lastTimestamp ?? Date.now());
  }

  replacePowerTrackerForUi(nextState: PowerTrackerState): void {
    this.deps.setPowerTracker(nextState);
    this.deps.updateDailyBudgetAndRecordCap({
      nowMs: nextState.lastTimestamp ?? Date.now(),
      forcePlanRebuild: true,
      persistReason: 'manual',
    });
    emitSettingsUiPowerUpdatedForApp(
      this.deps.homey,
      this.deps.getPowerTracker(),
      (message, error) => this.deps.error(message, error),
    );
    this.deps.persistPowerTrackerState('ui_replace');
  }
}
