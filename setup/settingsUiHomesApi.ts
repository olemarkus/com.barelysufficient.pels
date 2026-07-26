import type Homey from 'homey';
import type {
  SettingsUiHomesPayload,
  SettingsUiHomesSaveRequest,
  SettingsUiHomesSaveResponse,
} from '../packages/contracts/src/settingsUiHomes';
import {
  generateHomeId,
  isValidSubHomeId,
  resolveExplicitMainMeterDeviceId,
  type HomeConfig,
  type SubHomeConfig,
} from '../lib/home/homeConfig';
import { createHomesStore } from './homeRegistryAdapter';
import type { HomeMembershipDiagnostics, HomeMembershipService } from './homeMembership';
import { commitHomesConfigWriteWithTrackerFreshnessReset } from './homeRuntime/homeTrackerConfigSafety';
import {
  areaRootsAtForestRoot,
  saveMainMeterSelection,
  violatesComposedHomeInvariants,
} from './homeMeterOwnership';

type HomesApiContext = {
  homey: Homey.App['homey'];
};

// The multi-home membership cache. `AppContext` deliberately types this member
// as the lib/home PORT (control surface only); this setup-internal narrowing
// re-narrows to the concrete service the wiring assigned, because the read-only
// `ui_homes` endpoint is the ONE sanctioned consumer of the diagnostics view
// (per-device `source`). Optional: unassigned during the boot window before
// `initHomeMembership` runs.
type HomesApiApp = Homey.App & {
  homeMembership?: HomeMembershipService;
};

const getHomeMembership = (homey: Homey.App['homey']): HomeMembershipService | undefined => {
  if (!homey || typeof homey !== 'object') return undefined;
  return (homey.app as HomesApiApp | undefined)?.homeMembership;
};

// The full "config degraded" condition, as ONE predicate shared by the
// read payload (its `configDegraded` field → the UI's degraded copy) and the
// write seam (its refusal), so the two can never diverge. Degraded ⇔ no wired
// membership service (boot window) OR the last recompute classified EITHER
// persisted store (`homes_config` / `device_home_assignments`) `'suspect'`. A
// whole-value write composed while any of these holds could erase persisted
// areas — hence the write refuses on exactly the same condition the read reports.
const isHomesConfigDegraded = (diagnostics: HomeMembershipDiagnostics | undefined): boolean => (
  diagnostics === undefined || diagnostics.configDegraded
);

// Read-only multi-home view: the membership cache's diagnostics composed into
// the contracts mirror (`SettingsUiHomesPayload`). Before `initHomeMembership`
// runs (boot window) the payload is the honest empty single-home shape. Writes
// go through the `homes_config`/`device_home_assignments` settings keys, never
// through this endpoint.
export const getSettingsUiHomesPayload = ({ homey }: HomesApiContext): SettingsUiHomesPayload => {
  const diagnostics = getHomeMembership(homey)?.getDiagnostics();
  if (!diagnostics) {
    return {
      // Boot window: nothing can vouch for the persisted config, so the
      // payload is the empty single-home shape AND degraded — the UI must not
      // compose a whole-value homes_config write from this view.
      homes: [], membershipByDeviceId: {}, zoneTree: null, hasSubHomes: false, runtimeActive: false,
      configDegraded: true,
    };
  }
  // Uniform copy discipline: shallow-copy ALL collection members so the
  // composed payload never aliases the service's live caches (a future
  // in-process consumer mutating the payload must not corrupt membership).
  return {
    homes: [...diagnostics.subHomes],
    membershipByDeviceId: { ...diagnostics.membershipByDeviceId },
    zoneTree: diagnostics.zoneTree === null ? null : { ...diagnostics.zoneTree },
    hasSubHomes: diagnostics.hasSubHomes,
    runtimeActive: diagnostics.runtimeActive,
    configDegraded: isHomesConfigDegraded(diagnostics),
  };
};

// ── ui_homes_save: the Multiple meters UI's ONLY ownership-write seam ───────
// Intent operations (upsert/delete ONE area or select Main's explicit meter),
// never client-composed state: the runtime re-reads the persisted config
// through the CLASSIFIED store reader, refuses when it classifies suspect,
// then applies one operation. Area writes use the marker-first classified
// writer; Main-meter writes validate and persist synchronously in this same
// server turn. The app's single-threaded event loop therefore serializes both
// sides of meter ownership, and stale panels cannot wipe or double-own areas.

const asSaveRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const toSaveNonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

type ParsedUpsertArea = Extract<SettingsUiHomesSaveRequest, { op: 'upsert' }>['area'];

