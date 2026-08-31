import type Homey from 'homey';
import { readMainMeterSelection } from './mainMeterSettings';
import { readConfiguredPowerSource } from './powerSourceSettings';

/**
 * Composes the whole-home metering-arrangement fingerprint the weather
 * collector stamps into its persisted history (`meterScopeSignature`). It
 * includes only settings that can change the selected producer:
 * - Flow is self-contained (`source:flow`);
 * - Homey Energy includes the explicit Main meter it reads.
 *
 * The power source is part of the arrangement, not a modifier of it: Flow and
 * Homey Energy are different PRODUCERS of the same power-tracker buckets the
 * fit's kWh layer consumes, so switching sources splices two producers'
 * scopes into one retained history exactly like a meter swap does.
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
 * A persisted `main:automatic|areas:*` signature from the retired Automatic
 * selection classifies INVALID in `weatherMeterScope.ts`; the documented
 * invalid-pair policy makes the collector adopt the live explicit signature
 * without forgetting kWh history — the deliberate upgrade path, since the
 * Automatic arm never named the physical meter anyway.
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
  // The source value is a closed enum and meter ids are Homey device UUIDs,
  // so the separators cannot collide.
  return `source:homey_energy|main:${mainMeter.meterDeviceId}`;
};
