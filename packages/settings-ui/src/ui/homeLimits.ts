import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  homeScopedSettingsKey,
  MAIN_HOME_ID,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import {
  SETTINGS_UI_POWER_PATH,
  type SettingsUiCapacityPeak,
  type SettingsUiCapacityScalarsRead,
  type SettingsUiPowerPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  HOME_LIMITS_CONTROL_FAILED_TOAST,
  HOME_LIMITS_CONTROL_SAVED_TOAST,
  HOME_LIMITS_LOAD_FAILED_TOAST,
  HOME_LIMITS_MAIN_HARD_CAP_HINT,
  HOME_LIMITS_MAIN_HARD_CAP_HINT_WITH_AREAS,
  HOME_LIMITS_SAVE_FAILED_TOAST,
  HOME_LIMITS_SAVED_TOAST,
} from '../../../shared-domain/src/homeLimitsCopy.ts';
import {
  DEFAULT_CAPACITY_PERIOD_MINUTES,
  resolveCapacityPeriodMinutes,
} from '../../../shared-domain/src/settings/capacityPeriod.ts';
import type { CapacityPeriodMinutes } from '../../../contracts/src/capacitySettings.ts';
import { resolveHomeLimitsStatus } from '../../../shared-domain/src/homeLimitsStatus.ts';
import { getHomeScope, refreshHomeScope, subscribeToHomeScope } from './homeScope.ts';
import {
  getApiReadModel, getSettingFresh, homeScopedApiUri, invalidateApiCache, setSetting,
} from './homey.ts';
import { liveStatusOrNull } from './powerStatusRead.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';
import { state } from './state.ts';
import { classifyCapacityPeak } from './capacityPeakRead.ts';
import { classifyCapacityScalarsRead } from './capacityScalarsRead.ts';
import {
  capFieldFollowsRead, marginVsCapError, parseFiniteOrNull, reactionKwLabel, validateAreaCaps,
} from './homeLimitsFields.ts';
import {
  admitAreaRead,
  areaWriteEpoch,
  beginAreaWrite,
  endAreaWrite,
  takeDueAreaRead,
  resolveAreaCapsWriteQueue,
  resolveAreaPeriodWriteQueue,
  type AreaCapFieldWrites,
  type AreaCapsIntent,
  type AreaCapsWriteQueue,
  type AreaPeriodWriteQueue,
} from './homeLimitsWriteQueues.ts';
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

// Mirrors SUB_HOME_CAPACITY_DEFAULTS (lib/home/subHomeRuntime.ts):
// a meter area boots at 10 kW / 0.2 kW and — critically — dry-run TRUE, so it
// simulates until the user turns simulation off here.
const DEFAULT_LIMIT_KW = 10;
const DEFAULT_MARGIN_KW = 0.2;
const DEFAULT_DRY_RUN = true;

const STATIC_LIMITS_FORM_ID = 'settings-limits-form';
const HOME_LIMITS_MOUNT_ID = 'home-limits-mount';
const GLOBAL_LIMITS_SETTINGS_ID = 'settings-limits-global';
const MAIN_HARD_CAP_HINT_ID = 'settings-capacity-limit-hint';

type AreaEditorState = {
  homeId: string;
  areaName: string;
  hardCapValue: string;
  marginValue: string;
  /**
   * What each cap field holds without an uncommitted edit: the stored value it
   * last showed, or the value last committed from it. A read moves a field
   * still holding it; any other text is the user's and stays.
   */
  hardCapBaselineKw: number;
  marginBaselineKw: number;
  dryRun: boolean;
  periodMinutes: CapacityPeriodMinutes;
  periodWriteQueue: AreaPeriodWriteQueue;
  capsWriteQueue: AreaCapsWriteQueue;
  persistedDryRun: boolean;
  /** True while a control-toggle write is in flight — serialises toggles + gates rollback. */
  dryRunWriteInFlight: boolean;
  statusRaw: unknown;
  capacityPeak: SettingsUiCapacityPeak;
};

