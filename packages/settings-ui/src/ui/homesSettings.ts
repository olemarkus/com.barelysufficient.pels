import { HOMEY_ENERGY_METER_DEVICE_ID, POWER_SOURCE } from '../../../contracts/src/settingsKeys.ts';
import {
  HOMEY_ENERGY_METERS_PATH,
  SETTINGS_UI_DEVICES_PATH,
  type HomeyEnergyMeterEntry,
  type SettingsUiDevicesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  SETTINGS_UI_HOMES_PATH,
  SETTINGS_UI_HOMES_SAVE_PATH,
  type SettingsUiHomesPayload,
  type SettingsUiHomesSaveRefusal,
  type SettingsUiHomesSaveRequest,
  type SettingsUiHomesSaveResponse,
} from '../../../contracts/src/settingsUiHomes.ts';
import {
  countDevicesInZoneSubtree,
  flattenZoneTreeForPicker,
  previewAreaDeviceCount,
  shouldPromptMainHomeMeter,
  suggestSubHomeRootZone,
  validateSubHomeDraft,
  type HomesZoneTree,
  type SubHomeDraftError,
  type SubHomeListEntry,
} from '../../../shared-domain/src/homesManagement.ts';
import {
  composeDraftErrorLine,
  composeDraftWarningLine,
  composeMeterOptionLabel,
  composeSubHomeSupportingLine,
  composeZonePickerOptionLabel,
  formatZoneDeviceCount,
  HOMES_REMOVED_TOAST,
  HOMES_SAVE_FAILED_TOAST,
  HOMES_SAVED_TOAST,
} from '../../../shared-domain/src/homesManagementCopy.ts';
import {
  composeHomeAreaSaveRefusalLine,
} from '../../../shared-domain/src/homeAreaConfigRulesCopy.ts';
import { callApi, getSettingFresh } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { ERROR_DURATION_MS, showToast, showToastError } from './toast.ts';
import {
  renderHomesSettingsSection,
  type HomesEditorView,
  type HomesPickerOption,
} from './views/HomesSettingsSection.tsx';

// Module-state controller for the "Multiple meters" sub-page (mirrors the
// weatherInsight.ts pattern): owns the latest `ui_homes` payload, the picker
// device lists, and the editor/delete state; renders the Preact section into
// `#homes-settings-mount` on the panel's activation hook.
//
// Write path: INTENT operations (upsert/delete of one area) POSTed to the
// typed `ui_homes_save` endpoint — the runtime re-reads the persisted config
// through its classified store reader, refuses on suspect, applies the op,
// and writes through the marker-first classified writer. The UI never
// composes a whole list, so a stale panel can never wipe other areas;
// `ui_homes` is refetched after every save so the list re-renders from the
// runtime's normalized truth.

type DeviceZoneInfo = { name: string; zoneId: string | null; zoneName: string | null };

type HomesEditorState = {
  mode: 'create' | 'edit';
  homeId: string | null;
  name: string;
  nameTouched: boolean;
  meterDeviceId: string | null;
  rootZoneId: string | null;
  zoneTouched: boolean;
  submitAttempted: boolean;
};

