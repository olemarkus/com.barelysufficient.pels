import { HOMES_CONFIG, MAIN_HOME_ID } from '../../../contracts/src/settingsKeys.ts';
import { SETTINGS_UI_HOMES_PATH } from '../../../contracts/src/settingsUiHomes.ts';
import { MAIN_HOME_NAME } from '../../../shared-domain/src/homeScopeCopy.ts';
import { resolveHomeAreaDisplayName } from '../../../shared-domain/src/homesManagementCopy.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { state } from './state.ts';
import { renderHomeScopeBar, type HomeScopeOption } from './views/HomeScopeBar.tsx';

/**
 * The shell's global home scope: which part of the home (Main home, or one
 * configured meter area) the visible page is about.
 *
 * One owner for three things the rest of the UI reads rather than re-derives:
 * the meter-area roster served by `ui_homes`, the selected home, and the 48 px
 * scope bar that renders it. Consumers subscribe; they never own a selection of
 * their own (the per-home Limits editor used to, and that switcher retired into
 * this bar).
 *
 * Honesty rule: the bar renders ONLY on a page whose content is already
 * resolved against the selected home. A bar promising a scope the page does not
 * honour would be a lie, so `SCOPE_AWARE_PANELS` — not the roster alone — gates
 * visibility, and later train PRs add their panel id as each surface learns the
 * scope.
 */

/**
 * Panels whose content is resolved against the selected home today. Grow this
 * set in the PR that teaches a surface the scope, never ahead of it:
 * Devices/Modes and the explicit not-supported-yet states each land in their
 * own train PR. `usage` honours the scope through `readUsagePower` (its
 * history, hero, and charts resolve from the selected home's own tracker,
 * with an honest unavailable state). `overview` honours it through
 * `readOverviewPlan` + the scope-following `refreshPlan` in `planRedesign.ts`
 * (hero + device cards from the selected home's own plan/power, Main-only
 * elements omitted, honest unavailable notice).
 */
const SCOPE_AWARE_PANELS = new Set(['limits', 'usage', 'overview']);

/**
 * Persisted selection. Namespaced under `pels.` so it cannot collide with other
 * Homey-shell consumers, and under `shell` because the scope belongs to the
 * whole WebView rather than one surface (the same convention as the smart-task
 * history device filter).
 */
const SCOPE_STORAGE_KEY = 'pels.shell.homeScope';

const SCOPE_BAR_MOUNT_ID = 'home-scope-bar';

export type HomeScopeArea = { homeId: string; name: string };

export type HomeScopeState = {
  /** `main` or a meter-area id that the last fresh roster confirmed exists. */
  selectedHomeId: string;
  /** Read-only view: this module is the single owner of the roster. */
  areas: readonly HomeScopeArea[];
  /**
   * Producer-resolved activation posture from `ui_homes`. False is not
   * simulation: it is a held legacy config whose devices still belong to Main.
   */
  runtimeActive: boolean;
};

let areas: HomeScopeArea[] = [];
let runtimeActive = false;
let selectedHomeId: string = MAIN_HOME_ID;
// Armed at boot, consumed by the session's first roster resolution: the
// persisted id is only ever a CANDIDATE. A stale id (its area deleted from
// another WebView, or by this one before a reload) must never resurrect a scope
// that has no home behind it.
let persistedCandidate: string | null = null;
// Whether the chip's home menu is showing. Owned here rather than inside the
// Preact view because Material closes its own menu (item activation, outside
// click, Escape) without telling Preact: as view state the rendered vdom would
// keep `open: true` against a closed element, and the next open would diff to a
// no-op. The view's `onMenuOpenChange` — fed by the element's own `closed`
// event — keeps this in step with reality.
let menuOpen = false;
let tabListenerBound = false;
// Monotonic refresh id. `homes_config` notifications and panel activations can
// start overlapping `ui_homes` reads, and they may settle out of order — an
// older answer landing last would resurrect a deleted area or drop a new one.
let rosterGeneration = 0;
const listeners = new Set<() => void>();

// localStorage may be unavailable inside the Homey iframe (privacy mode,
// sandboxed contexts, jsdom-less test envs). Both helpers swallow access errors
// so a missing/forbidden storage surface degrades to "no persistence" rather
// than crashing the shell.
const readPersistedScope = (): string | null => {
  try {
    const value = window.localStorage.getItem(SCOPE_STORAGE_KEY);
    if (typeof value !== 'string' || value.length === 0) return null;
    return value;
  } catch {
    return null;
  }
};

const writePersistedScope = (homeId: string): void => {
  try {
    if (homeId === MAIN_HOME_ID) {
      // Main is the default; storing it would only keep a value to invalidate.
      window.localStorage.removeItem(SCOPE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SCOPE_STORAGE_KEY, homeId);
  } catch {
    // Storage failures degrade to in-memory-only scope; the bar still reflects
    // the pick for the current session.
  }
};

export const getHomeScope = (): HomeScopeState => ({ selectedHomeId, areas, runtimeActive });


/** Register a consumer of the selected home. There is no unsubscribe: every
 * subscriber is a long-lived shell controller. */
export const subscribeToHomeScope = (listener: () => void): void => {
  listeners.add(listener);
};

// One failing subscriber must not silently strand the others: a throw here
// would otherwise abort the remaining listeners mid-notification, leaving those
// panels on a scope the shell has already moved off.
const notifyListeners = (): void => {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (caught) {
      void logSettingsError('Home scope listener failed', caught, 'homeScope');
    }
  });
};

