import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import {
  getApiReadModel,
  primeApiCache,
  setHomeyClient,
} from '../src/ui/homey.ts';
import {
  createSettingsSetHandler, createSettingsUnsetHandler, handlePlanStatusPublished, handlePowerTrackerPersisted,
} from '../src/ui/settingsChangeRouter.ts';
import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
} from '../../contracts/src/settingsUiApi.ts';
import {
  DEVICE_HOME_ASSIGNMENTS,
  HOMES_CONFIG,
} from '../../contracts/src/settingsKeys.ts';

/* -------------------------------------------------------------------------- *
 * The settings-change router's per-home cache routes (multi-home R5b).
 *
 * A sub-home's ONLY freshness signals are the `plan_status_published` and
 * `power_tracker_persisted` pushes carrying its id — the
 * realtime `plan_updated` / `power_updated` pushes are the main home's and are
 * never widened. And the roster/pin blobs (`homes_config` /
 * `device_home_assignments`) decide which homes resolve and which devices a
 * scoped read serves. If either route silently stopped sweeping the scoped
 * entries, a selected sub-home would render pre-change payloads for the rest
 * of the WebView session with no staleness signal anywhere.
 * -------------------------------------------------------------------------- */

const AREA = 'h_area1';
const scoped = (path: string) => `${path}?homeId=${AREA}`;

// A cached entry is observable only through `getApiReadModel`: a hit resolves
// to the primed value; a miss falls through to the mock transport, which 404s
// unknown (query-bearing) URIs — so a rejection IS the miss signal.
const isCached = async (uri: string, primedValue: string): Promise<boolean> => {
  try {
    return (await getApiReadModel<string>(uri)) === primedValue;
  } catch {
    return false;
  }
};

