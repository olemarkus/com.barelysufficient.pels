// Integration coverage for the `?homeId=` half of the per-home read seam: the
// three settings-UI endpoints (`ui_plan` / `ui_power` / `ui_devices`) composed
// against the shared Homey mock. Only the outward seams are mocked — the
// shared `MockSettings` store from `test/mocks/homey.ts`, the `AppContext`
// read port, and the membership port — because those are exactly the
// boundaries this layer resolves.
//
// Two properties carry the whole design and are asserted directly here:
//
//  1. an ABSENT `homeId` returns the historical payload with no `homeScope`
//     member at all (the settings UI's `apiCache` is keyed by exact URI, so the
//     whole-home response must stay byte-identical), and
//  2. a REFUSED `homeId` performs no settings read and no scoped-key build.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Homey from 'homey';
import { mockHomeyInstance } from '../mocks/homey';
import {
  getSettingsUiDevicesPayload,
  getSettingsUiPlanPayload,
  getSettingsUiPowerPayload,
} from '../../setup/settingsUiApi';
import type { HomeRuntimeReadPort, HomeRuntimeReading } from '../../lib/home/homeRuntimeRead';
import type { HomeMembershipPort } from '../../lib/home/membership';
import { buildSettingsUiPlanMeta } from '../utils/planTestUtils';

const AREA_ID = 'h_area1';

// Hoisted out of the specs so the id projection is not a fourth nested callback.
const deviceIds = (payload: { devices: { id: string }[] }): string[] => (
  payload.devices.map((device) => device.id)
);

// Hoisted for the same nesting reason: a store override that fails ONLY the
// area's suffixed status key and serves every other key from the real store.
const failOnlyScopedStatus = (readRealSetting: (key: string) => unknown) => (key: string): unknown => {
  if (key === `pels_status:${AREA_ID}`) throw new Error('transient settings-store failure');
  return readRealSetting(key);
};

// The other settings read the scoped composers perform: the global
// `power_source` gate behind the solar fields.
const failOnlyPowerSource = (readRealSetting: (key: string) => unknown) => (key: string): unknown => {
  if (key === 'power_source') throw new Error('transient settings-store failure');
  return readRealSetting(key);
};

const AREA_PLAN = { generatedAtMs: 42, meta: buildSettingsUiPlanMeta({ totalKw: 1.5 }), devices: [] };
// Latched (production `recordPowerSample` stamps `lastPowerW` and
// `lastTimestamp` together): the served area is a MEASURED home, so its
// suffixed blob classifies as live. The gated-area test clears the latch.
const AREA_TRACKER = { lastPowerW: 1500, lastTimestamp: 4242, buckets: { '2026-07-26T10:00:00.000Z': 0.4 } };

const areaReading = (
  tracker: Record<string, unknown> = AREA_TRACKER,
): HomeRuntimeReading => ({
  homeId: AREA_ID,
  plan: AREA_PLAN,
  planUpdatedAtMs: 42,
  powerTracker: tracker as unknown as HomeRuntimeReading['powerTracker'],
  diagnostics: {
    homeId: AREA_ID,
    meterDeviceId: 'meter-1',
    operatingMode: 'Home',
    dryRunEffective: false,
    lastMeterPowerKw: 1.5,
    capacityScalars: { limitKw: 10, marginKw: 1, dryRun: false },
    lastDeviceControlledMs: {},
  },
});

// The COMPLETE membership port, typed against the real contract so any port
// signature change fails compilation here instead of leaving this suite green
// while production breaks. Attribution + the two readiness gates are the
// surfaces the scoped read path consumes; the rest are honest inert stubs.
const createMembershipPort = (options: {
  membership: Record<string, string>;
  ownershipReady?: boolean;
  pendingGeneration?: boolean;
}): HomeMembershipPort => ({
  getHomeIdForDevice: (id) => options.membership[id] ?? 'main',
  getMembershipMap: () => ({ ...options.membership }),
  getConfiguredMeterSources: () => ({ state: 'resolved', deviceIds: new Set<string>() }),
  hasSubHomes: () => true,
  isOwnershipReady: () => options.ownershipReady ?? true,
  hasPendingOwnershipGeneration: () => options.pendingGeneration ?? false,
  isMainHomeActuationFenced: () => false,
  noteResolvedHomeMeter: () => undefined,
  noteAdmittedFlowHomeSample: () => undefined,
  recompute: () => undefined,
});

