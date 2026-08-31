import type Homey from 'homey';
import { getLogger } from '../lib/logging/logger';
import { normalizeError } from '../lib/utils/errorUtils';
import { type SoleCumulativeMeterResolution } from '../lib/device/managerEnergy';
import { censusLiveSoleCumulativeMeter } from '../lib/device/transport/managerFetch';
import { normalizePowerSource } from '../lib/power/powerSource';
import { HOMEY_ENERGY_METER_DEVICE_ID, POWER_SOURCE, POWER_TRACKER_STATE } from '../lib/utils/settingsKeys';
import { resolveExplicitMainMeterDeviceId } from '../lib/home/homeConfig';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import {
  savePowerSourceSelection,
  type MultiHomeActivationRead,
} from './homeMeterOwnership';
import { createHomesStore } from './homeRegistryAdapter';
import { readHomeConfigRuntimeActivation } from './multiHomeActivation';

const migrationLogger = getLogger('startup/main-meter-migration');

export const MAIN_METER_AUTHORITY_MIGRATION_MARKER = 'main_meter_authority_migration_v1_done';

const RETRY_TIMER_NAME = 'mainMeterAuthorityMigration';
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 12;
/**
 * Minimum spacing between a decisive proposal and the attempt allowed to
 * confirm it. A transient settings-read miss or half-warmed energy report is
 * plausibly still wrong 5 s later; 30 s of separation is what makes "two
 * consecutive attempts agree" meaningful evidence rather than one condition
 * read twice.
 */
const CONFIRMATION_GAP_MS = 30_000;
/** Consecutive empty-census reads a fresh install must show before the exhaustion demote. */
const NONE_FOUND_STREAK_FOR_FRESH_DEMOTE = 3;

const retryDelayMs = (attempt: number): number => (
  Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
);

type SettingsPort = {
  get(key: string): unknown;
  getKeys(): string[];
};

/**
 * The synchronous half of the meter-authority decision table: what does the
 * persisted state say, and does deciding need the live energy report?
 *
 * The meter key is read RAW here, not through `readMainMeterSelection`: this
 * migration is the one place that still has to tell a stored/never-written
 * Automatic (`null`/absent — the meaning this migration exists to retire)
 * apart from a transient read miss of an explicit value (defer, retry next
 * boot). The reader's job is the post-migration meaning; the migration owns
 * the legacy one.
 */
export type MainMeterAuthorityClassification =
  | { kind: 'conformant'; detail: 'flow_source' | 'explicit_meter' }
  | { kind: 'write_flow'; detail: 'unset_source_with_history' }
  | { kind: 'resolve_automatic' }
  | { kind: 'detect_fresh_install' }
  | { kind: 'defer'; reasonCode: 'empty_key_list' | 'missing_existing_key' | 'suspect_meter_value' | 'read_failed' };

export const classifyMainMeterAuthorityState = (
  settings: SettingsPort,
): MainMeterAuthorityClassification => {
  try {
    const rawSource = settings.get(POWER_SOURCE);
    if (rawSource !== undefined && rawSource !== null) {
      if (normalizePowerSource(rawSource) === 'flow') return { kind: 'conformant', detail: 'flow_source' };
      return classifyHomeyEnergyMeterState(settings);
    }
    const keys = settings.getKeys();
    if (keys.length === 0) return { kind: 'defer', reasonCode: 'empty_key_list' };
    if (keys.includes(POWER_SOURCE)) return { kind: 'defer', reasonCode: 'missing_existing_key' };
    // Any persisted tracker state means this install has run before, and the
    // Homey Energy poll only ever ran with the source key explicitly set — so
    // an unset source with history was necessarily Flow-fed all along.
    return keys.includes(POWER_TRACKER_STATE)
      ? { kind: 'write_flow', detail: 'unset_source_with_history' }
      : { kind: 'detect_fresh_install' };
  } catch {
    return { kind: 'defer', reasonCode: 'read_failed' };
  }
};