let latestPayload: SettingsUiHomesPayload | null = null;
let loadFailed = false;
// Every activation that overlaps the same homes read awaits this promise before
// it can release the stale-payload mutation lock.
let homesFetchInFlight: Promise<void> | null = null;
// Only the newest panel activation may publish advisory inputs or release the
// mutation lock after its full refresh settles.
let homesActivationGeneration = 0;
// Every freshness read (activation or post-mutation reconciliation) owns one
// lock generation. Only the newest owner may release mutations on settlement.
let homesMutationLockGeneration = 0;
// Every save/delete write owns one write generation. Only the newest write may
// reconcile: a refused or failed write releases the editor lock BEFORE its
// five-second instructional dwell (so the owner can act on the instruction),
// which lets a retry start AND land while the older handler is still parked on
// its toast. See `postHomesSaveOp`.
let homesWriteGeneration = 0;
// Mutation lock, distinct from `configDegraded`: true from panel (re)activation
// until that activation's fresh `ui_homes` read resolves. A cached `latestPayload`
// renders as ready IMMEDIATELY on re-entry (before the refetch lands), so without
// this gate a quick Edit could capture stale same-area fields and its full upsert
// overwrite newer same-area edits made elsewhere. It disables the mutation
// controls (Add / Edit / Remove / Save) — no degraded copy; it is a transient
// load lock, not the runtime-can't-vouch lockout.
let mutationsLocked = true;
let meterDevices: HomeyEnergyMeterEntry[] | null = null;
let meterDevicesLoading = false;
let deviceZoneById: Map<string, DeviceZoneInfo> | null = null;
let deviceZonesLoading = false;
let editor: HomesEditorState | null = null;
let confirmingDeleteHomeId: string | null = null;
let writeBusy = false;
// Main-meter-notice inputs, refreshed on every panel activation. Boundary
// rule: raw settings resolve to a trimmed string or flat null.
let powerSource: string | null = null;
let mainMeterDeviceId: string | null = null;
// True once `power_source` has been READ SUCCESSFULLY at least once this
// activation. Distinguishes a genuinely-absent value (unset install → the
// runtime treats it as Flow, so warn) from the pre-read boot window and a
// transient read error (unknown → stay silent, no flash / no false alarm).
let powerSourceResolved = false;

const asNonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value : null
);

const isConfigDegraded = (): boolean => latestPayload?.configDegraded === true;

const resolveZoneName = (zoneId: string | null): string | null => {
  if (zoneId === null || latestPayload?.zoneTree === null || latestPayload === null) return null;
  return latestPayload.zoneTree[zoneId]?.name ?? null;
};

const resolveMeterName = (meterDeviceId: string | null): string | null => {
  if (meterDeviceId === null) return null;
  const fromMeters = meterDevices?.find((device) => device.id === meterDeviceId)?.name;
  return fromMeters ?? deviceZoneById?.get(meterDeviceId)?.name ?? null;
};

/** The picked meter's zone id, when the snapshot knows the device; else null. */
const resolveMeterZoneId = (meterDeviceId: string | null): string | null => (
  meterDeviceId === null ? null : deviceZoneById?.get(meterDeviceId)?.zoneId ?? null
);

const currentHomes = (): SubHomeListEntry[] => latestPayload?.homes ?? [];

const countDevicesInHome = (homeId: string): number => {
  const membership = latestPayload?.membershipByDeviceId ?? {};
  return Object.values(membership).filter((entry) => entry.homeId === homeId).length;
};

// "Missing" errors stay quiet until a save attempt so a fresh form doesn't
// open covered in alerts; clash errors (duplicate name, meter in use, zone
// overlap) show live — the user can only fix them by changing the value.
const LIVE_ERROR_KINDS = new Set<SubHomeDraftError['kind']>([
  'name_duplicate', 'meter_in_use', 'zone_overlap', 'zone_is_root',
]);

