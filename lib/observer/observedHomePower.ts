/**
 * Observer-owned gross PV generation reading and its read time.
 *
 * PR2a of the observer/transport split (`notes/state-management/observer-transport-split.md`).
 *
 * Two producers push the already-resolved scalar here, one per power source: on
 * `homey_energy` it rides the SDK energy report read in the device layer
 * (`managerFetch` → `managerHomeyApi` → `managerEnergy`), pushed by transport
 * through the `observedStateDispatcher` callback bag (`setGenerationW`); on
 * `flow` the companion generation poll writes it through its own
 * wiring-injected dep. Either way observer never imports the producing layer —
 * it only holds the value it is handed.
 *
 * The holder used to carry the whole-home net scalar too
 * (`setHomePowerW`/`getHomePowerW`, PR2a). That half was removed as write-only:
 * wiring takes the net sample as a parameter, so `getHomePowerW` had no
 * production reader left.
 *
 * Besides the latest value it keeps the recent readings themselves
 * ({@link getGenerationReadings}). On `flow` the net sample and the production
 * reading ride different clocks, and the energy between two sparse Flow samples
 * can only be integrated honestly from the production readings taken in
 * between — the latest one alone would be held across the whole gap.
 */
export type GenerationReading = {
    readonly watts: number | null;
    readonly observedAtMs: number;
};

/**
 * How far back the reading history reaches, and so how far back one sparse Flow
 * interval can accrue production. It matches the 60 min the tracker allows for
 * a net interval (`MAX_SOLAR_ACCRUAL_GAP_MS`), so a Flow home reporting at any
 * cadence the net side accepts gets its full interval's production.
 */
const GENERATION_READING_RETENTION_MS = 60 * 60 * 1000;

/**
 * Hard ceiling on the history length, independent of the time window, so a
 * burst of pushes (or a clock step) can never grow it without bound. The poll
 * alone fills an hour with 360; the device-snapshot path adds a reading per
 * refresh, which is irregular. 1800 keeps the full hour at an average of one
 * push every 2 s (~90 KB); past that the oldest readings go first, which can
 * only under-count the start of a very long Flow interval.
 */
const GENERATION_READING_MAX_COUNT = 1800;

export class ObservedHomePower {
    private generationW: number | null = null;

    private generationObservedAtMs: number | null = null;

    private readings: GenerationReading[] = [];

    /**
     * Push the latest gross PV generation reading (watts), or `null` when no
     * generation signal is present, stamped with the time it was read. `+`-only.
     *
     * On the `homey_energy` source this is co-temporal with the net reading (one
     * report, one poll). On `flow` it is NOT: net arrives through the
     * `report_power_usage` card while generation comes from a separate reader
     * (`GenerationPollSource`), so the two ride different clocks. That is why the
     * read time is held here — a consumer must be able to tell a fresh reading
     * from one left behind by a poll that stopped, and it cannot recover that
     * from the value alone.
     *
     * This class stays a dumb value+time store. The staleness POLICY lives in
     * `generationFreshness.ts`, beside the layer's other freshness producers —
     * consumers read a producer-resolved answer rather than re-deriving one from
     * a raw age (`lib/observer/AGENTS.md`).
     */
    setGenerationW(w: number | null, observedAtMs: number): void {
        this.generationW = w;
        this.generationObservedAtMs = observedAtMs;
        this.recordReading({ watts: w, observedAtMs });
    }

    /**
     * The recent readings, oldest first. Two producers can push on `flow` (the
     * companion poll, stamped at issue, and the device snapshot path, stamped at
     * completion), so a push may carry an earlier stamp than the one before it;
     * the history is kept in stamp order regardless of arrival order.
     */
    getGenerationReadings(): readonly GenerationReading[] {
        return this.readings;
    }

    private recordReading(reading: GenerationReading): void {
        // Insert after every reading stamped at or before this one. Arrival is
        // almost always in order, so this is the end of the array.
        const firstLater = this.readings.findIndex((held) => held.observedAtMs > reading.observedAtMs);
        const insertAt = firstLater === -1 ? this.readings.length : firstLater;
        this.readings.splice(insertAt, 0, reading);
        const newestMs = this.readings.at(-1)?.observedAtMs ?? reading.observedAtMs;
        const cutoffMs = newestMs - GENERATION_READING_RETENTION_MS;
        // The newest reading always survives the cutoff, so `firstKept` is >= 0.
        const firstKept = this.readings.findIndex((held) => held.observedAtMs >= cutoffMs);
        const drop = Math.max(firstKept, this.readings.length - GENERATION_READING_MAX_COUNT);
        if (drop > 0) this.readings.splice(0, drop);
    }

    /**
     * Returns the gross PV generation in watts as last reported by transport, or
     * `null` when no generation signal is available. Consumed to gross up the
     * authoritative whole-home actual consumption for the managed/unmanaged
     * split, and — on the flow source — to co-sample production alongside a
     * Flow-reported net. Never the hard-cap import path.
     */
    getGenerationW(): number | null {
        return this.generationW;
    }

    /**
     * When {@link getGenerationW} was read, or `null` if nothing has been pushed
     * yet. An absent VALUE and an absent TIMESTAMP are different things: a
     * reading of `null` (the report carried no generation) is itself an
     * observation and carries a time.
     */
    getGenerationObservedAtMs(): number | null {
        return this.generationObservedAtMs;
    }
}