const classifyHomeyEnergyMeterState = (settings: SettingsPort): MainMeterAuthorityClassification => {
  const rawMeter = settings.get(HOMEY_ENERGY_METER_DEVICE_ID);
  if (typeof rawMeter === 'string') {
    return resolveExplicitMainMeterDeviceId(rawMeter) === null
      ? { kind: 'defer', reasonCode: 'suspect_meter_value' }
      : { kind: 'conformant', detail: 'explicit_meter' };
  }
  if (rawMeter === null) return { kind: 'resolve_automatic' };
  const keys = settings.getKeys();
  if (keys.length === 0) return { kind: 'defer', reasonCode: 'empty_key_list' };
  // A listed key answering `undefined` is a transient miss of an explicitly
  // configured meter (TODO.md's transient-null case) — defer, never Automatic.
  return keys.includes(HOMEY_ENERGY_METER_DEVICE_ID)
    ? { kind: 'defer', reasonCode: 'missing_existing_key' }
    : { kind: 'resolve_automatic' };
};

/**
 * Boot-window activation read for the ownership seam. The membership service
 * may not be wired yet, so this resolves activation straight from the config
 * + settings evidence; a suspect read maps to `unavailable`, which the save
 * functions answer with `degraded` (and this migration treats as a retry).
 */
const readBootActivation = (homey: Homey.App['homey']): MultiHomeActivationRead => {
  const read = createHomesStore(homey).read();
  if (read.state === 'suspect') return { state: 'unavailable' };
  const config = read.state === 'present' ? read.value : { subHomes: [] };
  const activation = readHomeConfigRuntimeActivation(config, homey.settings);
  return activation.state === 'resolved'
    ? { state: 'resolved', runtimeActive: activation.active }
    : { state: 'unavailable' };
};

type AsyncMigrationCase = 'resolve_automatic' | 'detect_fresh_install';

/**
 * What one attempt decided. `propose` is a decisive conclusion that has not
 * been confirmed yet: any outcome that WRITES a permanent answer (persist a
 * meter, demote to Flow) must be reached by two consecutive spaced attempts
 * before it executes, because a single boot-window read of the settings store
 * or the energy report is exactly the evidence class this codebase documents
 * as untrustworthy (`notes/persisted-settings-state.md`). `conformant` and
 * `superseded` come from re-classifying persisted state at the top of every
 * attempt — the seam that stops a retry chain from clobbering a concurrent
 * user save with a stale boot-time classification.
 */
type MigrationStepResult =
  | { result: 'done'; outcome: 'meter_persisted'; meterDeviceId: string }
  | { result: 'done'; outcome: 'flow_persisted' }
  | { result: 'conformant'; detail: 'flow_source' | 'explicit_meter' }
  | { result: 'superseded'; kind: string }
  | { result: 'propose'; decision: MigrationDecision; reasonCode: string }
  | { result: 'retry'; reasonCode: string }
  | { result: 'abandon'; reasonCode: 'areas_running' };

/** A decisive write, expressed as a comparable key for confirm-twice. */
type MigrationDecision = 'none' | 'demote_flow' | `persist:${string}`;

const demoteToFlow = (
  homey: Homey.App['homey'],
  activation: MultiHomeActivationRead,
): MigrationStepResult => {
  const saved = savePowerSourceSelection(homey, { op: 'set_power_source', source: 'flow' }, activation);
  if (saved.ok) return { result: 'done', outcome: 'flow_persisted' };
  if (saved.reason === 'homey_energy_required') {
    // Running meter areas require the Homey Energy source, and their Main
    // meter cannot be resolved — a legacy shape only the owner can fix (pick
    // a meter in the UI). Abandon this boot; the next boot retries.
    return { result: 'abandon', reasonCode: 'areas_running' };
  }
  return { result: 'retry', reasonCode: `flow_save_${saved.reason}` };
};

type PersistMeterResult =
  | { persisted: 'done'; step: MigrationStepResult }
  | { persisted: 'retry'; step: MigrationStepResult }
  | { persisted: 'fallthrough_flow' };

