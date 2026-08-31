import { syncSettingsHubChips } from './settingsHubChips.ts';
import {
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
  settingsCapacityMarginAlert,
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
  DEBUG_LOGGING_TOPICS,
  HOMEY_ENERGY_METER_DEVICE_ID,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  POWER_SOURCE,
} from '../../../contracts/src/settingsKeys.ts';
import {
  isHomeyEnergyMeterExplicit,
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
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../../shared-domain/src/powerFreshness.ts';
import { usableCapacityKw } from '../../../shared-domain/src/capacityAllowance.ts';
import {
  resolveSimulationBannerContent,
  type SimulationBannerScope,
} from '../../../shared-domain/src/simulationPosture.ts';
import { syncSimulationHomeScopeNote } from './simulationScopeNote.ts';
import type { SettingsUiPowerPayload } from '../../../contracts/src/settingsUiApi.ts';
import { logSettingsError } from './logging.ts';
import { showToast } from './toast.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import { refreshPlanSurface } from './planSurfaceRefresh.ts';
import { liveStatusOrNull } from './powerStatusRead.ts';

export type PowerSource = 'flow' | 'homey_energy';

type CapacitySettingsPatch = {
  limit?: number;
  margin?: number;
  dryRun?: boolean;
};

type CurrentCapacitySettings = {
  limit: unknown;
  margin: unknown;
  dryRun: unknown;
};

type ResolvedCapacitySettings = {
  limit: number;
  margin: number;
  dryRun: boolean;
};

// Mirrors the runtime snapshot's lifecycle: simulation is the boot default,
// then only a resolved boolean read or successful save replaces it.
let lastGoodCapacityDryRun = true;
let lastGoodCapacityLimit = 10;
let lastGoodCapacityMargin = 0.2;

const commitCapacityScalars = (limit: number, margin: number, dryRun: boolean): void => {
  lastGoodCapacityLimit = limit;
  lastGoodCapacityMargin = margin;
  lastGoodCapacityDryRun = dryRun;
  state.dryRun = dryRun;
};

const resolveMainCapacityNumber = (
  persisted: unknown,
  runtimeEffective: unknown,
  lastGood: number,
): number => {
  if (typeof persisted === 'number' && Number.isFinite(persisted)) return persisted;
  if (typeof runtimeEffective === 'number' && Number.isFinite(runtimeEffective)) return runtimeEffective;
  return lastGood;
};

const needsRuntimeCapacityScalars = (
  limit: unknown,
  margin: unknown,
  dryRun: unknown,
): boolean => (
  typeof limit !== 'number'
  || !Number.isFinite(limit)
  || typeof margin !== 'number'
  || !Number.isFinite(margin)
  || typeof dryRun !== 'boolean'
);

const resolveMainDryRun = (
  persisted: unknown,
  runtimeEffective: unknown,
  lastGood: boolean,
): boolean => {
  if (typeof persisted === 'boolean') return persisted;
  if (typeof runtimeEffective === 'boolean') return runtimeEffective;
  return lastGood;
};

export const normalizePowerSource = (raw: unknown): PowerSource => (
  raw === 'homey_energy' ? 'homey_energy' : 'flow'
);

// Exported pure for tests; the meterSelected branch points at the explicitly
// selected meter instead of Homey Energy's whole-home marking.
export const resolveStaleDataHint = (source: string | undefined, meterSelected: boolean): string => {
  if (source === 'homey_energy') {
    return meterSelected
      ? 'Check that the selected whole-home meter is available and reporting power in Homey Energy.'
      // No meter chosen yet (a drafted source switch, or a legacy shape the
      // boot migration deferred on): the remedy is the picker, not Homey.
      : 'Pick a whole-home meter under Limits & safety.';
  }
  return 'Check your Flow that reports power usage.';
};

const getStaleDataHint = (): string => (
  resolveStaleDataHint(settingsPowerSourceSelect?.value, isHomeyEnergyMeterExplicit())
);

export type StaleDataBannerContent = { text: string; actionLabel: string };

// Exported pure for tests. The runtime never writes a default `power_source`,
// so an absent setting plus no sample ever received means a fresh install where
// the user hasn't chosen where PELS reads power from — that state gets
// onboarding copy instead of a "check your Flow" hint about a Flow that was
// never set up. Returns null when the banner should hide (fresh data).
export const resolveStaleDataBannerContent = (input: {
  lastPowerUpdate: number | null;
  nowMs: number;
  powerSourceConfigured: boolean;
  hint: string;
}): StaleDataBannerContent | null => {
  if (input.lastPowerUpdate === null) {
    if (!input.powerSourceConfigured) {
      return {
        text: 'No power data yet. PELS needs to know where to read your home’s power usage.',
        actionLabel: 'Choose power source',
      };
    }
    return {
      text: `No power data received yet. ${input.hint}`,
      actionLabel: 'Check power source',
    };
  }
  if ((input.nowMs - input.lastPowerUpdate) <= POWER_SAMPLE_STALE_THRESHOLD_MS) return null;
  return {
    text: `No power data received in the last minute. ${input.hint}`,
    actionLabel: 'Check power source',
  };
};

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
      || isSimulationBannerSuppressedOnPanel(content.scope, state.activePanel);
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
  // The result row's static label ("With these settings, safe pace starts each hour at")
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

const syncCapacityOwnedControls = (
  limit: number,
  margin: number,
  isDryRun: boolean,
) => {
  if (settingsCapacityLimitInput) {
    settingsCapacityLimitInput.value = limit.toString();
  }
  if (settingsCapacityMarginInput) {
    settingsCapacityMarginInput.value = margin.toString();
  }
  if (settingsSimulationModeInput) {
    settingsSimulationModeInput.selected = isDryRun;
  }
  updateCapacityReactionHint(limit, margin);
  renderMarginAlert(getMarginVsLimitError(limit, margin));
};

const readNumberInput = (input: MdFilledTextFieldElement | null, label: string): number => {
  const value = parseFloat(input?.value ?? '');
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
  return value;
};

const readCurrentCapacitySettings = async (): Promise<CurrentCapacitySettings> => {
  const [limit, margin, dryRun] = await Promise.all([
    getSetting(CAPACITY_LIMIT_KW),
    getSetting(CAPACITY_MARGIN_KW),
    getSetting(CAPACITY_DRY_RUN),
  ]);
  return { limit, margin, dryRun };
};

const resolveCapacitySettings = (
  current: CurrentCapacitySettings,
  patch: CapacitySettingsPatch,
): ResolvedCapacitySettings => ({
  limit: patch.limit ?? resolveMainCapacityNumber(current.limit, undefined, lastGoodCapacityLimit),
  margin: patch.margin ?? resolveMainCapacityNumber(current.margin, undefined, lastGoodCapacityMargin),
  // The runtime retains its validated in-memory posture when the persisted
  // key is absent or malformed. Mirror that last-good value so an unset never
  // makes the WebView claim simulation while the current runtime remains live.
  dryRun: patch.dryRun ?? (
    typeof current.dryRun === 'boolean' ? current.dryRun : lastGoodCapacityDryRun
  ),
});

const validateCapacitySettings = ({ limit, margin }: ResolvedCapacitySettings) => {
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

// null = not yet loaded. Treated as configured so a returning user with stale
// data never flashes the fresh-install copy while settings are still loading.
let powerSourceConfigured: boolean | null = null;
// Last value handed to the banner, so a settings load that resolves AFTER the
// first power read can re-render the copy without refetching power. undefined
// = the banner has never rendered.
let lastBannerPowerUpdate: number | null | undefined;
// Newer loads supersede the entire older snapshot. Power-source saves have a
// narrower generation: they fence stale source-dependent paint without
// discarding unrelated capacity values read from a realtime refresh.
let capacitySettingsLoadGeneration = 0;
let capacitySettingsAppliedGeneration = 0;
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

const updateStaleDataBanner = (lastPowerUpdate: number | null) => {
  lastBannerPowerUpdate = lastPowerUpdate;
  if (!staleDataBanner) return;
  const content = resolveStaleDataBannerContent({
    lastPowerUpdate,
    nowMs: Date.now(),
    powerSourceConfigured: powerSourceConfigured !== false,
    hint: getStaleDataHint(),
  });
  staleDataBanner.hidden = content === null;
  if (content === null) return;
  if (staleDataBannerText) staleDataBannerText.textContent = content.text;
  if (staleDataBannerAction) staleDataBannerAction.textContent = content.actionLabel;
};

export const setPowerSourceConfigured = (configured: boolean) => {
  if (powerSourceConfigured === configured) return;
  powerSourceConfigured = configured;
  if (lastBannerPowerUpdate !== undefined) updateStaleDataBanner(lastBannerPowerUpdate);
};

export const refreshStaleDataBanner = (): void => {
  if (lastBannerPowerUpdate !== undefined) updateStaleDataBanner(lastBannerPowerUpdate);
};

const resolveLastPowerUpdate = (power: SettingsUiPowerPayload): number | null => {
  const trackerTimestamp = power.tracker?.lastTimestamp;
  if (typeof trackerTimestamp === 'number' && Number.isFinite(trackerTimestamp)) {
    return trackerTimestamp;
  }
  const statusTimestamp = liveStatusOrNull(power.status)?.lastPowerUpdate;
  return typeof statusTimestamp === 'number' && Number.isFinite(statusTimestamp) ? statusTimestamp : null;
};

export const loadStaleDataStatus = async () => {
  const power = await getPowerReadModel();
  updateStaleDataBanner(resolveLastPowerUpdate(power));
};

export const updateStaleDataStatusFromPowerPayload = (power: SettingsUiPowerPayload | null) => {
  updateStaleDataBanner(power ? resolveLastPowerUpdate(power) : null);
};

const syncLoadedPowerSource = (powerSource: unknown): void => {
  const sourceResolved = powerSource === 'flow' || powerSource === 'homey_energy';
  if (sourceResolved) {
    setPowerSourceConfigured(true);
    if (settingsPowerSourceSelect) settingsPowerSourceSelect.value = powerSource;
    syncHomeyEnergyMeterVisibility(powerSource);
    recordConfirmedPowerSourcePaint(powerSource);
    return;
  }
  if (powerSourceConfigured === null) {
    // First load with no configured source: keep the template's Flow default
    // but mark it as onboarding, not persisted truth. After any confirmed
    // paint, an unavailable read preserves that last-good source instead of
    // fabricating Flow over a save rollback or another WebView's write.
    setPowerSourceConfigured(false);
  }
};

export const loadCapacitySettings = async () => {
  capacitySettingsLoadGeneration += 1;
  const generation = capacitySettingsLoadGeneration;
  const sourceGeneration = powerSourcePaintGeneration;
  // Publish the home scope first and independently. A transient roster/marker
  // read failure must narrow the banner to Main even if another settings read
  // later rejects and aborts the rest of the capacity refresh.
  await refreshDryRunBannerHomeScope();
  const limit = await getSetting(CAPACITY_LIMIT_KW);
  const margin = await getSetting(CAPACITY_MARGIN_KW);
  const dryRun = await getSetting(CAPACITY_DRY_RUN);
  // Missing persisted keys are not Main-home defaults: the running app keeps
  // its last-good scalars. The bootstrap-primed whole-home power snapshot
  // carries that authoritative in-memory state across a WebView reload.
  const runtimeScalars = needsRuntimeCapacityScalars(limit, margin, dryRun)
    ? await getPowerReadModel()
    : null;
  const powerSource = await getSetting(POWER_SOURCE);
  const meterDeviceId = await getSetting(HOMEY_ENERGY_METER_DEVICE_ID);
  const normalizedLimit = resolveMainCapacityNumber(
    limit,
    runtimeScalars?.mainCapacityScalars?.limitKw,
    lastGoodCapacityLimit,
  );
  const normalizedMargin = resolveMainCapacityNumber(
    margin,
    runtimeScalars?.mainCapacityScalars?.marginKw,
    lastGoodCapacityMargin,
  );
  const isDryRun = resolveMainDryRun(
    dryRun,
    runtimeScalars?.mainDryRunEffective,
    lastGoodCapacityDryRun,
  );
  // Only a successfully completed newer load supersedes this snapshot. A load
  // that merely STARTED later but failed must not discard valid settings with
  // no remaining refresh guaranteed.
  if (generation < capacitySettingsAppliedGeneration) return;
  capacitySettingsAppliedGeneration = generation;
  syncCapacityOwnedControls(normalizedLimit, normalizedMargin, isDryRun);
  // Meter selection is independently persisted. A power-source save may fence
  // source-owned paint while this load is in flight, but it must not discard a
  // concurrent Whole-home meter refresh that this snapshot already read.
  const trimmedMeterId = typeof meterDeviceId === 'string' ? meterDeviceId.trim() : '';
  syncHomeyEnergyMeterSelection(trimmedMeterId === '' ? null : trimmedMeterId);
  if (sourceGeneration === powerSourcePaintGeneration) {
    syncLoadedPowerSource(powerSource);
  }
  const dryRunChanged = state.dryRun !== isDryRun;
  commitCapacityScalars(normalizedLimit, normalizedMargin, isDryRun);
  syncDryRunBannerVisibility();
  syncSettingsHubChips();
  // An external simulation-mode change (e.g. a second open WebView, or a Flow)
  // reaches here via the realtime settings.set handler. Re-render the overview
  // so the hero decision sentence and device-card "(simulation)" framing flip
  // with the banner, not on the next plan/power push. (Safe no-op before the
  // plan surface renderer is registered — e.g. the first boot load.)
  if (dryRunChanged) refreshPlanSurface();
};

const saveCapacitySettingsPatch = async (
  patch: CapacitySettingsPatch,
  successMessage = 'Capacity settings saved.',
) => {
  const current = await readCurrentCapacitySettings();
  const { limit, margin, dryRun } = resolveCapacitySettings(current, patch);
  validateCapacitySettings({ limit, margin, dryRun });

  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(writes, CAPACITY_LIMIT_KW, current.limit, limit);
  pushSettingWriteIfChanged(writes, CAPACITY_MARGIN_KW, current.margin, margin);
  pushSettingWriteIfChanged(writes, CAPACITY_DRY_RUN, current.dryRun, dryRun);
  // Never power_source: a hard-cap/margin/simulation save must not materialize
  // the 'flow' default for a user who never chose a source, and the select's
  // own change goes through the guarded seam (`savePowerSourceSetting`).
  if (writes.length > 0) {
    await Promise.all(writes);
  }
  const dryRunChanged = current.dryRun !== dryRun;
  commitCapacityScalars(limit, margin, dryRun);
  // This save owns only cap, margin and simulation. In particular it must not
  // repaint the Power source from its pre-write read: a source save can overlap
  // this awaited settings write and owns that control's final value.
  syncCapacityOwnedControls(limit, margin, dryRun);
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
  await saveCapacitySettingsPatch({
    limit: readNumberInput(settingsCapacityLimitInput, 'Hard cap'),
    margin: readNumberInput(settingsCapacityMarginInput, 'Safety margin'),
  }, 'Limits & safety saved.');
};

export const saveSimulationModeSettings = async (
  enabled = settingsSimulationModeInput ? settingsSimulationModeInput.selected : true,
) => {
  await saveCapacitySettingsPatch({
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
