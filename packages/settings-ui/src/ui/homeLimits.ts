import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  homeScopedSettingsKey,
  MAIN_HOME_ID,
  PELS_STATUS,
} from '../../../contracts/src/settingsKeys.ts';
import {
  HOME_LIMITS_CONTROL_FAILED_TOAST,
  HOME_LIMITS_CONTROL_SAVED_TOAST,
  HOME_LIMITS_HARD_CAP_MAX,
  HOME_LIMITS_HARD_CAP_POSITIVE,
  HOME_LIMITS_LOAD_FAILED_TOAST,
  HOME_LIMITS_MAIN_HARD_CAP_HINT,
  HOME_LIMITS_MAIN_HARD_CAP_HINT_WITH_AREAS,
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
import { getHomeScope, refreshHomeScope, subscribeToHomeScope } from './homeScope.ts';
import { getSettingFresh, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';
import { state } from './state.ts';
import {
  renderHomeLimitsSection,
  type HomeLimitsEditorView,
} from './views/HomeLimitsSection.tsx';

// Module-state controller for the per-home slice of the Limits & safety panel
// (multi-home U3). Owns the selected meter area's scalar editor (hard cap /
// safety margin / simulation) and its live status card. It does NOT own the
// home selection: the shell's global scope bar (`homeScope.ts`) does, and this
// controller subscribes to it.
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
const GLOBAL_LIMITS_SETTINGS_ID = 'settings-limits-global';
const MAIN_HARD_CAP_HINT_ID = 'settings-capacity-limit-hint';

type AreaCapsWriteQueue = {
  persistedLimitKw: number;
  persistedMarginKw: number;
  pendingCount: number;
  latestSequence: number;
  tail: Promise<void>;
};

type AreaEditorState = {
  homeId: string;
  areaName: string;
  hardCapValue: string;
  marginValue: string;
  dryRun: boolean;
  capsWriteQueue: AreaCapsWriteQueue;
  persistedDryRun: boolean;
  /** True while a control-toggle write is in flight — serialises toggles + gates rollback. */
  dryRunWriteInFlight: boolean;
  statusRaw: unknown;
  statusLoaded: boolean;
};

let areaEditor: AreaEditorState | null = null;
// Write ordering belongs to the meter area, not a rendered editor object. A
// realtime reload or quick area switch can replace the editor while callbacks
// are pending; later captured intents must still run after earlier ones.
const areaCapsWriteQueueByHomeId = new Map<string, AreaCapsWriteQueue>();

const resolveAreaCapsWriteQueue = (params: {
  homeId: string;
  limitKw: number;
  marginKw: number;
}): AreaCapsWriteQueue => {
  const existing = areaCapsWriteQueueByHomeId.get(params.homeId);
  if (existing !== undefined) {
    // A fresh load may reflect an intermediate write. Only reconcile the
    // persisted fingerprint once this home's ordered chain is fully settled.
    if (existing.pendingCount === 0) {
      existing.persistedLimitKw = params.limitKw;
      existing.persistedMarginKw = params.marginKw;
    }
    return existing;
  }
  const created: AreaCapsWriteQueue = {
    persistedLimitKw: params.limitKw,
    persistedMarginKw: params.marginKw,
    pendingCount: 0,
    latestSequence: 0,
    tail: Promise.resolve(),
  };
  areaCapsWriteQueueByHomeId.set(params.homeId, created);
  return created;
};

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

/**
 * Power source and the whole-home meter are app-global settings — neither is
 * home-scoped — so they must not sit under a bar claiming a meter area. They
 * live in their own card outside the Main-home cap form: visible in Main scope,
 * and in area scope replaced by a line saying where they live, rather than
 * silently vanishing.
 */
const setGlobalSettingsScope = (onMeterArea: boolean): void => {
  const card = document.getElementById(GLOBAL_LIMITS_SETTINGS_ID);
  if (card) card.hidden = onMeterArea;
};

/**
 * Once a meter area exists, "Your grid tariff step" no longer means the whole
 * house — the Main-home form is one home among several. Name it, so the Main
 * branch is as explicit about its scope as the area branch already is.
 */
const setMainHardCapHint = (areasExist: boolean): void => {
  const hint = document.getElementById(MAIN_HARD_CAP_HINT_ID);
  if (hint) {
    hint.textContent = areasExist
      ? HOME_LIMITS_MAIN_HARD_CAP_HINT_WITH_AREAS
      : HOME_LIMITS_MAIN_HARD_CAP_HINT;
  }
};

const buildAreaEditorView = (editor: AreaEditorState): HomeLimitsEditorView => {
  const hardCapKw = parseFiniteOrNull(editor.hardCapValue);
  const marginKw = parseFiniteOrNull(editor.marginValue);
  const { runtimeActive } = getHomeScope();
  return {
    areaName: editor.areaName,
    hardCapValue: editor.hardCapValue,
    marginValue: editor.marginValue,
    dryRun: editor.dryRun,
    runtimeActive,
    controlBusy: editor.dryRunWriteInFlight,
    marginError: marginVsCapError(hardCapKw, marginKw),
    reactionKw: reactionKwLabel(hardCapKw, marginKw),
    // Resolve the status against the LIVE edited cap + simulation state so the
    // card's Hard cap and posture track the inputs without a re-read. A held
    // config is forced non-active even if its pre-GA dry-run value was false.
    status: editor.statusLoaded
      ? resolveHomeLimitsStatus(editor.statusRaw, {
        dryRun: !runtimeActive || editor.dryRun,
        hardCapKw,
      })
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
  const { selectedHomeId, areas } = getHomeScope();
  const onMeterArea = selectedHomeId !== MAIN_HOME_ID;
  setGlobalSettingsScope(onMeterArea);
  setMainHardCapHint(areas.length > 0);
  // The static Main-home form shows for a single-home user, or when Main is the
  // selected scope. A meter area hides it as soon as it is selected (before its
  // scalars finish loading) so the Main form never flashes mid-switch.
  setStaticFormHidden(onMeterArea);
  const editor = onMeterArea && areaEditor !== null ? buildAreaEditorView(areaEditor) : null;
  // The mount ships `hidden` (display:none) so an empty node never occupies a
  // grid track in the panel — with 0 meter areas the panel stays pixel-identical
  // to a single-meter install (no stray gap between the app bar and the Main
  // form). Only a rendered meter-area editor un-hides it.
  mount.hidden = editor === null;
  renderHomeLimitsSection(mount, { editor });
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
  if (getHomeScope().selectedHomeId !== homeId) return;
  const limitKw = typeof limitRaw === 'number' && Number.isFinite(limitRaw)
    ? limitRaw
    : DEFAULT_LIMIT_KW;
  const marginKw = typeof marginRaw === 'number' && Number.isFinite(marginRaw)
    ? marginRaw
    : DEFAULT_MARGIN_KW;
  const dryRun = typeof dryRunRaw === 'boolean' ? dryRunRaw : DEFAULT_DRY_RUN;
  const capsWriteQueue = resolveAreaCapsWriteQueue({ homeId, limitKw, marginKw });
  areaEditor = {
    homeId,
    areaName,
    hardCapValue: limitKw.toString(),
    marginValue: marginKw.toString(),
    dryRun,
    capsWriteQueue,
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

/**
 * Bring the editor in line with the shell's selected home scope. The Main home
 * (or a scope whose area is gone) clears the editor and restores the static
 * form; a meter area loads its suffixed scalars. Idempotent by default so a
 * repeat notification for an already-open area does not re-read it — `force`
 * is for a panel activation, where a fresh read is the point.
 */
const syncEditorToScope = async (options: { force?: boolean } = {}): Promise<void> => {
  const { selectedHomeId, areas } = getHomeScope();
  const area = areas.find((entry) => entry.homeId === selectedHomeId);
  if (area === undefined) {
    areaEditor = null;
    renderSection();
    return;
  }
  if (options.force !== true && areaEditor?.homeId === area.homeId) {
    // The area is already open, so its suffixed scalars need no re-read — but
    // the name is the one editor field sourced from the roster, and this branch
    // is reached precisely when the roster changed. A rename must reach the
    // simulation notice, or it would keep naming the old area while the scope
    // bar above already shows the new one.
    areaEditor.areaName = area.name;
    renderSection();
    return;
  }
  // Editor null during the fresh read so stale values never flash; the load
  // resolves it in place.
  areaEditor = null;
  renderSection();
  await loadAreaIntoEditor(area.homeId, area.name);
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

const persistAreaCaps = async (params: {
  editor: AreaEditorState;
  hardCapKw: number;
  marginKw: number;
  queue: AreaCapsWriteQueue;
  sequence: number;
}): Promise<void> => {
  const {
    editor, hardCapKw, marginKw, queue, sequence,
  } = params;
  const writes: Array<{
    field: 'limit' | 'margin';
    task: Promise<void>;
  }> = [];
  if (queue.persistedLimitKw !== hardCapKw) {
    writes.push({
      field: 'limit',
      task: setSetting(homeScopedSettingsKey(CAPACITY_LIMIT_KW, editor.homeId), hardCapKw),
    });
  }
  if (queue.persistedMarginKw !== marginKw) {
    writes.push({
      field: 'margin',
      task: setSetting(homeScopedSettingsKey(CAPACITY_MARGIN_KW, editor.homeId), marginKw),
    });
  }
  if (writes.length === 0) return;
  // Wait for every callback even when one write fails. Advancing this home's
  // chain after the first rejection would let a slower sibling write from the
  // older intent land after a newer cap/margin pair.
  const results = await Promise.allSettled(writes.map(({ task }) => task));
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    if (writes[index]?.field === 'limit') queue.persistedLimitKw = hardCapKw;
    if (writes[index]?.field === 'margin') queue.persistedMarginKw = marginKw;
  });
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    await logSettingsError('Failed to save meter-area limits', failed.reason, 'homeLimits');
    if (areaEditor === editor && sequence === queue.latestSequence) {
      await showToastError(failed.reason, HOME_LIMITS_SAVE_FAILED_TOAST);
    }
    return;
  }
  // A newer intent is already waiting; let the tail own the success
  // acknowledgement so the UI never celebrates an intermediate value.
  if (sequence === queue.latestSequence && areaEditor === editor) {
    await showToast(HOME_LIMITS_SAVED_TOAST, 'ok');
  }
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
  const { capsWriteQueue: queue } = editor;
  // Preserve the no-op fast path once this area's chain is settled. While it
  // is pending, every change intent is captured so a failed earlier callback
  // cannot swallow a later same-value commitment.
  if (
    queue.pendingCount === 0
    && queue.persistedLimitKw === hardCapKw
    && queue.persistedMarginKw === marginKw
  ) return;
  queue.latestSequence += 1;
  const sequence = queue.latestSequence;
  queue.pendingCount += 1;
  const task = queue.tail
    .catch(() => {})
    .then(() => persistAreaCaps({
      editor, hardCapKw, marginKw, queue, sequence,
    }))
    .finally(() => {
      queue.pendingCount -= 1;
    });
  queue.tail = task;
  await task;
};

// Positive activation toggle. `controlEnabled` true = PELS controls this area,
// which persists `capacity_dry_run:<id> = false` (the key semantics are
// unchanged — only the UI polarity flips). The write is serialised: while one
// is in flight the toggle renders disabled, and this guard drops any change
// event that still slips through, so a rapid second toggle can't race the first
// or be lost. On failure the optimistic UI rolls back to the persisted value.
const saveAreaControl = async (controlEnabled: boolean): Promise<void> => {
  if (areaEditor === null) return;
  // A legacy-held homes config is activated only by the deliberate
  // Multiple-meters save path. Never let this scalar toggle claim success
  // while runtime still assigns every device to Main home.
  if (!getHomeScope().runtimeActive) return;
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

/**
 * Limits-panel activation hook (realtime `showTab('limits')`, alongside the
 * Main-home `loadCapacitySettings`). Refreshes the shell's meter-area roster so
 * the scope bar never sits on a stale list, then re-reads the selected area's
 * scalars + status.
 */
export const refreshHomeLimitsOnLimitsPanel = async (): Promise<void> => {
  // The scope may have changed while this panel was hidden, when its
  // subscriber deliberately does no work. Clear the writable editor before
  // the roster await so stale suffixed controls never sit under a new chip.
  areaEditor = null;
  renderSection();
  await refreshHomeScope();
  await syncEditorToScope({ force: true });
};

/**
 * Realtime `settings.set` hook: keep the open card live when the selected meter
 * area's status or scalars change externally (a second WebView, or the runtime
 * writing a fresh `pels_status:<id>`). No-op unless the limits panel is showing
 * a meter area. The roster blob (`homes_config`) is the scope owner's business,
 * not this controller's — `homeScope` refetches it and notifies subscribers.
 */
export const notifyHomeLimitsSettingChanged = (key: string): void => {
  if (state.activePanel !== 'limits') return;
  const { selectedHomeId } = getHomeScope();
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

// Follow the shell's scope. Registered at import time (this module is imported
// by the settings-change router and the tab navigator, both boot-time) so a
// scope pick made from the global bar reaches the open panel with no extra
// wiring. Off-panel notifications are ignored — the panel's own activation hook
// resyncs on the next open.
subscribeToHomeScope(() => {
  if (state.activePanel !== 'limits') return;
  surfaceHomeLimitsLoadError(syncEditorToScope(), 'Failed to load meter-area limits');
});
