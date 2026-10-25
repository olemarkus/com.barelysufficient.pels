import type Homey from 'homey';
import type {
  SettingsUiHomesSaveRequest,
  SettingsUiHomesSaveResponse,
} from '../packages/contracts/src/settingsUiHomes';
import { findMainMeterCollision } from '../lib/home/homeConfig';
import { HOMEY_ENERGY_METER_DEVICE_ID, POWER_SOURCE } from '../lib/utils/settingsKeys';
import { createHomesStore } from '../lib/home/homeRegistryStore';

type PowerSourceSaveRequest = Extract<SettingsUiHomesSaveRequest, { op: 'set_power_source' }>;

/**
 * Validate + persist the power source in the same serialized server turn as
 * area mutations, so "save an area" and "switch to Flow" cannot both land.
 * The exclusion the area path enforces, from the other side: a Flow reading
 * carries no meter identity, so configured meter areas would silently stop
 * receiving samples the moment the source flips.
 *
 * Switching TO Homey Energy now carries the meter it will read, so it
 * consults the homes store exactly as far as meter ownership requires (the
 * collision check); the configured-areas refusal applies only to Flow, so
 * the remedy direction every refusal names is never itself blocked by it.
 */
/** `true` only on a clean read of an already-homey_energy source; a throwing read reports `false`. */
const readsAsHomeyEnergySource = (homey: Homey.App['homey']): boolean => {
  try {
    return homey.settings.get(POWER_SOURCE) === 'homey_energy';
  } catch {
    return false;
  }
};

export const savePowerSourceSelection = (
  homey: Homey.App['homey'],
  request: PowerSourceSaveRequest,
): SettingsUiHomesSaveResponse => {
  const read = createHomesStore(homey.settings).read();
  if (read.state === 'suspect') return { ok: false, reason: 'degraded' };
  const config = read.state === 'present' ? read.value : { subHomes: [] };
  if (request.source === 'flow') {
    if (config.subHomes.length > 0) return { ok: false, reason: 'homey_energy_required' };
    homey.settings.set(POWER_SOURCE, 'flow');
    return { ok: true };
  }
  // Homey Energy switches atomically with the meter it will read: validate
  // the meter against area ownership, then write the meter key FIRST and the
  // source second — so `power_source = homey_energy` never exists persisted
  // without a meter id, even across a crash between the two writes.
  const collision = findMainMeterCollision(request.meterDeviceId, config.subHomes);
  if (collision !== null) {
    return { ok: false, reason: 'meter_in_use', otherName: collision.name };
  }
  // The source is read BEFORE the first write, so a throwing read cannot
  // leave a half-applied save reported as a failure; if the read itself
  // throws, the source is rewritten unconditionally (idempotent).
  const sourceAlreadyHomeyEnergy = readsAsHomeyEnergySource(homey);
  homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, request.meterDeviceId);
  // Skip rewriting an unchanged source: a meter change while already on Homey
  // Energy stays a single-key write (one settings event, one poll restart).
  if (!sourceAlreadyHomeyEnergy) {
    homey.settings.set(POWER_SOURCE, 'homey_energy');
  }
  return { ok: true };
};
