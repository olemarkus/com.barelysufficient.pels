/**
 * Home-power sample production for the shared live-power producer seam
 * (`fetchLivePowerReport` in `livePowerReport.ts`). Split out of the snapshot
 * module:
 * main sits at exactly the 500-line `max-lines` ceiling, so this carved out its
 * own module rather than pushing the seam over it.
 *
 * The resolved whole-home meter IDENTITY leaves the transport ON the sample —
 * never as a separate read-time dispatch. Publication to membership happens at
 * the admitted sample ingest (`PowerSamplePipeline`), so the identity, the
 * watts, and their timestamp move as one: a read whose sample is discarded
 * (post-actuation refresh, the post-write re-read, a superseded poll, a
 * mid-flight selection change) publishes nothing, and the ownership fence can
 * only ever move together with the watts it governs.
 */
import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';
import type { TransportContext } from './transportContext';
import type { LivePowerReport } from './managerFetch';

/** One whole-home power sample, carrying the identity of the meter it came from. */
export type HomePowerSampleWithIdentity = {
  powerW: number;
  generationW?: number;
  /**
   * Identity of the meter `powerW` was read from — by construction the
   * resolved selection's configured id, stamped where the sample is produced.
   * Always present: a sample cannot exist without a named meter any more.
   * Consumers that record this sample hand the field to the ingest seam;
   * consumers that discard the sample discard the identity claim with it.
   */
  meterDeviceId: string;
};

export function updateHomePowerFromReport(
    ctx: TransportContext,
    report: LivePowerReport,
    selection: MainMeterSelection,
): HomePowerSampleWithIdentity | null {
    // PR2a of the observer/transport split: observer owns the home-power
    // read. Transport produces the scalar from the Homey SDK energy report
    // and pushes it to observer's holder via the injected dispatcher; it no
    // longer caches the value locally. The return value still feeds the direct
    // `pollHomePowerW()` caller (homey_energy poll source), with generation
    // carried from the same report so it stays co-temporal with the net it was
    // read beside.
    ctx.observedStateDispatcher?.setHomePowerW(report.homePowerW);
    // Stamped with the read time. On THIS path net and generation are
    // co-temporal, but the holder is shared with the flow source's separate
    // generation reader (`GenerationPollSource`), whose readings are not — so
    // every writer carries a time rather than letting the holder assume one.
    //
    // A FAILED read is not a measurement and must not be published: this
    // snapshot path runs on flow homes too, where a thrown fetch would
    // otherwise overwrite the companion poll's good reading with a
    // freshly-stamped `null` — defeating the freshness window, dropping
    // `lastGenerationW`, and moving the gross-consumption split on the next
    // Flow event. Leave the held value to age out on its own instead.
    if (report.reportAvailable) {
      ctx.observedStateDispatcher?.setGenerationW(report.generationW, Date.now());
    }
    // A whole-home reading only exists for a resolved selection (an
    // `unavailable` selection nulls `homePowerW` in `resolveHomeReading`), so
    // the sample's identity is the configured id — checked here so the
    // invariant is structural, not assumed.
    if (report.homePowerW === null || selection.state !== 'resolved') return null;
    return report.generationW === null
        ? {
            powerW: report.homePowerW,
            meterDeviceId: selection.meterDeviceId,
        }
        : {
            powerW: report.homePowerW,
            generationW: report.generationW,
            meterDeviceId: selection.meterDeviceId,
        };
}