const buildOptions = (): HomeScopeOption[] => [
  { homeId: MAIN_HOME_ID, label: MAIN_HOME_NAME },
  ...areas.map((area) => ({ homeId: area.homeId, label: area.name })),
];

const renderScopeBar = (): void => {
  const mount = document.getElementById(SCOPE_BAR_MOUNT_ID);
  if (!mount) return;
  const visible = areas.length > 0 && SCOPE_AWARE_PANELS.has(state.activePanel);
  // The mount ships `hidden` (display:none) so an empty node never occupies a
  // `main.screen` grid row — a home with no meter areas keeps a shell layout
  // identical to a single-meter install. Only a real meter area un-hides it.
  mount.hidden = !visible;
  // Hiding the bar closes the menu's LOGICAL state too: the unmounting menu's
  // own `closed` echo is deliberately ignored (stale-echo guard), so without
  // this a picker left open while navigating away would remount already open
  // on the next scope-aware panel, popping over the page with no user action.
  if (!visible) menuOpen = false;
  renderHomeScopeBar(mount, {
    visible,
    options: buildOptions(),
    selectedHomeId,
    menuOpen,
    onMenuOpenChange: (open: boolean) => {
      if (menuOpen === open) return;
      menuOpen = open;
      renderScopeBar();
    },
    // Late-bound on purpose: the picker below is declared after this renderer.
    onSelectHome: (homeId: string) => {
      // Close first: `selectHomeScope` repaints, and the repaint must already
      // carry the closed state or the menu would linger over the new scope.
      menuOpen = false;
      selectHomeScope(homeId);
    },
  });
};

/**
 * Pick a home. Any id the current roster does not contain resolves to the Main
 * home, so a stale option can never leave the shell claiming a scope that has
 * no home behind it.
 */
export const selectHomeScope = (homeId: string): void => {
  const resolved = areas.some((area) => area.homeId === homeId) ? homeId : MAIN_HOME_ID;
  // An explicit pick disarms a still-pending persisted candidate and rewrites
  // the stored scope even when the id matches the current one: before the first
  // roster read, `selectedHomeId` is already Main while the previous session's
  // area sits armed in `persistedCandidate` — without this, a Main-only deep
  // link's explicit pick would be silently overridden moments later by the
  // roster reconcile adopting that stale candidate.
  persistedCandidate = null;
  writePersistedScope(resolved);
  if (resolved === selectedHomeId) {
    // Still repaint: a rejected pick must snap the select back to the scope
    // that is actually in force.
    renderScopeBar();
    return;
  }
  selectedHomeId = resolved;
  renderScopeBar();
  notifyListeners();
};

/**
 * Reconcile the selection against a roster that was just read successfully. A
 * failed read keeps the last-good scope (abandon-grace): blanking the shell on
 * a momentary SDK/network miss would drop the user's selected area mid-session.
 */
const reconcileSelection = (): void => {
  const candidate = persistedCandidate;
  if (candidate !== null) {
    persistedCandidate = null;
    if (areas.some((area) => area.homeId === candidate)) {
      selectedHomeId = candidate;
      return;
    }
    // The persisted area is gone; clear the key so it cannot be adopted by a
    // later session either.
    writePersistedScope(MAIN_HOME_ID);
  }
  if (selectedHomeId === MAIN_HOME_ID) return;
  if (areas.some((area) => area.homeId === selectedHomeId)) return;
  selectedHomeId = MAIN_HOME_ID;
  writePersistedScope(MAIN_HOME_ID);
};

/**
 * Refetch the meter-area roster, reconcile the selection against it, and
 * repaint the bar. Call this from a scope-aware panel's activation hook so the
 * bar never sits on a stale roster. Does NOT notify subscribers — the caller is
 * already refreshing that surface; `notifyHomeScopeSettingChanged` is the path
 * for changes that arrive on their own.
 */
/**
 * The `ui_homes` read resolved to a semantic result. This adapter owns the
 * COMPLETE classification of what comes back — thrown, malformed, degraded, or
 * good — so the scope logic below never inspects a raw payload or branches on
 * why a read failed (root AGENTS.md, "Validation belongs at the boundary").
 */
type RosterRead =
  | { status: 'resolved'; areas: HomeScopeArea[]; runtimeActive: boolean }
  | { status: 'unavailable' };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

const asAreaName = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

