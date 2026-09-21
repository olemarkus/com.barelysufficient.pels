import { syncSettingsHubChips } from './settingsHubChips.ts';
import {
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
  settingsCapacityPeriodSelect,
  settingsCapacityMarginAlert,
  settingsCapacityMonthlyPeak,
  settingsCapacityMonthlyPeakValue,
  settingsCapacityReactionHint,
  settingsPowerSourceSelect,
  settingsSimulationModeInput,
  dryRunBanner,
  dryRunBannerText,
  simulationDisableButton,
  type MdSwitchElement,
  type MdFilledTextFieldElement,
  staleDataBanner,
  staleDataBannerText,
  staleDataBannerAction,
} from './dom.ts';
import { getSetting } from './homey.ts';
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
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  DEBUG_LOGGING_TOPICS,
  HOMEY_ENERGY_METER_DEVICE_ID,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  POWER_SOURCE,
} from '../../../contracts/src/settingsKeys.ts';
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
import { usableCapacityKw } from '../../../shared-domain/src/capacityAllowance.ts';
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
import { isFiniteNumber } from './combinedPrices.ts';

export type PowerSource = 'flow' | 'homey_energy';

type CapacitySettingsCommand =
  | {
    kind: 'limits';
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
};


// Mirrors the runtime snapshot's lifecycle: simulation is the boot default,
// then only a resolved read or successful save replaces it.
let lastGoodCapacityScalars: CapacityScalarSettings = {
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

const updateCapacityReactionHint = (limit: number, margin: number) => {
  if (!settingsCapacityReactionHint) return;
  // The result row's static label ("With these settings, safe pace starts each period at")
  // frames this as a ceiling derived from the current inputs, not an absolute
  // "safe pace now" — that live value is the Overview hero's job and can differ
  // when today's daily budget is the tighter constraint. This element carries
  // only the loud accent value so the two surfaces never contradict.
  const reactionAt = usableCapacityKw(limit, margin).toFixed(1);
  settingsCapacityReactionHint.textContent = `${reactionAt} kW`;
};

export const MARGIN_NOT_BELOW_LIMIT_MESSAGE
  = 'Safety margin must be less than the hard cap. Lower the margin to continue.';

// Stays silent when either number is empty or non-finite so partially-typed
// values don't flash an error mid-edit.
const getMarginVsLimitError = (limit: number, margin: number): string | null => {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(margin) || margin < 0) return null;
  if (margin >= limit) return MARGIN_NOT_BELOW_LIMIT_MESSAGE;
  return null;
};

const renderMarginAlert = (message: string | null) => {
  if (!settingsCapacityMarginAlert) return;
  settingsCapacityMarginAlert.textContent = message ?? '';
  settingsCapacityMarginAlert.hidden = message === null;
};

export const refreshLimitsValidationHints = () => {
  const limit = Number.parseFloat(settingsCapacityLimitInput?.value ?? '');
  const margin = Number.parseFloat(settingsCapacityMarginInput?.value ?? '');
  renderMarginAlert(getMarginVsLimitError(limit, margin));
};

const syncCapacityLimitControls = (scalars: CapacityScalarSettings) => {
  const { limitKw, marginKw, periodMinutes } = scalars;
  if (settingsCapacityLimitInput) {
    settingsCapacityLimitInput.value = limitKw.toString();
  }
  if (settingsCapacityMarginInput) {
    settingsCapacityMarginInput.value = marginKw.toString();
  }
  if (settingsCapacityPeriodSelect) settingsCapacityPeriodSelect.value = String(periodMinutes);
  if (settingsCapacityMonthlyPeak) settingsCapacityMonthlyPeak.hidden = periodMinutes !== 15;
  updateCapacityReactionHint(limitKw, marginKw);
  renderMarginAlert(getMarginVsLimitError(limitKw, marginKw));
};

const syncSimulationModeControl = (dryRun: boolean): void => {
  if (settingsSimulationModeInput) settingsSimulationModeInput.selected = dryRun;
};

const syncCapacityOwnedControls = (scalars: CapacityScalarSettings): void => {
  syncCapacityLimitControls(scalars);
  syncSimulationModeControl(scalars.dryRun);
};

const readNumberInput = (input: MdFilledTextFieldElement | null, label: string): number => {
  const value = parseFloat(input?.value ?? '');
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
  return value;
};

const readCurrentCapacitySettings = async (): Promise<CurrentCapacitySettings> => {
  const [limit, margin, dryRun, periodMinutes] = await Promise.all([
    getSetting(CAPACITY_LIMIT_KW),
    getSetting(CAPACITY_MARGIN_KW),
    getSetting(CAPACITY_DRY_RUN),
    getSetting(CAPACITY_PERIOD_MINUTES),
  ]);
  return { limit, margin, dryRun, periodMinutes };
};