let areaEditor: AreaEditorState | null = null;
const lastGoodPeriodByHomeId = new Map<string, CapacityPeriodMinutes>();

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
    periodMinutes: editor.periodMinutes,
    periodBusy: editor.periodWriteQueue.pendingCount > 0,
    dryRun: editor.dryRun,
    runtimeActive,
    controlBusy: editor.dryRunWriteInFlight,
    marginError: marginVsCapError(hardCapKw, marginKw),
    reactionKw: reactionKwLabel(hardCapKw, marginKw),
    capacityPeak: editor.capacityPeak,
    // Resolve the status against the LIVE edited cap + simulation state so the
    // card's Hard cap and posture track the inputs without a re-read. A held
    // config is forced non-active even if its pre-GA dry-run value was false.
    status: resolveHomeLimitsStatus(editor.statusRaw, {
      dryRun: !runtimeActive || editor.dryRun,
      hardCapKw,
    }),
    onHardCapInput: handleHardCapInput,
    onHardCapChange: () => { void saveAreaCaps(); },
    onMarginInput: handleMarginInput,
    onMarginChange: () => { void saveAreaCaps(); },
    onPeriodChange: (periodMinutes) => { void saveAreaPeriod(periodMinutes); },
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

/**
 * The area's live status, read FRESH off its scoped power payload (the
 * runtime holds the status in memory and serves it through `ui_power`; the
 * `plan_status_published` push says when to read again). `null` is the card's
 * pre-existing "no live status" vocabulary: nothing published yet, a gated
 * area, a scoped read the runtime refused, or a failed read.
 */
type AreaPowerRead = {
  status: unknown;
  capacityPeak: SettingsUiCapacityPeak;
  /** This area runtime's own scalars; its period seeds an unset persisted key. */
  capacityScalars: SettingsUiCapacityScalarsRead;
};

const readAreaStatus = async (homeId: string): Promise<AreaPowerRead> => {
  const uri = homeScopedApiUri(SETTINGS_UI_POWER_PATH, homeId);
  invalidateApiCache(uri);
  try {
    const payload = await getApiReadModel<SettingsUiPowerPayload>(uri);
    return {
      status: liveStatusOrNull(payload.status),
      capacityPeak: classifyCapacityPeak(payload.capacityPeak),
      capacityScalars: classifyCapacityScalarsRead(payload.capacityScalars),
    };
  } catch {
    const unavailable = { state: 'unavailable' } as const;
    return { status: null, capacityPeak: unavailable, capacityScalars: unavailable };
  }
};

// The period an unset persisted key resolves to: the running area's own, else
// the last good one this WebView saw, else the default.
const fallbackPeriodMinutes = (homeId: string, powerRead: AreaPowerRead): CapacityPeriodMinutes => (
  powerRead.capacityScalars.state === 'resolved'
    ? powerRead.capacityScalars.scalars.periodMinutes
    : lastGoodPeriodByHomeId.get(homeId) ?? DEFAULT_CAPACITY_PERIOD_MINUTES
);

/** One read of a meter area's persisted scalars, resolved here, with its scoped power payload. */
type AreaSettingsRead = {
  limitKw: number;
  marginKw: number;
  dryRun: boolean;
  periodMinutes: CapacityPeriodMinutes;
  power: AreaPowerRead;
};

const readAreaSettings = async (homeId: string): Promise<AreaSettingsRead> => {
  const [limitRaw, marginRaw, dryRunRaw, periodRaw, power] = await Promise.all([
    getSettingFresh(homeScopedSettingsKey(CAPACITY_LIMIT_KW, homeId)),
    getSettingFresh(homeScopedSettingsKey(CAPACITY_MARGIN_KW, homeId)),
    getSettingFresh(homeScopedSettingsKey(CAPACITY_DRY_RUN, homeId)),
    getSettingFresh(homeScopedSettingsKey(CAPACITY_PERIOD_MINUTES, homeId)),
    readAreaStatus(homeId),
  ]);
  return {
    limitKw: typeof limitRaw === 'number' && Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT_KW,
    marginKw: typeof marginRaw === 'number' && Number.isFinite(marginRaw) ? marginRaw : DEFAULT_MARGIN_KW,
    dryRun: typeof dryRunRaw === 'boolean' ? dryRunRaw : DEFAULT_DRY_RUN,
    periodMinutes: resolveCapacityPeriodMinutes(periodRaw, fallbackPeriodMinutes(homeId, power)),
    power,
  };
};

