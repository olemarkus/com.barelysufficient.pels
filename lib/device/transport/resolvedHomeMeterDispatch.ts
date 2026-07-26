/**
 * Home-power sample production for the shared live-power producer seam
 * (`fetchLivePowerReport` in `snapshotRefresh.ts`). Split out of that file:
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
import type { TransportContext } from './transportContext';
import type { LivePowerReport } from './managerFetch';

/** One whole-home power sample, carrying the identity of the meter it came from. */
export type HomePowerSampleWithIdentity = {
  powerW: number;
  generationW?: number;
  /**
   * Identity of the meter `powerW` was read from; `null` = unknown (the item
   * carried no id) — never proof of non-collision. Consumers that record this
   * sample hand the field to the ingest seam; consumers that discard the
   * sample thereby discard the identity claim with it.
   */
  resolvedHomeMeterDeviceId: string | null;
};

export function updateHomePowerFromReport(
    ctx: TransportContext,
    report: LivePowerReport,
): HomePowerSampleWithIdentity | null {
    // PR2a of the observer/transport split: observer owns the home-power
    // read. Transport produces the scalar from the Homey SDK energy report
    // and pushes it to observer's holder via the injected dispatcher; it no
    // longer caches the value locally. The return value still feeds the direct
    // `pollHomePowerW()` caller (homey_energy poll source), with generation
    // carried from the same report so later Flow samples cannot inherit it.
    ctx.observedStateDispatcher?.setHomePowerW(report.homePowerW);
    ctx.observedStateDispatcher?.setGenerationW(report.generationW);
    if (report.homePowerW === null) return null;
    return report.generationW === null
        ? { powerW: report.homePowerW, resolvedHomeMeterDeviceId: report.resolvedHomeMeterDeviceId }
        : {
            powerW: report.homePowerW,
            generationW: report.generationW,
            resolvedHomeMeterDeviceId: report.resolvedHomeMeterDeviceId,
        };
}
