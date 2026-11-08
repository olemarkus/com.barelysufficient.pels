import { getSetting, setSetting } from './homey.ts';
import { pushSettingWriteIfChanged, settleSettingWrites } from './settingWrites.ts';
import { isFiniteNumber } from '../../../shared-domain/src/numberGuards.ts';
import { resolveCapacityPeriodMinutes } from '../../../shared-domain/src/settings/capacityPeriod.ts';
import { resolvePowerLimitSettings } from '../../../shared-domain/src/settings/powerLimits.ts';
import { MAIN_FUSE_OFF, resolveMainFuseSetting } from '../../../shared-domain/src/settings/mainFuse.ts';
import type { CapacityScalarSettings, MainFuse } from '../../../contracts/src/capacitySettings.ts';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_ENABLED,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  GRID_IMPORT_ENABLED,
  GRID_IMPORT_LIMIT_KW,
  MAIN_FUSE_AMPS,
  MAIN_FUSE_SUPPLY,
} from '../../../shared-domain/src/settings/settingsKeys.ts';

/**
 * The WebView's read and write of the persisted capacity block. Values arrive
 * as Homey stored them; `capacity.ts` resolves them against the running app's
 * posture before anything is painted or saved.
 */
export type CurrentCapacitySettings = {
  limit: unknown;
  margin: unknown;
  dryRun: unknown;
  periodMinutes: unknown;
  capacityEnabled: unknown;
  gridImportEnabled: unknown;
  gridImportLimitKw: unknown;
  mainFuseSupply: unknown;
  mainFuseAmps: unknown;
};

export const readCurrentCapacitySettings = async (): Promise<CurrentCapacitySettings> => {
  const [
    limit, margin, dryRun, periodMinutes, capacityEnabled, gridImportEnabled, gridImportLimitKw,
    mainFuseSupply, mainFuseAmps,
  ] = await Promise.all([
    getSetting(CAPACITY_LIMIT_KW),
    getSetting(CAPACITY_MARGIN_KW),
    getSetting(CAPACITY_DRY_RUN),
    getSetting(CAPACITY_PERIOD_MINUTES),
    getSetting(CAPACITY_ENABLED),
    getSetting(GRID_IMPORT_ENABLED),
    getSetting(GRID_IMPORT_LIMIT_KW),
    getSetting(MAIN_FUSE_SUPPLY),
    getSetting(MAIN_FUSE_AMPS),
  ]);
  return {
    limit, margin, dryRun, periodMinutes, capacityEnabled, gridImportEnabled, gridImportLimitKw,
    mainFuseSupply, mainFuseAmps,
  };
};

/**
 * A persisted scalar wins; a missing or malformed one takes `fallback`'s. The
 * runtime retains its validated in-memory posture when a persisted key is
 * absent, so an unset key must never make the WebView claim a boot default
 * (simulation included) while the running app holds a live value.
 *
 * The same holds for the two control switches: a `null` switch is either never
 * written or a transient SDK miss, and the WebView cannot tell which (only the
 * runtime sees the key list), so it takes the running posture, which for a
 * never-written key is the legacy one. The switches and the grid threshold
 * resolve as one posture, as the runtime store does: a malformed member (grid on
 * without a valid threshold) takes `fallback`'s posture whole rather than mixing
 * a saved switch with a running one.
 */
/** The saved main fuse; a never-written or unreadable pair is off in the form. */
export const resolveSavedMainFuse = (current: CurrentCapacitySettings): MainFuse => {
  const read = resolveMainFuseSetting(current.mainFuseSupply ?? MAIN_FUSE_OFF, current.mainFuseAmps);
  return read.state === 'resolved' ? read.value : { kind: 'off' };
};

export const resolveCapacityScalars = (
  current: CurrentCapacitySettings,
  fallback: CapacityScalarSettings,
): CapacityScalarSettings => {
  const controls = resolvePowerLimitSettings(
    current.capacityEnabled ?? fallback.capacityEnabled,
    // The running limit includes the fuse's total, so with a fuse set it says
    // nothing about a grid import switch the owner never wrote.
    current.gridImportEnabled ?? (fallback.gridImportLimitKw !== null && resolveSavedMainFuse(current).kind === 'off'),
    current.gridImportLimitKw,
  ) ?? fallback;
  return {
    capacityEnabled: controls.capacityEnabled,
    gridImportLimitKw: controls.gridImportLimitKw,
    limitKw: isFiniteNumber(current.limit) ? current.limit : fallback.limitKw,
    marginKw: isFiniteNumber(current.margin) ? current.margin : fallback.marginKw,
    dryRun: typeof current.dryRun === 'boolean' ? current.dryRun : fallback.dryRun,
    periodMinutes: resolveCapacityPeriodMinutes(current.periodMinutes, fallback.periodMinutes),
  };
};

