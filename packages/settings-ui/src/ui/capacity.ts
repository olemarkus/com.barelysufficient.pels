import {
  readPowerLimitSettings,
  syncPowerLimitSwitches,
  syncCapacityLimitControls,
  validatePowerLimitSettings,
} from './powerLimitControls.ts';
export {
  MARGIN_NOT_BELOW_LIMIT_MESSAGE,
  refreshLimitsValidationHints,
  refreshPowerLimitControls,
} from './powerLimitControls.ts';
import { syncSettingsHubChips } from './settingsHubChips.ts';
import {
  settingsGridImportLimitInput,
  settingsCapacityMonthlyPeakValue,
  settingsPowerSourceSelect,
  settingsSimulationModeInput,
  dryRunBanner,
  dryRunBannerText,
  simulationDisableButton,
  type MdSwitchElement,
  staleDataBanner,
  staleDataBannerText,
  staleDataBannerAction,
} from './dom.ts';
import { isValidGridImportLimitKw } from '../../../shared-domain/src/settings/powerLimits.ts';
import { SETTINGS_UI_POWER_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { getSetting, setSetting, invalidateApiCache } from './homey.ts';
import { state } from './state.ts';
import { getPowerReadModel } from './power.ts';
import {
  mergeMeterAreaSimulation,
  readAreaSimulationFlag,
  readHomesConfigScope,
  resolveActiveMeterAreas,
  resolveHasMeterAreas,
  resolveRetainedScopeClaim,
} from './meterAreaPosture.ts';
import {
  CAPACITY_ENABLED,
  GRID_IMPORT_ENABLED,
  GRID_IMPORT_LIMIT_KW,
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  DEBUG_LOGGING_TOPICS,
  HOMEY_ENERGY_METER_DEVICE_ID,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  POWER_SOURCE,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import {
  hasChosenWholeHomeMeter,
  syncHomeyEnergyMeterSelection,
  syncHomeyEnergyMeterVisibility,
} from './homeyEnergyMeter.ts';
import {
  ALL_DEBUG_LOGGING_TOPICS,
  type DebugLoggingScenarioId,
  isDebugLoggingScenarioId,
  normalizeDebugLoggingTopics,
  topicsToScenarioIds,
} from '../../../shared-domain/src/utils/debugLogging.ts';
import { renderLegacyTopicsHint } from './debugLoggingHint.ts';
import {
  DEFAULT_CAPACITY_PERIOD_MINUTES,
  resolveCapacityPeriodMinutes,
} from '../../../shared-domain/src/settings/capacityPeriod.ts';
import type {
  CapacityPeriodMinutes,
  CapacityScalarSettings,
} from '../../../contracts/src/capacitySettings.ts';
import {
  resolveSimulationBannerContent,
  type SimulationBannerScope,
} from '../../../shared-domain/src/simulationPosture.ts';
import { syncSimulationHomeScopeNote } from './simulationScopeNote.ts';
import type {
  SettingsUiCapacityPeak,
  SettingsUiPowerPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  classifyPowerReadingsFact,
  resolvePowerReadingsBannerContent,
  type PowerReadingsFact,
} from '../../../shared-domain/src/powerReadingsBanner.ts';
import { logSettingsError } from './logging.ts';
import { showToast } from './toast.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import { refreshPlanSurface } from './planSurfaceRefresh.ts';
import { isPlanUnmeasured, onPlanMeasurementChange } from './planMeasurementSignal.ts';
import {
  isNoReadingsCarriedBySetupPath,
  isSimulationCarriedBySetupPath,
  onSetupPathChange,
  publishSetupHardCapRead,
  publishSetupHardCapUnavailable,
  publishSetupPower,
  publishSetupPowerUnavailable,
} from './setupPathFacts.ts';
import { formatCapacityPeak } from './capacityPeakRead.ts';
import { isFiniteNumber } from '../../../shared-domain/src/numberGuards.ts';

export type PowerSource = 'flow' | 'homey_energy';

type CapacitySettingsCommand =
  | {
    kind: 'limits';
    capacityEnabled: boolean;
    gridImportLimitKw: number | null;
    limitKw: number;
    marginKw: number;
    periodMinutes: CapacityPeriodMinutes;
  }
  | { kind: 'simulation'; dryRun: boolean };

type CurrentCapacitySettings = {
  limit: unknown;
  margin: unknown;
  dryRun: unknown;
  periodMinutes: unknown;
  capacityEnabled: unknown;
  gridImportEnabled: unknown;
  gridImportLimitKw: unknown;
};


// Mirrors the runtime snapshot's lifecycle: simulation is the boot default,
// then only a resolved read or successful save replaces it.
let lastGoodCapacityScalars: CapacityScalarSettings = {
  capacityEnabled: true,
  gridImportLimitKw: null,
  limitKw: 10,
  marginKw: 0.2,
  dryRun: true,
  periodMinutes: DEFAULT_CAPACITY_PERIOD_MINUTES,
};

// An unavailable read is a no-op: the last shown peak (or the template's
// "Peak unavailable") stays until a read that knows the answer.
const renderMonthlyQuarterPeak = (peak: SettingsUiCapacityPeak): void => {
  if (settingsCapacityMonthlyPeakValue && peak.state !== 'unavailable') {
    settingsCapacityMonthlyPeakValue.textContent = formatCapacityPeak(peak);
  }
};

const commitCapacityScalars = (scalars: CapacityScalarSettings): void => {
  lastGoodCapacityScalars = scalars;
  state.dryRun = scalars.dryRun;
};

/**
 * A persisted scalar wins; a missing or malformed one takes `fallback`'s. The
 * runtime retains its validated in-memory posture when a persisted key is
 * absent, so an unset key must never make the WebView claim a boot default
 * (simulation included) while the running app holds a live value.
 */
const resolveCapacityScalars = (
  current: CurrentCapacitySettings,
  fallback: CapacityScalarSettings,
): CapacityScalarSettings => ({
  ...fallback,
  limitKw: isFiniteNumber(current.limit) ? current.limit : fallback.limitKw,
  marginKw: isFiniteNumber(current.margin) ? current.margin : fallback.marginKw,
  dryRun: typeof current.dryRun === 'boolean' ? current.dryRun : fallback.dryRun,
  periodMinutes: resolveCapacityPeriodMinutes(current.periodMinutes, fallback.periodMinutes),
});

export const normalizePowerSource = (raw: unknown): PowerSource => (
  raw === 'homey_energy' ? 'homey_energy' : 'flow'
);

// null means the outer settings boundary could not classify the saved homes
// roster. In that case the banner uses the narrower Main-home claim: it remains
// truthful even when malformed state hides a meter area from this WebView.
let hasMeterAreas: boolean | null = null;

const renderDryRunBannerText = (text: string): void => {
  if (!dryRunBannerText) return;
  const noBreakSuffix = 'as-is';
  const prefix = text.endsWith(noBreakSuffix)
    ? text.slice(0, -noBreakSuffix.length)
    : text;
  const noBreak = document.createElement('span');
  noBreak.className = 'banner__no-break';
  noBreak.textContent = text.endsWith(noBreakSuffix) ? noBreakSuffix : '';
  dryRunBannerText.replaceChildren(prefix, noBreak);
};

// Exported pure for tests. The Simulation-mode settings page suppresses only
// the banners whose remedy its own Main switch already duplicates (`all` /
// `main` scope — a duplicate control on one screen reads as confusing
// chrome). The area-scoped line survives there: that page holds Main's
// switch, which is OFF in that posture, so hiding the only warning naming the
// simulating area would present an apparently all-live screen at the end of
// the "Partly on" chip's trail — with no route to the area's own control on
// Limits & safety.
export const isSimulationBannerSuppressedOnPanel = (
  scope: SimulationBannerScope,
  activePanel: string,
): boolean => activePanel === 'simulation' && scope !== 'areas';

// The global simulation banner shows on every tab; the Simulation-mode
// settings page suppresses only the Main-remedy variants (see
// `isSimulationBannerSuppressedOnPanel`). Reads live `state.dryRun`
// + `state.meterAreaSimulation` + `state.activePanel`, so the dry-run toggle,
// tab navigation, and the posture refresh below all call it.
export const syncDryRunBannerVisibility = (): void => {
  const content = resolveSimulationBannerContent({
    hasMeterAreas,
    mainSimulating: state.dryRun,
    // Only areas KNOWN to simulate are named; an unknown flag (`null`) never
    // puts words in the banner's mouth.
    simulatingAreaNames: state.meterAreaSimulation
      .filter((area) => area.simulating === true)
      .map((area) => area.name),
  });
  if (content !== null) {
    renderDryRunBannerText(content.text);
    if (simulationDisableButton) {
      simulationDisableButton.textContent = content.actionLabel ?? '';
      // The area-scoped line has no one-tap remedy: the button writes MAIN's
      // flag, which is already off in that state, so it hides and the text
      // names the page holding each area's own control.
      simulationDisableButton.hidden = content.actionLabel === null;
    }
  }
  if (dryRunBanner) {
    if (content !== null) dryRunBanner.dataset.homeScope = content.scope;
    dryRunBanner.hidden = content === null
      || isSimulationBannerSuppressedOnPanel(content.scope, state.activePanel)
      // An unread roster is not "no meter areas": only a known single home stands down.
      || isSimulationCarriedBySetupPath(hasMeterAreas === false);
  }
  // Honest Simulation-page scope note (multi-home): synced here because every
  // input it depends on (the active-area roster) already drives this function.
  syncSimulationHomeScopeNote(state.meterAreaSimulation.length > 0);
};

// Generation fence, mirroring `refreshHomeScope`: rapid suffixed-flag or
// roster writes each start an async refresh, and an older one — carrying a
// pre-change cached flag for another area — could finish last and overwrite
// the newest answer for the rest of the session. Only the newest started
// refresh may commit.
let postureRefreshGeneration = 0;

const refreshDryRunBannerHomeScope = async (): Promise<void> => {
  postureRefreshGeneration += 1;
  const generation = postureRefreshGeneration;
  const scopeRead = await readHomesConfigScope();
  const rosterRead = resolveActiveMeterAreas(scopeRead);
  if (rosterRead.status === 'unavailable') {
    if (generation !== postureRefreshGeneration) return;
    // Abandon-grace: an unclassifiable roster read keeps the last-good
    // snapshot — wiping it would hide the one banner naming a simulating
    // area (and flip the chip) on a single transient or suspect read. The
    // scope claim is held on exactly the same terms, so the two can never
    // contradict each other (`resolveRetainedScopeClaim`): only a RESOLVED
    // roster may claim this install has no meter areas.
    hasMeterAreas = resolveRetainedScopeClaim(hasMeterAreas, scopeRead);
    syncDryRunBannerVisibility();
    return;
  }
  const flags = await Promise.all(
    rosterRead.areas.map((area) => readAreaSimulationFlag(area.homeId)),
  );
  // A newer refresh started while this one was awaiting; its answer wins and
  // will paint the banner and chip.
  if (generation !== postureRefreshGeneration) return;
  hasMeterAreas = resolveHasMeterAreas(scopeRead);
  state.meterAreaSimulation = mergeMeterAreaSimulation(rosterRead.areas, flags, state.meterAreaSimulation);
  syncDryRunBannerVisibility();
};

/**
 * Realtime `settings.set`/`settings.unset` hook for every key the aggregate
 * posture derives from. Two families qualify:
 *
 * - The SUFFIXED per-area control flags: the exact-key routing table cannot
 *   match `capacity_dry_run:<homeId>` (the Limits page control toggle, or a
 *   second WebView), yet that write flips the posture the banner and the
 *   Settings hub chip render.
 * - The roster keys: an area added, removed, or renamed rewrites
 *   `homes_config`, changing which flags belong in the posture at all. On
 *   `settings.set` this overlaps with `loadCapacitySettings`' own refresh —
 *   benign under the generation fence — but the posture must not lean on that
 *   panel loader's side effect, and `settings.unset` has no other posture
 *   route.
 */
export const notifyAreaSimulationSettingChanged = (key: string): void => {
  const isAreaFlagKey = key.startsWith(`${CAPACITY_DRY_RUN}:`);
  if (!isAreaFlagKey && key !== HOMES_CONFIG && key !== HOMES_CONFIG_INITIALIZED) return;
  void refreshDryRunBannerHomeScope()
    .then(() => { syncSettingsHubChips(); })
    .catch((caught: unknown) => logSettingsError('Failed to refresh the simulation posture', caught, 'capacity'));
};

const syncSimulationModeControl = (dryRun: boolean): void => {
  if (settingsSimulationModeInput) settingsSimulationModeInput.selected = dryRun;
};

const syncCapacityOwnedControls = (scalars: CapacityScalarSettings): void => {
  syncCapacityLimitControls(scalars);
  syncSimulationModeControl(scalars.dryRun);
};

const readCurrentCapacitySettings = async (): Promise<CurrentCapacitySettings> => {
  const [
    limit, margin, dryRun, periodMinutes, capacityEnabled, gridImportEnabled, gridImportLimitKw,
  ] = await Promise.all([
    getSetting(CAPACITY_LIMIT_KW),
    getSetting(CAPACITY_MARGIN_KW),
    getSetting(CAPACITY_DRY_RUN),
    getSetting(CAPACITY_PERIOD_MINUTES),
    getSetting(CAPACITY_ENABLED),
    getSetting(GRID_IMPORT_ENABLED),
    getSetting(GRID_IMPORT_LIMIT_KW),
  ]);
  return { limit, margin, dryRun, periodMinutes, capacityEnabled, gridImportEnabled, gridImportLimitKw };
};

const resolveCapacitySettingsCommand = (
  current: CurrentCapacitySettings,
  command: CapacitySettingsCommand,
): CapacityScalarSettings => {
  const persisted = resolveCapacityScalars(current, lastGoodCapacityScalars);
  return command.kind === 'limits'
    ? {
      ...persisted,
      capacityEnabled: command.capacityEnabled,
      gridImportLimitKw: command.gridImportLimitKw,
      limitKw: command.limitKw,
      marginKw: command.marginKw,
      dryRun: persisted.dryRun,
      periodMinutes: command.periodMinutes,
    }
    : { ...persisted, dryRun: command.dryRun };
};

type CapacityPowerRead =
  | { state: 'resolved'; payload: SettingsUiPowerPayload }
  | { state: 'unavailable' };

const readCapacityPowerModel = async (): Promise<CapacityPowerRead> => {
  try {
    return { state: 'resolved', payload: await getPowerReadModel() };
  } catch (caught) {
    await logSettingsError('Failed to load runtime capacity state', caught, 'capacity');
    return { state: 'unavailable' };
  }
};

// Last readings fact handed to the banner, so a settings load that resolves
// AFTER the first power read can re-render the copy without refetching power.
// undefined = the banner has never rendered.
let lastBannerReadings: PowerReadingsFact | undefined;
// A never-received fact always resolves banner content; this only keeps the type honest.
const NO_READINGS_YET_FALLBACK = 'No power readings yet.';
// Newer loads supersede the entire older snapshot. Power-source saves have a
// narrower generation: they fence stale source-dependent paint without
// discarding unrelated capacity values read from a realtime refresh.
let capacitySettingsLoadGeneration = 0;
let capacitySettingsAppliedGeneration = 0;
let capacitySettingsMutationRevision = 0;
let powerSourcePaintGeneration = 0;
let confirmedPowerSourcePaintGeneration = 0;

export const supersedeCapacityPowerSourcePaints = (): number => {
  powerSourcePaintGeneration += 1;
  return confirmedPowerSourcePaintGeneration;
};

export const hasConfirmedPowerSourcePaintSince = (generation: number): boolean => (
  confirmedPowerSourcePaintGeneration !== generation
);

const recordConfirmedPowerSourcePaint = (powerSource: unknown): void => {
  if (powerSource === 'flow' || powerSource === 'homey_energy') {
    confirmedPowerSourcePaintGeneration += 1;
  }
};

const updateStaleDataBanner = (readings: PowerReadingsFact) => {
  lastBannerReadings = readings;
  const content = resolvePowerReadingsBannerContent({
    readings,
    nowMs: Date.now(),
    planUnmeasured: isPlanUnmeasured(),
    // The select mirrors the persisted source (and a drafted Homey Energy
    // switch, where the picker hint is exactly right).
    source: normalizePowerSource(settingsPowerSourceSelect?.value),
    meterChosen: hasChosenWholeHomeMeter(),
  });
  // The setup path's Power meter step says this same sentence where it stands
  // in for the banner, so it is handed the banner's words rather than its own.
  publishSetupPower(readings.state === 'never'
    ? { state: 'never', remedy: content?.text ?? NO_READINGS_YET_FALLBACK }
    : { state: 'received' });
  if (!staleDataBanner) return;
  staleDataBanner.hidden = content === null || isNoReadingsCarriedBySetupPath(hasMeterAreas === false);
  if (content === null) return;
  if (staleDataBannerText) staleDataBannerText.textContent = content.text;
  if (staleDataBannerAction) staleDataBannerAction.textContent = content.actionLabel;
};

export const refreshStaleDataBanner = (): void => {
  if (lastBannerReadings !== undefined) updateStaleDataBanner(lastBannerReadings);
};
// The plan render reports whether the current plan was measured; a flip
// re-renders the banner at once rather than on the next refresh tick.
onPlanMeasurementChange(refreshStaleDataBanner);
// Both global banners stand down where the setup path card speaks for them, and
// the facts that decide it (the device list above all) land after the first
// banner sync, so re-judge whenever the path moves.
onSetupPathChange(() => {
  syncDryRunBannerVisibility();
  refreshStaleDataBanner();
});

export const loadStaleDataStatus = async () => {
  const read = await readCapacityPowerModel();
  if (read.state === 'unavailable') {
    publishSetupPowerUnavailable();
    publishSetupHardCapUnavailable();
    return;
  }
  const power = read.payload;
  renderMonthlyQuarterPeak(power.capacityPeak);
  // Producer-resolved fact, classified ONCE at this transport seam (the GET
  // response is untrusted): a junk payload keeps the last-known fact rather
  // than fabricating `never` — and before any render, resolves to `never`.
  const fact = classifyPowerReadingsFact(power.readings);
  if (fact !== null) updateStaleDataBanner(fact);
  else if (lastBannerReadings !== undefined) refreshStaleDataBanner();
  else publishSetupPowerUnavailable();
  if (power.hardCapConfiguration.state === 'resolved' && power.capacityScalars.state === 'resolved') {
    publishSetupHardCapRead(power.hardCapConfiguration.configured, power.capacityScalars.scalars);
  } else {
    publishSetupHardCapUnavailable();
  }
};

export const updateStaleDataStatusFromPowerPayload = (power: SettingsUiPowerPayload | null) => {
  // The payload may be a realtime push (an untrusted transport): classify the
  // fact once here. A push carrying no valid fact keeps the last-known one —
  // it must never fabricate `never` over a real stamp.
  const fact = classifyPowerReadingsFact(power?.readings);
  if (fact !== null) updateStaleDataBanner(fact);
  else refreshStaleDataBanner();
};

const syncLoadedPowerSource = (powerSource: unknown): void => {
  const sourceResolved = powerSource === 'flow' || powerSource === 'homey_energy';
  if (sourceResolved) {
    if (settingsPowerSourceSelect) settingsPowerSourceSelect.value = powerSource;
    syncHomeyEnergyMeterVisibility(powerSource);
    recordConfirmedPowerSourcePaint(powerSource);
    return;
  }
  // An unavailable read preserves the last-good source paint instead of
  // fabricating Flow over a save rollback or another WebView's write.
};

const syncLoadedPowerSourceForGeneration = (
  sourceGeneration: number,
  powerSource: unknown,
): void => {
  if (sourceGeneration === powerSourcePaintGeneration) syncLoadedPowerSource(powerSource);
};

export const loadCapacitySettings = async () => {
  capacitySettingsLoadGeneration += 1;
  const generation = capacitySettingsLoadGeneration;
  const mutationRevision = capacitySettingsMutationRevision;
  const sourceGeneration = powerSourcePaintGeneration;
  // Publish the home scope first and independently. A transient roster/marker
  // read failure must narrow the banner to Main even if another settings read
  // later rejects and aborts the rest of the capacity refresh.
  await refreshDryRunBannerHomeScope();
  const current = await readCurrentCapacitySettings();
  // The power payload carries two runtime-owned facts settings values cannot
  // establish: last-good running scalars and whether the hard-cap key exists.
  const powerRead = await readCapacityPowerModel();
  const powerSource = await getSetting(POWER_SOURCE);
  const meterDeviceId = await getSetting(HOMEY_ENERGY_METER_DEVICE_ID);
  // Persisted first, then the running app's own block, then the last good.
  const runtime = powerRead.state === 'resolved'
    ? powerRead.payload.capacityScalars
    : { state: 'unavailable' } as const;
  const resolved = resolveCapacityScalars(
    current,
    runtime.state === 'resolved' ? runtime.scalars : lastGoodCapacityScalars,
  );
  // Only a successfully completed newer load supersedes this snapshot. A load
  // that merely STARTED later but failed must not discard valid settings with
  // no remaining refresh guaranteed.
  if (generation < capacitySettingsAppliedGeneration || mutationRevision !== capacitySettingsMutationRevision) return;
  capacitySettingsAppliedGeneration = generation;
  if (settingsGridImportLimitInput && isValidGridImportLimitKw(current.gridImportLimitKw)) {
    settingsGridImportLimitInput.value = String(current.gridImportLimitKw);
  }
  syncCapacityOwnedControls(resolved);
  // Meter selection is independently persisted. A power-source save may fence
  // source-owned paint while this load is in flight, but it must not discard a
  // concurrent Whole-home meter refresh that this snapshot already read.
  const trimmedMeterId = typeof meterDeviceId === 'string' ? meterDeviceId.trim() : '';
  syncHomeyEnergyMeterSelection(trimmedMeterId === '' ? null : trimmedMeterId);
  syncLoadedPowerSourceForGeneration(sourceGeneration, powerSource);
  const dryRunChanged = state.dryRun !== resolved.dryRun;
  commitCapacityScalars(resolved);
  if (powerRead.state === 'resolved') {
    const configuration = powerRead.payload.hardCapConfiguration;
    if (configuration.state === 'resolved') publishSetupHardCapRead(configuration.configured, resolved);
    else publishSetupHardCapUnavailable();
    renderMonthlyQuarterPeak(powerRead.payload.capacityPeak);
  } else publishSetupHardCapUnavailable();
  syncDryRunBannerVisibility();
  syncSettingsHubChips();
  // The banner may already have rendered from the template's defaults while
  // this load was in flight (the boot-time power read runs in parallel):
  // re-render it against the source and meter selection just painted. No-op
  // until the first power read has handed the banner a timestamp.
  refreshStaleDataBanner();
  // Refresh house-level framing from the newly loaded posture. The settings
  // event router separately refetches producer-owned device statuses.
  if (dryRunChanged) refreshPlanSurface();
};

const writeCapacitySettingsCommand = async (
  current: CurrentCapacitySettings,
  resolved: CapacityScalarSettings,
  command: CapacitySettingsCommand,
): Promise<void> => {
  const writes: Array<Promise<void>> = [];
  if (command.kind === 'limits') {
    // Persist the threshold before enabling it; keep a configured grid limit in place
    // before disabling capacity control during a switch between the two constraints.
    if (resolved.gridImportLimitKw !== null && current.gridImportLimitKw !== resolved.gridImportLimitKw) {
      await setSetting(GRID_IMPORT_LIMIT_KW, resolved.gridImportLimitKw);
    }
    if (current.gridImportEnabled !== (resolved.gridImportLimitKw !== null)) {
      await setSetting(GRID_IMPORT_ENABLED, resolved.gridImportLimitKw !== null);
    }
    pushSettingWriteIfChanged(writes, CAPACITY_ENABLED, current.capacityEnabled, resolved.capacityEnabled);
    pushSettingWriteIfChanged(writes, CAPACITY_LIMIT_KW, current.limit, resolved.limitKw);
    pushSettingWriteIfChanged(writes, CAPACITY_MARGIN_KW, current.margin, resolved.marginKw);
    pushSettingWriteIfChanged(writes, CAPACITY_PERIOD_MINUTES, current.periodMinutes, resolved.periodMinutes);
  } else {
    pushSettingWriteIfChanged(writes, CAPACITY_DRY_RUN, current.dryRun, resolved.dryRun);
  }
  // Never power_source: a hard-cap/margin/simulation save must not materialize
  // the 'flow' default for a user who never chose a source, and the select's
  // own change goes through the guarded seam (`savePowerSourceSetting`).
  const results = await Promise.allSettled(writes);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
};

const saveCapacitySettingsCommand = async (
  command: CapacitySettingsCommand,
  successMessage = 'Capacity settings saved.',
) => {
  capacitySettingsMutationRevision += 1;
  const current = await readCurrentCapacitySettings();
  const resolved = resolveCapacitySettingsCommand(current, command);
  validatePowerLimitSettings(resolved);

  try {
    await writeCapacitySettingsCommand(current, resolved, command);
  } catch (caught) {
    // Started writes have settled. Reconcile partial successes before the next
    // queued save can start; keep the typed fields available for correction.
    invalidateApiCache(SETTINGS_UI_POWER_PATH);
    const powerRead = await readCapacityPowerModel();
    if (powerRead.state === 'resolved' && powerRead.payload.capacityScalars.state === 'resolved') {
      const effective = powerRead.payload.capacityScalars.scalars;
      commitCapacityScalars(effective);
      syncPowerLimitSwitches(effective);
      syncDryRunBannerVisibility();
      syncSettingsHubChips();
    }
    throw caught;
  }
  // A save commits only the fields named by its command. Another save or a
  // realtime settings refresh may have established newer values for the other
  // fields while these writes were in flight; merge into that latest trusted
  // snapshot rather than restoring the pre-write read.
  const committed = command.kind === 'limits'
    ? {
      ...lastGoodCapacityScalars,
      capacityEnabled: resolved.capacityEnabled,
      gridImportLimitKw: resolved.gridImportLimitKw,
      limitKw: resolved.limitKw,
      marginKw: resolved.marginKw,
      periodMinutes: resolved.periodMinutes,
    }
    : { ...lastGoodCapacityScalars, dryRun: resolved.dryRun };
  const dryRunChanged = state.dryRun !== committed.dryRun;
  commitCapacityScalars(committed);
  if (command.kind === 'limits') {
    publishSetupHardCapRead(true, committed);
    syncCapacityLimitControls(committed);
  } else {
    syncSimulationModeControl(committed.dryRun);
  }
  syncDryRunBannerVisibility();
  syncSettingsHubChips();
  // Refresh house-level framing after the save. The settings event router
  // invalidates and refetches producer-owned device statuses.
  if (dryRunChanged) refreshPlanSurface();
  await showToast(successMessage, 'ok');
};

let limitsSaveQueue: Promise<void> = Promise.resolve();

export const saveSettingsLimitsSettings = async () => {
  try {
    const command: CapacitySettingsCommand = { kind: 'limits', ...readPowerLimitSettings(lastGoodCapacityScalars) };
    const save = limitsSaveQueue.then(() => saveCapacitySettingsCommand(command, 'Limits & safety saved.'));
    limitsSaveQueue = save.catch(() => undefined);
    await save;
  } catch (caught) {
    // A failed save must not leave a switch claiming a different control posture.
    syncPowerLimitSwitches(lastGoodCapacityScalars);
    throw caught;
  }
};

export const saveSimulationModeSettings = async (
  enabled = settingsSimulationModeInput ? settingsSimulationModeInput.selected : true,
) => {
  await saveCapacitySettingsCommand({
    kind: 'simulation',
    dryRun: enabled,
  }, 'Simulation mode updated.');
};

export const loadAdvancedSettings = async () => {
  const [topicsRaw, legacyEnabled] = await Promise.all([
    getSetting(DEBUG_LOGGING_TOPICS),
    getSetting('debug_logging_enabled'),
  ]);
  let enabledTopics = normalizeDebugLoggingTopics(topicsRaw);
  if (enabledTopics.length === 0 && legacyEnabled === true) {
    enabledTopics = [...ALL_DEBUG_LOGGING_TOPICS];
  }
  const { matched, unmatched } = topicsToScenarioIds(enabledTopics);
  const matchedSet = new Set<DebugLoggingScenarioId>(matched);
  document.querySelectorAll<MdSwitchElement>('[data-debug-scenario]').forEach((input) => {
    const el = input;
    const scenarioId = el.dataset.debugScenario;
    el.selected = isDebugLoggingScenarioId(scenarioId) && matchedSet.has(scenarioId);
  });
  const mount = document.getElementById('debug-logging-checkboxes');
  if (mount) renderLegacyTopicsHint(mount, unmatched);
};