// The app surfaces the three endpoints consume, typed against the real ports.
type ScopedApiApp = {
  latestTargetSnapshot: Record<string, unknown>[];
  getUiPickerDevices: () => Record<string, unknown>[];
  getLatestPlanSnapshotForUi: () => Record<string, unknown> | null;
  powerTracker: Record<string, unknown>;
  homeRuntimeRead?: HomeRuntimeReadPort;
  homeMembership?: HomeMembershipPort;
};

const installBoundary = (options: {
  hasReadPort?: boolean;
  hasMembership?: boolean;
  ownershipReady?: boolean;
  pendingGeneration?: boolean;
  settings?: Record<string, unknown>;
  areaTracker?: Record<string, unknown>;
} = {}) => {
  const seeded: Record<string, unknown> = {
    power_source: 'homey_energy',
    pels_status: { headroomKw: 9, priceLevel: 'cheap' },
    [`pels_status:${AREA_ID}`]: { headroomKw: 3, priceLevel: 'normal' },
    power_tracker_state: { buckets: {} },
    ...options.settings,
  };
  Object.entries(seeded).forEach(([key, value]) => {
    mockHomeyInstance.settings.set(key, value);
  });
  const homeRuntimeRead: HomeRuntimeReadPort = {
    readHome: (homeId) => (homeId === AREA_ID
      ? { state: 'resolved', reading: areaReading(options.areaTracker) }
      : { state: 'unavailable' }),
  };
  const homeMembership = createMembershipPort({
    membership: { 'dev-main': 'main', 'dev-area': AREA_ID, 'dev-area-pv': AREA_ID },
    ownershipReady: options.ownershipReady,
    pendingGeneration: options.pendingGeneration,
  });
  const app: ScopedApiApp = {
    latestTargetSnapshot: [
      { id: 'dev-main', name: 'Main heater', deviceClass: 'heater' },
      { id: 'dev-area', name: 'Area heater', deviceClass: 'heater' },
      { id: 'dev-area-pv', name: 'Area PV', deviceClass: 'solarpanel' },
    ],
    getUiPickerDevices: () => [],
    getLatestPlanSnapshotForUi: () => null,
    powerTracker: { lastPowerW: 5200, lastTimestamp: 4242, buckets: {} },
    ...(options.hasReadPort === false ? {} : { homeRuntimeRead }),
    ...(options.hasMembership === false ? {} : { homeMembership }),
  };
  mockHomeyInstance.app = app;
  // The one mock→SDK-type conversion, at the same seam every other
  // shared-mock consumer performs it (e.g. `homeRegistryAdapter.test.ts`).
  const homey = mockHomeyInstance as unknown as Homey.App['homey'];
  // Bound BEFORE the spy replaces the instance method, so a test overriding
  // the spy can still delegate untargeted keys to the real store.
  const readRealSetting = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
  const get = vi.spyOn(mockHomeyInstance.settings, 'get');
  return { homey, get, readRealSetting };
};