describe('settings-change router sweeps home-scoped read models', () => {
  let homey: MockHomeyClient;

  beforeEach(() => {
    homey = installHomeyMock({});
    setHomeyClient(homey as never);
    primeApiCache(SETTINGS_UI_PLAN_PATH, 'bare-plan');
    primeApiCache(scoped(SETTINGS_UI_PLAN_PATH), 'area-plan');
    primeApiCache(SETTINGS_UI_POWER_PATH, 'bare-power');
    primeApiCache(scoped(SETTINGS_UI_POWER_PATH), 'area-power');
    primeApiCache(SETTINGS_UI_DEVICES_PATH, 'bare-devices');
    primeApiCache(scoped(SETTINGS_UI_DEVICES_PATH), 'area-devices');
  });

  afterEach(() => {
    setHomeyClient(null);
  });

  it('a plan_status_published push for an area drops scoped plan+power and keeps the bare entries', async () => {
    handlePlanStatusPublished({ homeId: AREA });

    expect(await isCached(scoped(SETTINGS_UI_PLAN_PATH), 'area-plan')).toBe(false);
    expect(await isCached(scoped(SETTINGS_UI_POWER_PATH), 'area-power')).toBe(false);
    // The bare entries survive: a sub-home write says nothing about the whole
    // home, and the exact-URI cache would miss every one of the ~20 bare-path
    // invalidation sites if this ever swept them.
    expect(await isCached(SETTINGS_UI_PLAN_PATH, 'bare-plan')).toBe(true);
    expect(await isCached(SETTINGS_UI_POWER_PATH, 'bare-power')).toBe(true);
  });

  // The tracker lives in the userdata store under no settings key; the
  // runtime's `power_tracker_persisted` push carries the home id and must
  // sweep the area's scoped entries — devices included, because a scoped
  // `ui_devices` payload derives `hasExhibitedExport` from that home's
  // tracker, and one cached before the area's first export would otherwise
  // keep the solar-surplus controls hidden all session.
  it('a power_tracker_persisted push for an area sweeps scoped plan, power and devices, never the bare entries', async () => {
    handlePowerTrackerPersisted({ homeId: AREA });
    expect(await isCached(scoped(SETTINGS_UI_PLAN_PATH), 'area-plan')).toBe(false);
    expect(await isCached(scoped(SETTINGS_UI_POWER_PATH), 'area-power')).toBe(false);
    expect(await isCached(scoped(SETTINGS_UI_DEVICES_PATH), 'area-devices')).toBe(false);
    expect(await isCached(SETTINGS_UI_PLAN_PATH, 'bare-plan')).toBe(true);
    expect(await isCached(SETTINGS_UI_POWER_PATH, 'bare-power')).toBe(true);
    expect(await isCached(SETTINGS_UI_DEVICES_PATH, 'bare-devices')).toBe(true);
  });

  it('a power_tracker_persisted push for the main home sweeps the power and devices entries of every home', async () => {
    handlePowerTrackerPersisted({ homeId: 'main' });
    expect(await isCached(SETTINGS_UI_POWER_PATH, 'bare-power')).toBe(false);
    expect(await isCached(SETTINGS_UI_DEVICES_PATH, 'bare-devices')).toBe(false);
    expect(await isCached(scoped(SETTINGS_UI_POWER_PATH), 'area-power')).toBe(false);
    // Plan entries are not the tracker's to sweep.
    expect(await isCached(SETTINGS_UI_PLAN_PATH, 'bare-plan')).toBe(true);
  });

  it('a malformed power_tracker_persisted push sweeps nothing', async () => {
    handlePowerTrackerPersisted({ homeId: 42 });
    handlePowerTrackerPersisted(null);
    expect(await isCached(scoped(SETTINGS_UI_POWER_PATH), 'area-power')).toBe(true);
    expect(await isCached(SETTINGS_UI_POWER_PATH, 'bare-power')).toBe(true);
  });

  it('an area status publish leaves scoped devices cached (no devices field reads it)', async () => {
    handlePlanStatusPublished({ homeId: AREA });
    expect(await isCached(scoped(SETTINGS_UI_DEVICES_PATH), 'area-devices')).toBe(true);
  });

  it('a plan_status_published push for the main home sweeps the power entries of every home and nothing else', async () => {
    handlePlanStatusPublished({ homeId: 'main' });
    expect(await isCached(SETTINGS_UI_POWER_PATH, 'bare-power')).toBe(false);
    expect(await isCached(scoped(SETTINGS_UI_POWER_PATH), 'area-power')).toBe(false);
    expect(await isCached(SETTINGS_UI_PLAN_PATH, 'bare-plan')).toBe(true);
    expect(await isCached(SETTINGS_UI_DEVICES_PATH, 'bare-devices')).toBe(true);
  });

  it('a malformed plan_status_published push sweeps nothing', async () => {
    handlePlanStatusPublished({ homeId: 42 });
    handlePlanStatusPublished(undefined);
    expect(await isCached(scoped(SETTINGS_UI_POWER_PATH), 'area-power')).toBe(true);
    expect(await isCached(SETTINGS_UI_POWER_PATH, 'bare-power')).toBe(true);
  });

  it.each([[HOMES_CONFIG], [DEVICE_HOME_ASSIGNMENTS]])(
    'a %s change drops every scoped entry (a deleted area must not stay resolved)',
    async (key) => {
      createSettingsSetHandler()(key);

      expect(await isCached(scoped(SETTINGS_UI_PLAN_PATH), 'area-plan')).toBe(false);
      expect(await isCached(scoped(SETTINGS_UI_POWER_PATH), 'area-power')).toBe(false);
      expect(await isCached(scoped(SETTINGS_UI_DEVICES_PATH), 'area-devices')).toBe(false);
      expect(await isCached(SETTINGS_UI_DEVICES_PATH, 'bare-devices')).toBe(true);
    },
  );

  it('an unrelated suffixed key sweeps nothing', async () => {
    createSettingsSetHandler()(`combined_prices:${AREA}`);
    expect(await isCached(scoped(SETTINGS_UI_PLAN_PATH), 'area-plan')).toBe(true);
    expect(await isCached(scoped(SETTINGS_UI_POWER_PATH), 'area-power')).toBe(true);
  });

  // The UNSET mirror: Homey delivers deletes as `settings.unset`, and an unset
  // roster/pins blob de-resolves the same scoped read models a set rewrites —
  // neither key is set-only. Without this route a deleted area's cached
  // payloads would keep serving `homeScope: resolved` for the rest of the
  // WebView session.
  it.each([
    [HOMES_CONFIG],
    [DEVICE_HOME_ASSIGNMENTS],
  ])('a %s UNSET drops the scoped plan+power entries and keeps the bare ones', async (key) => {
    createSettingsUnsetHandler()(key);

    expect(await isCached(scoped(SETTINGS_UI_PLAN_PATH), 'area-plan')).toBe(false);
    expect(await isCached(scoped(SETTINGS_UI_POWER_PATH), 'area-power')).toBe(false);
    expect(await isCached(SETTINGS_UI_PLAN_PATH, 'bare-plan')).toBe(true);
    expect(await isCached(SETTINGS_UI_POWER_PATH, 'bare-power')).toBe(true);
  });
});
