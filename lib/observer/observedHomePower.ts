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
 *
 * The holder also carries one further awareness-only signal: gross PV generation
 * (`setGenerationW`/`getGenerationW`, co-temporal with the home-power poll), which
 * never feeds the hard-cap import path.
 */
export class ObservedHomePower {
    private homePowerW: number | null = null;

    private generationW: number | null = null;

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
     * generation signal is present. Co-temporal with `setHomePowerW` (both come
     * from the same energy-report poll). `+`-only.
     */
    setGenerationW(w: number | null): void {
        this.generationW = w;
    }

    /**
     * Returns the gross PV generation in watts as last reported by transport, or
     * `null` when no generation signal is available. Consumed only to gross up
     * the authoritative whole-home actual consumption for the managed/unmanaged
     * split — never the hard-cap import path.
     */
    getGenerationW(): number | null {
        return this.generationW;
    }
}