// Within one save, thresholds land before any switch moves, and a switch turns
// on before the other turns off: a save that moves both never passes through a
// moment with neither limit in force, and a failed threshold write moves no
// switch. Switches compare against the posture the page resolved (`stored`),
// not the raw keys, so a save never writes a switch the owner did not change.
// Threshold keys compare raw: saving the form is what records a hard cap as the
// owner's own (`hardCapConfiguration`).
export const writeLimitsSettings = async (
  current: CurrentCapacitySettings,
  stored: CapacityScalarSettings,
  next: CapacityScalarSettings,
): Promise<void> => {
  const values: Array<Promise<void>> = [];
  if (next.gridImportLimitKw !== null) {
    pushSettingWriteIfChanged(values, GRID_IMPORT_LIMIT_KW, current.gridImportLimitKw, next.gridImportLimitKw);
  }
  pushSettingWriteIfChanged(values, CAPACITY_LIMIT_KW, current.limit, next.limitKw);
  pushSettingWriteIfChanged(values, CAPACITY_MARGIN_KW, current.margin, next.marginKw);
  pushSettingWriteIfChanged(values, CAPACITY_PERIOD_MINUTES, current.periodMinutes, next.periodMinutes);
  await settleSettingWrites(values);

  const switches = [
    { key: GRID_IMPORT_ENABLED, stored: stored.gridImportLimitKw !== null, next: next.gridImportLimitKw !== null },
    { key: CAPACITY_ENABLED, stored: stored.capacityEnabled, next: next.capacityEnabled },
  ].filter((change) => change.stored !== change.next);
  await settleSettingWrites(switches.filter((change) => change.next).map((change) => setSetting(change.key, true)));
  await settleSettingWrites(switches.filter((change) => !change.next).map((change) => setSetting(change.key, false)));
};

/** The size first, so a supply never lands without a valid one. */
export const writeMainFuseSettings = async (current: CurrentCapacitySettings, next: MainFuse): Promise<void> => {
  if (next.kind === 'on') {
    const size: Array<Promise<void>> = [];
    pushSettingWriteIfChanged(size, MAIN_FUSE_AMPS, current.mainFuseAmps, next.amps);
    await settleSettingWrites(size);
  }
  const supply = next.kind === 'on' ? next.supply : MAIN_FUSE_OFF;
  if ((current.mainFuseSupply ?? MAIN_FUSE_OFF) !== supply) await setSetting(MAIN_FUSE_SUPPLY, supply);
};

export const writeLimitsAndFuseSettings = async (
  current: CurrentCapacitySettings,
  stored: CapacityScalarSettings,
  next: CapacityScalarSettings,
  mainFuse: MainFuse,
): Promise<void> => {
  await writeLimitsSettings(current, stored, next);
  await writeMainFuseSettings(current, mainFuse);
};

export const writeSimulationSetting = async (current: CurrentCapacitySettings, dryRun: boolean): Promise<void> => {
  if (current.dryRun !== dryRun) await setSetting(CAPACITY_DRY_RUN, dryRun);
};

/** Changing the period never materializes the built-in hard cap. */
export const writeCapacityPeriodSetting = async (
  current: CurrentCapacitySettings,
  periodMinutes: 15 | 60,
): Promise<void> => {
  if (current.periodMinutes !== periodMinutes) await setSetting(CAPACITY_PERIOD_MINUTES, periodMinutes);
};

/**
 * Turning Capacity limit off writes the switch alone, so the built-in hard cap is
 * never recorded as the owner's choice. The switch compares against the posture
 * the page resolved, as `writeLimitsSettings` does.
 */
export const writeCapacityOffSetting = async (stored: CapacityScalarSettings): Promise<void> => {
  if (stored.capacityEnabled) await setSetting(CAPACITY_ENABLED, false);
};