// Domain validity for an area id, mirroring the runtime's `isValidSubHomeId`
// (`lib/home/homeConfig.ts`): never the Main sentinel, no `':'` (the separator
// suffixed per-home settings keys ride on), never an Object.prototype-colliding
// key. Duplicated because the settings UI must not import runtime backend code
// (root AGENTS.md, accepted duplication at an architecture boundary) — keep the
// two rejection sets aligned.
const DANGEROUS_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isValidRosterAreaId = (value: string): boolean => (
  value !== MAIN_HOME_ID && !value.includes(':') && !DANGEROUS_RECORD_KEYS.has(value)
);

const resolveRosterPayload = (payload: unknown): RosterRead => {
  if (!isRecord(payload)) return { status: 'unavailable' };
  // `configDegraded` is the runtime saying it cannot vouch for what it served:
  // the `homes` array may be a stale or empty cache while real meter areas are
  // still persisted. Trusting it would clear the roster, reconcile the user's
  // area selection to Main and delete the stored key — a later healthy read
  // could then never restore the scope. Same treatment as a failed read.
  // Only a literal `false` is a vouch: an absent or non-boolean flag is the
  // runtime saying nothing at all, and absence of a denial is not an
  // affirmation of health.
  if (typeof payload.configDegraded !== 'boolean' || payload.configDegraded) {
    return { status: 'unavailable' };
  }
  if (typeof payload.runtimeActive !== 'boolean') return { status: 'unavailable' };
  if (!Array.isArray(payload.homes)) return { status: 'unavailable' };
  const resolved: HomeScopeArea[] = [];
  for (const home of payload.homes) {
    if (!isRecord(home)) return { status: 'unavailable' };
    const homeId = asAreaName(home.homeId);
    // The NAME is display data, not identity: the runtime legitimately serves
    // areas with empty or whitespace-only names, and the canonical rule
    // renders those as "Meter area" — rejecting one here would hide the whole
    // scope bar for a valid area, and admitting raw whitespace would render a
    // blank picker label. Only a non-string name marks the payload malformed.
    if (homeId === null || typeof home.name !== 'string') return { status: 'unavailable' };
    const name = resolveHomeAreaDisplayName(home.name);
    // A reserved, colon-carrying, dangerous, or duplicate id is one the runtime
    // could never have served (its normalizer enforces `isValidSubHomeId` and
    // de-duplicates), so the whole roster is untrustworthy: an admitted phantom
    // would be a pickable scope whose suffixed settings keys no home owns.
    if (!isValidRosterAreaId(homeId) || resolved.some((area) => area.homeId === homeId)) {
      return { status: 'unavailable' };
    }
    resolved.push({ homeId, name });
  }
  return { status: 'resolved', areas: resolved, runtimeActive: payload.runtimeActive };
};

export const refreshHomeScope = async (): Promise<void> => {
  rosterGeneration += 1;
  const generation = rosterGeneration;
  let read: RosterRead = { status: 'unavailable' };
  try {
    read = resolveRosterPayload(await callApi<unknown>('GET', SETTINGS_UI_HOMES_PATH));
    if (read.status === 'unavailable') {
      await logSettingsError('Unusable meter-area roster payload', undefined, 'homeScope');
    }
  } catch (caught) {
    await logSettingsError('Failed to load the meter-area roster', caught, 'homeScope');
  }
  // A newer refresh started while this one was in flight; its answer wins and
  // will paint. Applying this stale one could resurrect a just-deleted area.
  if (generation !== rosterGeneration) return;
  if (read.status === 'resolved') {
    // Only a vouched-for response reshapes the roster — an empty `homes` here is
    // a real "no meter areas" state and correctly clears it. Anything else keeps
    // the last-good roster and the still-armed persisted candidate.
    areas = read.areas;
    runtimeActive = read.runtimeActive;
    reconcileSelection();
  }
  renderScopeBar();
};

/**
 * Realtime `settings.set` hook. A roster change (an area added or removed from
 * the Multiple-meters panel, or from a second WebView) rewrites `homes_config`;
 * refetch so the bar and every subscriber track it. Deliberately NOT gated on
 * the shown panel: the common edit happens on the Multiple-meters panel, and
 * skipping the refetch there would let the next hop into a scope-aware page
 * paint the bar from a roster that still lists a just-deleted area. Roster edits
 * are rare, so one `ui_homes` GET per edit is the cheaper side of that trade.
 */
export const notifyHomeScopeSettingChanged = (key: string): void => {
  if (key !== HOMES_CONFIG) return;
  void refreshHomeScope()
    .then(() => { notifyListeners(); })
    .catch((caught: unknown) => logSettingsError('Failed to refresh the home scope', caught, 'homeScope'));
};

/**
 * Boot wiring. Arms the persisted pick for this session's first roster
 * resolution, and repaints the bar whenever the shown panel changes — its
 * visibility depends on the panel as well as the roster. Registered after
 * `initTabHandlers` so `state.activePanel` is already updated for this event.
 */
export const initHomeScope = (): void => {
  persistedCandidate = readPersistedScope();
  if (!tabListenerBound) {
    tabListenerBound = true;
    document.addEventListener('pels:tab-shown', () => { renderScopeBar(); });
  }
  renderScopeBar();
};
