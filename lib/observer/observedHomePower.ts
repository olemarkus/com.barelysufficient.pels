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
}