const applyAreaRead = (homeId: string, areaName: string, read: AreaSettingsRead): void => {
  const {
    limitKw, marginKw, dryRun, power,
  } = read;
  const capsWriteQueue = resolveAreaCapsWriteQueue(homeId, limitKw, marginKw);
  const periodWriteQueue = resolveAreaPeriodWriteQueue(homeId, read.periodMinutes);
  const periodMinutes = periodWriteQueue.pendingCount > 0
    ? periodWriteQueue.latestPeriodMinutes
    : read.periodMinutes;
  lastGoodPeriodByHomeId.set(homeId, periodMinutes);
  // A refresh of the open area (the `settings.set` echo of this editor's own
  // write, or a second WebView's) folds into the SAME editor: replacing it
  // reset a cap the user was still typing to the stored value, so the blur
  // that followed committed nothing.
  const open = areaEditor?.homeId === homeId ? areaEditor : null;
  if (open === null) {
    areaEditor = {
      homeId,
      areaName,
      hardCapValue: limitKw.toString(),
      marginValue: marginKw.toString(),
      hardCapBaselineKw: limitKw,
      marginBaselineKw: marginKw,
      dryRun,
      periodMinutes,
      periodWriteQueue,
      capsWriteQueue,
      persistedDryRun: dryRun,
      dryRunWriteInFlight: false,
      statusRaw: power.status,
      capacityPeak: power.capacityPeak,
    };
  } else {
    open.areaName = areaName;
    if (capFieldFollowsRead(open.hardCapValue, open.hardCapBaselineKw)) {
      open.hardCapValue = limitKw.toString();
      open.hardCapBaselineKw = limitKw;
    }
    if (capFieldFollowsRead(open.marginValue, open.marginBaselineKw)) {
      open.marginValue = marginKw.toString();
      open.marginBaselineKw = marginKw;
    }
    open.dryRun = dryRun;
    open.persistedDryRun = dryRun;
    open.periodMinutes = periodMinutes;
    open.statusRaw = power.status;
    open.capacityPeak = power.capacityPeak;
  }
  renderSection();
};

// As in `loadCapacitySettings`, only a newer load of the SAME area that has
// APPLIED supersedes this one: a later load that fails must not discard a good
// read with no further refresh guaranteed, and another area's read never does.
// The started sequence is shared, which still orders loads within each area.
let areaLoadGeneration = 0;
const appliedLoadGenerationByHomeId = new Map<string, number>();

const loadAreaIntoEditor = async (homeId: string, areaName: string): Promise<void> => {
  areaLoadGeneration += 1;
  const generation = areaLoadGeneration;
  const startEpoch = areaWriteEpoch(homeId);
  const read = await readAreaSettings(homeId);
  // A meter area that vanished mid-load (removed elsewhere) must not resurrect
  // its editor over a now-different selection.
  if (getHomeScope().selectedHomeId !== homeId) return;
  if (generation < (appliedLoadGenerationByHomeId.get(homeId) ?? 0)) return;
  // A refresh of the open editor applies only if no write to the area is in
  // flight and none finished since it started; otherwise it may predate that
  // write, so it is set aside and the area is read again once none remains.
  // The read that opens the editor always applies, so the area shows its stored
  // values at once, and a write it overlapped still re-reads when it finishes.
  // A write whose callback never returns therefore leaves the editor on stored
  // values and that area's later saves queued behind it, as before this rule.
  const current = admitAreaRead(homeId, startEpoch);
  if (!current && areaEditor?.homeId === homeId) {
    rereadIfDue(homeId);
    return;
  }
  appliedLoadGenerationByHomeId.set(homeId, generation);
  applyAreaRead(homeId, areaName, read);
  if (!current) rereadIfDue(homeId);
};

