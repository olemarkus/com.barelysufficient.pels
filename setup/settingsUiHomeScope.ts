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
 * (`lib/home/homeRuntimeRead.ts`) plus that home's own status out of the
 * app's registry — the same registry main reads under its own id, so the two
 * homes' payloads are assembled from the same kind of source. Nothing here rebuilds a plan,
 * refreshes a snapshot, arms a timer or actuates.
 */
import type { HomeRuntimeReading } from '../lib/home/homeRuntimeRead';
import { isValidSubHomeId } from '../lib/home/homeConfig';
import type { HomeId } from '../lib/utils/settingsKeys';
import { isListedWholeHomeDevice } from '../lib/home/wholeHomeDeviceListing';
import type { PelsHost } from '../lib/app/pelsHost';
import { SETTINGS_UI_HOME_ID_QUERY_PARAM } from '../packages/shared-domain/src/settingsUiHomeIdQuery';

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

const asQueryRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

/**
 * The one wiring surface of this module (setup convention: a file exposes a
 * class or a single factory, never a bag of standalone utilities). Constructed
 * per request by the `settingsUiApi` composers over the running app
 * (`readPelsHost`); holds no state beyond that handle, so construction is free
 * and nothing can go stale.
 */
export class SettingsUiHomeScopeAdapter {
  public constructor(private readonly host: PelsHost) {}

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
    const raw = record !== null && Object.prototype.hasOwnProperty.call(record, SETTINGS_UI_HOME_ID_QUERY_PARAM)
      ? record[SETTINGS_UI_HOME_ID_QUERY_PARAM]
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
   * `null` is the port's own `unavailable` (no registry before
   * `initHomeRuntimeRegistry` or after `runUninit`): this producer has no
   * committed state for that home, which no consumer may reinterpret.
   */
  public readRuntime(scope: ResolvedSubHomeScope): HomeRuntimeReading | null {
    const read = this.host.homeRuntimeRead.readHome(scope.homeId);
    return read.state === 'resolved' ? read.reading : null;
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
    const membership = this.host.homeMembership;
    if (!membership) return null;
    if (!membership.isOwnershipReady() || membership.hasPendingOwnershipGeneration()) return null;
    return devices.filter((device) => membership.getHomeIdForDevice(device.id) === scope.homeId);
  }

  /** The devices the whole-home list offers (`lib/home/wholeHomeDeviceListing.ts`). */
  public filterWholeHomeDevices<T extends Parameters<typeof isListedWholeHomeDevice>[1]>(devices: readonly T[]): T[] {
    const membership = this.host.homeMembership;
    return devices.filter((device) => isListedWholeHomeDevice(membership, device));
  }
}