const resolveCapacitySettingsCommand = (
  current: CurrentCapacitySettings,
  command: CapacitySettingsCommand,
): CapacityScalarSettings => {
  const persisted = resolveCapacityScalars(current, lastGoodCapacityScalars);
  return command.kind === 'limits'
    ? {
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

const validateCapacitySettings = ({ limitKw: limit, marginKw: margin }: CapacityScalarSettings) => {
  // Validate limit: must be a finite positive number within reasonable bounds.
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Hard cap must be positive.');
  if (limit > 1000) throw new Error('Hard cap cannot exceed 1000 kW.');

  // Validate margin: must be a finite non-negative number within reasonable bounds.
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Safety margin must be non-negative.');
  if (margin >= limit) {
    renderMarginAlert(MARGIN_NOT_BELOW_LIMIT_MESSAGE);
    throw new Error(MARGIN_NOT_BELOW_LIMIT_MESSAGE);
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
  const {
    limit, margin, dryRun, periodMinutes,
  } = await readCurrentCapacitySettings();
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
    { limit, margin, dryRun, periodMinutes },
    runtime.state === 'resolved' ? runtime.scalars : lastGoodCapacityScalars,
  );
  // Only a successfully completed newer load supersedes this snapshot. A load
  // that merely STARTED later but failed must not discard valid settings with
  // no remaining refresh guaranteed.
  if (generation < capacitySettingsAppliedGeneration || mutationRevision !== capacitySettingsMutationRevision) return;
  capacitySettingsAppliedGeneration = generation;
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
  // An external simulation-mode change (e.g. a second open WebView, or a Flow)
  // reaches here via the realtime settings.set handler. Re-render the overview
  // so the hero decision sentence and device-card "(simulation)" framing flip
  // with the banner, not on the next plan/power push. (Safe no-op before the
  // plan surface renderer is registered — e.g. the first boot load.)
  if (dryRunChanged) refreshPlanSurface();
};

const saveCapacitySettingsCommand = async (
  command: CapacitySettingsCommand,
  successMessage = 'Capacity settings saved.',
) => {
  capacitySettingsMutationRevision += 1;
  const current = await readCurrentCapacitySettings();
  const resolved = resolveCapacitySettingsCommand(current, command);
  validateCapacitySettings(resolved);

  const writes: Array<Promise<void>> = [];
  if (command.kind === 'limits') {
    pushSettingWriteIfChanged(writes, CAPACITY_LIMIT_KW, current.limit, resolved.limitKw);
    pushSettingWriteIfChanged(writes, CAPACITY_MARGIN_KW, current.margin, resolved.marginKw);
    pushSettingWriteIfChanged(writes, CAPACITY_PERIOD_MINUTES, current.periodMinutes, resolved.periodMinutes);
  } else {
    pushSettingWriteIfChanged(writes, CAPACITY_DRY_RUN, current.dryRun, resolved.dryRun);
  }
  // Never power_source: a hard-cap/margin/simulation save must not materialize
  // the 'flow' default for a user who never chose a source, and the select's
  // own change goes through the guarded seam (`savePowerSourceSetting`).
  if (writes.length > 0) {
    await Promise.all(writes);
  }
  // A save commits only the fields named by its command. Another save or a
  // realtime settings refresh may have established newer values for the other
  // fields while these writes were in flight; merge into that latest trusted
  // snapshot rather than restoring the pre-write read.
  const committed = command.kind === 'limits'
    ? {
      ...lastGoodCapacityScalars,
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
  // Toggling simulation flips the hero decision sentence and the device-card
  // "(simulation)" hypothetical framing. Re-render the overview now so they flip
  // together with the banner instead of staying stale until the next realtime
  // push (~10s on homey_energy, longer on flow).
  if (dryRunChanged) refreshPlanSurface();
  await showToast(successMessage, 'ok');
};

export const saveSettingsLimitsSettings = async () => {
  await saveCapacitySettingsCommand({
    kind: 'limits',
    limitKw: readNumberInput(settingsCapacityLimitInput, 'Hard cap'),
    marginKw: readNumberInput(settingsCapacityMarginInput, 'Safety margin'),
    periodMinutes: resolveCapacityPeriodMinutes(
      Number(settingsCapacityPeriodSelect?.value),
      lastGoodCapacityScalars.periodMinutes,
    ),
  }, 'Limits & safety saved.');
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
