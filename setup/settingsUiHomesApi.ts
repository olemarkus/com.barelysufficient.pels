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
import { normalizeHomeAreaName } from '../packages/shared-domain/src/homeAreaConfigRules';
import { createHomesStore } from './homeRegistryAdapter';
import type { HomeMembershipDiagnostics, HomeMembershipService } from './homeMembership';
import {
  commitHomesConfigWriteWithTrackerFreshnessReset,
  resolveApiLoggerProvider,
} from './homeRuntime/homeTrackerConfigSafety';
import {
  areaRootsAtForestRoot,
  findComposedHomeInvariantViolation,
  saveMainMeterSelection,
  savePowerSourceSelection,
  type MultiHomeActivationRead,
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

// The membership service's LATCHED activation posture, forwarded as a typed
// semantic result. It resolved the retired legacy flag once at wiring time and
// its diagnostics contract forbids consumers re-reading it.
//
// Resolved ONLY from a snapshot the service can vouch for, which is exactly the
// condition `isHomesConfigDegraded` reports and the area write refuses on. A
// degraded snapshot's `runtimeActive` is not an answer: `refreshStoreCaches`
// leaves the field at its previous value on a suspect homes-store read, so a
// service whose recompute never adopted a config still reports the initial
// `false`. Reading that as "areas are not running" while `saveMainMeterSelection`
// re-reads a recovered, activated config would let Automatic persist moments
// before the runtime reactivates those areas. Sharing the predicate also pulls
// in the pins-store arm, which activation does not depend on; that is accepted
// so there is ONE degraded condition, and it only ever errs toward "try again".
// (The `undefined` arm is what narrows for the compiler; the predicate covers it.)
const readMultiHomeActivation = (homey: Homey.App['homey']): MultiHomeActivationRead => {
  const diagnostics = getHomeMembership(homey)?.getDiagnostics();
  if (diagnostics === undefined || isHomesConfigDegraded(diagnostics)) {
    return { state: 'unavailable' };
  }
  return { state: 'resolved', runtimeActive: diagnostics.runtimeActive };
};

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
// Intent operations (upsert/delete ONE area, select Main's explicit meter, or
// switch the power source), never client-composed state: the runtime re-reads
// the persisted config through the CLASSIFIED store reader, refuses when it
// classifies suspect, then applies one operation. Area writes use the
// marker-first classified writer; Main-meter and power-source writes validate
// and persist synchronously in this same server turn. The app's
// single-threaded event loop therefore serializes both sides of meter
// ownership AND the flow/area mutual exclusion, so stale panels cannot wipe
// or double-own areas, and "save an area" cannot race "switch to Flow".

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
  // Surrounding whitespace is normalized away at the boundary, so the name the
  // rules judge is the name that gets persisted and displayed. The rules
  // themselves (non-empty, length, reserved, unique) need the resulting config
  // and run later, in `findComposedHomeInvariantViolation`.
  if (typeof area.name !== 'string') return null;
  const name = normalizeHomeAreaName(area.name);
  const rootZoneId = toSaveNonEmptyString(area.rootZoneId);
  if (rootZoneId === null) return null;
  // Explicit null = no meter (the domain allows it); anything else must be a
  // non-empty string — absent/malformed refuses rather than coercing.
  const meterRaw = area.meterDeviceId;
  const meterDeviceId = meterRaw === null ? null : toSaveNonEmptyString(meterRaw);
  if (meterRaw !== null && meterDeviceId === null) return null;
  return {
    ...(homeId === undefined ? {} : { homeId }), name, rootZoneId, meterDeviceId,
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
  if (record.op === 'set_power_source') {
    // Strict closed union: anything else is a malformed payload, never a
    // coerced default (the runtime treats unset as Flow, so a junk write
    // slipping through as Flow would flip the sampling mode).
    return record.source === 'homey_energy' || record.source === 'flow'
      ? { op: 'set_power_source', source: record.source }
      : null;
  }
  if (record.op === 'delete') {
    const homeId = toSaveNonEmptyString(record.homeId);
    return homeId !== null && isValidSubHomeId(homeId) ? { op: 'delete', homeId } : null;
  }
  if (record.op !== 'upsert') return null;
  const area = parseUpsertArea(record.area);
  return area === null ? null : { op: 'upsert', area };
};

/** The composed list plus the one entry the upsert wrote into it. */
type AppliedUpsert = { subHomes: SubHomeConfig[]; upserted: SubHomeConfig };

const applyHomesUpsert = (
  current: readonly SubHomeConfig[],
  area: Extract<SettingsUiHomesSaveRequest, { op: 'upsert' }>['area'],
): AppliedUpsert => {
  // Id allocation is the runtime's (create = absent id); an upsert with a
  // vanished id honestly re-adds the area — the UI's "Add again" semantics.
  const homeId = area.homeId ?? generateHomeId(current.map((entry) => entry.homeId));
  const upserted: SubHomeConfig = {
    homeId, name: area.name, rootZoneId: area.rootZoneId, meterDeviceId: area.meterDeviceId,
  };
  return {
    upserted,
    subHomes: current.some((existing) => existing.homeId === homeId)
      ? current.map((existing) => (existing.homeId === homeId ? upserted : existing))
      : [...current, upserted],
  };
};

type AreaMutationRequest = Exclude<
SettingsUiHomesSaveRequest,
{ op: 'set_main_meter' } | { op: 'set_power_source' }
>;

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
  // A delete composes its own list and names no written entry; an upsert hands
  // back the entry it wrote so the name rules can judge that one alone.
  const composed = request.op === 'delete'
    ? {
      subHomes: currentConfig.subHomes.filter((area) => area.homeId !== request.homeId),
      upserted: null,
    }
    : applyHomesUpsert(currentConfig.subHomes, request.area);
  const next = composed.subHomes;
  // An upsert must not reuse a meter, leave the Main home on Automatic, break
  // a name or count rule, or nest/duplicate an existing root zone. A delete is
  // never validated against those config rules — it can only make the list more
  // valid, and it is how an owner escapes a config the rules now refuse. (It is
  // still refused while the config is degraded, above: no write may be composed
  // over an unknown config.) Validate before any tracker-reset or write.
  if (composed.upserted !== null) {
    const refusal = findComposedHomeInvariantViolation(homey, {
      subHomes: next,
      upserted: composed.upserted,
      growsList: next.length > currentConfig.subHomes.length,
      // The degraded gate above proved a wired, vouched-for service, so the
      // latched arrangement is readable here; `unknown` (nothing proven yet)
      // keeps the ordinary main_meter_required remedy.
      mainMeterArrangement: getHomeMembership(homey)?.getDiagnostics().mainMeterArrangement
        ?? 'unknown',
      zoneTree,
    });
    if (refusal !== null) return refusal;
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

const routeHomesSaveRequest = (
  homey: Homey.App['homey'],
  request: SettingsUiHomesSaveRequest,
): SettingsUiHomesSaveResponse => {
  if (request.op === 'set_main_meter') {
    return saveMainMeterSelection(homey, request, readMultiHomeActivation(homey));
  }
  if (request.op === 'set_power_source') {
    return savePowerSourceSelection(homey, request, readMultiHomeActivation(homey));
  }
  return saveAreaMutation(homey, request);
};

// Every refusal, at the one seam that sees them all. Without it a support
// report of "PELS won't let me save my area" leaves nothing in the log that
// separates a missing whole-home meter from a duplicate name from the area
// cap. Diagnostics only: a logger that is unwired or throws never changes the
// refusal the caller receives.
const logHomesSaveRefusal = (
  homey: Homey.App['homey'],
  op: SettingsUiHomesSaveRequest['op'] | 'unparsed',
  response: SettingsUiHomesSaveResponse,
): void => {
  if (response.ok) return;
  try {
    resolveApiLoggerProvider(homey.app)?.getApiStructuredLogger()?.info({
      event: 'homes_save_refused', op, reason: response.reason,
    });
  } catch {
    // Intentionally silent: see above.
  }
};

export const saveSettingsUiHomesConfig = (
  { homey, body }: HomesApiContext & { body?: unknown },
): SettingsUiHomesSaveResponse => {
  const request = parseHomesSaveRequest(body);
  if (request === null) {
    const refusal: SettingsUiHomesSaveResponse = { ok: false, reason: 'invalid' };
    logHomesSaveRefusal(homey, 'unparsed', refusal);
    return refusal;
  }
  const response = routeHomesSaveRequest(homey, request);
  logHomesSaveRefusal(homey, request.op, response);
  return response;
};