const persistResolvedMeter = (
  homey: Homey.App['homey'],
  meterDeviceId: string,
  activation: MultiHomeActivationRead,
): PersistMeterResult => {
  // The one atomic seam op: meter written first, source only when it is not
  // already homey_energy — so `homey_energy` never exists persisted without a
  // meter id, and an already-homey_energy home gets a single-key write.
  const saved = savePowerSourceSelection(
    homey,
    { op: 'set_power_source', source: 'homey_energy', meterDeviceId },
    activation,
  );
  if (saved.ok) {
    return { persisted: 'done', step: { result: 'done', outcome: 'meter_persisted', meterDeviceId } };
  }
  // `meter_in_use`: the sole cumulative meter belongs to a meter area, so the
  // Main home was reading an area's meter — nothing nameable remains for
  // Main; fall through to the Flow demotion. That is a durable configuration
  // fact read from the homes store (a suspect store read returns a retry
  // reason instead), so it does not need its own confirmation round. Anything
  // else is a degraded/suspect store read: retry.
  return saved.reason === 'meter_in_use'
    ? { persisted: 'fallthrough_flow' }
    : { persisted: 'retry', step: { result: 'retry', reasonCode: `meter_save_${saved.reason}` } };
};

/**
 * The read-only half of one attempt: what would this attempt do? The census
 * splits `unresolvable` into retryable (empty/warming report — never a
 * decision) and decisive (ambiguous, id-less sole — a real Flow demotion,
 * once confirmed).
 */
const concludeAttempt = (
  homey: Homey.App['homey'],
  migrationCase: AsyncMigrationCase,
  sole: SoleCumulativeMeterResolution,
): MigrationStepResult => {
  if (sole.state === 'unresolvable' && sole.verdict === 'retryable') {
    return { result: 'retry', reasonCode: `census_${sole.reason}` };
  }
  if (migrationCase === 'detect_fresh_install') {
    const homesRead = createHomesStore(homey).read();
    if (homesRead.state === 'suspect') return { result: 'retry', reasonCode: 'homes_store_suspect' };
    const singleHome = homesRead.state === 'unwritten' || homesRead.value.subHomes.length === 0;
    if (singleHome && sole.state === 'resolved') {
      return { result: 'propose', decision: `persist:${sole.meterDeviceId}`, reasonCode: 'sole_meter_detected' };
    }
    const reasonCode = singleHome && sole.state === 'unresolvable' ? `census_${sole.reason}` : 'multi_home';
    return { result: 'propose', decision: 'demote_flow', reasonCode };
  }
  if (sole.state === 'resolved') {
    return { result: 'propose', decision: `persist:${sole.meterDeviceId}`, reasonCode: 'sole_meter_detected' };
  }
  return { result: 'propose', decision: 'demote_flow', reasonCode: `census_${sole.reason}` };
};

const executeDecision = (
  homey: Homey.App['homey'],
  decision: MigrationDecision,
  activation: MultiHomeActivationRead,
): MigrationStepResult => {
  if (decision === 'demote_flow' || decision === 'none') return demoteToFlow(homey, activation);
  const meterDeviceId = decision.slice('persist:'.length);
  const persisted = persistResolvedMeter(homey, meterDeviceId, activation);
  return persisted.persisted === 'fallthrough_flow' ? demoteToFlow(homey, activation) : persisted.step;
};

const runAsyncMigrationAttempt = async (
  homey: Homey.App['homey'],
  migrationCase: AsyncMigrationCase,
  confirmedDecision: MigrationDecision,
): Promise<MigrationStepResult> => {
  const sole = await censusLiveSoleCumulativeMeter();
  if (sole.state === 'unavailable') return { result: 'retry', reasonCode: 'energy_report_unavailable' };
  // Re-classify persisted state AFTER the awaited fetch, so it is the last
  // read before any write: a concurrent user save through the same ownership
  // seam (the settings UI is reachable during the retry window, and the fetch
  // itself takes seconds) makes the home conformant, and this chain must
  // observe that and stop — never overwrite it with a boot-time conclusion.
  const reclassified = classifyMainMeterAuthorityState(homey.settings);
  if (reclassified.kind === 'conformant') return { result: 'conformant', detail: reclassified.detail };
  if (reclassified.kind === 'defer') return { result: 'retry', reasonCode: `reclassify_${reclassified.reasonCode}` };
  if (reclassified.kind !== migrationCase) return { result: 'superseded', kind: reclassified.kind };
  const conclusion = concludeAttempt(homey, migrationCase, sole);
  if (conclusion.result !== 'propose') return conclusion;
  if (conclusion.decision !== confirmedDecision) return conclusion;
  return executeDecision(homey, conclusion.decision, readBootActivation(homey));
};