const buildEditorView = (state: HomesEditorState): HomesEditorView => {
  const zones = latestPayload?.zoneTree ?? {};
  const validation = validateSubHomeDraft({
    draft: {
      homeId: state.homeId,
      name: state.name,
      meterDeviceId: state.meterDeviceId,
      rootZoneId: state.rootZoneId,
    },
    existing: currentHomes(),
    zones,
    meterZoneId: resolveMeterZoneId(state.meterDeviceId),
    mainMeterDeviceId,
  });
  const visibleErrors = validation.errors.filter(
    (error) => state.submitAttempted || LIVE_ERROR_KINDS.has(error.kind),
  );
  const errorLinesFor = (kinds: SubHomeDraftError['kind'][]): string[] => visibleErrors
    .filter((error) => kinds.includes(error.kind))
    .map((error) => composeDraftErrorLine(error));
  const meterOptions: HomesPickerOption[] = (meterDevices ?? [])
    .map((device) => ({
      id: device.id,
      label: composeMeterOptionLabel(device.name, deviceZoneById?.get(device.id)?.zoneName ?? null),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const zoneOptions: HomesPickerOption[] = flattenZoneTreeForPicker(zones)
    .map((option) => ({ id: option.id, label: composeZonePickerOptionLabel(option.name, option.depth) }));
  return {
    mode: state.mode,
    meterId: state.meterDeviceId,
    meterOptions,
    metersLoaded: meterDevices !== null,
    zoneId: state.rootZoneId,
    zoneOptions,
    zoneDeviceCountLine: buildZoneDeviceCountLine(state, zones),
    // Refetch reconciliation: the edited area vanished from the fresh list
    // (removed elsewhere) — the editor says so and Save reads "Add again".
    areaGone: state.mode === 'edit' && state.homeId !== null
      && !currentHomes().some((home) => home.homeId === state.homeId),
    name: state.name,
    meterErrors: errorLinesFor(['meter_missing', 'meter_in_use']),
    zoneErrors: errorLinesFor(['zone_missing', 'zone_overlap', 'zone_is_root']),
    zoneWarnings: validation.warnings.map((warning) => composeDraftWarningLine(warning)),
    nameErrors: errorLinesFor(['name_missing', 'name_duplicate']),
    busy: writeBusy,
    onMeterChange: handleMeterChange,
    onZoneChange: handleZoneChange,
    onNameInput: handleNameInput,
    onSave: () => { void handleSave(); },
    onCancel: handleCancel,
  };
};

/**
 * Live sweep preview under the Zone field. Primary path mirrors the real
 * resolver: the `ui_homes` membership (pins first, zone rule otherwise)
 * joined with the device-zone map. Fresh-boot fallback (no resolved
 * membership yet): a zone-containment estimate over the picker set, honestly
 * phrased "About N…". Null until a zone is chosen and zones have loaded.
 */
const buildZoneDeviceCountLine = (
  state: HomesEditorState,
  zones: HomesZoneTree,
): string | null => {
  if (state.rootZoneId === null || deviceZoneById === null) return null;
  const membership = latestPayload?.membershipByDeviceId ?? {};
  if (Object.keys(membership).length > 0) {
    return formatZoneDeviceCount(previewAreaDeviceCount({
      zones,
      rootZoneId: state.rootZoneId,
      membershipByDeviceId: membership,
      zoneIdByDeviceId: new Map(
        [...deviceZoneById.entries()].map(([deviceId, info]) => [deviceId, info.zoneId]),
      ),
      areaHomeId: state.homeId,
    }));
  }
  return formatZoneDeviceCount(countDevicesInZoneSubtree(
    zones,
    state.rootZoneId,
    [...deviceZoneById.values()].map((info) => info.zoneId),
  ), true);
};

const resolveSectionStatus = (): 'loading' | 'error' | 'ready' => {
  if (latestPayload !== null) return 'ready';
  return loadFailed ? 'error' : 'loading';
};

const renderSection = (): void => {
  const mount = document.getElementById('homes-settings-mount');
  if (!mount) return;
  const status = resolveSectionStatus();
  renderHomesSettingsSection(mount, {
    status,
    homes: currentHomes().map((home) => ({
      homeId: home.homeId,
      name: home.name,
      supportingLine: composeSubHomeSupportingLine({
        // While the device list is still loading an unresolved meter name gets
        // a neutral dash, never a premature "Meter not found".
        meterName: resolveMeterName(home.meterDeviceId)
          ?? (meterDevices === null && home.meterDeviceId !== null ? '—' : null),
        zoneName: resolveZoneName(home.rootZoneId),
        deviceCount: countDevicesInHome(home.homeId),
      }),
    })),
    zonesAvailable: latestPayload !== null && latestPayload.zoneTree !== null,
    configDegraded: isConfigDegraded(),
    mutationsLocked,
    // The degraded lockout owns the moment — the nudge waits for a healthy read.
    showMainMeterNotice: !isConfigDegraded() && shouldPromptMainHomeMeter({
      subHomeCount: currentHomes().length,
      powerSource,
      mainMeterDeviceId,
    }),
    // Flow power source: meter areas can't be measured (a Flow reading has no
    // meter identity). Mirror the runtime's `normalizePowerSource`, which treats
    // anything but 'homey_energy' — INCLUDING an absent setting — as Flow. Gate
    // on a successful read so the pre-read boot window and a transient read error
    // stay silent (no flash, no false alarm) while a genuinely-unset install
    // (which the runtime runs as Flow) still gets warned.
    showFlowSourceNotice: powerSourceResolved && powerSource !== 'homey_energy',
    editor: editor === null ? null : buildEditorView(editor),
    confirmingDeleteHomeId,
    deleteBusy: writeBusy,
    onAddClick: handleAddClick,
    onEditClick: handleEditClick,
    onDeleteClick: handleDeleteClick,
    onDeleteConfirm: (homeId) => { void handleDeleteConfirm(homeId); },
    onDeleteCancel: handleDeleteCancel,
  });
};

const beginHomesMutationLock = (): number => {
  homesMutationLockGeneration += 1;
  mutationsLocked = true;
  renderSection();
  return homesMutationLockGeneration;
};

const fetchHomes = async (ownedLockGeneration?: number): Promise<void> => {
  const lockGeneration = ownedLockGeneration ?? beginHomesMutationLock();
  if (homesFetchInFlight !== null) {
    await homesFetchInFlight;
  } else {
    const request = (async (): Promise<void> => {
      try {
        latestPayload = await callApi<SettingsUiHomesPayload>('GET', SETTINGS_UI_HOMES_PATH);
        loadFailed = false;
      } catch (error) {
        loadFailed = true;
        await logSettingsError('Failed to load meter areas', error, 'homesSettings');
      }
      renderSection();
    })();
    homesFetchInFlight = request;
    try {
      await request;
    } finally {
      if (homesFetchInFlight === request) homesFetchInFlight = null;
    }
  }
  if (lockGeneration !== homesMutationLockGeneration) return;
  mutationsLocked = loadFailed;
  renderSection();
};

// Both picker lists refetch on EVERY panel activation (no permanent
// first-load cache — a device renamed/added/deleted in Homey must show on the
// next open), keeping last-good on a failed fetch and deduping in-flight.
const refreshMeterDevices = async (): Promise<void> => {
  if (meterDevicesLoading) return;
  meterDevicesLoading = true;
  try {
    const meters = await callApi<HomeyEnergyMeterEntry[] | null>('GET', HOMEY_ENERGY_METERS_PATH);
    // An empty result never overwrites last-good (it can be transient) —
    // mirrors the whole-home meter picker in homeyEnergyMeter.ts.
    if (meters !== null && meters.length > 0) meterDevices = meters;
    renderSection();
  } catch (error) {
    await logSettingsError('Failed to load meters for the meter picker', error, 'homesSettings');
  } finally {
    meterDevicesLoading = false;
  }
};

const refreshDeviceZones = async (): Promise<void> => {
  if (deviceZonesLoading) return;
  deviceZonesLoading = true;
  try {
    const payload = await callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH);
    deviceZoneById = new Map(payload.devices.map((device) => [device.id, {
      name: device.name,
      zoneId: device.zoneId ?? null,
      zoneName: device.zone ?? null,
    }]));
    renderSection();
  } catch (error) {
    // Zone enrichment is best-effort: without it the meter options lose their
    // zone suffix and the zone prefill, but the flow still works.
    await logSettingsError('Failed to load device zones for the meter picker', error, 'homesSettings');
  } finally {
    deviceZonesLoading = false;
  }
};

const handleAddClick = (): void => {
  if (isConfigDegraded() || mutationsLocked) return;
  editor = {
    mode: 'create',
    homeId: null,
    name: '',
    nameTouched: false,
    meterDeviceId: null,
    rootZoneId: null,
    zoneTouched: false,
    submitAttempted: false,
  };
  confirmingDeleteHomeId = null;
  renderSection();
};

const handleEditClick = (homeId: string): void => {
  if (isConfigDegraded() || mutationsLocked) return;
  const home = currentHomes().find((entry) => entry.homeId === homeId);
  if (home === undefined) return;
  editor = {
    mode: 'edit',
    homeId: home.homeId,
    name: home.name,
    nameTouched: true,
    meterDeviceId: home.meterDeviceId,
    rootZoneId: home.rootZoneId,
    zoneTouched: true,
    submitAttempted: false,
  };
  confirmingDeleteHomeId = null;
  renderSection();
};

const applyZoneDefaults = (zoneId: string | null): void => {
  if (editor === null) return;
  editor.rootZoneId = zoneId;
  if (!editor.nameTouched) {
    editor.name = (zoneId !== null ? resolveZoneName(zoneId) : null) ?? editor.name;
  }
};

const handleMeterChange = (deviceId: string | null): void => {
  if (editor === null) return;
  editor.meterDeviceId = deviceId;
  // Ancestor-walk prefill: from the meter's zone up to the highest ancestor
  // disjoint from every OTHER area's meter zone + root zone. Skipped once the
  // user has picked a zone by hand, or when the meter's zone is unknown.
  if (!editor.zoneTouched && deviceId !== null) {
    const meterZoneId = resolveMeterZoneId(deviceId);
    if (meterZoneId !== null && latestPayload !== null && latestPayload.zoneTree !== null) {
      const others = currentHomes().filter((entry) => entry.homeId !== editor?.homeId);
      const reserved = [
        ...others.flatMap((entry) => {
          const zoneId = resolveMeterZoneId(entry.meterDeviceId);
          return zoneId === null ? [] : [zoneId];
        }),
        ...others.map((entry) => entry.rootZoneId),
      ];
      const suggestion = suggestSubHomeRootZone(latestPayload.zoneTree, meterZoneId, reserved);
      // No fallback on a null suggestion (e.g. a meter in the zone-forest
      // root): the zone stays unselected and the user must choose explicitly —
      // a silent fallback could sweep far more than intended.
      if (suggestion !== null) applyZoneDefaults(suggestion);
    }
  }
  renderSection();
};

const handleZoneChange = (zoneId: string | null): void => {
  if (editor === null) return;
  editor.zoneTouched = true;
  applyZoneDefaults(zoneId);
  renderSection();
};

const handleNameInput = (name: string): void => {
  if (editor === null) return;
  editor.name = name;
  editor.nameTouched = true;
  renderSection();
};

const handleCancel = (): void => {
  editor = null;
  renderSection();
};

/** How one write ended, from the point of view of the handler that issued it. */
type HomesWriteOutcome = {
  /** The runtime applied the op. */
  applied: boolean;
  /**
   * A newer write began before this handler left the screen, so the newer
   * handler owns the reconcile and this one must not touch shared state.
   */
  superseded: boolean;
};

/**
 * POST one intent op to the typed save endpoint. The runtime owns the real
 * protections (fresh classified read, refuse-on-suspect, marker-first
 * write); a typed refusal maps to the degraded copy or the save-failed
 * toast.
 */
const postHomesSaveOp = async (op: SettingsUiHomesSaveRequest): Promise<HomesWriteOutcome> => {
  homesWriteGeneration += 1;
  const writeGeneration = homesWriteGeneration;
  // Reconciliation fence, evaluated when this handler finally returns — which
  // for a refusal is AFTER its toast dwell, long after its own write ended.
  // A handler the dwell outlived must not reconcile: its `fetchHomes()` would
  // issue a GET reading the roster from before the retry's write, and the
  // retry's own reconciliation would coalesce onto that in-flight read
  // (`homesFetchInFlight`) instead of taking a post-write one — closing the
  // editor and reporting success over a payload that omits the saved change.
  const outcome = (applied: boolean): HomesWriteOutcome => ({
    applied,
    superseded: writeGeneration !== homesWriteGeneration,
  });
  writeBusy = true;
  renderSection();
  // Every branch below releases the lock as soon as ITS write is over, before
  // awaiting a toast dwell. `released` keeps the finally backstop from
  // clobbering the busy flag a newer write may have taken during that dwell:
  // the flag guards whichever write is in flight, not this handler's lifetime
  // (same released-flag backstop as `handleMeterSelectionChange` in
  // homeyEnergyMeter.ts).
  let released = false;
  const releaseWriteLock = (): void => {
    if (released) return;
    released = true;
    writeBusy = false;
  };
  try {
    const response = await callApi<SettingsUiHomesSaveResponse>('POST', SETTINGS_UI_HOMES_SAVE_PATH, op);
    if (response.ok) return outcome(true);
    // The settings-UI tsconfig runs `strict: false`, which erases the boolean
    // discriminant, so `if (response.ok) return` does NOT narrow `response` to
    // the failure variant here — extract the refusal through the typed variant
    // the early return has already proven. Every refusal names its own next
    // step; only genuinely shapeless ones fall back to the save-failed line.
    // Error dwell, not the 1.8 s acknowledgement default: these are two-sentence
    // instructions, and a typed refusal is not an Error so `showToastError`
    // (which applies it automatically) does not fit.
    //
    // The write is over, so release the editor lock BEFORE the dwell: the
    // refusal names a next step (remove an area, pick a meter) but Cancel and
    // Save disable while busy, so holding the lock through the five-second
    // toast would bar the user from acting on the very instruction on screen.
    releaseWriteLock();
    renderSection();
    await showToast(
      composeHomeAreaSaveRefusalLine(response as SettingsUiHomesSaveRefusal),
      'warn',
      { durationMs: ERROR_DURATION_MS },
    );
    return outcome(false);
  } catch (error) {
    // Same release-before-dwell as the refusal branch: the failed write is
    // over, so the save-failed toast must not keep the editor locked either.
    releaseWriteLock();
    renderSection();
    await logSettingsError('Failed to save meter areas', error, 'homesSettings');
    await showToastError(error, HOMES_SAVE_FAILED_TOAST);
    return outcome(false);
  } finally {
    releaseWriteLock();
  }
};

const handleSave = async (): Promise<void> => {
  // UX guard only — the endpoint re-checks against a FRESH classified read,
  // so a degraded flip between this check and the write cannot slip through.
  // `mutationsLocked` bars a save composed from a not-yet-refreshed payload.
  if (editor === null || latestPayload === null || writeBusy || isConfigDegraded() || mutationsLocked) return;
  const state = editor;
  const validation = validateSubHomeDraft({
    draft: {
      homeId: state.homeId,
      name: state.name,
      meterDeviceId: state.meterDeviceId,
      rootZoneId: state.rootZoneId,
    },
    existing: currentHomes(),
    zones: latestPayload.zoneTree ?? {},
    meterZoneId: resolveMeterZoneId(state.meterDeviceId),
    mainMeterDeviceId,
  });
  if (validation.errors.length > 0) {
    state.submitAttempted = true;
    renderSection();
    return;
  }
  // The errors gate above guarantees meter + zone are set.
  if (state.meterDeviceId === null || state.rootZoneId === null) return;
  // Intent op, not a list: create sends no id (the runtime allocates it);
  // edit names the area's id — an upsert of a since-vanished id honestly
  // re-adds it ("Add again").
  const { applied, superseded } = await postHomesSaveOp({
    op: 'upsert',
    area: {
      ...(state.homeId === null ? {} : { homeId: state.homeId }),
      name: state.name.trim(),
      rootZoneId: state.rootZoneId,
      meterDeviceId: state.meterDeviceId,
    },
  });
  // A retry started (and may have already landed) during this write's toast
  // dwell. It owns the editor and the reconcile; reading the roster from here
  // would publish a pre-retry snapshot the retry then reuses as its own.
  if (superseded) return;
  if (!applied) {
    await fetchHomes();
    return;
  }
  editor = null;
  await fetchHomes();
  await showToast(HOMES_SAVED_TOAST, 'ok');
};

const handleDeleteClick = (homeId: string): void => {
  if (isConfigDegraded() || mutationsLocked) return;
  confirmingDeleteHomeId = homeId;
  renderSection();
};

const handleDeleteCancel = (): void => {
  confirmingDeleteHomeId = null;
  renderSection();
};

const handleDeleteConfirm = async (homeId: string): Promise<void> => {
  // UX guard only — the endpoint re-checks against a fresh classified read.
  if (latestPayload === null || writeBusy || isConfigDegraded() || mutationsLocked) return;
  const { applied, superseded } = await postHomesSaveOp({ op: 'delete', homeId });
  // Same fence as `handleSave`: a superseded handler must neither reconcile
  // nor close a confirmation the owner opened during its dwell.
  if (superseded) return;
  confirmingDeleteHomeId = null;
  await fetchHomes();
  if (applied) await showToast(HOMES_REMOVED_TOAST, 'ok');
};

/**
 * Panel-activation hook (realtime.ts `showTab('homes')`): render immediately
 * (skeleton on first open), refetch `ui_homes` so the view never sits on a
 * stale snapshot, and refresh BOTH picker lists (no permanent cache).
 */
// Re-read (cache-bypassing) on every activation so configuring the
// whole-home meter (or switching power source) under Limits & safety retires
// the nudge on return.
const refreshMainMeterNoticeInputs = async (activationGeneration: number): Promise<void> => {
  const [powerSourceRead, mainMeterRead] = await Promise.allSettled([
    getSettingFresh(POWER_SOURCE),
    getSettingFresh(HOMEY_ENERGY_METER_DEVICE_ID),
  ]);
  let nextPowerSource: string | null = null;
  let nextPowerSourceResolved = false;
  let nextMainMeterDeviceId: string | null = null;
  if (powerSourceRead.status === 'fulfilled') {
    nextPowerSource = asNonEmptyString(powerSourceRead.value);
    nextPowerSourceResolved = true;
  } else {
    // The Flow-source warning depends only on this read. An unrelated whole-
    // home-meter failure must not suppress it.
    await logSettingsError(
      'Failed to read power-source notice setting',
      powerSourceRead.reason,
      'homesSettings',
    );
  }
  if (mainMeterRead.status === 'fulfilled') {
    nextMainMeterDeviceId = asNonEmptyString(mainMeterRead.value);
  } else {
    // Main-meter notice input is advisory: unknown resolves to no prompt while
    // preserving any independently resolved Flow-source warning.
    await logSettingsError(
      'Failed to read whole-home-meter notice setting',
      mainMeterRead.reason,
      'homesSettings',
    );
  }
  if (activationGeneration !== homesActivationGeneration) return;
  powerSource = nextPowerSource;
  powerSourceResolved = nextPowerSourceResolved;
  mainMeterDeviceId = nextMainMeterDeviceId;
};

export const refreshHomesOnHomesPanel = async (): Promise<void> => {
  const activationGeneration = homesActivationGeneration + 1;
  homesActivationGeneration = activationGeneration;
  // Lock mutations until this activation's fresh `ui_homes` read lands, so a
  // cached (possibly stale) payload rendering as ready cannot be mutated over.
  const lockGeneration = beginHomesMutationLock();
  void refreshMeterDevices();
  void refreshDeviceZones();
  await refreshMainMeterNoticeInputs(activationGeneration);
  if (activationGeneration !== homesActivationGeneration) return;
  await fetchHomes(lockGeneration);
  if (activationGeneration !== homesActivationGeneration) return;
};
