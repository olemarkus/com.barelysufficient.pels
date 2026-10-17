/**
 * The meter readings one live energy report yields (`fetchLivePowerReport`),
 * for the poll and the snapshot refresh alike.
 */
import type { LiveMeterReadings } from '../../ports/homeMeterReadings';
import type { LivePowerReport } from './managerFetch';

export function resolveLiveMeterReadings(
    setGenerationW: (watts: number | null, observedAtMs: number) => void,
    report: LivePowerReport,
): LiveMeterReadings | null {
    // A FAILED read is not a measurement and must not be published: this
    // snapshot path runs on flow homes too, where a thrown fetch would
    // otherwise overwrite the companion poll's good reading with a
    // freshly-stamped absence — defeating the freshness window, dropping
    // `lastGenerationW`, and moving the gross-consumption split on the next
    // Flow event. Leave the held value to age out on its own instead.
    if (report.state !== 'measured') return null;
    // Stamped with the read time. On THIS path the meters and generation are
    // co-temporal, but the holder is shared with the flow source's separate
    // generation reader (`GenerationPollSource`), whose readings are not — so
    // every writer carries a time rather than letting the holder assume one.
    // "No generator" is itself an observation the holder records as `null`;
    // a malformed generation signal (`unavailable`) is not, and publishes
    // nothing so the held reading carries forward.
    const { meterPowerW, generation } = report;
    if (generation.state !== 'unavailable') {
        setGenerationW(
            generation.state === 'measured' ? generation.watts : null,
            Date.now(),
        );
    }
    // Generation rides with the meters it was read beside, so a whole-home
    // sample built from them stays co-temporal.
    return generation.state === 'measured'
        ? { meterPowerW, generationW: generation.watts }
        : { meterPowerW };
}
