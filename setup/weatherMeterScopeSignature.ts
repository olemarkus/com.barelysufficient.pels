import type Homey from 'homey';
import { createHomesStore } from './homeRegistryAdapter';
import { readMainMeterSelection } from './mainMeterSettings';
import { readConfiguredPowerSource } from './powerSourceSettings';
import { readHomeConfigRuntimeActivation } from './multiHomeActivation';

/**
 * Composes the whole-home metering-arrangement fingerprint the weather
 * collector stamps into its persisted history (`meterScopeSignature`). It
 * includes only settings that can change the selected producer:
 * - Flow is self-contained (`source:flow`);
 * - Homey Energy with an explicit Main meter includes that meter;
 * - Homey Energy on Automatic additionally includes the roster's activation
 *   posture, because activating a dormant legacy roster changes Automatic's
 *   sampled scope.
 *
 * The power source is part of the arrangement, not a modifier of it: Flow and
 * Homey Energy are different PRODUCERS of the same power-tracker buckets the
 * fit's kWh layer consumes, so switching sources splices two producers'
 * scopes into one retained history exactly like a meter swap does.
 *
 * The activation posture is relevant only on Automatic. An explicit Main
 * selection keeps sampling the same device when a dormant roster activates,
 * so including posture there would discard learned history without a producer
 * change.
 *
 * Deliberately excluded:
 * - per-area meter ids. The collector's kWh series is Main's own
 *   `powerTracker` alone; area-owned meter readings are routed to sub-home
 *   bundles and fenced OUT of Main's admitted samples by the sampled-meter
 *   identity work (`setup/powerSamplePipeline.ts` publishes the resolved
 *   identity with the admitted watts, and whenever meter areas run on Homey
 *   Energy, Main must name its own meter — `setup/homeMeterOwnership.ts`).
 *   Editing an area's meter therefore never changes the series behind Main's
 *   retained history, while a roster arm would discard up to two years of
 *   evidence on routine area maintenance;
 * - area names, root zones, and device pins — membership cosmetics that do
 *   not change which meter measures what.
 *
 * Known limitation — the Automatic arm is the constant `main:automatic`, not
 * the device it resolves to: `extractAutomaticHomePowerReading` samples the
 * first usable cumulative item, so a Homey reorder/availability change (or a
 * roster edit that re-fences the very device Automatic had elected) can
 * silently switch the physically sampled device with no fingerprint change.
 * Bounded, not open-ended: `homeMeterOwnership.ts` refuses any Homey-Energy
 * save that leaves Main on Automatic while meter areas exist, so the
 * areas-plus-Automatic shape survives only on legacy configs saved before
 * that invariant.
 * The RESOLVED identity does exist — membership publishes it via
 * `noteResolvedHomeMeter` into `SampledMeterIdentity` — but it is proven only
 * after the first admitted sample and expires on that sample's freshness
 * horizon, so it is structurally unavailable at the collector's boot-time
 * `start()` reconcile (the primary invalidation edge). Consuming it here
 * would either compose to `undefined` at every boot (skipping the boot
 * reconcile for Automatic homes entirely) or flip-flop against a constant
 * fallback arm (spurious forgets). The sound fix is a mid-run
 * identity-proven reconcile edge with restart semantics; tracked in TODO.md
 * ("weather meter-scope fingerprint: resolve the Automatic arm").
 *
 * Returns `undefined` when a read needed for the selected branch is
 * unavailable. A genuinely unwritten homes registry is the normal
 * single-home state: membership resolves it to an active empty roster, so the
 * fingerprint does the same. A `suspect` read remains unavailable — ambiguity
 * is not change evidence.
 */
export const readWholeHomeMeterScopeSignature = (
  homey: Homey.App['homey'],
): string | undefined => {
  const powerSource = readConfiguredPowerSource(homey.settings);
  if (powerSource.state === 'suspect') return undefined;
  if (powerSource.value === 'flow') return 'source:flow';

  const mainMeter = readMainMeterSelection(homey.settings);
  if (mainMeter.state === 'unavailable') return undefined;
  if (mainMeter.meterDeviceId !== null) {
    return `source:homey_energy|main:${mainMeter.meterDeviceId}`;
  }

  const homesRead = createHomesStore(homey).read();
  if (homesRead.state === 'suspect') return undefined;
  if (homesRead.state === 'unwritten') {
    return 'source:homey_energy|main:automatic|areas:active';
  }
  const activation = readHomeConfigRuntimeActivation(homesRead.value, homey.settings);
  if (activation.state === 'suspect') return undefined;
  // The source and posture values are closed enums and meter ids are Homey
  // device UUIDs, so the separators cannot collide.
  const posture = activation.active ? 'active' : 'dormant';
  return `source:homey_energy|main:automatic|areas:${posture}`;
};
