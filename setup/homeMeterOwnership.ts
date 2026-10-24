import type Homey from 'homey';
import type {
  SettingsUiHomesSaveRequest,
  SettingsUiHomesSaveResponse,
} from '../packages/contracts/src/settingsUiHomes';
import {
  findMainMeterCollision,
  HOME_CONFIG_ACTIVATION_VERSION,
  type HomeConfig,
} from '../lib/home/homeConfig';
import { HOMEY_ENERGY_METER_DEVICE_ID, POWER_SOURCE } from '../lib/utils/settingsKeys';
import { createHomesStore } from '../lib/home/homeRegistryStore';

type PowerSourceSaveRequest = Extract<SettingsUiHomesSaveRequest, { op: 'set_power_source' }>;

/**
 * Multi-home activation as the membership service latched it, passed in rather
 * than re-resolved: `HomeMembershipDiagnostics.runtimeActive` is the producer's
 * answer and its contract says consumers must not re-read the retired legacy
 * flag (`lib/home/homeConfigActivation.ts`). `unavailable` is the boot window, when
 * no service is wired and the answer is genuinely unknown.
 */
export type MultiHomeActivationRead =
  | { state: 'resolved'; runtimeActive: boolean }
  | { state: 'unavailable' };

/**
 * Whether the freshly read config's areas are RUNNING, for the two saves that
 * must not proceed while they are (Automatic, and the Flow source). A saved
 * pre-GA config that multi-home is deliberately holding dormant is not
 * running and must not block either save.
 *
 * The activation MARKER travels in the same fresh read as `subHomes`, so an
 * upsert that just activated this config is visible here even while the
 * membership recompute it queued is still pending — the latched snapshot
 * would still say "not running" in that window, and consulting it first
 * would let the save persist moments before the area controllers start.
 *
 * No marker: dormant, or activated only through the retired legacy flag.
 * That discrimination is the membership service's latched answer; `unknown`
 * refuses rather than guesses, because the legacy flag's own read fails
 * closed to `false`, which HERE would read as "not running" and would
 * silently permit exactly the save the caller exists to refuse.
 */
const classifyAreasRunning = (
  config: HomeConfig,
  activation: MultiHomeActivationRead,
): 'running' | 'dormant' | 'unknown' => {
  if (config.subHomes.length === 0) return 'dormant';
  if (config.activationVersion === HOME_CONFIG_ACTIVATION_VERSION) return 'running';
  if (activation.state === 'unavailable') return 'unknown';
  return activation.runtimeActive ? 'running' : 'dormant';
};

/**
 * Validate + persist the power source in the same serialized server turn as
 * area mutations, so "save an area" and "switch to Flow" cannot both land.
 * The exclusion the area path enforces, from the other side: a Flow reading
 * carries no meter identity, so RUNNING meter areas would silently stop
 * receiving samples the moment the source flips. Dormancy discrimination is
 * `classifyAreasRunning`, shared with the Automatic refusal.
 *
 * Switching TO Homey Energy now carries the meter it will read, so it
 * consults the homes store exactly as far as meter ownership requires (the
 * collision check); the areas-running gate still applies only to Flow, so
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
  activation: MultiHomeActivationRead,
): SettingsUiHomesSaveResponse => {
  const read = createHomesStore(homey.settings).read();
  if (read.state === 'suspect') return { ok: false, reason: 'degraded' };
  const config = read.state === 'present' ? read.value : { subHomes: [] };
  if (request.source === 'flow') {
    const running = classifyAreasRunning(config, activation);
    if (running === 'unknown') return { ok: false, reason: 'degraded' };
    if (running === 'running') return { ok: false, reason: 'homey_energy_required' };
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
