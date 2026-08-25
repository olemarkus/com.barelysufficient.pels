/**
 * The `?homeId=` boundary for `ui_plan` / `ui_power` / `ui_devices`.
 *
 * This module owns the COMPLETE classification of the untrusted query value and
 * of the runtime's ability to serve it, and hands adjacent layers a typed
 * result. Downstream (the endpoint bodies, then the settings UI) reads
 * `SettingsUiHomeScope` and never re-validates the id, re-reads the query, or
 * branches on where an absent value came from.
 *
 * Three rules this file exists to keep:
 *
 * 1. **An absent `homeId` is not a scope.** It resolves to `whole_home`, and the
 *    endpoint then returns the historical payload with NO `homeScope` member —
 *    byte-identical to the pre-multi-home response. The settings UI's `apiCache`
 *    is keyed by exact URI and ~20 sites invalidate the bare path, so a
 *    single-home install must keep hitting exactly that entry.
 * 2. **A rejected id must not touch the settings store.** `''`, `'main'`, an id
 *    containing the `':'` settings-key separator, and the prototype-colliding
 *    keys all fail `isValidSubHomeId` BEFORE anything calls
 *    `homeScopedSettingsKey` or `settings.get`. `'main'` is refused rather than
 *    silently aliased to the whole-home read: a client that scopes to main has a
 *    bug, and serving it would hide the byte-identical-URI violation.
 * 3. **`unavailable` is never a fabricated home.** No fallback to main, no empty
 *    payload dressed as a real reading — the flat fields are the empty shape and
 *    the scope block says so.
 *
 * Values come from the already-committed per-home read port
 * (`lib/home/homeRuntimeRead.ts`) plus that home's own suffixed `pels_status`
 * blob — the same blob main reads unsuffixed, so the two homes' payloads are
 * assembled from the same kind of source. Nothing here rebuilds a plan,
 * refreshes a snapshot, arms a timer or actuates.
 */
import type Homey from 'homey';
import type { HomeRuntimeReadPort, HomeRuntimeReading } from '../lib/home/homeRuntimeRead';
import type { HomeMembershipPort } from '../lib/home/membership';
import { isValidSubHomeId } from '../lib/home/homeConfig';
import { PELS_STATUS, homeScopedSettingsKey, type HomeId } from '../lib/utils/settingsKeys';
import type { SettingsUiPowerStatus } from '../packages/contracts/src/settingsUiApi';

/**
 * Mirror of `SETTINGS_UI_HOME_ID_QUERY_PARAM` in
 * `packages/contracts/src/settingsUiApi.ts`. Declared here as a literal because
 * `packages/contracts` is types-only at runtime (the sanitize step deletes it
 * from the shipped bundle, so a value import crashes boot) — the same mirroring
 * `packages/contracts/src/settingsKeys.ts` already does for settings keys.
 */
const HOME_ID_QUERY_PARAM = 'homeId';

/**
 * The parsed request scope. `rejected` is deliberately distinct from
 * `whole_home`: an unparseable id must NOT degrade into the main-home read.
 */
export type SettingsUiRequestedHomeScope =
  | { readonly state: 'whole_home' }
  | { readonly state: 'sub_home'; readonly homeId: HomeId }
  | { readonly state: 'rejected' };

/**
 * A scope the parser has RESOLVED to a sub-home — the only argument the
 * read methods below accept. Making the discriminant the parameter type (not a
 * raw `HomeId` string) turns rule 2 into a compile-time property: no future
 * call site can reach a settings read or a scoped-key build without first
 * going through {@link SettingsUiHomeScopeAdapter.parseRequestedScope}.
 */
export type ResolvedSubHomeScope = Extract<SettingsUiRequestedHomeScope, { state: 'sub_home' }>;

/**
 * One sub-home's own status-blob read, discriminated at this adapter boundary.
 * `resolved` carries the object-guarded blob; `absent` is genuine absence (the
 * home has not committed a status yet, or the stored value fails the object
 * guard — exactly the cases main's unsuffixed read treats as "no blob").
 * `unavailable` is a THROWN settings read: a transient Homey store failure is
 * not absence, and must neither escape as an untyped transport error nor be
 * dressed up as "no status yet".
 */
export type SubHomeStatusRead =
  | { readonly state: 'resolved'; readonly status: SettingsUiPowerStatus }
  | { readonly state: 'absent' }
  | { readonly state: 'unavailable' };

const asQueryRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

type HomeScopeApp = Homey.App & {
  homeRuntimeRead?: HomeRuntimeReadPort;
  homeMembership?: HomeMembershipPort;
};

/**
 * The one wiring surface of this module (setup convention: a file exposes a
 * class or a single factory, never a bag of standalone utilities). Constructed
 * per request by the `settingsUiApi` composers; holds no state beyond the
 * Homey handle, so construction is free and nothing can go stale.
 */
