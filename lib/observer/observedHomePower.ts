/**
 * Observer-owned whole-home power scalar.
 *
 * PR2a of the observer/transport split (`notes/state-management/observer-transport-split.md`).
 *
 * The *source* of this value is a Homey SDK energy report read in the device
 * layer (`managerFetch` → `managerHomeyApi` → `managerEnergy`); transport pushes
 * the already-resolved scalar here through the `observedStateDispatcher` callback
 * bag (`setHomePowerW`) at construction time. Observer never imports `lib/device/`
 * or `lib/power/` — it only holds the value transport hands it, and wiring
 * (`lib/app/`) reads it back via `getHomePowerW()`.
 */
export class ObservedHomePower {
    private homePowerW: number | null = null;

    private generationW: number | null = null;

    private generationObservedAtMs: number | null = null;

    /** Push the latest whole-home reading (watts), or `null` when absent. */
    setHomePowerW(w: number | null): void {
        this.homePowerW = w;
    }

    /**
     * Returns the whole-home power reading in watts as last reported by
     * transport, or `null` when no live reading is available.
     */
    getHomePowerW(): number | null {
        return this.homePowerW;
    }

    /**
     * Push the latest gross PV generation reading (watts), or `null` when no
     * generation signal is present, stamped with the time it was read. `+`-only.
     *
     * On the `homey_energy` source this is co-temporal with `setHomePowerW` (one
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