describe('settings-UI `?homeId=` endpoints', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockHomeyInstance.app = null;
    mockHomeyInstance.settings.clear();
  });

  describe('an absent homeId keeps the whole-home payload byte-identical', () => {
    it('omits homeScope entirely on every unscoped read', () => {
      const { homey } = installBoundary();
      // `in` rather than a value check: an explicit `homeScope: undefined` would
      // still serialize differently and is exactly what must not appear.
      expect('homeScope' in getSettingsUiPlanPayload({ homey })).toBe(false);
      expect('homeScope' in getSettingsUiPowerPayload({ homey })).toBe(false);
      expect('homeScope' in getSettingsUiDevicesPayload({ homey })).toBe(false);
      // Passing an empty query bag (the shape a bare HTTP GET actually delivers)
      // must be indistinguishable from passing none.
      expect(getSettingsUiPlanPayload({ homey, query: {} }))
        .toEqual(getSettingsUiPlanPayload({ homey }));
      expect(getSettingsUiPowerPayload({ homey, query: {} }))
        .toEqual(getSettingsUiPowerPayload({ homey }));
      expect(getSettingsUiDevicesPayload({ homey, query: {} }))
        .toEqual(getSettingsUiDevicesPayload({ homey }));
    });

    it('serves the whole home, not a sub-home, when unscoped', () => {
      const { homey } = installBoundary();
      // The whole home's list (minus the observe-only PV), never narrowed by
      // membership — the area's heater stays present.
      expect(deviceIds(getSettingsUiDevicesPayload({ homey }))).toEqual(['dev-main', 'dev-area']);
      expect(getSettingsUiPowerPayload({ homey }).status).toEqual({
        state: 'live', status: { headroomKw: 9, priceLevel: 'cheap' },
      });
    });
  });

  describe('a refused homeId', () => {
    // The load-bearing assertion: nothing downstream of the parser runs, so no
    // scoped settings key is ever built from an untrusted value.
    it.each([['', 'empty'], ['main', 'the main sentinel'], ['a:b', 'a separator'], ['__proto__', 'a prototype key']])(
      'reads no setting for %s (%s)',
      (homeId) => {
        const { homey, get } = installBoundary();
        const query = { homeId };

        expect(getSettingsUiPlanPayload({ homey, query })).toEqual({
          plan: null, homeScope: { state: 'unavailable' },
        });
        expect(getSettingsUiPowerPayload({ homey, query })).toEqual({
          tracker: {}, readings: { state: 'never' }, status: { state: 'unavailable', reason: 'home_scope_unavailable' }, homeScope: { state: 'unavailable' },
        });
        // The solar flags are OMITTED, not fabricated `false` — absence is the
        // only honest value an unservable home can carry.
        expect(getSettingsUiDevicesPayload({ homey, query })).toEqual({
          devices: [], homeScope: { state: 'unavailable' },
        });

        // No settings read at all — so in particular no `<base>:<homeId>` key
        // was ever composed from the refused value.
        expect(get).not.toHaveBeenCalled();
      },
    );
  });

  describe('a configured sub-home', () => {
    it('serves that home committed plan, tracker and suffixed status', () => {
      const { homey } = installBoundary();
      const query = { homeId: AREA_ID };

      expect(getSettingsUiPlanPayload({ homey, query })).toEqual({
        plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA_ID },
      });

      const power = getSettingsUiPowerPayload({ homey, query });
      expect(power.tracker).toEqual(AREA_TRACKER);
      // The area's OWN suffixed blob, never main's — live, because the area's
      // own tracker holds a measurement.
      expect(power.status).toEqual({ state: 'live', status: { headroomKw: 3, priceLevel: 'normal' } });
      expect(power.homeScope).toEqual({ state: 'resolved', homeId: AREA_ID });
    });

    it('narrows the device list to that home members', () => {
      const { homey } = installBoundary();
      const payload = getSettingsUiDevicesPayload({ homey, query: { homeId: AREA_ID } });
      // The area's own devices only; the observe-only PV is filtered out of the
      // list exactly as it is for the whole home, but still raises the flag.
      expect(deviceIds(payload)).toEqual(['dev-area']);
      expect(payload.hasManagedSolarDevice).toBe(true);
      // ...but the surplus ENGINE is switched off for a sub-home by
      // construction: its bundle binds `getInferredSurplusKw: () => null`, is
      // fenced out of the posture, and gets empty price-opt settings (which
      // kills the temperature lift too). Solar presence must not be read as a
      // reachable pool, or the toggle promises an engine that cannot run.
      expect(payload.surplusPoolReachable).toBe(false);
      expect(payload.homeScope).toEqual({ state: 'resolved', homeId: AREA_ID });
    });
  });

  describe('an unservable home reports unavailable, never a fabricated one', () => {
    it('refuses an unknown area', () => {
      const { homey } = installBoundary();
      const query = { homeId: 'h_ghost' };
      expect(getSettingsUiPlanPayload({ homey, query }).homeScope)
        .toEqual({ state: 'unavailable' });
      // Crucially NOT main's status blob.
      expect(getSettingsUiPowerPayload({ homey, query }).status)
        .toEqual({ state: 'unavailable', reason: 'home_scope_unavailable' });
      expect(getSettingsUiDevicesPayload({ homey, query }).devices).toEqual([]);
    });

    it('refuses every home while the read port is unwired (boot / uninit)', () => {
      const { homey } = installBoundary({ hasReadPort: false });
      const query = { homeId: AREA_ID };
      expect(getSettingsUiPlanPayload({ homey, query })).toEqual({
        plan: null, homeScope: { state: 'unavailable' },
      });
      expect(getSettingsUiPowerPayload({ homey, query }).homeScope)
        .toEqual({ state: 'unavailable' });
    });

    it('refuses every scoped read while membership is unwired', () => {
      // Without device→home attribution there is no true per-home list, so the
      // honest answer is `unavailable` rather than an unfiltered or empty one.
      // Power refuses too: `homeScope: resolved` must always mean every field
      // is this home's truth, so its solar flag can never need a second
      // absence meaning.
      const { homey } = installBoundary({ hasMembership: false });
      expect(getSettingsUiDevicesPayload({ homey, query: { homeId: AREA_ID } })).toEqual({
        devices: [], homeScope: { state: 'unavailable' },
      });
      expect(getSettingsUiPowerPayload({ homey, query: { homeId: AREA_ID } })).toEqual({
        tracker: {}, readings: { state: 'never' }, status: { state: 'unavailable', reason: 'home_scope_unavailable' }, homeScope: { state: 'unavailable' },
      });
    });

    // A WIRED membership port can still be provisional: `getHomeIdForDevice`
    // then serves fallback/previous ownership, and a device list built from it
    // could be cached as `resolved` long after the real generation commits.
    it.each([
      ['ownership is not ready (startup)', { ownershipReady: false }],
      ['an ownership generation is pending', { pendingGeneration: true }],
    ])('refuses scoped device-bearing reads while %s', (_label, provisional) => {
      const { homey } = installBoundary(provisional);
      const query = { homeId: AREA_ID };
      expect(getSettingsUiDevicesPayload({ homey, query })).toEqual({
        devices: [], homeScope: { state: 'unavailable' },
      });
      expect(getSettingsUiPowerPayload({ homey, query })).toEqual({
        tracker: {}, readings: { state: 'never' }, status: { state: 'unavailable', reason: 'home_scope_unavailable' }, homeScope: { state: 'unavailable' },
      });
      // The plan composer consumes no membership, so it stays served: the
      // committed plan is the runtime's own truth, not an attribution claim.
      expect(getSettingsUiPlanPayload({ homey, query }).homeScope)
        .toEqual({ state: 'resolved', homeId: AREA_ID });
    });

    it('reports absence when the area has committed no plan or status yet', () => {
      const { homey } = installBoundary({ settings: { [`pels_status:${AREA_ID}`]: undefined } });
      expect(getSettingsUiPowerPayload({ homey, query: { homeId: AREA_ID } }).status)
        .toEqual({ state: 'unavailable', reason: 'no_status_recorded' });
    });

    it('never serves a gated area its stale suffixed blob as live — and preserves the blob', () => {
      // The area's live tracker holds no measurement (its meter never reported
      // this run), so the suffixed blob is a previous era's: the classified
      // read says so instead of serving the previous run's numbers as live.
      const { homey } = installBoundary({ areaTracker: { buckets: {} } });
      const power = getSettingsUiPowerPayload({ homey, query: { homeId: AREA_ID } });
      expect(power.status).toEqual({ state: 'unavailable', reason: 'no_measurement' });
      expect(power.homeScope).toEqual({ state: 'resolved', homeId: AREA_ID });
      // The stored blob survives untouched — the read changes only its claim.
      expect(homey.settings.get(`pels_status:${AREA_ID}`))
        .toEqual({ headroomKw: 3, priceLevel: 'normal' });
    });

    it('classifies a thrown scoped status read as unavailable, not a rejected request', () => {
      // A transient Homey settings failure at the adapter boundary must become
      // `homeScope: unavailable` (never an escaping transport error that
      // rejects the whole API request, and never a resolved payload with a
      // fabricated "no status yet" that the client could cache).
      const { homey, get, readRealSetting } = installBoundary();
      get.mockImplementation(failOnlyScopedStatus(readRealSetting));

      expect(getSettingsUiPowerPayload({ homey, query: { homeId: AREA_ID } })).toEqual({
        tracker: {}, readings: { state: 'never' }, status: { state: 'unavailable', reason: 'home_scope_unavailable' }, homeScope: { state: 'unavailable' },
      });
    });

    it('serves every scoped composer when the power-source read throws — none of them read it', () => {
      // This used to assert the POWER composer answered `unavailable`, because
      // its solar flag was gated on the source. No scoped payload depends on the
      // power source any more: production reaches both sources, so the flag is
      // device presence alone. A transient failure of a key nothing reads must
      // not fence a home out of its own payload — the classification is per
      // read, not a blanket catch around the endpoint.
      const { homey, get, readRealSetting } = installBoundary();
      get.mockImplementation(failOnlyPowerSource(readRealSetting));

      const powerPayload = getSettingsUiPowerPayload({ homey, query: { homeId: AREA_ID } });
      expect(powerPayload.homeScope).toEqual({ state: 'resolved', homeId: AREA_ID });
      const devicesPayload = getSettingsUiDevicesPayload({ homey, query: { homeId: AREA_ID } });
      expect(devicesPayload.homeScope).toEqual({ state: 'resolved', homeId: AREA_ID });
      expect(deviceIds(devicesPayload)).toEqual(['dev-area']);
      expect(getSettingsUiPlanPayload({ homey, query: { homeId: AREA_ID } })).toEqual({
        plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA_ID },
      });
    });
  });
});