export class SettingsUiHomeScopeAdapter {
  public constructor(private readonly homey: Homey.App['homey']) {}

  /**
   * Classify the untrusted `query` bag of an inbound settings-UI GET. Static:
   * parsing consumes no runtime state, and the unit tier pins the rejection
   * set without constructing an adapter.
   *
   * Express hands `req.query` through verbatim, so a repeated parameter
   * arrives as an array and a bracketed one (`?homeId[x]=y`) as an object;
   * both are `rejected` by the string check rather than coerced. A missing
   * `query` bag (every non-HTTP caller: the bootstrap composer, tests, the
   * widget host) is `whole_home`.
   */
  public static parseRequestedScope(query: unknown): SettingsUiRequestedHomeScope {
    const record = asQueryRecord(query);
    // Own-property read: a plain lookup would inherit a polluted
    // `Object.prototype.homeId` and scope a request the client never scoped. Same
    // read-guard discipline the membership resolver already applies to untrusted
    // record keys (`lib/home/homeConfig.ts`).
    const raw = record !== null && Object.prototype.hasOwnProperty.call(record, HOME_ID_QUERY_PARAM)
      ? record[HOME_ID_QUERY_PARAM]
      : undefined;
    if (raw === undefined) return { state: 'whole_home' };
    // Everything below this line is untrusted. `isValidSubHomeId` is the single
    // gate: non-empty, not the `'main'` sentinel, no `':'`, no prototype-colliding
    // key. Nothing has read a setting or built a scoped key yet, and nothing will
    // unless the id passes.
    if (typeof raw !== 'string' || !isValidSubHomeId(raw)) return { state: 'rejected' };
    return { state: 'sub_home', homeId: raw };
  }

  /**
   * One sub-home's already-committed reading, or `null` when it cannot be
   * served.
   *
   * `null` folds the boot/uninit window (no port on the context yet or any
   * more) into the port's own `unavailable` — both mean "this producer has no
   * committed state for that home", and neither is a value a consumer may
   * reinterpret.
   */
  public readRuntime(scope: ResolvedSubHomeScope): HomeRuntimeReading | null {
    const read = this.app()?.homeRuntimeRead?.readHome(scope.homeId);
    return read?.state === 'resolved' ? read.reading : null;
  }

  /**
   * That home's own live status blob (`pels_status:<homeId>`), object-guarded —
   * the same depth of guard main's unsuffixed `pels_status` read applies
   * (`getSettingsUiPower`); the per-field resolution of both blobs is a shared
   * follow-up tracked in TODO.md.
   *
   * The suffixed key is built from a scope the parser resolved, and callers run
   * it only after {@link readRuntime} proved the runtime owns the home. A
   * thrown `settings.get` (transient Homey store failure) is classified HERE —
   * adapters own the complete classification of thrown reads — as
   * `unavailable`, so the endpoint answers `homeScope: unavailable` instead of
   * rejecting the whole API request or caching a fabricated "no status yet".
   */
  public readStatus(scope: ResolvedSubHomeScope): SubHomeStatusRead {
    let status: unknown;
    try {
      status = this.homey.settings.get(homeScopedSettingsKey(PELS_STATUS, scope.homeId));
    } catch {
      return { state: 'unavailable' };
    }
    return status !== null && typeof status === 'object' && !Array.isArray(status)
      ? { state: 'resolved', status: status as SettingsUiPowerStatus }
      : { state: 'absent' };
  }

  /**
   * Narrow a device list to one sub-home's members.
   *
   * `null` when membership cannot attribute authoritatively: device→home
   * attribution is the ONLY thing that makes a per-home device list true, so
   * without it the honest answer is `unavailable`, not an unfiltered or empty
   * list. That covers an unwired port (the boot window) AND a wired-but-
   * PROVISIONAL one: before `isOwnershipReady()` proves a trustworthy
   * baseline, or while `hasPendingOwnershipGeneration()` reports an observed
   * ownership change whose freshly planned generation has not committed,
   * `getHomeIdForDevice` serves fallback/previous ownership — and a list built
   * from that could be cached as `resolved` long after the generation commits.
   */
  public filterDevicesForHome<T extends { id: string }>(
    scope: ResolvedSubHomeScope,
    devices: readonly T[],
  ): T[] | null {
    const membership = this.app()?.homeMembership;
    if (!membership) return null;
    if (!membership.isOwnershipReady() || membership.hasPendingOwnershipGeneration()) return null;
    return devices.filter((device) => membership.getHomeIdForDevice(device.id) === scope.homeId);
  }

  private app(): HomeScopeApp | null {
    if (!this.homey || typeof this.homey !== 'object') return null;
    // `homey.app` is undefined during the boot/uninit window; honour the
    // declared null so a future non-optional-chained caller cannot type-check
    // against a value that is actually undefined.
    return (this.homey.app as HomeScopeApp | undefined) ?? null;
  }
}
