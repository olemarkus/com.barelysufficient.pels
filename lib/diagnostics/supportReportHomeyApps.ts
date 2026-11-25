import type { SupportReportSection } from '../../packages/contracts/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { AppMemorySnapshot } from './appMemoryFootprint';
import { requestHomeyAppsList, type HomeyAppManagerRuntime } from './homeyAppManagerRequest';
import { SUPPORT_REPORT_MAX_HOMEY_DEVICES, type HomeyDeviceInventoryRead } from './homeyDeviceSupportSection';

export const INSTALLED_APP_VERSIONS_TITLE = 'Installed Homey app versions';

const APPS_READ_TIMEOUT_MS = 3_000;
const APP_ID = /^[a-z0-9][a-z0-9.-]{0,127}$/iu;
const APP_VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/iu;

export type InstalledAppVersions = ReadonlyMap<string, string>;

/** Parse the installed versions only. A denied or malformed list is an unavailable read. */
export const readInstalledAppVersions = async (homey: HomeyAppManagerRuntime): Promise<InstalledAppVersions> => {
  const { ok, body } = await requestHomeyAppsList(homey, APPS_READ_TIMEOUT_MS);
  if (!ok || (!isUnknownRecord(body) && !Array.isArray(body))) throw new Error('Homey app list is unavailable');
  const versions = new Map<string, string>();
  for (const entry of Object.values(body)) {
    if (!isUnknownRecord(entry)) continue;
    const { id, version } = entry;
    if (typeof id !== 'string' || !APP_ID.test(id) || id === homey.manifest.id) continue;
    if (typeof version !== 'string' || version.length > 80
      || version !== version.trim() || !APP_VERSION.test(version)) continue;
    versions.set(`homey:app:${id}`, version);
  }
  return versions;
};

export const reportInstalledAppVersions = (
  inventory: HomeyDeviceInventoryRead, versions: InstalledAppVersions,
): SupportReportSection | null => {
  if (inventory.state === 'unavailable') return null;
  const owners = new Set(inventory.devices.slice(0, SUPPORT_REPORT_MAX_HOMEY_DEVICES).map((device) => device.ownerUri));
  const apps = [...owners].flatMap((ownerUri) => {
    const version = versions.get(ownerUri);
    return version === undefined ? [] : [{ ownerUri, version }];
  });
  return { title: INSTALLED_APP_VERSIONS_TITLE, values: { apps } };
};

export const APP_MEMORY_REPORT_TITLE = 'App memory';

/**
 * Every report states the app's memory, so reports from many homes can be
 * compared: high or unexpectedly low use against their devices, apps and
 * settings. Homey's reading is the one its memory warning acts on.
 */
export const readAppMemorySection = async (readMemory: () => Promise<AppMemorySnapshot>) => {
  let snapshot: AppMemorySnapshot;
  try {
    snapshot = await readMemory();
  } catch {
    return [{ state: 'unavailable' as const, reason: `${APP_MEMORY_REPORT_TITLE} is unavailable.` }];
  }
  const { usage, ...rest } = snapshot;
  return [
    { state: 'available' as const, section: { title: APP_MEMORY_REPORT_TITLE, values: usage ? snapshot : rest } },
    ...(usage ? [] : [{
      state: 'unavailable' as const, reason: 'Homey\'s reading of the app\'s memory is unavailable.',
    }]),
  ];
};