/** Reads an area again if this panel is showing it. */
const rereadArea = (homeId: string): void => {
  const { selectedHomeId, areas } = getHomeScope();
  const area = areas.find((entry) => entry.homeId === homeId);
  if (state.activePanel !== 'limits' || selectedHomeId !== homeId || area === undefined) return;
  surfaceHomeLimitsLoadError(loadAreaIntoEditor(homeId, area.name), 'Failed to reload meter-area limits');
};

const rereadIfDue = (homeId: string): void => {
  if (takeDueAreaRead(homeId)) rereadArea(homeId);
};

const finishAreaWrite = (homeId: string): void => {
  endAreaWrite(homeId);
  rereadIfDue(homeId);
};

const saveAreaPeriod = async (periodMinutes: CapacityPeriodMinutes): Promise<void> => {
  if (areaEditor === null) return;
  const editor = areaEditor;
  const { periodWriteQueue: queue } = editor;
  if (queue.pendingCount === 0 && queue.persistedPeriodMinutes === periodMinutes) return;
  editor.periodMinutes = periodMinutes;
  queue.latestPeriodMinutes = periodMinutes;
  queue.latestSequence += 1;
  const sequence = queue.latestSequence;
  queue.pendingCount += 1;
  beginAreaWrite(editor.homeId);
  renderSection();
  const task = queue.tail
    .catch(() => {})
    .then(async () => {
      try {
        await setSetting(homeScopedSettingsKey(CAPACITY_PERIOD_MINUTES, editor.homeId), periodMinutes);
        queue.persistedPeriodMinutes = periodMinutes;
        lastGoodPeriodByHomeId.set(editor.homeId, periodMinutes);
        if (sequence === queue.latestSequence) await showToast(HOME_LIMITS_SAVED_TOAST, 'ok');
      } catch (caught) {
        await logSettingsError('Failed to save meter-area capacity period', caught, 'homeLimits');
        if (sequence === queue.latestSequence) {
          queue.latestPeriodMinutes = queue.persistedPeriodMinutes;
          lastGoodPeriodByHomeId.set(editor.homeId, queue.persistedPeriodMinutes);
          if (areaEditor?.homeId === editor.homeId) {
            areaEditor.periodMinutes = queue.persistedPeriodMinutes;
          }
          await showToastError(caught, HOME_LIMITS_SAVE_FAILED_TOAST);
        }
      }
    })
    .finally(() => {
      queue.pendingCount -= 1;
      if (areaEditor?.homeId === editor.homeId) {
        areaEditor.periodMinutes = queue.latestPeriodMinutes;
        renderSection();
      }
      finishAreaWrite(editor.homeId);
    });
  queue.tail = task;
  await task;
};