/** Boundary parse of an upsert `area` payload; `null` = malformed. */
const parseUpsertArea = (value: unknown): ParsedUpsertArea | null => {
  const area = asSaveRecord(value);
  if (!area) return null;
  // A present-but-malformed homeId must refuse, never silently become a create.
  let homeId: string | undefined;
  if (area.homeId !== undefined) {
    if (typeof area.homeId !== 'string' || !isValidSubHomeId(area.homeId)) return null;
    homeId = area.homeId;
  }
  if (typeof area.name !== 'string') return null;
  const rootZoneId = toSaveNonEmptyString(area.rootZoneId);
  if (rootZoneId === null) return null;
  // Explicit null = no meter (the domain allows it); anything else must be a
  // non-empty string — absent/malformed refuses rather than coercing.
  const meterRaw = area.meterDeviceId;
  const meterDeviceId = meterRaw === null ? null : toSaveNonEmptyString(meterRaw);
  if (meterRaw !== null && meterDeviceId === null) return null;
  return {
    ...(homeId === undefined ? {} : { homeId }), name: area.name, rootZoneId, meterDeviceId,
  };
};

/** Boundary parse of the untrusted request body; `null` = malformed. */
const parseHomesSaveRequest = (body: unknown): SettingsUiHomesSaveRequest | null => {
  const record = asSaveRecord(body);
  if (!record) return null;
  if (record.op === 'set_main_meter') {
    const meterRaw = record.meterDeviceId;
    if (meterRaw === null) return { op: 'set_main_meter', meterDeviceId: null };
    const meterDeviceId = resolveExplicitMainMeterDeviceId(meterRaw);
    return meterDeviceId === null ? null : { op: 'set_main_meter', meterDeviceId };
  }
  if (record.op === 'delete') {
    const homeId = toSaveNonEmptyString(record.homeId);
    return homeId !== null && isValidSubHomeId(homeId) ? { op: 'delete', homeId } : null;
  }
  if (record.op !== 'upsert') return null;
  const area = parseUpsertArea(record.area);
  return area === null ? null : { op: 'upsert', area };
};

const applyHomesUpsert = (
  current: readonly SubHomeConfig[],
  area: Extract<SettingsUiHomesSaveRequest, { op: 'upsert' }>['area'],
): SubHomeConfig[] => {
  // Id allocation is the runtime's (create = absent id); an upsert with a
  // vanished id honestly re-adds the area — the UI's "Add again" semantics.
  const homeId = area.homeId ?? generateHomeId(current.map((entry) => entry.homeId));
  const entry: SubHomeConfig = {
    homeId, name: area.name, rootZoneId: area.rootZoneId, meterDeviceId: area.meterDeviceId,
  };
  return current.some((existing) => existing.homeId === homeId)
    ? current.map((existing) => (existing.homeId === homeId ? entry : existing))
    : [...current, entry];
};

type AreaMutationRequest = Exclude<SettingsUiHomesSaveRequest, { op: 'set_main_meter' }>;

const saveAreaMutation = (
  homey: Homey.App['homey'],
  request: AreaMutationRequest,
): SettingsUiHomesSaveResponse => {
  const zoneTree = getHomeMembership(homey)?.getDiagnostics().zoneTree ?? null;
  if (areaRootsAtForestRoot(request, zoneTree)) return { ok: false, reason: 'invalid' };
  // Refuse whenever the ui_homes read would report degraded — an unwired
  // membership service (boot window) OR EITHER persisted store `'suspect'` as
  // of the last recompute — not merely a suspect homes-store read: composing a
  // whole-value write over an unknown/stale config could erase areas. Shares
  // the read payload's predicate so the two gates can never diverge; the UI
  // maps this refusal to its degraded copy.
  if (isHomesConfigDegraded(getHomeMembership(homey)?.getDiagnostics())) {
    return { ok: false, reason: 'degraded' };
  }
  const store = createHomesStore(homey);
  const read = store.read();
  // TOCTOU close: a FRESH classified read (the homes store can go suspect
  // between the last recompute and now). The persisted truth is unknown, and
  // applying an op over a guess could erase areas.
  if (read.state === 'suspect') return { ok: false, reason: 'degraded' };
  const currentConfig: HomeConfig = read.state === 'present' ? read.value : { subHomes: [] };
  const next = request.op === 'delete'
    ? currentConfig.subHomes.filter((area) => area.homeId !== request.homeId)
    : applyHomesUpsert(currentConfig.subHomes, request.area);
  // An upsert must not reuse a meter or nest/duplicate an existing root zone
  // (a delete never can). Validate the freshly composed list before any
  // tracker-reset side effect or persisted write.
  if (request.op === 'upsert' && violatesComposedHomeInvariants(homey, next, zoneTree)) {
    return { ok: false, reason: 'invalid' };
  }
  // Reset before config commit, but restore the old tracker if the boundary
  // proves the old config survived a refused/thrown write.
  const commit = commitHomesConfigWriteWithTrackerFreshnessReset({
    apiApp: homey.app,
    settings: homey.settings,
    store,
    request,
    currentConfig,
    next,
  });
  if (commit.state === 'committed') return { ok: true };
  return { ok: false, reason: commit.state === 'invalid' ? 'invalid' : 'degraded' };
};

export const saveSettingsUiHomesConfig = (
  { homey, body }: HomesApiContext & { body?: unknown },
): SettingsUiHomesSaveResponse => {
  const request = parseHomesSaveRequest(body);
  if (request === null) return { ok: false, reason: 'invalid' };
  return request.op === 'set_main_meter'
    ? saveMainMeterSelection(homey, request)
    : saveAreaMutation(homey, request);
};
