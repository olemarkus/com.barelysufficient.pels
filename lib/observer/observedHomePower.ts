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
 */
export class ObservedHomePower {
    private generationW: number | null = null;

    private generationObservedAtMs: number | null = null;

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
