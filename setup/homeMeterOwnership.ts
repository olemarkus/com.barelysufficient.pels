import type Homey from 'homey';
import type {
  SettingsUiHomesSaveRequest,
  SettingsUiHomesSaveResponse,
} from '../packages/contracts/src/settingsUiHomes';
import {
  findMainMeterCollision,
  findNestedSubHomeRoots,
  hasUniqueSubHomeMeters,
  type SubHomeConfig,
  type ZoneTree,
} from '../lib/home/homeConfig';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../lib/utils/settingsKeys';
import { createHomesStore } from './homeRegistryAdapter';
import { readMainMeterSelection } from './mainMeterSettings';

type MainMeterSaveRequest = Extract<SettingsUiHomesSaveRequest, { op: 'set_main_meter' }>;
type AreaMutationRequest = Exclude<SettingsUiHomesSaveRequest, MainMeterSaveRequest>;

/** Cross-store meter ownership guard for a freshly composed area list. */
export const violatesMeterOwnership = (
  homey: Homey.App['homey'],
  subHomes: readonly SubHomeConfig[],
): boolean => {
  if (!hasUniqueSubHomeMeters(subHomes)) return true;
  const mainMeter = readMainMeterSelection(homey.settings);
  return mainMeter.state === 'unavailable'
    || findMainMeterCollision(mainMeter.meterDeviceId, subHomes) !== null;
};

/** Whether an area upsert would swallow the whole known zone forest. */
export const areaRootsAtForestRoot = (
  request: AreaMutationRequest,
  zoneTree: ZoneTree | null,
): boolean => {
  if (request.op !== 'upsert') return false;
  return zoneTree !== null && zoneTree[request.area.rootZoneId]?.parent === null;
};

/** All invariants that require the freshly composed area list. */
export const violatesComposedHomeInvariants = (
  homey: Homey.App['homey'],
  subHomes: readonly SubHomeConfig[],
  zoneTree: ZoneTree | null,
): boolean => (
  violatesMeterOwnership(homey, subHomes)
  || (zoneTree !== null && findNestedSubHomeRoots({ subHomes: [...subHomes] }, zoneTree).length > 0)
);

/**
 * Validate + persist Main's selection in one synchronous server turn. Sharing
 * the ui_homes_save intent seam with area mutations means either concurrent
 * arrival order observes the first owner and refuses the second.
 */
export const saveMainMeterSelection = (
  homey: Homey.App['homey'],
  request: MainMeterSaveRequest,
): SettingsUiHomesSaveResponse => {
  const read = createHomesStore(homey).read();
  if (read.state === 'suspect') return { ok: false, reason: 'degraded' };
  const subHomes = read.state === 'present' ? read.value.subHomes : [];
  const collision = findMainMeterCollision(request.meterDeviceId, subHomes);
  if (collision !== null) {
    return { ok: false, reason: 'meter_in_use', otherName: collision.name };
  }
  homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, request.meterDeviceId);
  return { ok: true };
};
