import { MAIN_HOME_ID } from '../../../contracts/src/settingsKeys.ts';
import { resolveHomeScopedRead, type HomeScopedRead } from '../../../contracts/src/homeScopedRead.ts';
import {
  SETTINGS_UI_DEVICES_PATH,
  type SettingsUiDevicesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { getApiReadModel, homeScopedApiUri } from './homey.ts';
import { getHomeScope } from './homeScope.ts';
import { logSettingsError } from './logging.ts';
import type { SettingsUiOverviewDevice } from './overviewDeviceRows.ts';

/**
 * What the Overview gets from a device read: the devices of the home ON SCREEN.
 *
 * An empty list on a `served` read means one thing only — this home manages no
 * devices — because every other reading (absent scope, wrong home, unreadable
 * transport) is classified `unavailable` before it reaches here. That
 * distinction is what lets the surface tell "nothing to manage" apart from
 * "could not ask", and the empty-state copy depends on it.
 */
export type OverviewDevicesPayload = { readonly devices: readonly SettingsUiOverviewDevice[] };

/**
 * The Overview's scope-following device read, the twin of `readOverviewPlan`.
 *
 * It exists because the Overview's cards are DEVICE rows now. The plan read has
 * always followed the selected meter area; the device read never had to, since
 * nothing on this surface came from it. Leaving it on the bare URI once the
 * cards moved would render MAIN's devices under an area's scope chip — the
 * exact cross-home leak the scope bar's honesty claim rules out.
 *
 * Main keeps the historical whole-home behaviour byte for byte: the BARE
 * `/ui_devices` URI, the same `apiCache` entry every existing invalidation site
 * targets, and an always-`served` result.
 */
export const readOverviewDevices = async (): Promise<HomeScopedRead<OverviewDevicesPayload>> => {
  const { selectedHomeId } = getHomeScope();
  if (selectedHomeId === MAIN_HOME_ID) {
    const payload = await getApiReadModel<SettingsUiDevicesPayload>(SETTINGS_UI_DEVICES_PATH);
    return { state: 'served', payload: { devices: readDevices(payload) } };
  }
  // This adapter owns the COMPLETE classification of the scoped read, a THROWN
  // fetch included (root AGENTS.md, "Clean and trusted interfaces between
  // layers"). Letting the rejection propagate would abort the caller's refresh
  // after the scope pick already blanked the surface.
  try {
    const read = resolveHomeScopedRead(
      await getApiReadModel<SettingsUiDevicesPayload>(
        homeScopedApiUri(SETTINGS_UI_DEVICES_PATH, selectedHomeId),
      ),
      // Refuses a resolved payload naming a DIFFERENT home: a misrouted
      // producer answer must never render another area's devices under this
      // scope's chip.
      selectedHomeId,
    );
    if (read.state !== 'served') return read;
    return { state: 'served', payload: { devices: readDevices(read.payload) } };
  } catch (caught) {
    void logSettingsError('Failed to read the meter area\'s devices', caught, 'overviewDevicesRead');
    return { state: 'unavailable' };
  }
};

// The envelope is validated by the resolver; the list it carries is still
// untrusted. A non-array `devices` is a malformed producer answer and reads as
// no devices rather than throwing into the caller's refresh.
const readDevices = (
  payload: SettingsUiDevicesPayload | null | undefined,
): readonly SettingsUiOverviewDevice[] => (
  Array.isArray(payload?.devices) ? payload.devices as SettingsUiOverviewDevice[] : []
);
