import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  homeScopedSettingsKey,
  HOMES_CONFIG,
  MAIN_HOME_ID,
  PELS_STATUS,
} from '../../../contracts/src/settingsKeys.ts';
import {
  SETTINGS_UI_HOMES_PATH,
  type SettingsUiHomesPayload,
} from '../../../contracts/src/settingsUiHomes.ts';
import {
  HOME_LIMITS_CONTROL_FAILED_TOAST,
  HOME_LIMITS_CONTROL_SAVED_TOAST,
  HOME_LIMITS_HARD_CAP_MAX,
  HOME_LIMITS_HARD_CAP_POSITIVE,
  HOME_LIMITS_LOAD_FAILED_TOAST,
  HOME_LIMITS_MAIN_HOME_OPTION,
  HOME_LIMITS_MARGIN_NEGATIVE,
  HOME_LIMITS_MARGIN_TOO_HIGH,
  HOME_LIMITS_SAVE_FAILED_TOAST,
  HOME_LIMITS_SAVED_TOAST,
  HOME_LIMITS_VALUE_PLACEHOLDER,
} from '../../../shared-domain/src/homeLimitsCopy.ts';
import {
  formatHomeLimitsKw,
  resolveHomeLimitsStatus,
} from '../../../shared-domain/src/homeLimitsStatus.ts';
import { callApi, getSettingFresh, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import { showToast, showToastError } from './toast.ts';
import { state } from './state.ts';
import {
  renderHomeLimitsSection,
  type HomeLimitsEditorView,
  type HomeLimitsHomeOption,
} from './views/HomeLimitsSection.tsx';

// Module-state controller for the per-home slice of the Limits & safety panel
// (multi-home U3). Owns the home switcher, the selected meter area's scalar
// editor (hard cap / safety margin / simulation), and its live status card.
//
// Write path: per-home capacity scalars are NOT the wipe-sensitive whole-value
// class, so the UI writes the suffixed keys directly (plain `setSetting` of
// `capacity_limit_kw:<homeId>` etc.). The runtime's suffix-hook + registry
// reload apply them. The Main home keeps the historical unsuffixed keys and its
// existing static form (`#settings-limits-form`), untouched and byte-identical:
// this controller only toggles that form's visibility and never writes its keys.

// Mirrors SUB_HOME_CAPACITY_DEFAULTS (setup/homeRuntime/createHomeCapacityBundle.ts):
// a meter area boots at 10 kW / 0.2 kW and — critically — dry-run TRUE, so it
// simulates until the user turns simulation off here.
const DEFAULT_LIMIT_KW = 10;
const DEFAULT_MARGIN_KW = 0.2;
const DEFAULT_DRY_RUN = true;

const STATIC_LIMITS_FORM_ID = 'settings-limits-form';
const HOME_LIMITS_MOUNT_ID = 'home-limits-mount';

type MeterArea = { homeId: string; name: string };

type AreaEditorState = {
  homeId: string;
  areaName: string;
  hardCapValue: string;
  marginValue: string;
  dryRun: boolean;
  persistedLimitKw: number;
  persistedMarginKw: number;
  persistedDryRun: boolean;
  /** True while a control-toggle write is in flight — serialises toggles + gates rollback. */
  dryRunWriteInFlight: boolean;
  statusRaw: unknown;
  statusLoaded: boolean;
};

let meterAreas: MeterArea[] = [];
let selectedHomeId: string = MAIN_HOME_ID;
let areaEditor: AreaEditorState | null = null;

// Fire-and-forget guard for a discarded async settings load (an area switch, a
// realtime reload). A rejected fetch must never surface as an unhandled
// rejection: log it and toast a soft error. The editor is left null on failure
// (the switcher-only degraded state), never a stale/half-loaded card.
const surfaceHomeLimitsLoadError = (task: Promise<unknown>, message: string): void => {
  task.catch((caught) => {
    void logSettingsError(message, caught, 'homeLimits');
    void showToastError(caught, HOME_LIMITS_LOAD_FAILED_TOAST);
  });
};

const parseFiniteOrNull = (raw: string): number | null => {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
};

// Mirrors capacity.ts getMarginVsLimitError: quiet until both numbers are valid
// so a partially-typed value never flashes an error mid-edit.
const marginVsCapError = (hardCapKw: number | null, marginKw: number | null): string | null => {
  if (hardCapKw === null || hardCapKw <= 0) return null;
  if (marginKw === null || marginKw < 0) return null;
  return marginKw >= hardCapKw ? HOME_LIMITS_MARGIN_TOO_HIGH : null;
};

const reactionKwLabel = (hardCapKw: number | null, marginKw: number | null): string => {
  if (hardCapKw === null || hardCapKw <= 0 || marginKw === null || marginKw < 0) {
    return HOME_LIMITS_VALUE_PLACEHOLDER;
  }
  return formatHomeLimitsKw(Math.max(0, hardCapKw - marginKw));
};

const setStaticFormHidden = (hidden: boolean): void => {
  const form = document.getElementById(STATIC_LIMITS_FORM_ID);
  if (form) form.hidden = hidden;
};

const buildHomeOptions = (): HomeLimitsHomeOption[] => [
  { homeId: MAIN_HOME_ID, label: HOME_LIMITS_MAIN_HOME_OPTION },
  ...meterAreas.map((area) => ({ homeId: area.homeId, label: area.name })),
];

const buildAreaEditorView = (editor: AreaEditorState): HomeLimitsEditorView => {
  const hardCapKw = parseFiniteOrNull(editor.hardCapValue);
  const marginKw = parseFiniteOrNull(editor.marginValue);
  return {
    areaName: editor.areaName,
    hardCapValue: editor.hardCapValue,
    marginValue: editor.marginValue,
    dryRun: editor.dryRun,
    controlBusy: editor.dryRunWriteInFlight,
    marginError: marginVsCapError(hardCapKw, marginKw),
    reactionKw: reactionKwLabel(hardCapKw, marginKw),
    // Resolve the status against the LIVE edited cap + simulation state so the
    // card's Hard cap and posture track the inputs without a re-read.
    status: editor.statusLoaded
      ? resolveHomeLimitsStatus(editor.statusRaw, { dryRun: editor.dryRun, hardCapKw })
      : null,
    onHardCapInput: handleHardCapInput,
    onHardCapChange: () => { void saveAreaCaps(); },
    onMarginInput: handleMarginInput,
    onMarginChange: () => { void saveAreaCaps(); },
    onControlToggle: (controlEnabled) => { void saveAreaControl(controlEnabled); },
  };
};

const renderSection = (): void => {
  const mount = document.getElementById(HOME_LIMITS_MOUNT_ID);
  if (!mount) return;
  // The switcher appears once at least one meter area exists; with none, the
  // panel stays pixel-identical to a single-meter home (just Main's form).
  const visible = meterAreas.length > 0;
  // The mount ships `hidden` (display:none) so an empty node never occupies a
  // grid track in the panel — with 0 meter areas the panel stays pixel-identical
  // to origin/main (no stray gap between the app bar and the Main form). Only a
  // real meter area un-hides it.
  mount.hidden = !visible;
  const onMeterArea = visible && selectedHomeId !== MAIN_HOME_ID;
  // The static Main-home form shows for a single-home user, or when Main is the
  // selected home. A meter area hides it as soon as it is selected (before its
  // scalars finish loading) so the Main form never flashes mid-switch.
  setStaticFormHidden(onMeterArea);
  renderHomeLimitsSection(mount, {
    visible,
    homeOptions: buildHomeOptions(),
    selectedHomeId,
    onSelectHome: handleSelectHome,
    editor: onMeterArea && areaEditor !== null ? buildAreaEditorView(areaEditor) : null,
  });
};

const loadAreaIntoEditor = async (homeId: string, areaName: string): Promise<void> => {
  const [limitRaw, marginRaw, dryRunRaw, statusRaw] = await Promise.all([
    getSettingFresh(homeScopedSettingsKey(CAPACITY_LIMIT_KW, homeId)),
    getSettingFresh(homeScopedSettingsKey(CAPACITY_MARGIN_KW, homeId)),
    getSettingFresh(homeScopedSettingsKey(CAPACITY_DRY_RUN, homeId)),
    getSettingFresh(homeScopedSettingsKey(PELS_STATUS, homeId)).catch((): unknown => null),
  ]);
  // A meter area that vanished mid-load (removed elsewhere) must not resurrect
  // its editor over a now-different selection.
  if (selectedHomeId !== homeId) return;
  const limitKw = typeof limitRaw === 'number' ? limitRaw : DEFAULT_LIMIT_KW;
  const marginKw = typeof marginRaw === 'number' ? marginRaw : DEFAULT_MARGIN_KW;
  const dryRun = typeof dryRunRaw === 'boolean' ? dryRunRaw : DEFAULT_DRY_RUN;
  areaEditor = {
    homeId,
    areaName,
    hardCapValue: limitKw.toString(),
    marginValue: marginKw.toString(),
    dryRun,
    persistedLimitKw: limitKw,
    persistedMarginKw: marginKw,
    persistedDryRun: dryRun,
    dryRunWriteInFlight: false,
    statusRaw,
    statusLoaded: true,
  };
  renderSection();
};

const reloadAreaStatus = async (): Promise<void> => {
  if (areaEditor === null) return;
  const { homeId } = areaEditor;
  const statusRaw = await getSettingFresh(homeScopedSettingsKey(PELS_STATUS, homeId)).catch((): unknown => null);
  if (areaEditor === null || areaEditor.homeId !== homeId) return;
  areaEditor.statusRaw = statusRaw;
  areaEditor.statusLoaded = true;
  renderSection();
};

const handleSelectHome = (homeId: string): void => {
  selectedHomeId = homeId;
  if (homeId === MAIN_HOME_ID) {
    areaEditor = null;
    renderSection();
    return;
  }
  const area = meterAreas.find((entry) => entry.homeId === homeId);
  if (area === undefined) {
    selectedHomeId = MAIN_HOME_ID;
    areaEditor = null;
    renderSection();
    return;
  }
  // Editor null during the fresh read (switcher-only) so stale values never
  // flash; the load resolves it in place.
  areaEditor = null;
  renderSection();
  surfaceHomeLimitsLoadError(loadAreaIntoEditor(homeId, area.name), 'Failed to load meter-area limits');
};

const handleHardCapInput = (value: string): void => {
  if (areaEditor === null) return;
  areaEditor.hardCapValue = value;
  renderSection();
};

const handleMarginInput = (value: string): void => {
  if (areaEditor === null) return;
  areaEditor.marginValue = value;
  renderSection();
};

const validateAreaCaps = (hardCapKw: number, marginKw: number): string | null => {
  if (!Number.isFinite(hardCapKw) || hardCapKw <= 0) return HOME_LIMITS_HARD_CAP_POSITIVE;
  if (hardCapKw > 1000) return HOME_LIMITS_HARD_CAP_MAX;
  if (!Number.isFinite(marginKw) || marginKw < 0) return HOME_LIMITS_MARGIN_NEGATIVE;
  if (marginKw >= hardCapKw) return HOME_LIMITS_MARGIN_TOO_HIGH;
  return null;
};

const saveAreaCaps = async (): Promise<void> => {
  if (areaEditor === null) return;
  const editor = areaEditor;
  const hardCapKw = Number.parseFloat(editor.hardCapValue);
  const marginKw = Number.parseFloat(editor.marginValue);
  const error = validateAreaCaps(hardCapKw, marginKw);
  if (error !== null) {
    renderSection();
    await showToast(error, 'warn');
    return;
  }
  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(
    writes,
    homeScopedSettingsKey(CAPACITY_LIMIT_KW, editor.homeId),
    editor.persistedLimitKw,
    hardCapKw,
  );
  pushSettingWriteIfChanged(
    writes,
    homeScopedSettingsKey(CAPACITY_MARGIN_KW, editor.homeId),
    editor.persistedMarginKw,
    marginKw,
  );
  if (writes.length === 0) return;
  try {
    await Promise.all(writes);
  } catch (caught) {
    await logSettingsError('Failed to save meter-area limits', caught, 'homeLimits');
    await showToastError(caught, HOME_LIMITS_SAVE_FAILED_TOAST);
    return;
  }
  editor.persistedLimitKw = hardCapKw;
  editor.persistedMarginKw = marginKw;
  await showToast(HOME_LIMITS_SAVED_TOAST, 'ok');
};

// Positive activation toggle. `controlEnabled` true = PELS controls this area,
// which persists `capacity_dry_run:<id> = false` (the key semantics are
// unchanged — only the UI polarity flips). The write is serialised: while one
// is in flight the toggle renders disabled, and this guard drops any change
// event that still slips through, so a rapid second toggle can't race the first
// or be lost. On failure the optimistic UI rolls back to the persisted value.
const saveAreaControl = async (controlEnabled: boolean): Promise<void> => {
  if (areaEditor === null) return;
  const editor = areaEditor;
  if (editor.dryRunWriteInFlight) return;
  const nextDryRun = !controlEnabled;
  if (editor.persistedDryRun === nextDryRun) {
    editor.dryRun = nextDryRun;
    renderSection();
    return;
  }
  editor.dryRun = nextDryRun;
  editor.dryRunWriteInFlight = true;
  renderSection();
  try {
    await setSetting(homeScopedSettingsKey(CAPACITY_DRY_RUN, editor.homeId), nextDryRun);
  } catch (caught) {
    editor.dryRun = editor.persistedDryRun;
    editor.dryRunWriteInFlight = false;
    renderSection();
    await logSettingsError('Failed to save meter-area control setting', caught, 'homeLimits');
    await showToastError(caught, HOME_LIMITS_CONTROL_FAILED_TOAST);
    return;
  }
  editor.persistedDryRun = nextDryRun;
  editor.dryRunWriteInFlight = false;
  renderSection();
  await showToast(HOME_LIMITS_CONTROL_SAVED_TOAST, 'ok');
};

const fetchMeterAreas = async (): Promise<void> => {
  try {
    const payload = await callApi<SettingsUiHomesPayload>('GET', SETTINGS_UI_HOMES_PATH);
    // Only an authoritative (successful) response reshapes the roster — an empty
    // `homes` here is a real "no meter areas" state and correctly clears it.
    meterAreas = payload.homes.map((home) => ({ homeId: home.homeId, name: home.name }));
  } catch (caught) {
    // Abandon-grace (mirrors homesSettings' pickers): a transient read failure
    // KEEPS the last-good roster + selection rather than blanking the whole
    // per-home surface. Blanking on a momentary SDK/network miss would collapse
    // the switcher to Main-only and drop the user's selected area mid-session.
    await logSettingsError('Failed to load meter areas for the limits switcher', caught, 'homeLimits');
  }
};

/**
 * Limits-panel activation hook (realtime `showTab('limits')`, alongside the
 * Main-home `loadCapacitySettings`). Refetches the meter-area list so the
 * switcher never sits on a stale roster, reconciles the selection, and re-reads
 * the selected area's scalars + status.
 */
export const refreshHomeLimitsOnLimitsPanel = async (): Promise<void> => {
  await fetchMeterAreas();
  // Reconcile a selection whose area was removed since the last visit.
  if (selectedHomeId !== MAIN_HOME_ID && !meterAreas.some((area) => area.homeId === selectedHomeId)) {
    selectedHomeId = MAIN_HOME_ID;
    areaEditor = null;
  }
  renderSection();
  if (selectedHomeId !== MAIN_HOME_ID) {
    const area = meterAreas.find((entry) => entry.homeId === selectedHomeId);
    if (area !== undefined) await loadAreaIntoEditor(area.homeId, area.name);
  }
};

/**
 * Realtime `settings.set` hook: keep the open card live when the selected meter
 * area's status or scalars change externally (a second WebView, or the runtime
 * writing a fresh `pels_status:<id>`). No-op unless the limits panel is showing
 * a meter area.
 */
export const notifyHomeLimitsSettingChanged = (key: string): void => {
  if (state.activePanel !== 'limits') return;
  // A roster change (an area added/removed via the Multiple-meters panel or a
  // second WebView) rewrites `homes_config`. Re-fetch the full switcher roster
  // and reconcile the selection — even from the Main home, where the local guard
  // below would otherwise ignore it. `device_home_assignments` (device→home
  // membership) does NOT alter the area roster, so it is intentionally excluded;
  // its effect on a selected area surfaces through `pels_status:<id>` instead.
  if (key === HOMES_CONFIG) {
    surfaceHomeLimitsLoadError(refreshHomeLimitsOnLimitsPanel(), 'Failed to refresh the limits switcher roster');
    return;
  }
  if (selectedHomeId === MAIN_HOME_ID || areaEditor === null) return;
  if (key === homeScopedSettingsKey(PELS_STATUS, selectedHomeId)) {
    void reloadAreaStatus();
    return;
  }
  const capKeys = [CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CAPACITY_DRY_RUN]
    .map((base) => homeScopedSettingsKey(base, selectedHomeId));
  if (capKeys.includes(key)) {
    surfaceHomeLimitsLoadError(
      loadAreaIntoEditor(areaEditor.homeId, areaEditor.areaName),
      'Failed to reload meter-area limits',
    );
  }
};