export type MainMeterAuthorityMigrationParams = {
  homey: Homey.App['homey'];
  timers: TimerRegistry;
};

/**
 * One-time meter-authority migration: every install ends up with an explicit
 * persisted answer to "where do whole-home readings come from" — either
 * `power_source = homey_energy` plus a named meter id, or `power_source =
 * flow`. Retires the Automatic (`null`) meter selection: an upgrading
 * Automatic home gets the meter Automatic was in fact reading persisted
 * (user ruling 2026-08-31), and only a home where nothing nameable exists
 * (ambiguous census, id-less aggregate) demotes to Flow.
 *
 * This deliberately supersedes the "runtime never writes a default
 * power_source" rule (commit 69076d54c) for this marker-gated migration
 * alone; the settings-UI bulk save keeps its half of that rule. Writes go
 * through `savePowerSourceSelection` — the two keys' only writer — on the
 * same event loop as `ui_homes_save`, so the
 * single-writer serialization and every ownership invariant apply unchanged.
 *
 * Marker (`main_meter_authority_migration_v1_done`) is set only on a decisive
 * outcome; a suspect read or unavailable energy report withholds it so the
 * next boot retries (abandon-grace, `notes/persisted-settings-state.md`).
 * Cases that need the live energy report retry with bounded backoff for
 * ~10 minutes per boot, then give up until the next boot. Two guards protect
 * the permanent writes: every attempt re-classifies persisted state first
 * (a concurrent user save wins and stops the chain), and a decisive write
 * executes only after two consecutive attempts reach the same conclusion, the
 * confirming attempt at least `CONFIRMATION_GAP_MS` after the proposal — one
 * warming-up energy report or one transient `null` settings read never seals
 * an answer. The one bounded exception: a fresh install whose census stays
 * empty through the retry ladder demotes to Flow at exhaustion, and only when
 * the ladder ENDED on a sustained streak of consecutive empty reads
 * (`NONE_FOUND_STREAK_FOR_FRESH_DEMOTE`) rather than a run of failed fetches,
 * because a flow-only fresh install has no meter to ever find and must still
 * end with a persisted source.
 */
type DecisiveOutcome =
  | { outcome: 'meter_persisted'; meterDeviceId: string }
  | { outcome: 'flow_persisted' | 'flow_source' | 'explicit_meter' | 'unset_source_with_history' };

const commitMarker = (homey: Homey.App['homey'], decisive: DecisiveOutcome): void => {
  // A throwing marker write must not escape into boot, and must not count
  // as done: the settings writes themselves went through the save seam, so
  // the next boot re-classifies as conformant and only re-writes the marker.
  try {
    homey.settings.set(MAIN_METER_AUTHORITY_MIGRATION_MARKER, true);
  } catch (error) {
    migrationLogger.warn({
      event: 'main_meter_migration_marker_write_failed',
      err: normalizeError(error),
    });
    return;
  }
  migrationLogger.info({ event: 'main_meter_migration_applied', ...decisive });
};

const handleExhaustion = (
  homey: Homey.App['homey'],
  migrationCase: AsyncMigrationCase,
  reasonCode: string,
  noneFoundStreak: number,
): void => {
  // A fresh install whose census stayed empty through a sustained streak of
  // consecutive reads (not merely on the final attempt after a run of failed
  // fetches) is a flow-only install: demote decisively (see the docblock)
  // instead of deferring forever.
  if (
    migrationCase === 'detect_fresh_install'
    && reasonCode === 'census_none_found'
    && noneFoundStreak >= NONE_FOUND_STREAK_FOR_FRESH_DEMOTE
  ) {
    const step = demoteToFlow(homey, readBootActivation(homey));
    if (step.result === 'done') {
      commitMarker(homey, { outcome: 'flow_persisted' });
      return;
    }
  }
  migrationLogger.warn({
    event: 'main_meter_migration_gave_up_this_boot',
    migrationCase,
    reasonCode,
    attempts: MAX_ATTEMPTS,
  });
};

