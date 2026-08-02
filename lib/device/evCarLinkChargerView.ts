import type { EvChargingState } from '../../packages/contracts/src/types';

/**
 * The charger half of the car-link probe's inputs, plus the predicates that say
 * what its fields are evidence OF.
 *
 * Split from `evCarLinkProducer.ts` so the shape and its evidence rules sit
 * together: every field below is deliberately absent-able, and each absence
 * means "unresolved", never a defaulted value. Design of record:
 * `notes/ev-car-link/README.md`.
 */

/**
 * Charger state as the transport wiring resolves it. Flat, already-narrowed
 * values: the observed-cluster guards (`isEvObserved`, `hasObservedStateOfCharge`,
 * `hasObservedMeasuredPower`) are applied by the producer seam that builds this,
 * so nothing downstream re-branches on provenance.
 */
export type EvCarLinkChargerView = {
    id: string;
    name: string;
    /** Always resolved: the builder skips a charger whose plug state is unknown. */
    evChargingState: EvChargingState;
    /** Measured draw in watts. ABSENT when there is no trusted reading — never a
     *  fabricated zero, which would read as "idle" and fake a self-stop. */
    measuredPowerW?: number;
    /** When that draw was observed; absent when the producer could not resolve it. */
    measuredPowerObservedAtMs?: number;
    /**
     * The charger's OBSERVED binary control state — not what PELS commanded.
     * Kept observed-only on purpose: `lib/device/AGENTS.md` treats collapsing
     * commanded into observed as the bug this layer exists to prevent. It is
     * used here only to widen "the charger believes it is delivering" beyond a
     * literal `plugged_in_charging`, never to assert PELS asked for anything.
     */
    controlOn: boolean;
    /** Charge already on the charger snapshot (the existing flow card); absent
     *  when that card has never reported. */
    reportedSocPct?: number;
};

/**
 * Whether the charger's measured draw is usable evidence about THIS session.
 *
 * Absent means unresolved, and a reading taken before the session began says
 * nothing about it — a retained idle value from a previous session would
 * otherwise read as live proof the charger is delivering nothing. Callers treat
 * `false` as "hold the dwell", never as "the condition broke": an unresolved
 * reading is not evidence the car resumed.
 */
export const hasSessionPowerEvidence = (
    charger: EvCarLinkChargerView,
    sessionStartedAtMs: number,
): charger is EvCarLinkChargerView & { measuredPowerW: number } => {
    if (charger.measuredPowerW === undefined) return false;
    return charger.measuredPowerObservedAtMs === undefined
        || charger.measuredPowerObservedAtMs >= sessionStartedAtMs;
};