const reloadAreaStatus = async (): Promise<void> => {
  if (areaEditor === null) return;
  const { homeId } = areaEditor;
  const powerRead = await readAreaStatus(homeId);
  if (areaEditor === null || areaEditor.homeId !== homeId) return;
  areaEditor.statusRaw = powerRead.status;
  areaEditor.capacityPeak = powerRead.capacityPeak;
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

const persistAreaCaps = async (editor: AreaEditorState, intent: AreaCapsIntent): Promise<void> => {
  const { capsWriteQueue: queue } = editor;
  const { limitKw, marginKw, sequence } = intent;
  const writes: Array<{
    field: AreaCapFieldWrites;
    kw: number;
    task: Promise<void>;
  }> = [];
  if (intent.writesLimit && queue.limit.persistedKw !== limitKw) {
    writes.push({
      field: queue.limit,
      kw: limitKw,
      task: setSetting(homeScopedSettingsKey(CAPACITY_LIMIT_KW, editor.homeId), limitKw),
    });
  }
  if (intent.writesMargin && queue.margin.persistedKw !== marginKw) {
    writes.push({
      field: queue.margin,
      kw: marginKw,
      task: setSetting(homeScopedSettingsKey(CAPACITY_MARGIN_KW, editor.homeId), marginKw),
    });
  }
  if (writes.length === 0) return;
  // Wait for every callback even when one write fails. Advancing this home's
  // chain after the first rejection would let a slower sibling write from the
  // older intent land after a newer cap/margin pair.
  const results = await Promise.allSettled(writes.map(({ task }) => task));
  results.forEach((result, index) => {
    const write = writes[index];
    if (result.status === 'fulfilled' && write !== undefined) write.field.persistedKw = write.kw;
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
  const { limit, margin } = queue;
  // An intent writes each field the user changed, and each field whose earlier
  // write is still pending, so a failed earlier callback cannot swallow a later
  // same-value commitment. It never writes an untouched field: that text may
  // predate an outside change a fresh read has since made the baseline.
  const writesLimit = limit.pendingCount > 0 || limit.persistedKw !== hardCapKw;
  const writesMargin = margin.pendingCount > 0 || margin.persistedKw !== marginKw;
  if (!writesLimit && !writesMargin) return;
  queue.latestSequence += 1;
  const intent: AreaCapsIntent = {
    limitKw: hardCapKw, marginKw, writesLimit, writesMargin, sequence: queue.latestSequence,
  };
  if (writesLimit) {
    limit.pendingCount += 1;
    editor.hardCapBaselineKw = hardCapKw;
  }
  if (writesMargin) {
    margin.pendingCount += 1;
    editor.marginBaselineKw = marginKw;
  }
  beginAreaWrite(editor.homeId);
  const task = queue.tail
    .catch(() => {})
    .then(() => persistAreaCaps(editor, intent))
    .finally(() => {
      if (writesLimit) limit.pendingCount -= 1;
      if (writesMargin) margin.pendingCount -= 1;
      finishAreaWrite(editor.homeId);
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
  beginAreaWrite(editor.homeId);
  renderSection();
  try {
    await setSetting(homeScopedSettingsKey(CAPACITY_DRY_RUN, editor.homeId), nextDryRun);
  } catch (caught) {
    editor.dryRun = editor.persistedDryRun;
    editor.dryRunWriteInFlight = false;
    renderSection();
    finishAreaWrite(editor.homeId);
    await logSettingsError('Failed to save meter-area control setting', caught, 'homeLimits');
    await showToastError(caught, HOME_LIMITS_CONTROL_FAILED_TOAST);
    return;
  }
  editor.persistedDryRun = nextDryRun;
  editor.dryRunWriteInFlight = false;
  renderSection();
  finishAreaWrite(editor.homeId);
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
 * Realtime `plan_status_published` hook: the runtime published a fresh status
 * for a meter area; an open card showing that area re-reads it. No-op unless
 * the limits panel is showing that area.
 */
export const notifyHomeLimitsStatusPublished = (homeId: string): void => {
  if (state.activePanel !== 'limits') return;
  if (areaEditor === null || areaEditor.homeId !== homeId) return;
  void reloadAreaStatus();
};

/**
 * Realtime `settings.set` hook: keep the open card live when the selected meter
 * area's scalars change externally (a second WebView). No-op unless the limits
 * panel is showing a meter area. The roster blob (`homes_config`) is the scope
 * owner's business, not this controller's — `homeScope` refetches it and
 * notifies subscribers.
 */
export const notifyHomeLimitsSettingChanged = (key: string): void => {
  if (state.activePanel !== 'limits') return;
  const { selectedHomeId } = getHomeScope();
  if (selectedHomeId === MAIN_HOME_ID || areaEditor === null) return;
  const capKeys = [CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CAPACITY_DRY_RUN, CAPACITY_PERIOD_MINUTES]
    .map((base) => homeScopedSettingsKey(base, selectedHomeId));
  if (capKeys.includes(key)) rereadArea(selectedHomeId);
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