export const runMainMeterAuthorityMigration = (params: MainMeterAuthorityMigrationParams): void => {
  const { homey, timers } = params;
  try {
    if (homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER) === true) return;
  } catch (error) {
    migrationLogger.warn({
      event: 'main_meter_migration_deferred',
      reasonCode: 'marker_read_failed',
      err: normalizeError(error),
    });
    return;
  }

  const commit = (decisive: DecisiveOutcome): void => commitMarker(homey, decisive);

  const scheduleNext = (
    migrationCase: AsyncMigrationCase,
    attempt: number,
    pending: MigrationDecision,
    noneFoundStreak: number,
  ): void => {
    // A pending decision waits the full confirmation gap; plain retries keep
    // the ordinary backoff.
    const delay = pending === 'none' ? retryDelayMs(attempt) : Math.max(retryDelayMs(attempt), CONFIRMATION_GAP_MS);
    timers.registerTimeout(RETRY_TIMER_NAME, setTimeout(() => {
      runAttempt(migrationCase, attempt + 1, pending, noneFoundStreak);
    }, delay));
  };

  const runAttempt = (
    migrationCase: AsyncMigrationCase,
    attempt: number,
    pending: MigrationDecision,
    noneFoundStreak: number,
  ): void => {
    runAsyncMigrationAttempt(homey, migrationCase, pending)
      .then((step) => {
        if (step.result === 'done') {
          commit(step.outcome === 'meter_persisted'
            ? { outcome: 'meter_persisted', meterDeviceId: step.meterDeviceId }
            : { outcome: 'flow_persisted' });
          return;
        }
        if (step.result === 'conformant') {
          commit({ outcome: step.detail });
          return;
        }
        if (step.result === 'superseded') {
          // Persisted state changed shape under the chain (rare); stop with
          // the marker withheld — the next boot classifies fresh.
          migrationLogger.warn({ event: 'main_meter_migration_superseded', migrationCase, kind: step.kind });
          return;
        }
        if (step.result === 'abandon') {
          migrationLogger.warn({
            event: 'main_meter_migration_deferred_areas_running',
            migrationCase,
          });
          return;
        }
        const nextStreak = step.reasonCode === 'census_none_found' ? noneFoundStreak + 1 : 0;
        if (attempt + 1 >= MAX_ATTEMPTS) {
          handleExhaustion(homey, migrationCase, step.reasonCode, nextStreak);
          return;
        }
        if (step.result === 'propose') {
          migrationLogger.debug({
            event: 'main_meter_migration_confirmation_pending',
            migrationCase,
            decision: step.decision,
            reasonCode: step.reasonCode,
            attempt: attempt + 1,
          });
          scheduleNext(migrationCase, attempt, step.decision, nextStreak);
          return;
        }
        migrationLogger.debug({
          event: 'main_meter_migration_retry_scheduled',
          migrationCase,
          reasonCode: step.reasonCode,
          attempt: attempt + 1,
        });
        // A retry is not a disagreement, but it is not a confirmation either:
        // reset the pending decision so only consecutive attempts confirm.
        scheduleNext(migrationCase, attempt, 'none', nextStreak);
      })
      .catch((error: unknown) => {
        migrationLogger.error({ event: 'main_meter_migration_step_failed', migrationCase, err: normalizeError(error) });
      });
  };

  const classification = classifyMainMeterAuthorityState(homey.settings);
  switch (classification.kind) {
    case 'conformant':
      commit({ outcome: classification.detail });
      return;
    case 'write_flow': {
      const step = demoteToFlow(homey, readBootActivation(homey));
      if (step.result === 'done') commit({ outcome: classification.detail });
      else if (step.result === 'retry') {
        migrationLogger.warn({ event: 'main_meter_migration_deferred', reasonCode: step.reasonCode });
      } else if (step.result === 'abandon') {
        migrationLogger.warn({ event: 'main_meter_migration_deferred_areas_running', migrationCase: 'write_flow' });
      }
      return;
    }
    case 'defer':
      migrationLogger.warn({ event: 'main_meter_migration_deferred', reasonCode: classification.reasonCode });
      return;
    case 'resolve_automatic':
    case 'detect_fresh_install':
      runAttempt(classification.kind, 0, 'none', 0);
  }
};
